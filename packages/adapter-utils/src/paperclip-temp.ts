import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-run temp entries that Paperclip creates directly in `os.tmpdir()`, and
 * the sweep that removes the ones a dead run left behind.
 *
 * A creator's `finally` cannot run when its process dies (a restart, a lost
 * run, a killed worker). Each entry therefore carries the id of the run that
 * made it: `<prefix><runId>-<random>`. The sweep removes an entry only when
 * the caller proves that run is dead. An entry without a run id is never
 * removed.
 */

/**
 * The prefixes {@link createPaperclipTempDir} accepts and the sweep may
 * remove. Each is one path segment. Key material comes first, so the sweep
 * removes it before anything else.
 */
export const SWEPT_PAPERCLIP_TEMP_PREFIXES = [
  "paperclip-ssh-key-",
  "paperclip-ssh-known-hosts-",
  "paperclip-ssh-sync-back-",
  "paperclip-ssh-bundle-",
  "paperclip-workspace-baseline-",
  "paperclip-codex-home-sync-",
  "paperclip-bridge-asset-",
  "paperclip-workspace-manifest-",
  "paperclip-git-workspace-",
  "paperclip-sandbox-sync-",
  "paperclip-sandbox-restore-",
  "paperclip-tar-list-",
  "paperclip-syncin-fallback-",
] as const;

export type PaperclipTempPrefix = (typeof SWEPT_PAPERCLIP_TEMP_PREFIXES)[number];

const KEY_PREFIXES: readonly string[] = ["paperclip-ssh-key-", "paperclip-ssh-known-hosts-"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// `mkdtemp` appends six characters from this set.
const ATTRIBUTED_SUFFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[A-Za-z0-9]{6}$/;

/** The default number of entries one sweep may remove. */
export const DEFAULT_PAPERCLIP_TEMP_SWEEP_MAX_ENTRIES = 200;
/** The default time one sweep may take, in milliseconds. */
export const DEFAULT_PAPERCLIP_TEMP_SWEEP_TIME_BUDGET_MS = 30_000;

/** Why the sweep kept an entry. */
export type PaperclipTempKeptReason =
  | "unattributed"
  | "held"
  | "symlink"
  | "not_directory"
  | "other_owner"
  | "mount_point"
  | "recent"
  | "run_missing"
  | "run_live"
  | "lease_busy"
  | "run_recent"
  | "db_error"
  | "changed"
  | "rm_failed";

/** What the caller knows about a run. Only `dead` lets the sweep remove its entries. */
export type PaperclipTempRunVerdict = "dead" | "run_missing" | "run_live" | "lease_busy" | "run_recent";

/** The counts one sweep reports. `freedBytes` is the size of the files it removed. */
export interface PaperclipTempSweepResult {
  removed: number;
  freedBytes: number;
  kept: Partial<Record<PaperclipTempKeptReason, number>>;
  /** Entries left for the next sweep by the entry cap or the time budget. */
  deferred: number;
  /** The first removal failure, as `<entry name>: <error code>`. */
  firstFailure?: string;
}

// Kept on globalThis so two loaded copies of this module share one registry
// and one run context.
const HELD_ENTRIES_KEY = Symbol.for("paperclip.heldTempEntries");
const RUN_CONTEXT_KEY = Symbol.for("paperclip.tempRunContext");

function heldEntries(): Set<string> {
  const existing: unknown = Reflect.get(globalThis, HELD_ENTRIES_KEY);
  if (existing instanceof Set) return existing;
  const created = new Set<string>();
  Reflect.set(globalThis, HELD_ENTRIES_KEY, created);
  return created;
}

function runContext(): AsyncLocalStorage<string> {
  const existing: unknown = Reflect.get(globalThis, RUN_CONTEXT_KEY);
  if (existing instanceof AsyncLocalStorage) return existing;
  const created = new AsyncLocalStorage<string>();
  Reflect.set(globalThis, RUN_CONTEXT_KEY, created);
  return created;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Runs `fn` as part of a run, so the temp entries it creates carry the run id.
 * An id that is not a UUID gives no attribution: those entries are never swept.
 *
 * @param runId - The heartbeat run id.
 * @param fn - The run's work.
 * @returns What `fn` returns.
 */
export function runWithPaperclipTempRun<T>(runId: string | null | undefined, fn: () => T): T {
  const normalized = typeof runId === "string" ? runId.toLowerCase() : "";
  return runContext().run(UUID_PATTERN.test(normalized) ? normalized : "", fn);
}

/**
 * Creates a `0700` directory in `os.tmpdir()` and holds it until
 * {@link removePaperclipTempDir} removes it. Inside a run it is named
 * `<prefix><runId>-<random>`.
 *
 * @param prefix - One of {@link SWEPT_PAPERCLIP_TEMP_PREFIXES}.
 * @returns The absolute directory path.
 * @throws When `prefix` is not an allowlisted prefix.
 */
export async function createPaperclipTempDir(prefix: PaperclipTempPrefix): Promise<string> {
  if (!(SWEPT_PAPERCLIP_TEMP_PREFIXES as readonly string[]).includes(prefix)) {
    throw new Error(`Unknown Paperclip temp prefix: ${JSON.stringify(prefix)}`);
  }
  const runId = runContext().getStore() ?? "";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), UUID_PATTERN.test(runId) ? `${prefix}${runId}-` : prefix));
  heldEntries().add(dir);
  return dir;
}

