import { createReadStream, createWriteStream, existsSync, promises as fs, type WriteStream } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Command } from "commander";
import type { CompanyArchiveRecord } from "@paperclipai/shared";
import type { PaperclipApiClient } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ArchiveExportOptions extends BaseClientOptions {
  companyId?: string;
  since?: string;
  until?: string;
  include?: string;
  limit?: string;
  out?: string;
  resume?: boolean;
}

interface ResumePoint {
  cursor: string;
  /** Byte length of the file up to and including the last complete run. */
  length: number;
}

interface ExportHeader {
  companyId: string;
  include: string[];
  since: string | null;
  /** The `--until` the export was started with (not the server's cutoff). */
  until: string | null;
}

/**
 * Reads an earlier export: its header (to check the options match) and the
 * last `run.end` line, so a cut-off export continues after the last complete
 * run instead of starting over.
 */
async function findResumePoint(file: string): Promise<{ header: ExportHeader | null; point: ResumePoint | null }> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let offset = 0;
  let lineNumber = 0;
  let point: ResumePoint | null = null;
  let header: ExportHeader | null = null;
  for await (const line of lines) {
    offset += Buffer.byteLength(line, "utf8") + 1;
    lineNumber += 1;
    let record: CompanyArchiveRecord<{ cursor?: unknown; include?: string[]; since?: string | null; requestedUntil?: string | null }>;
    try {
      record = JSON.parse(line);
    } catch {
      // A torn last line is dropped by the truncation after the last run.
      continue;
    }
    if (lineNumber === 1 && record.kind === "export.header") {
      header = {
        companyId: record.companyId,
        include: record.data.include ?? [],
        since: record.data.since ?? null,
        until: record.data.requestedUntil ?? null,
      };
    }
    if (record.kind === "run.end" && typeof record.data.cursor === "string") {
      point = { cursor: record.data.cursor, length: offset };
    }
  }
  return { header, point };
}

/**
 * A resumed export keeps the original company, --include, --since and
 * --until, so one file never mixes two data sets. Omitted options are taken
 * from the file.
 */
function resumeOptions(header: ExportHeader | null, companyId: string | undefined, opts: ArchiveExportOptions): ArchiveExportOptions {
  if (!header) throw new Error("--resume: the existing file has no export.header line; start a new export.");
  const requested = opts.include
    ? [...new Set(opts.include.split(",").map((part) => part.trim()).filter(Boolean))].sort().join(",")
    : null;
  const original = [...header.include].sort().join(",");
  const since = opts.since ? new Date(opts.since).toISOString() : null;
  const until = opts.until ? new Date(opts.until).toISOString() : null;
  if (
    header.companyId !== companyId
    || (requested !== null && requested !== original)
    || (opts.since && since !== header.since)
    || (opts.until && until !== header.until)
  ) {
    throw new Error("--resume: the existing file was exported for another company or with other --include/--since/--until options.");
  }
  return { ...opts, include: header.include.join(","), since: header.since ?? undefined, until: header.until ?? undefined };
}

interface ExportOutput {
  write(line: string): Promise<void>;
  /** Flushes and closes a file; rejects with the first write error. */
  close(): Promise<void>;
  /** The first write error, if the output failed (disk full, permissions). */
  failure(): Error | null;
}

/**
 * stdout, or a file that is opened on the first write, so a request that
 * fails before any data arrives leaves an existing file untouched.
 */
function createOutput(file: string | undefined, append: boolean): ExportOutput {
  let stream: WriteStream | null = null;
  let failure: Error | null = null;
  const target = (): NodeJS.WritableStream => {
    if (!file) return process.stdout;
    if (!stream) {
      stream = createWriteStream(file, { flags: append ? "a" : "w" });
      stream.on("error", (error) => {
        failure ??= error;
      });
    }
    return stream;
  };
  return {
    async write(line) {
      if (failure) throw failure;
      const out = target();
      if (!out.write(`${line}\n`)) await once(out, "drain");
    },
    async close() {
      const opened = stream;
      if (opened && !opened.destroyed) {
        await new Promise<void>((resolve) => {
          opened.end(() => resolve());
        });
      }
      if (failure) throw failure;
    },
    failure: () => failure,
  };
}

