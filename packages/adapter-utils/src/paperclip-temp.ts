import { AsyncLocalStorage } from "node:async_hooks";
import { promises as nodeFs, type Dir, type Stats } from "node:fs";
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
 *
 * Threat model. Another local user is in scope: nothing another user creates
 * or controls, and no race another user wins, may make this process delete
 * anything outside a run's own temp tree. This process's own user and root are
 * out of scope: they can already delete everything the sweep can reach. So the
 * removal is not free of races; instead it enters only directories that no
 * other user can change (owned by this user, not writable by group or others,
 * under a root that is safe the same way or sticky).
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
const GROUP_OTHER_WRITE = 0o022;
const STICKY = 0o1000;

/** The default number of entries one sweep may remove. */
export const DEFAULT_PAPERCLIP_TEMP_SWEEP_MAX_ENTRIES = 200;
/** The default number of swept-prefix names one sweep may examine. */
export const DEFAULT_PAPERCLIP_TEMP_SWEEP_SCAN_BUDGET = 5_000;
/** The default time one whole sweep may take, in milliseconds. */
export const DEFAULT_PAPERCLIP_TEMP_SWEEP_TIME_BUDGET_MS = 30_000;
// How many entries one `classifyRuns` call covers.
const CLASSIFY_BATCH = 100;
// How many children of one directory are removed at once.
const REMOVE_CONCURRENCY = 16;

/** Why the sweep kept an entry. */
export type PaperclipTempKeptReason =
  | "unattributed"
  | "held"
  | "symlink"
  | "not_directory"
  | "foreign_owner"
  | "unsafe_mode"
  | "mount_point"
  | "recent"
  | "run_missing"
  | "run_live"
  | "lease_busy"
  | "run_recent"
  | "finish_unknown"
  | "db_error"
  | "changed"
  | "rm_failed";

/** What the caller knows about a run. Only `dead` lets the sweep remove its entries. */
export type PaperclipTempRunVerdict = "dead" | "run_missing" | "run_live" | "lease_busy" | "run_recent" | "finish_unknown";

/** Why a sweep did less than all of its work. */
export type PaperclipTempSweepStop =
  | "root_unsafe"
  | "root_changed"
  | "scan_budget_exhausted"
  | "time_budget_exhausted"
  | "aborted";

/** The counts one sweep reports. `freedBytes` is the size of the files it removed. */
export interface PaperclipTempSweepResult {
  removed: number;
  freedBytes: number;
  kept: Partial<Record<PaperclipTempKeptReason, number>>;
  /** Entries left for the next sweep by the entry cap, a budget or an abort. */
  deferred: number;
  /** Why the sweep stopped early; empty when it did all its work. */
  stops: PaperclipTempSweepStop[];
  /** The first failure, as `<entry name>: <error code>` or `classifyRuns: <error code>`. */
  firstFailure?: string;
}

/**
 * The file operations the sweep and the removal use. Production uses
 * `node:fs`; a test passes a wrapper to simulate a race, a mount or another
 * owner.
 */
export interface PaperclipTempFs {
  lstat(entry: string): Promise<Stats>;
  realpath(entry: string): Promise<string>;
  opendir(entry: string): Promise<Dir>;
  chmod(entry: string, mode: number): Promise<void>;
  unlink(entry: string): Promise<void>;
  rmdir(entry: string): Promise<void>;
}

const defaultFs: PaperclipTempFs = {
  lstat: (entry) => nodeFs.lstat(entry),
  realpath: (entry) => nodeFs.realpath(entry),
  opendir: (entry) => nodeFs.opendir(entry),
  chmod: (entry, mode) => nodeFs.chmod(entry, mode),
  unlink: (entry) => nodeFs.unlink(entry),
  rmdir: (entry) => nodeFs.rmdir(entry),
};

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

function ignoreMissing(error: unknown): null {
  if (errorCode(error) === "ENOENT") return null;
  throw error;
}