/**
 * Removes a directory from {@link createPaperclipTempDir} and stops holding
 * it, even when the removal fails.
 *
 * @param dir - The path {@link createPaperclipTempDir} returned.
 * @throws When the removal fails or meets a mount point.
 */
export async function removePaperclipTempDir(dir: string): Promise<void> {
  try {
    const stats = await fs.lstat(dir).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (!stats) return;
    const outcome = await removeConfined(dir, stats.dev, Number.POSITIVE_INFINITY, { bytes: 0 });
    if (outcome !== "removed") throw new Error(`Kept Paperclip temp directory ${dir}: ${outcome}`);
  } finally {
    heldEntries().delete(dir);
  }
}

/** Whether this process holds `entry`. */
export function isPaperclipTempEntryHeld(entry: string): boolean {
  return heldEntries().has(entry);
}

type RemoveOutcome = "removed" | "mount_point" | "budget";

// Removes a tree without following a link or crossing into another device.
// A read-only directory (for example a Go module cache that tar extracted) is
// made writable first, because a non-root process cannot remove its files.
async function removeConfined(entry: string, rootDev: number, deadline: number, freed: { bytes: number }): Promise<RemoveOutcome> {
  const stats = await fs.lstat(entry).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!stats) return "removed";
  if (stats.dev !== rootDev) return "mount_point";
  if (!stats.isDirectory()) {
    await fs.unlink(entry);
    freed.bytes += stats.size;
    return "removed";
  }
  if ((stats.mode & 0o700) !== 0o700) await fs.chmod(entry, (stats.mode & 0o7777) | 0o700);
  for (const child of await fs.readdir(entry)) {
    if (Date.now() > deadline) return "budget";
    const outcome = await removeConfined(path.join(entry, child), rootDev, deadline, freed);
    if (outcome !== "removed") return outcome;
  }
  await fs.rmdir(entry);
  return "removed";
}

function parseEntryName(name: string): { prefix: string; runId: string | null } | null {
  const prefix = SWEPT_PAPERCLIP_TEMP_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return null;
  return { prefix, runId: ATTRIBUTED_SUFFIX.exec(name.slice(prefix.length))?.[1] ?? null };
}

/**
 * Removes the swept-prefix directories in `tmpDir` whose run `classifyRuns`
 * reports as `dead`. It works only on direct children of the real `tmpDir`,
 * keeps symlinks, files, entries another user owns, mount points, entries this
 * process holds, entries changed within `minAgeMs`, and anything it cannot
 * attribute or classify. It removes at most `maxEntries`, oldest first (key
 * material before the rest), within `timeBudgetMs`.
 *
 * @param options.classifyRuns - Reports each run id's state. A missing id counts as `run_missing`; a throw keeps every entry as `db_error`.
 * @param options.minAgeMs - The entry's change time must be at least this old.
 * @param options.tmpDir - The directory to sweep; `os.tmpdir()` by default.
 * @param options.now - The current time for the age check; `Date.now()` by default.
 * @param options.maxEntries - Defaults to {@link DEFAULT_PAPERCLIP_TEMP_SWEEP_MAX_ENTRIES}.
 * @param options.timeBudgetMs - Defaults to {@link DEFAULT_PAPERCLIP_TEMP_SWEEP_TIME_BUDGET_MS}.
 * @returns The counts, the kept reasons and the bytes freed.
 */
