import { and, asc, count, eq, getTableColumns, gte, inArray, isNull, lt, lte, max, min, or, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issues,
  projects,
  runUsageRecords,
  type Db,
} from "@paperclipai/db";
import {
  RUN_USAGE_RECORD_SCHEMA_VERSION,
  RUN_USAGE_TERMINAL_STATUSES,
  type ObservabilityHealth,
  type RunUsageRecordSource,
} from "@paperclipai/shared";
import {
  deriveRunUsageRecord,
  type RunUsageDeriveIssue,
  type RunUsageDeriveRun,
  type RunUsageRecordInsert,
} from "./run-usage-record-derive.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
export type RunUsageExecutor = Db | Tx;

/** One stored usage record. */
export type RunUsageRecordRow = typeof runUsageRecords.$inferSelect;

/** Postgres advisory lock that makes the derivation worker single-flight across server instances. */
export const RUN_USAGE_WORKER_LOCK = {
  namespace: "paperclip.observability",
  name: "run_usage_records",
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A run is derived only after it finished this long ago, so late writes (liveness) have landed. */
export const RUN_USAGE_SETTLE_MS = 10 * MINUTE_MS;
/** The normal pass looks at runs created in this window. */
export const RUN_USAGE_LOOKBACK_MS = 48 * HOUR_MS;
/** The daily sweep looks at runs created in this window and counts what it finds as late. */
export const RUN_USAGE_SWEEP_LOOKBACK_MS = 30 * DAY_MS;
const SWEEP_INTERVAL_MS = DAY_MS;
const BATCH_SIZE = 200;
const MAX_BATCHES_PER_COMPANY = 25;
const MAX_RETRY_DEPTH = 20;
const MAX_LIST_LIMIT = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES: string[] = [...RUN_USAGE_TERMINAL_STATUSES];

const RUN_COLUMNS = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  status: heartbeatRuns.status,
  errorCode: heartbeatRuns.errorCode,
  signal: heartbeatRuns.signal,
  stderrExcerpt: heartbeatRuns.stderrExcerpt,
  runtimeMode: heartbeatRuns.runtimeMode,
  driverKind: heartbeatRuns.driverKind,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
  livenessState: heartbeatRuns.livenessState,
  lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
  usageJson: heartbeatRuns.usageJson,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  createdAt: heartbeatRuns.createdAt,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
};

/** Options for one derivation pass. */
export interface RunUsagePassOptions {
  now?: Date;
  /** Only runs created within this window. Defaults to {@link RUN_USAGE_LOOKBACK_MS}. */
  lookbackMs?: number;
  /** Limit the pass to one company. Defaults to every company. */
  companyId?: string;
  /** Also replace records written under an older schema version. */
  rederive?: boolean;
}

/** What a pass did. A skipped pass found another worker holding the lock. */
export interface RunUsagePassResult {
  skipped: boolean;
  scanned: number;
  written: number;
  /** True when a company had more work than one pass handles, so the rest waits for the next pass. */
  truncated: boolean;
}

/** Options for {@link RunUsageRecordService.backfill}. */
export interface RunUsageBackfillOptions {
  now?: Date;
  companyId?: string;
  rederive?: boolean;
  /** Only runs created at or after this time. Defaults to every run. */
  since?: Date;
  onBatch?: (progress: { companyId: string; scanned: number; written: number }) => void;
}

/** A keyset position in the record list: `(finished_at, run_id)`. */
export interface RunUsageRecordCursor {
  finishedAt: string;
  runId: string;
}

/** Input of {@link RunUsageRecordService.listUsageRecordsAfter}. */
export interface ListRunUsageRecordsInput {
  companyId: string;
  cursor: RunUsageRecordCursor | null;
  limit: number;
  now?: Date;
}

/** One page of records and the cursor of the next page, or null at the end. */
export interface RunUsageRecordPage {
  records: RunUsageRecordRow[];
  next: RunUsageRecordCursor | null;
}