type ExportRecord = CompanyArchiveRecord<{ next?: string | null }>;

/**
 * Follows `export.end.next` until the window is exhausted. Writes one header,
 * every run's records and one final `export.end`; intermediate page headers
 * and ends are dropped.
 */
async function streamExport(
  api: PaperclipApiClient,
  companyId: string | undefined,
  opts: ArchiveExportOptions,
  out: ExportOutput,
  startCursor: string | null,
): Promise<void> {
  let cursor = startCursor;
  let wroteHeader = startCursor !== null;
  for (;;) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (opts.since) params.set("since", opts.since);
    if (opts.until) params.set("until", opts.until);
    if (opts.include) params.set("include", opts.include);
    if (opts.limit) params.set("limit", opts.limit);
    const query = params.toString();
    const body = await api.getStream(`${apiPath`/api/companies/${companyId}/archive/export`}${query ? `?${query}` : ""}`);
    const lines = createInterface({
      input: Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
      crlfDelay: Infinity,
    });
    const cutOff = (cause?: unknown) => new Error(
      opts.out
        ? "Export was cut off. Run the same command with --resume to continue."
        : "Export was cut off. Use --out and --resume to continue an interrupted export.",
      cause === undefined ? undefined : { cause },
    );
    let end: ExportRecord | null = null;
    try {
      for await (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line) as ExportRecord;
        if (record.kind === "export.header") {
          if (wroteHeader) continue;
          wroteHeader = true;
        }
        if (record.kind === "export.end") {
          end = record;
          continue;
        }
        await out.write(line);
      }
    } catch (error) {
      // An output error is reported as itself; anything else is a reset
      // connection ("terminated") or a torn last line from the server.
      const outputError = out.failure();
      if (outputError) throw outputError;
      throw cutOff(error);
    }
    if (!end) throw cutOff();
    if (!end.data.next) {
      await out.write(JSON.stringify(end));
      return;
    }
    cursor = end.data.next;
  }
}

export function registerArchiveCommands(program: Command): void {
  const archive = program.command("archive").description("Company run archive and export");

  addCommonClientOptions(
    archive
      .command("export")
      .description("Stream a company's settled run history as NDJSON (board only)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--since <iso>", "Only runs settled at or after this time")
      .option("--until <iso>", "Only runs settled at or before this time")
      .option("--include <list>", "Comma list of run, events, transcript, costs, activity (default all)")
      .option("--limit <n>", "Runs per request (1-500)")
      .option("-o, --out <file>", "Write to a file instead of stdout")
      .option("--resume", "Continue an interrupted export from the last complete run in --out")
      .action(async (opts: ArchiveExportOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.resume && !opts.out) throw new Error("--resume needs --out");

          let cursor: string | null = null;
          let exportOptions = opts;
          let append = false;
          if (opts.out && opts.resume && existsSync(opts.out)) {
            const found = await findResumePoint(opts.out);
            // An empty or record-less file (a run that failed before any data)
            // is a fresh start, not an error.
            if (found.header || found.point) {
              exportOptions = resumeOptions(found.header, ctx.companyId, opts);
            }
            if (found.point) {
              // Never extend the file: a last line without "\n" is one byte short.
              const size = (await fs.stat(opts.out)).size;
              await fs.truncate(opts.out, Math.min(found.point.length, size));
              cursor = found.point.cursor;
              append = true;
            }
          }
          const out = createOutput(opts.out, append);
          let failure: unknown = null;
          try {
            await streamExport(ctx.api, ctx.companyId, exportOptions, out, cursor);
          } catch (error) {
            failure = error;
          }
          // Flush what was written, also on failure, so --resume sees it. The
          // export error, when there is one, is the one to report.
          await out.close().catch((error: unknown) => {
            failure ??= error;
          });
          if (failure) throw failure;
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