export async function sweepPaperclipTempEntries(options: {
  classifyRuns: (runIds: string[]) => Promise<ReadonlyMap<string, PaperclipTempRunVerdict>>;
  minAgeMs: number;
  tmpDir?: string;
  now?: number;
  maxEntries?: number;
  timeBudgetMs?: number;
}): Promise<PaperclipTempSweepResult> {
  const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_PAPERCLIP_TEMP_SWEEP_TIME_BUDGET_MS);
  const now = options.now ?? Date.now();
  const maxEntries = options.maxEntries ?? DEFAULT_PAPERCLIP_TEMP_SWEEP_MAX_ENTRIES;
  const uid = process.getuid?.();
  const result: PaperclipTempSweepResult = { removed: 0, freedBytes: 0, kept: {}, deferred: 0 };
  const keep = (reason: PaperclipTempKeptReason) => {
    result.kept[reason] = (result.kept[reason] ?? 0) + 1;
  };

  // Resolve the root once. Every path below is a direct child of it, so a
  // TMPDIR link that changes during the sweep cannot redirect a removal.
  const root = await fs.realpath(options.tmpDir ?? os.tmpdir());
  const rootDev = (await fs.lstat(root)).dev;

  const eligible: Array<{ name: string; entry: string; runId: string; rank: number; dev: number; ino: number; ctimeMs: number }> = [];
  for (const name of await fs.readdir(root)) {
    const parsed = parseEntryName(name);
    if (!parsed) continue;
    if (!parsed.runId) {
      keep("unattributed");
      continue;
    }
    const entry = path.join(root, name);
    if (isPaperclipTempEntryHeld(entry)) {
      keep("held");
      continue;
    }
    if (Date.now() > deadline) {
      result.deferred += 1;
      continue;
    }
    const stats = await fs.lstat(entry).catch(() => null);
    if (!stats) continue;
    if (stats.isSymbolicLink()) keep("symlink");
    else if (!stats.isDirectory()) keep("not_directory");
    else if (uid !== undefined && stats.uid !== uid) keep("other_owner");
    else if (stats.dev !== rootDev) keep("mount_point");
    else if (now - stats.ctimeMs < options.minAgeMs) keep("recent");
    else {
      eligible.push({
        name,
        entry,
        runId: parsed.runId,
        rank: KEY_PREFIXES.includes(parsed.prefix) ? 0 : 1,
        dev: stats.dev,
        ino: stats.ino,
        ctimeMs: stats.ctimeMs,
      });
    }
  }
  eligible.sort((left, right) => left.rank - right.rank || left.ctimeMs - right.ctimeMs);
  const batch = eligible.slice(0, Math.max(0, maxEntries));
  result.deferred += eligible.length - batch.length;

  let verdicts: ReadonlyMap<string, PaperclipTempRunVerdict> | null = null;
  if (batch.length > 0) {
    verdicts = await options.classifyRuns([...new Set(batch.map((candidate) => candidate.runId))]).catch(() => null);
  }
  for (const candidate of batch) {
    if (!verdicts) {
      keep("db_error");
      continue;
    }
    const verdict = verdicts.get(candidate.runId) ?? "run_missing";
    if (verdict !== "dead") {
      keep(verdict);
      continue;
    }
    if (Date.now() > deadline) {
      result.deferred += 1;
      continue;
    }
    if (isPaperclipTempEntryHeld(candidate.entry)) {
      keep("held");
      continue;
    }
    // The entry must still be the directory that was classified.
    const current = await fs.lstat(candidate.entry).catch(() => null);
    if (!current || !current.isDirectory() || current.dev !== candidate.dev || current.ino !== candidate.ino) {
      keep("changed");
      continue;
    }
    const freed = { bytes: 0 };
    try {
      const outcome = await removeConfined(candidate.entry, rootDev, deadline, freed);
      if (outcome === "removed") result.removed += 1;
      else if (outcome === "budget") result.deferred += 1;
      else keep(outcome);
    } catch (error) {
      keep("rm_failed");
      result.firstFailure ??= `${candidate.name}: ${errorCode(error) ?? "unknown"}`;
    }
    result.freedBytes += freed.bytes;
  }
  return result;
}