interface CandidateRow {
  run: RunUsageDeriveRun;
  adapterType: string | null;
  wakeupReason: string | null;
  createdAtText: string;
}

interface CandidateFilter {
  companyId: string;
  settledBefore: Date;
  createdSince: Date | null;
  rederive: boolean;
  after: { createdAtText: string; id: string } | null;
  limit: number;
}

function readUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function uniqueNonNull(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

async function selectCandidates(executor: RunUsageExecutor, filter: CandidateFilter): Promise<CandidateRow[]> {
  const conditions: SQL[] = [
    eq(heartbeatRuns.companyId, filter.companyId),
    inArray(heartbeatRuns.status, TERMINAL_STATUSES),
    sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) <= ${filter.settledBefore.toISOString()}::timestamptz`,
  ];
  if (filter.createdSince) conditions.push(gte(heartbeatRuns.createdAt, filter.createdSince));
  if (filter.rederive) {
    const stale = or(isNull(runUsageRecords.runId), lt(runUsageRecords.schemaVersion, RUN_USAGE_RECORD_SCHEMA_VERSION));
    if (stale) conditions.push(stale);
  } else {
    conditions.push(isNull(runUsageRecords.runId));
  }
  if (filter.after) {
    conditions.push(
      sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${filter.after.createdAtText}::timestamptz, ${filter.after.id}::uuid)`,
    );
  }

  return executor
    .select({
      run: RUN_COLUMNS,
      adapterType: agents.adapterType,
      wakeupReason: agentWakeupRequests.reason,
      createdAtText: sql<string>`${heartbeatRuns.createdAt}::text`,
    })
    .from(heartbeatRuns)
    .leftJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .leftJoin(
      agentWakeupRequests,
      and(
        eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
        eq(agentWakeupRequests.companyId, heartbeatRuns.companyId),
      ),
    )
    .leftJoin(runUsageRecords, eq(runUsageRecords.runId, heartbeatRuns.id))
    .where(and(...conditions))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(filter.limit);
}

