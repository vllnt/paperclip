import { createInterface } from "node:readline";
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, costEvents, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import {
  COMPANY_ARCHIVE_FORMAT,
  COMPANY_ARCHIVE_INCLUDES,
  COMPANY_ARCHIVE_RECORD_VERSION,
  COMPANY_ARCHIVE_REDACTION_POLICY,
  COMPANY_ARCHIVE_SETTLE_DELAY_MS,
  HEARTBEAT_RUN_TERMINAL_STATUSES,
  encodeCompanyArchiveCursor,
  type CompanyArchiveCursor,
  type CompanyArchiveInclude,
  type CompanyArchiveOmissionReason,
  type CompanyArchiveRecord,
  type CompanyArchiveRecordKind,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import { getRunLogStore, type RunLogStore } from "./run-log-store.js";
import { createRunReadRedaction, type RunReadRedactor } from "./run-read-redaction.js";

const EVENT_PAGE_SIZE = 1000;

/**
 * The settle key orders runs for the export and the archive. It is never
 * null and `finished_at` is written once; `updated_at` would move on every
 * event append. Keep this expression identical to the index on
 * `heartbeat_runs` so the keyset query can use it.
 */
const settleKey = sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt})`;
// Microsecond text: a JS Date keeps milliseconds only, and a keyset compared
// on truncated values skips or repeats runs.
const settleKeyText = sql<string>`to_char(${settleKey} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface CompanyArchiveExportOptions {
  companyId: string;
  cursor: CompanyArchiveCursor | null;
  since?: Date;
  until?: Date;
  include?: readonly CompanyArchiveInclude[];
  limit: number;
  /** Follow `next` inside this response until the window is exhausted. */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface CompanyArchiveExportSummary {
  runs: number;
  next: string | null;
}

interface CompanyArchiveExportDeps {
  runLogStore?: RunLogStore;
  now?: () => Date;
}

type RunRow = NonNullable<Awaited<ReturnType<ReturnType<typeof heartbeatService>["getRun"]>>>;

/**
 * Streams a company's settled runs as company-archive records (format v1).
 * Every record passes the same read-time redaction as the run API.
 */
export function companyArchiveExportService(db: Db, deps: CompanyArchiveExportDeps = {}) {
  const heartbeat = heartbeatService(db);
  const redaction = createRunReadRedaction(db);
  const now = deps.now ?? (() => new Date());

  function record<TData extends object>(
    kind: CompanyArchiveRecordKind,
    companyId: string,
    runId: string | undefined,
    data: TData,
  ): CompanyArchiveRecord<TData> {
    return { kind, v: COMPANY_ARCHIVE_RECORD_VERSION, companyId, ...(runId ? { runId } : {}), data };
  }

  async function listSettledRuns(options: CompanyArchiveExportOptions, cutoff: Date) {
    const conditions: SQL[] = [
      eq(heartbeatRuns.companyId, options.companyId),
      inArray(heartbeatRuns.status, [...HEARTBEAT_RUN_TERMINAL_STATUSES]),
      sql`${settleKey} <= ${cutoff.toISOString()}::timestamptz`,
    ];
    if (options.since) conditions.push(sql`${settleKey} >= ${options.since.toISOString()}::timestamptz`);
    if (options.cursor) {
      conditions.push(sql`(${settleKey}, ${heartbeatRuns.id}) > (${options.cursor.t}::timestamptz, ${options.cursor.id}::uuid)`);
    }
    return db
      .select({ id: heartbeatRuns.id, settleKey: settleKeyText })
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(settleKey, asc(heartbeatRuns.id))
      .limit(options.limit);
  }

  async function* runEvents(
    companyId: string,
    runId: string,
    redactor: RunReadRedactor,
    signal?: AbortSignal,
  ): AsyncGenerator<{ event: Record<string, unknown>; seq: number } | { omission: CompanyArchiveOmissionReason }> {
    let afterSeq = -1;
    for (;;) {
      signal?.throwIfAborted();
      let page;
      try {
        page = await db
          .select()
          .from(heartbeatRunEvents)
          .where(and(
            eq(heartbeatRunEvents.companyId, companyId),
            eq(heartbeatRunEvents.runId, runId),
            gt(heartbeatRunEvents.seq, afterSeq),
          ))
          .orderBy(asc(heartbeatRunEvents.seq))
          .limit(EVENT_PAGE_SIZE);
      } catch (error) {
        signal?.throwIfAborted();
        // A payload that fails to decode must not block every later export
        // of the company: report it and move on to the next entity.
        logger.warn({ err: error, companyId, runId }, "company archive export could not read run events");
        yield { omission: "events_unreadable" };
        return;
      }
      for (const event of page) yield { event: redactor.exportEvent(event), seq: event.seq };
      if (page.length < EVENT_PAGE_SIZE) return;
      afterSeq = page[page.length - 1]!.seq;
    }
  }

  async function* transcriptLines(
    run: RunRow,
    redactor: RunReadRedactor,
    signal?: AbortSignal,
  ): AsyncGenerator<{ line: Record<string, unknown> } | { omission: CompanyArchiveOmissionReason }> {
    if (!run.logStore || !run.logRef) return;
    const store = deps.runLogStore ?? getRunLogStore();
    if (!store.openReadStream) {
      yield { omission: "transcript_unavailable" };
      return;
    }
    let input;
    try {
      input = await store.openReadStream({ store: run.logStore as "local_file", logRef: run.logRef }, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      const missing = error instanceof HttpError && error.status === 404;
      // A bad log pointer, a permission error or a failing mirror affects one
      // run; it must not block every later export of the company.
      if (!missing) logger.warn({ err: error, companyId: run.companyId, runId: run.id }, "company archive export could not open run log");
      yield { omission: missing ? "transcript_unavailable" : "transcript_unreadable" };
      return;
    }
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const text of lines) {
        lineNumber += 1;
        if (!text) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const line = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>), line: lineNumber }
          // A torn last line (crash mid-append) stays visible as raw text.
          : { line: lineNumber, raw: text };
        yield { line: redactor.exportValue(line) };
      }
    } catch (error) {
      signal?.throwIfAborted();
      // The file vanished or the mirror failed mid-read: keep what was read and
      // say so, instead of failing the whole export.
      logger.warn({ err: error, companyId: run.companyId, runId: run.id }, "company archive export stopped reading a run log");
      yield { omission: "transcript_unreadable" };
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async function* runRecords(
    run: RunRow,
    key: string,
    include: ReadonlySet<CompanyArchiveInclude>,
    signal?: AbortSignal,
  ): AsyncGenerator<CompanyArchiveRecord> {
    const { companyId, id: runId } = run;
    const redactor = await redaction.forRun(companyId, runId);
    const counts = { run: 0, events: 0, transcript: 0, costs: 0, activity: 0 };

    if (include.has("run")) {
      yield record("run", companyId, runId, redactor.exportRun(run));
      counts.run = 1;
    }
    let eventMaxSeq: number | null = null;
    if (include.has("events")) {
      for await (const item of runEvents(companyId, runId, redactor, signal)) {
        if ("omission" in item) {
          yield record("run.omission", companyId, runId, { reason: item.omission, include: "events" });
          continue;
        }
        yield record("run_event", companyId, runId, item.event);
        eventMaxSeq = item.seq;
        counts.events += 1;
      }
    }
    if (include.has("transcript")) {
      for await (const item of transcriptLines(run, redactor, signal)) {
        if ("omission" in item) {
          yield record("run.omission", companyId, runId, { reason: item.omission, include: "transcript" });
        } else {
          yield record("transcript", companyId, runId, item.line);
          counts.transcript += 1;
        }
      }
    }
    if (include.has("costs")) {
      const rows = await db
        .select()
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)))
        .orderBy(asc(costEvents.occurredAt), asc(costEvents.id));
      for (const row of rows) {
        yield record("cost_event", companyId, runId, redactor.exportValue(row));
        counts.costs += 1;
      }
    }
    if (include.has("activity")) {
      const rows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
      for (const row of rows) {
        yield record("activity", companyId, runId, redactor.exportValue(row));
        counts.activity += 1;
      }
    }

    // High-water marks let a consumer detect child rows that land after this
    // run was exported (see doc/company-archive.md). The event mark is the
    // last seq actually exported, so an event appended during a long read
    // shows up as a difference on the next pull.
    if (!include.has("events")) {
      const [row] = await db
        .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId)));
      eventMaxSeq = row?.maxSeq === null || row?.maxSeq === undefined ? null : Number(row.maxSeq);
    }
    const costCount = include.has("costs")
      ? counts.costs
      : await db.$count(costEvents, and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));
    const activityCount = include.has("activity")
      ? counts.activity
      : await db.$count(activityLog, and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    const marks = { eventMaxSeq, costCount, activityCount, logBytes: run.logBytes ?? null };
    const cursor = encodeCompanyArchiveCursor({ t: key, id: runId });
    yield record("run.end", companyId, runId, { counts, marks, settleKey: key, cursor });
  }

  return {
    /**
     * @param options company, window, cursor and page size (already validated)
     * @returns an async iterator of records; the last one is `export.end`
     */
    async *stream(options: CompanyArchiveExportOptions): AsyncGenerator<CompanyArchiveRecord> {
      const include = new Set(options.include ?? COMPANY_ARCHIVE_INCLUDES);
      const settleCutoff = new Date(now().getTime() - COMPANY_ARCHIVE_SETTLE_DELAY_MS);
      const cutoff = options.until && options.until < settleCutoff ? options.until : settleCutoff;
      const { companyId, signal } = options;

      // Query the first page before the header: a failure here (bad cursor
      // value, database down) must reach the client as an HTTP error, not as
      // a cut stream after a 200.
      let position = options.cursor;
      let runs = await listSettledRuns({ ...options, cursor: position }, cutoff);

      yield record("export.header", companyId, undefined, {
        format: COMPANY_ARCHIVE_FORMAT,
        generatedAt: now().toISOString(),
        include: [...include],
        since: options.since?.toISOString() ?? null,
        // What the caller asked for, as opposed to the effective cutoff below:
        // a resumed export must keep the same requested window.
        requestedUntil: options.until?.toISOString() ?? null,
        until: cutoff.toISOString(),
        cursor: options.cursor ? encodeCompanyArchiveCursor(options.cursor) : null,
        limit: options.limit,
        follow: options.follow ?? false,
        redaction: COMPANY_ARCHIVE_REDACTION_POLICY,
      });

      let total = 0;
      let next: string | null = null;
      // The window is fixed at the start (cutoff), so following pages ends.
      for (;;) {
        for (const { id: runId, settleKey: key } of runs) {
          signal?.throwIfAborted();
          // Advance before the skip below, so a page of deleted runs still
          // moves the cursor.
          position = { t: key, id: runId };
          const run = await heartbeat.getRun(runId);
          // Deleted between the page query and this read: skip it.
          if (!run || run.companyId !== companyId) continue;
          yield* runRecords(run, key, include, signal);
        }
        total += runs.length;
        const more = runs.length === options.limit;
        if (!more || !options.follow) {
          next = more && position ? encodeCompanyArchiveCursor(position) : null;
          break;
        }
        runs = await listSettledRuns({ ...options, cursor: position }, cutoff);
      }
      const summary: CompanyArchiveExportSummary = { runs: total, next };
      yield record("export.end", companyId, undefined, {
        ...summary,
        resumeCursor: position ? encodeCompanyArchiveCursor(position) : null,
      });
    },
  };
}