function sameNode(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  const dir = await nodeFs.mkdtemp(path.join(os.tmpdir(), UUID_PATTERN.test(runId) ? `${prefix}${runId}-` : prefix));
  heldEntries().add(dir);
  return dir;
}

/**
 * Removes a directory from {@link createPaperclipTempDir} and stops holding
 * it, even when the removal fails. A directory inside it that group or others
 * may write is made private before it is entered.
 *
 * @param dir - The path {@link createPaperclipTempDir} returned.
 * @throws When the removal fails or meets a mount point, another user's directory or a swapped directory.
 */
export async function removePaperclipTempDir(dir: string): Promise<void> {
  try {
    const stats = await defaultFs.lstat(dir).catch(ignoreMissing);
    if (!stats) return;
    const outcome = await removeConfined(dir, {
      fs: defaultFs,
      rootDev: stats.dev,
      uid: process.getuid?.(),
      tightenModes: true,
      isOutOfBudget: () => null,
      freed: { bytes: 0 },
    });
    if (outcome !== "removed") throw new Error(`Kept Paperclip temp directory ${dir}: ${outcome}`);
  } finally {
    heldEntries().delete(dir);
  }
}

/** Whether this process holds `entry`. */
export function isPaperclipTempEntryHeld(entry: string): boolean {
  return heldEntries().has(entry);
}

type RemoveOutcome = "removed" | "mount_point" | "foreign_owner" | "unsafe_mode" | "changed" | "time_budget" | "aborted";

interface RemoveContext {
  fs: PaperclipTempFs;
  rootDev: number;
  uid: number | undefined;
  // The owner of a live entry makes its own group- or other-writable
  // directories private; the sweep keeps such a tree instead.
  tightenModes: boolean;
  isOutOfBudget: () => "time_budget" | "aborted" | null;
  freed: { bytes: number };
}