async function readIssues(
  executor: RunUsageExecutor,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, RunUsageDeriveIssue>> {
  if (issueIds.length === 0) return new Map();
  const rows = await executor
    .select({
      id: issues.id,
      projectId: issues.projectId,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  return new Map(rows.map((row) => [row.id, row]));
}

async function readProjectIds(executor: RunUsageExecutor, companyId: string, projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const rows = await executor
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
  return new Set(rows.map((row) => row.id));
}

/** How many retries sit above each run: 1 for a run retried once, 2 for a retry of a retry. */
async function readRetryDepths(
  executor: RunUsageExecutor,
  companyId: string,
  runIds: string[],
): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const idList = sql.join(runIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await executor.execute<{ run_id: string; depth: number }>(sql`
    with recursive chain(run_id, parent_id, depth) as (
      select id, retry_of_run_id, 1
        from heartbeat_runs
       where company_id = ${companyId}::uuid and id in (${idList}) and retry_of_run_id is not null
      union all
      select chain.run_id, parent.retry_of_run_id, chain.depth + 1
        from chain
        join heartbeat_runs parent on parent.id = chain.parent_id and parent.company_id = ${companyId}::uuid
       where parent.retry_of_run_id is not null and chain.depth < ${MAX_RETRY_DEPTH}
    )
    select run_id, max(depth)::int as depth from chain group by run_id
  `);
  return new Map(rows.map((row) => [row.run_id, row.depth]));
}

async function deriveRecords(
  executor: RunUsageExecutor,
  companyId: string,
  rows: CandidateRow[],
  source: RunUsageRecordSource,
  derivedAt: Date,
): Promise<RunUsageRecordInsert[]> {
  const contexts = rows.map((row) => row.run.contextSnapshot ?? {});
  const issueById = await readIssues(executor, companyId, uniqueNonNull(contexts.map((context) => readUuid(context.issueId))));
  const projectIds = await readProjectIds(executor, companyId, uniqueNonNull(contexts.map((context) => readUuid(context.projectId))));
  const retryDepths = await readRetryDepths(
    executor,
    companyId,
    rows.filter((row) => row.run.retryOfRunId !== null).map((row) => row.run.id),
  );

  const records: RunUsageRecordInsert[] = [];
  rows.forEach((row, index) => {
    const context = contexts[index] ?? {};
    const issueId = readUuid(context.issueId);
    const contextProjectId = readUuid(context.projectId);
    const record = deriveRunUsageRecord({
      run: row.run,
      adapterType: row.adapterType ?? "unknown",
      issue: issueId ? issueById.get(issueId) ?? null : null,
      contextProjectId: contextProjectId && projectIds.has(contextProjectId) ? contextProjectId : null,
      wakeReason: readString(context.wakeReason) ?? row.wakeupReason,
      retryDepth: retryDepths.get(row.run.id) ?? 0,
      source,
    });
    if (record) records.push({ ...record, derivedAt });
  });
  return records;
}

function buildReplaceSet(): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(getTableColumns(runUsageRecords))) {
    if (key !== "runId") set[key] = sql.raw(`excluded."${column.name}"`);
  }
  return set;
}

const REPLACE_SET = buildReplaceSet();

/**
 * Writes records, replacing a stored one only when the new schema version is higher, so a slower
 * or older server can never overwrite a newer record.
 *
 * @param executor - The database handle or an open transaction.
 * @param records - Records from {@link deriveRunUsageRecord}.
 * @returns How many rows were inserted or replaced.
 */
export async function upsertRunUsageRecords(executor: RunUsageExecutor, records: RunUsageRecordInsert[]): Promise<number> {
  if (records.length === 0) return 0;
  const written = await executor
    .insert(runUsageRecords)
    .values(records)
    .onConflictDoUpdate({
      target: runUsageRecords.runId,
      set: REPLACE_SET,
      setWhere: sql`${runUsageRecords.schemaVersion} < excluded.schema_version`,
    })
    .returning({ runId: runUsageRecords.runId });
  return written.length;
}

interface CompanyPassInput {
  companyId: string;
  now: Date;
  createdSince: Date | null;
  rederive: boolean;
  source: RunUsageRecordSource;
  maxBatches: number;
  onBatch?: (progress: { companyId: string; scanned: number; written: number }) => void;
}

async function runCompanyBatches(
  executor: RunUsageExecutor,
  input: CompanyPassInput,
): Promise<{ scanned: number; written: number; truncated: boolean }> {
  const settledBefore = new Date(input.now.getTime() - RUN_USAGE_SETTLE_MS);
  let after: CandidateFilter["after"] = null;
  let scanned = 0;
  let written = 0;

  for (let batch = 0; batch < input.maxBatches; batch += 1) {
    const rows = await selectCandidates(executor, {
      companyId: input.companyId,
      settledBefore,
      createdSince: input.createdSince,
      rederive: input.rederive,
      after,
      limit: BATCH_SIZE,
    });
    if (rows.length === 0) return { scanned, written, truncated: false };

    const records = await deriveRecords(executor, input.companyId, rows, input.source, input.now);
    const batchWritten = await upsertRunUsageRecords(executor, records);
    scanned += rows.length;
    written += batchWritten;
    input.onBatch?.({ companyId: input.companyId, scanned: rows.length, written: batchWritten });

    const last = rows[rows.length - 1];
    if (!last) return { scanned, written, truncated: false };
    after = { createdAtText: last.createdAtText, id: last.run.id };
    if (rows.length < BATCH_SIZE) return { scanned, written, truncated: false };
  }
  return { scanned, written, truncated: true };
}

async function listCompanyIds(executor: RunUsageExecutor, only: string | undefined): Promise<string[]> {
  if (only) return [only];
  const rows = await executor.select({ id: companies.id }).from(companies);
  return rows.map((row) => row.id);
}

/**
 * Derives, backfills and reads `run_usage_records`. The records are computed from the run's own
 * row after it settles, never from the run path, so a failure here delays a panel and cannot
 * affect a run.
 *
 * @param db - The database handle.
 * @returns The worker pass, backfill, health and keyset read.
 * @example
 * const usage = runUsageRecordService(db);
 * await usage.runScheduledPass();
 */
export function runUsageRecordService(db: Db) {
  let lastSweepAt = 0;

  /**
   * One derivation pass under the single-worker advisory lock. It writes a record for every
   * settled terminal run in the lookback window that has none (or, with `rederive`, an older one).
   * Another worker holding the lock makes this a no-op that reports `skipped`.
   */
  async function runPass(options: RunUsagePassOptions = {}): Promise<RunUsagePassResult> {
    const now = options.now ?? new Date();
    const createdSince = new Date(now.getTime() - (options.lookbackMs ?? RUN_USAGE_LOOKBACK_MS));
    return db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${RUN_USAGE_WORKER_LOCK.namespace}), hashtext(${RUN_USAGE_WORKER_LOCK.name})) as acquired`,
      );
      if (!lock?.acquired) return { skipped: true, scanned: 0, written: 0, truncated: false };

      let scanned = 0;
      let written = 0;
      let truncated = false;
      for (const companyId of await listCompanyIds(tx, options.companyId)) {
        const result = await runCompanyBatches(tx, {
          companyId,
          now,
          createdSince,
          rederive: options.rederive ?? false,
          source: "derived",
          maxBatches: MAX_BATCHES_PER_COMPANY,
        });
        scanned += result.scanned;
        written += result.written;
        truncated = truncated || result.truncated;
      }
      return { skipped: false, scanned, written, truncated };
    });
  }

  /**
   * The scheduler tick: a normal pass, and once a day a wider sweep that finds runs which turned
   * terminal after the normal window. The sweep repeats on the next tick until it completes.
   */
  async function runScheduledPass(now: Date = new Date()): Promise<RunUsagePassResult & { sweep: boolean }> {
    const sweep = now.getTime() - lastSweepAt >= SWEEP_INTERVAL_MS;
    const result = await runPass({ now, lookbackMs: sweep ? RUN_USAGE_SWEEP_LOOKBACK_MS : RUN_USAGE_LOOKBACK_MS });
    if (sweep && !result.skipped && !result.truncated) lastSweepAt = now.getTime();
    return { ...result, sweep };
  }

  /**
   * Derives records for runs of any age with `source = backfill`. It takes no lock: the upsert is
   * idempotent, so running beside the worker only repeats work. Each batch commits on its own, so an
   * interrupted backfill resumes from the runs that still have no record.
   */
  async function backfill(options: RunUsageBackfillOptions = {}): Promise<RunUsagePassResult> {
    const now = options.now ?? new Date();
    let scanned = 0;
    let written = 0;
    for (const companyId of await listCompanyIds(db, options.companyId)) {
      const result = await runCompanyBatches(db, {
        companyId,
        now,
        createdSince: options.since ?? null,
        rederive: options.rederive ?? false,
        source: "backfill",
        maxBatches: Number.POSITIVE_INFINITY,
        onBatch: options.onBatch,
      });
      scanned += result.scanned;
      written += result.written;
    }
    return { skipped: false, scanned, written, truncated: false };
  }

  /** Collector health for one company: how much is derived, how much waits, and what was late. */
  async function health(companyId: string, now: Date = new Date()): Promise<ObservabilityHealth> {
    const settledBefore = new Date(now.getTime() - RUN_USAGE_SETTLE_MS).toISOString();
    const settled = and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.status, TERMINAL_STATUSES),
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) <= ${settledBefore}::timestamptz`,
    );
    const since24h = new Date(now.getTime() - DAY_MS);
    const lookbackStart = new Date(now.getTime() - RUN_USAGE_LOOKBACK_MS);
    const sweepStart = new Date(now.getTime() - RUN_USAGE_SWEEP_LOOKBACK_MS);

    const [recent] = await db
      .select({ terminal: count(), derived: count(runUsageRecords.runId) })
      .from(heartbeatRuns)
      .leftJoin(runUsageRecords, eq(runUsageRecords.runId, heartbeatRuns.id))
      .where(and(settled, gte(heartbeatRuns.createdAt, since24h)));
    const [pending] = await db
      .select({ pending: count(), oldest: min(heartbeatRuns.createdAt) })
      .from(heartbeatRuns)
      .leftJoin(runUsageRecords, eq(runUsageRecords.runId, heartbeatRuns.id))
      .where(and(settled, gte(heartbeatRuns.createdAt, lookbackStart), isNull(runUsageRecords.runId)));
    const [unreconciled] = await db
      .select({ value: count() })
      .from(heartbeatRuns)
      .leftJoin(runUsageRecords, eq(runUsageRecords.runId, heartbeatRuns.id))
      .where(
        and(settled, gte(heartbeatRuns.createdAt, sweepStart), lt(heartbeatRuns.createdAt, lookbackStart), isNull(runUsageRecords.runId)),
      );
    const [late] = await db
      .select({ value: count() })
      .from(runUsageRecords)
      .where(
        and(
          eq(runUsageRecords.companyId, companyId),
          eq(runUsageRecords.source, "derived"),
          gte(runUsageRecords.runCreatedAt, sweepStart),
          sql`${runUsageRecords.derivedAt} > ${runUsageRecords.runCreatedAt} + interval '48 hours'`,
        ),
      );
    const [latest] = await db
      .select({ value: max(runUsageRecords.derivedAt) })
      .from(runUsageRecords)
      .where(eq(runUsageRecords.companyId, companyId));

    return {
      schemaVersion: RUN_USAGE_RECORD_SCHEMA_VERSION,
      terminalRuns24h: recent?.terminal ?? 0,
      derivedRuns24h: recent?.derived ?? 0,
      pendingRuns: pending?.pending ?? 0,
      oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
      lateRecords30d: late?.value ?? 0,
      unreconciledRuns30d: unreconciled?.value ?? 0,
      lastDerivedAt: latest?.value ? new Date(latest.value).toISOString() : null,
    };
  }

  /**
   * The keyset read other tracks use (the session-warehouse export reads it): records of one
   * company ordered by `(finished_at, run_id)`, only for runs that finished more than the settle
   * delay ago, so a slower commit cannot land behind a cursor that already passed it.
   */
  async function listUsageRecordsAfter(input: ListRunUsageRecordsInput): Promise<RunUsageRecordPage> {
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(input.limit)));
    const settledBefore = new Date((input.now ?? new Date()).getTime() - RUN_USAGE_SETTLE_MS);
    const conditions: SQL[] = [
      eq(runUsageRecords.companyId, input.companyId),
      lte(runUsageRecords.finishedAt, settledBefore),
    ];
    if (input.cursor) {
      conditions.push(
        sql`(${runUsageRecords.finishedAt}, ${runUsageRecords.runId}) > (${input.cursor.finishedAt}::timestamptz, ${input.cursor.runId}::uuid)`,
      );
    }
    const records = await db
      .select()
      .from(runUsageRecords)
      .where(and(...conditions))
      .orderBy(asc(runUsageRecords.finishedAt), asc(runUsageRecords.runId))
      .limit(limit);
    const last = records[records.length - 1];
    return {
      records,
      next: last && records.length === limit ? { finishedAt: last.finishedAt.toISOString(), runId: last.runId } : null,
    };
  }

  return { runPass, runScheduledPass, backfill, health, listUsageRecordsAfter };
}

export type RunUsageRecordService = ReturnType<typeof runUsageRecordService>;
