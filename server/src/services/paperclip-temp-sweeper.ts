import { and, inArray, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  sweepPaperclipTempEntries,
  type PaperclipTempRunVerdict,
  type PaperclipTempSweepResult,
} from "@paperclipai/adapter-utils/paperclip-temp";
import { BUSY_LEASE_STATUSES, TERMINAL_RUN_STATUSES } from "./ssh-run-directory-reaper.js";

// The restart-safe backstop for per-run temp entries in the OS temp directory.
// Each creator removes its entry in `finally`, but a process that dies (a
// restart, a lost run) never reaches it. Each entry carries its run id, and
// the sweep removes it only when the database proves the run dead: terminal,
// with a known finish time more than the grace period ago, with no busy lease,
// and not executing in this process. That is the SSH run directory reaper's
// definition of a live run, plus the grace period. Anything it cannot prove
// stays.
//
// Threat model: another local user is in scope. Nothing another user creates
// or controls, and no race another user wins, may make the server delete
// anything outside a run's own temp tree. The server's own user and root are
// out of scope, since they can already delete everything the sweep reaches.
// The sweep therefore enters only directories no other user can change; see
// `sweepPaperclipTempEntries`.

export type PaperclipTempSweepTrigger = "startup" | "interval";

/** The structured log record of one sweep. `event` is stable for log queries. */
export interface PaperclipTempSweepLogRecord extends PaperclipTempSweepResult {
  event: "paperclip_tmp_sweep";
  trigger: PaperclipTempSweepTrigger;
  runGraceMs: number;
}

// One sweep at a time per database, also across server processes.
const SWEEP_LOCK_KEY = "paperclip:tmp-sweep";

/**
 * Reports each run's state for the temp sweep. A run id with no row is left
 * out, so the sweep keeps its entries as `run_missing`.
 *
 * @param db - The database or a transaction.
 * @param runIds - Heartbeat run ids parsed from entry names.
 * @param options.runGraceMs - How long after a run finished its entries stay.
 * @param options.now - The current time in milliseconds.
 * @param options.isRunExecuting - Whether this process executes the run now.
 * @returns A verdict per known run.
 */
export async function classifyPaperclipTempRuns(
  db: Pick<Db, "select">,
  runIds: string[],
  options: { runGraceMs: number; now: number; isRunExecuting: (runId: string) => boolean },
): Promise<Map<string, PaperclipTempRunVerdict>> {
  const verdicts = new Map<string, PaperclipTempRunVerdict>();
  if (runIds.length === 0) return verdicts;
  const runs = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.id, runIds));
  const busyRuns = new Set(
    (await db
      .select({ runId: environmentLeases.heartbeatRunId })
      .from(environmentLeases)
      .where(and(
        inArray(environmentLeases.heartbeatRunId, runIds),
        inArray(environmentLeases.status, [...BUSY_LEASE_STATUSES]),
      ))).map((lease) => lease.runId),
  );
  for (const run of runs) {
    if (options.isRunExecuting(run.id) || !TERMINAL_RUN_STATUSES.includes(run.status)) verdicts.set(run.id, "run_live");
    else if (busyRuns.has(run.id)) verdicts.set(run.id, "lease_busy");
    // Without a finish time the grace period cannot be proven.
    else if (!run.finishedAt) verdicts.set(run.id, "finish_unknown");
    else if (options.now - run.finishedAt.getTime() < options.runGraceMs) verdicts.set(run.id, "run_recent");
    else verdicts.set(run.id, "dead");
  }
  return verdicts;
}

/**
 * Builds one sweep pass. A pass takes a transaction-scoped advisory lock and
 * returns `null` when another process holds it. The pass's time budget covers
 * the whole sweep, so the lock is held for about that long at most.
 *
 * @param options.runGraceMs - How long after a run finished its entries stay; also the minimum entry age.
 * @param options.isRunExecuting - Whether this process executes the run now.
 * @returns The pass, which resolves to its log record.
 */
export function createPaperclipTempSweep(db: Db, options: {
  runGraceMs: number;
  isRunExecuting: (runId: string) => boolean;
  tmpDir?: string;
  now?: () => number;
  maxEntries?: number;
  scanBudget?: number;
  timeBudgetMs?: number;
}): (trigger: PaperclipTempSweepTrigger, signal?: AbortSignal) => Promise<PaperclipTempSweepLogRecord | null> {
  return (trigger, signal) => db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${SWEEP_LOCK_KEY})) as acquired`,
    );
    if (!lock?.acquired) return null;
    const now = options.now?.() ?? Date.now();
    const result = await sweepPaperclipTempEntries({
      classifyRuns: (runIds) => classifyPaperclipTempRuns(tx, runIds, {
        runGraceMs: options.runGraceMs,
        now,
        isRunExecuting: options.isRunExecuting,
      }),
      minAgeMs: options.runGraceMs,
      tmpDir: options.tmpDir,
      now,
      maxEntries: options.maxEntries,
      scanBudget: options.scanBudget,
      timeBudgetMs: options.timeBudgetMs,
      signal,
    });
    return { event: "paperclip_tmp_sweep", trigger, runGraceMs: options.runGraceMs, ...result };
  });
}

/**
 * Sweeps once now and then every `intervalMs`. A tick that lands while a sweep
 * still runs is skipped.
 *
 * @param options.sweep - One pass; `null` means another process swept.
 * @param options.intervalMs - The period; `0` sweeps on startup only.
 * @returns `startup`, which settles when the startup sweep has logged, and
 *   `stop`, which also aborts a running pass.
 */
export function startPaperclipTempSweeper(options: {
  sweep: (trigger: PaperclipTempSweepTrigger, signal: AbortSignal) => Promise<PaperclipTempSweepLogRecord | null>;
  intervalMs: number;
  log: (record: PaperclipTempSweepLogRecord) => void;
  onError: (error: unknown) => void;
}): { startup: Promise<void>; stop: () => void } {
  let running: Promise<void> | null = null;
  const stopping = new AbortController();
  const sweep = (trigger: PaperclipTempSweepTrigger): Promise<void> => {
    if (stopping.signal.aborted) return Promise.resolve();
    running ??= options.sweep(trigger, stopping.signal)
      .then((record) => {
        if (record) options.log(record);
      })
      .catch(options.onError)
      .finally(() => { running = null; });
    return running;
  };
  const startup = sweep("startup");
  const timer = options.intervalMs > 0 ? setInterval(() => void sweep("interval"), options.intervalMs) : null;
  timer?.unref();
  return {
    startup,
    stop: () => {
      if (timer) clearInterval(timer);
      stopping.abort();
    },
  };
}