// Removes a tree without following a link. It enters only directories on the
// root's device that this process's user owns and that no other user can
// write, so no other user can swap what it walks. Only a directory can be a
// mount point, so only directories are compared with the root's device (on
// overlayfs a file can report its lower layer's device). A read-only directory
// (for example a Go module cache that tar extracted) is made writable first,
// because a non-root process cannot remove its files. A node that is already
// gone counts as removed. It checks the budget before each node and leaves the
// rest of the tree for a later pass when the budget runs out.
async function removeConfined(entry: string, context: RemoveContext): Promise<RemoveOutcome> {
  const outOfBudget = context.isOutOfBudget();
  if (outOfBudget) return outOfBudget;
  const stats = await context.fs.lstat(entry).catch(ignoreMissing);
  if (!stats) return "removed";
  if (!stats.isDirectory()) {
    if (await context.fs.unlink(entry).then(() => true, (error: unknown) => ignoreMissing(error) ?? false)) {
      context.freed.bytes += stats.size;
    }
    return "removed";
  }
  if (stats.dev !== context.rootDev) return "mount_point";
  if (context.uid !== undefined && stats.uid !== context.uid) return "foreign_owner";
  const othersMayWrite = (stats.mode & GROUP_OTHER_WRITE) !== 0;
  if (othersMayWrite && !context.tightenModes) return "unsafe_mode";
  if (othersMayWrite || (stats.mode & 0o700) !== 0o700) {
    // Only this user can change the directory's mode, and its parent was
    // checked the same way, so the new mode applies to the checked directory.
    await context.fs.chmod(entry, (stats.mode & 0o7777 & ~GROUP_OTHER_WRITE) | 0o700).catch(ignoreMissing);
    const current = await context.fs.lstat(entry).catch(ignoreMissing);
    if (!current) return "removed";
    if (!current.isDirectory() || !sameNode(current, stats)) return "changed";
    if ((current.mode & GROUP_OTHER_WRITE) !== 0) return "unsafe_mode";
  }
  // Removing entries while listing can make a listing skip one, so list again
  // when the directory is still not empty.
  for (let listing = 0; listing < 3; listing += 1) {
    const dir = await context.fs.opendir(entry).catch(ignoreMissing);
    if (!dir) return "removed";
    const outcome = await removeChildren(entry, stats, dir, context);
    if (outcome !== "removed") return outcome;
    const after = await context.fs.lstat(entry).catch(ignoreMissing);
    if (!after) return "removed";
    if (!sameNode(after, stats)) return "changed";
    try {
      await context.fs.rmdir(entry);
      return "removed";
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return "removed";
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
  throw Object.assign(new Error(`Directory is still not empty: ${entry}`), { code: "ENOTEMPTY" });
}

// Streams the entries of an open directory and removes them a few at a time.
async function removeChildren(entry: string, stats: Stats, dir: Dir, context: RemoveContext): Promise<RemoveOutcome> {
  try {
    // The listing must come from the directory that was checked.
    const opened = await context.fs.lstat(entry).catch(ignoreMissing);
    if (!opened) return "removed";
    if (!sameNode(opened, stats)) return "changed";
    let batch: string[] = [];
    const removeBatch = async (): Promise<RemoveOutcome> => {
      const outcomes = await Promise.all(batch.map((name) => removeConfined(path.join(entry, name), context)));
      batch = [];
      return outcomes.find((outcome) => outcome !== "removed") ?? "removed";
    };
    for await (const child of dir) {
      batch.push(child.name);
      if (batch.length < REMOVE_CONCURRENCY) continue;
      const outcome = await removeBatch();
      if (outcome !== "removed") return outcome;
    }
    return await removeBatch();
  } finally {
    // Iteration closes the directory when it ends; this covers an early return.
    await dir.close().catch(() => undefined);
  }
}

// The root and each directory above it must belong to root or to this user,
// and no other user may write it unless it is sticky (like /tmp), where no
// other user can rename or remove this user's entries.
async function isSafeRoot(fsOps: PaperclipTempFs, root: string, uid: number): Promise<boolean> {
  for (let current = root; ; current = path.dirname(current)) {
    const stats = await fsOps.lstat(current);
    if (!stats.isDirectory()) return false;
    if (stats.uid !== 0 && stats.uid !== uid) return false;
    if ((stats.mode & GROUP_OTHER_WRITE) !== 0 && (stats.mode & STICKY) === 0) return false;
    if (path.dirname(current) === current) return true;
  }
}

function parseEntryName(name: string): { prefix: string; runId: string | null } | null {
  const prefix = SWEPT_PAPERCLIP_TEMP_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return null;
  return { prefix, runId: ATTRIBUTED_SUFFIX.exec(name.slice(prefix.length))?.[1] ?? null };
}

/**
 * Removes the swept-prefix directories in `tmpDir` whose run `classifyRuns`
 * reports as `dead`, under the threat model at the top of this module.
 *
 * - The real `tmpDir` and every directory above it must belong to root or to
 *   this user and must not be writable by others unless sticky; otherwise the
 *   sweep does nothing (`root_unsafe`). The root is checked again before each
 *   removal (`root_changed` stops the sweep).
 * - It works only on direct children of the real root. It keeps symlinks,
 *   files, entries without a run id, entries another user owns, mount points,
 *   entries this process holds, entries changed within `minAgeMs`, and anything
 *   it cannot classify.
 * - A removal enters only directories this user owns that no other user can
 *   write, on the root's device; otherwise it keeps the rest of the tree
 *   (`foreign_owner`, `unsafe_mode`, `mount_point`).
 * - It reads the root as a stream and examines at most `scanBudget`
 *   swept-prefix names, classifies in batches until `maxEntries` dead entries
 *   are found (key material first, then the oldest), and stops the whole sweep
 *   at `timeBudgetMs` or when `signal` aborts. A tree it could not finish is
 *   left for a later sweep.
 *
 * @param options.classifyRuns - Reports each run id's state. A missing id counts as `run_missing`; a throw keeps the rest as `db_error`.
 * @param options.minAgeMs - The entry's change time must be at least this old.
 * @param options.tmpDir - The directory to sweep; `os.tmpdir()` by default.
 * @param options.now - The current time for the age check; `Date.now()` by default.
 * @param options.maxEntries - Defaults to {@link DEFAULT_PAPERCLIP_TEMP_SWEEP_MAX_ENTRIES}.
 * @param options.scanBudget - Defaults to {@link DEFAULT_PAPERCLIP_TEMP_SWEEP_SCAN_BUDGET}.
 * @param options.timeBudgetMs - Defaults to {@link DEFAULT_PAPERCLIP_TEMP_SWEEP_TIME_BUDGET_MS}.
 * @param options.signal - Stops the sweep, for example at server shutdown.
 * @param options.clock - The clock for the time budget; `Date.now` by default.
 * @param options.fs - The file operations; `node:fs` by default.
 * @returns The counts, the kept reasons, the stops and the bytes freed.
 */
export async function sweepPaperclipTempEntries(options: {
  classifyRuns: (runIds: string[]) => Promise<ReadonlyMap<string, PaperclipTempRunVerdict>>;
  minAgeMs: number;
  tmpDir?: string;
  now?: number;
  maxEntries?: number;
  scanBudget?: number;
  timeBudgetMs?: number;
  signal?: AbortSignal;
  clock?: () => number;
  fs?: PaperclipTempFs;
}): Promise<PaperclipTempSweepResult> {
  const fsOps = options.fs ?? defaultFs;
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.timeBudgetMs ?? DEFAULT_PAPERCLIP_TEMP_SWEEP_TIME_BUDGET_MS);
  const now = options.now ?? Date.now();
  const maxEntries = options.maxEntries ?? DEFAULT_PAPERCLIP_TEMP_SWEEP_MAX_ENTRIES;
  const scanBudget = options.scanBudget ?? DEFAULT_PAPERCLIP_TEMP_SWEEP_SCAN_BUDGET;
  const uid = process.getuid?.();
  const result: PaperclipTempSweepResult = { removed: 0, freedBytes: 0, kept: {}, deferred: 0, stops: [] };
  const keep = (reason: PaperclipTempKeptReason) => {
    result.kept[reason] = (result.kept[reason] ?? 0) + 1;
  };
  const stop = (reason: PaperclipTempSweepStop) => {
    if (!result.stops.includes(reason)) result.stops.push(reason);
  };
  const isOutOfBudget = (): "time_budget" | "aborted" | null =>
    options.signal?.aborted ? "aborted" : clock() > deadline ? "time_budget" : null;
  const stopForBudget = (reason: "time_budget" | "aborted") => stop(reason === "aborted" ? "aborted" : "time_budget_exhausted");

  // Resolve the root once. Every path below is a direct child of it, so a
  // TMPDIR link that changes during the sweep cannot redirect a removal.
  const listedDir = options.tmpDir ?? os.tmpdir();
  const root = await fsOps.realpath(listedDir);
  if (uid === undefined || !(await isSafeRoot(fsOps, root, uid))) {
    stop("root_unsafe");
    return result;
  }
  const rootStats = await fsOps.lstat(root);
  // A creator registers the path under `os.tmpdir()`, which may be a link to the root.
  const isHeld = (name: string) =>
    isPaperclipTempEntryHeld(path.join(root, name)) || isPaperclipTempEntryHeld(path.join(listedDir, name));

  const eligible: Array<{ name: string; entry: string; runId: string; rank: number; dev: number; ino: number; ctimeMs: number }> = [];
  let scanned = 0;
  const listing = await fsOps.opendir(root);
  try {
    const opened = await fsOps.lstat(root);
    if (!sameNode(opened, rootStats)) {
      stop("root_changed");
      return result;
    }
    for await (const dirent of listing) {
      const outOfBudget = isOutOfBudget();
      if (outOfBudget) {
        stopForBudget(outOfBudget);
        break;
      }
      const parsed = parseEntryName(dirent.name);
      if (!parsed) continue;
      if (scanned >= scanBudget) {
        stop("scan_budget_exhausted");
        break;
      }
      scanned += 1;
      if (!parsed.runId) {
        keep("unattributed");
        continue;
      }
      if (isHeld(dirent.name)) {
        keep("held");
        continue;
      }
      const entry = path.join(root, dirent.name);
      const stats = await fsOps.lstat(entry).catch(() => null);
      if (!stats) continue;
      if (stats.isSymbolicLink()) keep("symlink");
      else if (!stats.isDirectory()) keep("not_directory");
      else if (stats.uid !== uid) keep("foreign_owner");
      else if (stats.dev !== rootStats.dev) keep("mount_point");
      else if (now - stats.ctimeMs < options.minAgeMs) keep("recent");
      else {
        eligible.push({
          name: dirent.name,
          entry,
          runId: parsed.runId,
          rank: KEY_PREFIXES.includes(parsed.prefix) ? 0 : 1,
          dev: stats.dev,
          ino: stats.ino,
          ctimeMs: stats.ctimeMs,
        });
      }
    }
  } finally {
    await listing.close().catch(() => undefined);
  }
  eligible.sort((left, right) => left.rank - right.rank || left.ctimeMs - right.ctimeMs);

  // Classify in batches until enough dead entries are found. Entries that are
  // kept do not count against the cap, so they cannot fill every sweep.
  const verdicts = new Map<string, PaperclipTempRunVerdict>();
  const dead: typeof eligible = [];
  let classified = 0;
  let classifyFailed = false;
  while (classified < eligible.length && dead.length < maxEntries) {
    const outOfBudget = isOutOfBudget();
    if (outOfBudget) {
      stopForBudget(outOfBudget);
      break;
    }
    const batch = eligible.slice(classified, classified + CLASSIFY_BATCH);
    const unknownRunIds = [...new Set(batch.map((candidate) => candidate.runId).filter((runId) => !verdicts.has(runId)))];
    try {
      if (unknownRunIds.length > 0) {
        for (const [runId, verdict] of await options.classifyRuns(unknownRunIds)) verdicts.set(runId, verdict);
      }
    } catch (error) {
      classifyFailed = true;
      result.firstFailure = `classifyRuns: ${errorCode(error) ?? (error instanceof Error ? error.name : "unknown")}`;
      break;
    }
    for (const candidate of batch) {
      classified += 1;
      const verdict = verdicts.get(candidate.runId) ?? "run_missing";
      if (verdict !== "dead") keep(verdict);
      else if (dead.length < maxEntries) dead.push(candidate);
      else result.deferred += 1;
    }
  }
  for (let index = classified; index < eligible.length; index += 1) {
    if (classifyFailed) keep("db_error");
    else result.deferred += 1;
  }

  for (const [position, candidate] of dead.entries()) {
    const outOfBudget = isOutOfBudget();
    if (outOfBudget) {
      stopForBudget(outOfBudget);
      result.deferred += dead.length - position;
      break;
    }
    // The root must still be the directory that was checked.
    const currentRoot = await fsOps.lstat(root).catch(() => null);
    if (!currentRoot || !sameNode(currentRoot, rootStats)) {
      stop("root_changed");
      result.deferred += dead.length - position;
      break;
    }
    if (isHeld(candidate.name)) {
      keep("held");
      continue;
    }
    // The entry must still be the directory that was classified.
    const current = await fsOps.lstat(candidate.entry).catch(() => null);
    if (!current || !current.isDirectory() || !sameNode(current, candidate)) {
      keep("changed");
      continue;
    }
    const freed = { bytes: 0 };
    try {
      const outcome = await removeConfined(candidate.entry, {
        fs: fsOps,
        rootDev: rootStats.dev,
        uid,
        tightenModes: false,
        isOutOfBudget,
        freed,
      });
      if (outcome === "removed") result.removed += 1;
      else if (outcome === "time_budget" || outcome === "aborted") {
        stopForBudget(outcome);
        result.deferred += 1;
      } else keep(outcome);
    } catch (error) {
      keep("rm_failed");
      result.firstFailure ??= `${candidate.name}: ${errorCode(error) ?? "unknown"}`;
    }
    result.freedBytes += freed.bytes;
  }
  return result;
}
