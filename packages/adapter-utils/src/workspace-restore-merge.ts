import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceManifest, WorkspaceManifestMap, workspacePathMatcher, type PathManifest, type WorkspacePaths, type WorkspaceManifestWriter } from "./workspace-manifest.js";
import { shouldExcludePath } from "./exclude-patterns.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";
import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";

export type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry> | WorkspaceManifestMap<SnapshotEntry>;
  ignoredPaths?: WorkspacePaths;
}

export interface LegacySerializedDirectorySnapshot {
  version: 1;
  exclude: string[];
  entries: Array<[string, SnapshotEntry]>;
}

export type SerializedDirectorySnapshot = LegacySerializedDirectorySnapshot | {
  version: 2;
  exclude: string[];
  entries: PathManifest;
  ignoredPaths?: WorkspacePaths;
};
const ownedDirectorySnapshots = new WeakMap<DirectorySnapshot, string>();
export async function disposeDirectorySnapshot(snapshot: DirectorySnapshot | null): Promise<void> {
  if (!snapshot) return;
  if (snapshot.entries instanceof WorkspaceManifestMap) {
    snapshot.entries.close();
    const ownedDirectory = ownedDirectorySnapshots.get(snapshot);
    ownedDirectorySnapshots.delete(snapshot);
    if (ownedDirectory) await fs.rm(ownedDirectory, { recursive: true, force: true });
  }
}

function parseManifestEntry(value: string): SnapshotEntry {
  const result = parseSnapshotEntry(JSON.parse(value));
  if (!result) throw new Error("Invalid workspace baseline entry");
  return result;
}

/** Call only after the controller validates a persisted manifest's path and digest. */
export function openDirectorySnapshot(value: Extract<SerializedDirectorySnapshot, { version: 2 }>): DirectorySnapshot {
  return { exclude: value.exclude, entries: new WorkspaceManifestMap(value.entries, parseManifestEntry), ignoredPaths: value.ignoredPaths };
}

function isSafeSnapshotRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return !value.split(/[\\/]/).some((segment) => segment === "..");
}

function parseSnapshotEntry(value: unknown): SnapshotEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "dir") return { kind: "dir" };
  if (candidate.kind === "symlink" && typeof candidate.target === "string") {
    return { kind: "symlink", target: candidate.target };
  }
  if (
    candidate.kind === "file" &&
    typeof candidate.mode === "number" &&
    Number.isInteger(candidate.mode) &&
    candidate.mode >= 0 &&
    typeof candidate.hash === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.hash)
  ) {
    return { kind: "file", mode: candidate.mode, hash: candidate.hash };
  }
  return null;
}

export function serializeDirectorySnapshot(
  snapshot: DirectorySnapshot,
): SerializedDirectorySnapshot {
  if (snapshot.entries instanceof WorkspaceManifestMap) return {
    version: 2, exclude: [...snapshot.exclude], entries: snapshot.entries.manifest,
    ...(snapshot.ignoredPaths ? { ignoredPaths: snapshot.ignoredPaths } : {}),
  };
  return {
    version: 1,
    exclude: [...snapshot.exclude],
    entries: [...snapshot.entries.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  };
}

export function parseDirectorySnapshot(
  value: unknown,
): DirectorySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.exclude) ||
    !candidate.exclude.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  const entries = new Map<string, SnapshotEntry>();
  for (const rawEntry of candidate.entries) {
    if (!Array.isArray(rawEntry) || rawEntry.length !== 2) return null;
    const [relative, rawSnapshotEntry] = rawEntry;
    if (typeof relative !== "string" || !isSafeSnapshotRelativePath(relative)) {
      return null;
    }
    const entry = parseSnapshotEntry(rawSnapshotEntry);
    if (!entry || entries.has(relative)) return null;
    entries.set(relative, entry);
  }
  return {
    exclude: [...new Set(candidate.exclude as string[])],
    entries,
  };
}

export function directorySnapshotSha256(snapshot: DirectorySnapshot): string {
  if (!(snapshot.entries instanceof WorkspaceManifestMap)) return createHash("sha256")
    .update(JSON.stringify(serializeDirectorySnapshot(snapshot))).digest("hex");
  const digest = createHash("sha256").update("workspace-baseline-v2\0").update(JSON.stringify(snapshot.exclude));
  for (const entry of snapshot.entries) digest.update(JSON.stringify(entry)).update("\0");
  return digest.digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// copySnapshotEntry stages each incoming file beside its target as
// `.paperclip-merge-<uuid>`, then renames it into place. Another run can walk
// or archive the same tree while a merge runs, so snapshot walks and sync tars
// skip exactly these names.
const MERGE_STAGING_PREFIX = ".paperclip-merge-";
const UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12];
const UUID_SOURCE = UUID_GROUP_LENGTHS.map((length) => `[0-9a-f]{${length}}`).join("-");
const MERGE_STAGING_NAME = new RegExp(`^${MERGE_STAGING_PREFIX.replaceAll(".", "\\.")}${UUID_SOURCE}$`);
/** The tar `--exclude` glob for the merge staging names a snapshot walk skips. */
export const MERGE_STAGING_TAR_EXCLUDE = `${MERGE_STAGING_PREFIX}${UUID_GROUP_LENGTHS.map((length) => "[0-9a-f]".repeat(length)).join("-")}`;

// Another run's restore can delete or rename an entry after the walk lists it,
// or replace its parent directory with a file. Such an entry is absent; every
// other error still fails the walk.
function absentIfVanished(error: unknown): null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  throw error;
}

async function* walkDirectory(
  root: string, exclude: readonly string[], ignored: ReturnType<typeof workspacePathMatcher>, relative = "",
): AsyncGenerator<[string, SnapshotEntry]> {
  // The root must exist. Only a directory below it may vanish mid-walk.
  const directory = relative ? await fs.opendir(path.join(root, relative)).catch(absentIfVanished) : await fs.opendir(root);
  if (!directory) return;
  for await (const entry of directory) {
    if (MERGE_STAGING_NAME.test(entry.name)) continue;
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldExcludePath(nextRelative, exclude) || ignored.matches(nextRelative)) continue;
    const fullPath = path.join(root, nextRelative);
    const stats = await fs.lstat(fullPath).catch(absentIfVanished);
    if (stats?.isDirectory()) {
      yield [nextRelative, { kind: "dir" }];
      yield* walkDirectory(root, exclude, ignored, nextRelative);
    } else if (stats?.isSymbolicLink()) {
      const target = await fs.readlink(fullPath).catch(absentIfVanished);
      if (target !== null) yield [nextRelative, { kind: "symlink", target }];
    } else if (stats?.isFile()) {
      const hash = await hashFile(fullPath).catch(absentIfVanished);
      if (hash !== null) yield [nextRelative, { kind: "file", mode: stats.mode, hash }];
    }
  }
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  if (!stats.isFile()) return null;

  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashFile(fullPath),
  };
}

function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

const LOCK_WAIT_MS = 30_000;
const LOCK_WAIT_PROGRESS_INTERVAL_MS = 30_000;
// Parallel runs on one project workspace restore into it one at a time, and
// one merge of a large tree can hold the lock for more than 30 s. A restore
// therefore waits for the whole queue ahead of it, within this bound.
// Operators can set PAPERCLIP_WORKSPACE_RESTORE_LOCK_WAIT_MS to 1 s to 1 h.
const WORKSPACE_RESTORE_LOCK_WAIT_MS = 10 * 60_000;
const LOCK_DIAGNOSTIC_READ_TIMEOUT_MS = 100;
const activeDirectoryMergeLocks = new Set<string>();
const MAX_LOCK_DIAGNOSTIC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type DirectoryMergeLockOperation =
  | "agent_directory_prepare"
  | "agent_directory_release"
  | "agent_directory_collect"
  | "agent_directory_checkpoint"
  | "agent_directory_handoff";

/** Evidence only: neither process age nor this module's holder set can prove
 * that a lock in another process or PID namespace is safe to reclaim. */
async function directoryMergeLockDiagnostics(lockDir: string, waitMs: number, ownerPath: string): Promise<Record<string, string | number | boolean>> {
  const diagnostics: Record<string, string | number | boolean> = {
    ownerState: "unknown",
    knownLocalHolder: activeDirectoryMergeLocks.has(lockDir),
    waitMs: Math.min(MAX_LOCK_DIAGNOSTIC_AGE_MS, Math.max(0, Math.floor(waitMs))),
  };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Abort is best effort: race the read as well so a stalled filesystem
    // cannot keep the original lock timeout from reaching its caller.
    const raw = await Promise.race([
      fs.readFile(ownerPath, { encoding: "utf8", signal: controller.signal }),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), LOCK_DIAGNOSTIC_READ_TIMEOUT_MS);
      }),
    ]);
    if (raw === undefined) return diagnostics;
    let owner: { pid?: unknown; createdAt?: unknown } | null;
    try {
      owner = JSON.parse(raw) as typeof owner;
    } catch {
      diagnostics.ownerState = "invalid";
      return diagnostics;
    }
    if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) {
      diagnostics.ownerState = "invalid";
      return diagnostics;
    }
    const pid = owner.pid as number;
    diagnostics.ownerSameProcess = pid === process.pid;
    try {
      process.kill(pid, 0);
      diagnostics.ownerState = "alive";
    } catch (error) {
      diagnostics.ownerState = (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
    const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : NaN;
    const ageMs = Date.now() - createdAt;
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      diagnostics.ownerAgeMs = Math.min(MAX_LOCK_DIAGNOSTIC_AGE_MS, Math.floor(ageMs));
      if (pid === process.pid) diagnostics.ownerPredatesProcess = ageMs > process.uptime() * 1000 + 1000;
    }
  } catch (error) {
    diagnostics.ownerState = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return diagnostics;
}

/**
 * The stable `code` a lock-timeout error carries, so a caller can identify it
 * without matching on the error message text (the message embeds the lock
 * directory path).
 */
export const WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE = "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT";

/**
 * The closed set of codes a failed workspace restore can carry off the
 * sandbox. Every code is safe to store on a run record readable by any
 * same-company actor: none embeds a filesystem path, a raw error message, or
 * a process id.
 */
export type WorkspaceRestoreFailureCode =
  | "restore_permission_denied"
  | "restore_lock_timeout"
  | "restore_unsafe_archive"
  | "restore_failed";

/**
 * The outcome of one workspace restore. `ok: true` on a clean restore. `ok:
 * false` carries one allowlisted {@link WorkspaceRestoreFailureCode} — never a
 * raw error, a path, or a process id.
 */
export type WorkspaceRestoreOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WorkspaceRestoreFailureCode };

/**
 * Classifies a caught workspace-restore error into one allowlisted code. Maps
 * `EACCES` and `EPERM` to a permission failure, the merge-lock timeout
 * (matched by {@link WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE}, never by the error
 * message text) to a lock-timeout failure, and every other error to a generic
 * failure. The known Daytona confinement diagnostic also identifies unsafe
 * archives across plugin transports that retain only a message. Never returns
 * raw messages, paths or process IDs.
 */
export function classifyWorkspaceRestoreFailure(error: unknown): WorkspaceRestoreFailureCode {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "EACCES" || code === "EPERM") return "restore_permission_denied";
  if (code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) return "restore_lock_timeout";
  const message = error instanceof Error ? error.message : "";
  const archiveRefused = /Daytona syncOut refusing (?:tarball (?:with an unparseable entry listing|(?:link whose target|member that) escapes the extraction dir)|unparseable or ambiguous (?:sym|hard)link entry)/.test(message);
  const outboundPathRefused = /Daytona sync source path (?:is not a confined absolute path|escapes the workspace remote dir):/.test(message);
  // These are the fail-closed guard's own exit codes. Transport/command failures
  // with other exit codes retain the existing transient failure policy.
  const outboundGuardRefused = /Daytona outbound symlink-escape guard command failed \(exit (?:40|41|42|44|45)\)/.test(message);
  if (code === "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" ||
      archiveRefused || outboundPathRefused || outboundGuardRefused) {
    return "restore_unsafe_archive";
  }
  return "restore_failed";
}

/**
 * The fixed, allowlisted line an ACP adapter writes to the run log when a
 * workspace restore fails. Every call site must pass this to `onLog` instead
 * of the caught error's own message: the caught error can carry a host
 * filesystem path or the lock owner's process id, and the run log is
 * readable by any same-company actor. Never add the code's raw
 * `Error.message` to this text.
 */
export function describeWorkspaceRestoreFailure(code: WorkspaceRestoreFailureCode): string {
  switch (code) {
    case "restore_permission_denied":
      return "the restore could not write to the workspace (permission denied)";
    case "restore_lock_timeout":
      return "the restore timed out waiting for the workspace merge lock";
    case "restore_unsafe_archive":
      return "the archive contains an unsafe link or path; workspace repair is required";
    case "restore_failed":
      return "the restore failed";
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
}

// Let SQLite create and manage every descriptor for these inodes. On POSIX,
// closing a raw fs.open descriptor could release another connection's locks.
// The parent is private (0700), including while a new file is chmodded.
async function openLockRootDatabase(filePath: string): Promise<DatabaseSync> {
  const stats = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)) {
    throw new Error("Directory merge lock database is not a plain, unshared file.");
  }
  const database = new DatabaseSync(filePath, { allowExtension: false });
  try {
    await fs.chmod(filePath, 0o600);
    // Never block the event loop while another async operation holds a lock.
    database.exec("PRAGMA busy_timeout=0;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

// First-come admission. Contenders that each retry the lock every 50 ms win in
// random order, so newer restores could keep overtaking an older one until its
// wait expired. Each contender instead takes a ticket in `<lock>.queue.sqlite`,
// and only the oldest live ticket tries the lock. Tickets order attempts only:
// the lock database stays the sole authority for mutual exclusion, so a lost
// or stale ticket can delay a contender but never admit two.
//
// A contender holds the SQLite lock of its own `<lock>.waiter-<uuid>.sqlite`
// before it takes a ticket and until it gives the ticket up. The OS releases
// that lock if the contender crashes, so others prove a ticket dead by
// locking its file, never from PIDs, ages, or clocks.
const ADMISSION_PROBE_INTERVAL_MS = 1_000;
const WAITER_TOKEN = new RegExp(`^${UUID_SOURCE}$`);

function waiterFilePath(lockDir: string, token: string): string {
  return `${lockDir}.waiter-${token}.sqlite`;
}

// Opening creates a missing file, which is then unlocked: missing and unlocked
// both mean the ticket's contender left or died.
async function waiterIsLive(lockDir: string, token: string): Promise<boolean> {
  const probe = await openLockRootDatabase(waiterFilePath(lockDir, token));
  try {
    probe.exec("BEGIN IMMEDIATE;");
    probe.exec("ROLLBACK;");
    return false;
  } catch (error) {
    if (isSqliteBusy(error)) return true;
    throw error;
  } finally { probe.close(); }
}

// Best effort: the next contender removes a ticket whose waiter file is
// unlocked, so a busy or failing queue only delays that cleanup.
async function removeOwnTicket(queue: DatabaseSync, seq: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      queue.prepare("DELETE FROM tickets WHERE seq = ?").run(seq);
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface DirectoryMergeAdmission {
  /** Tickets older than this contender's, as of the last `isNext()` call. */
  readonly ahead: number;
  /** True once no live contender holds an older ticket. A busy queue answers false. */
  isNext(): Promise<boolean>;
  /** Gives up the ticket. Never throws. */
  leave(): Promise<void>;
}

function joinDirectoryMergeAdmission(lockDir: string): DirectoryMergeAdmission {
  const token = randomUUID();
  let waiter: DatabaseSync | null = null;
  let queue: DatabaseSync | null = null;
  let seq: number | null = null;
  let left = false;
  let watched = { token: "", since: 0 };
  let ahead = Number.POSITIVE_INFINITY;
  return {
    get ahead() { return ahead; },
    async isNext() {
      try {
        waiter ??= await openLockRootDatabase(waiterFilePath(lockDir, token));
        if (!waiter.isTransaction) waiter.exec("BEGIN IMMEDIATE;");
        queue ??= await openLockRootDatabase(`${lockDir}.queue.sqlite`);
        if (seq === null) {
          queue.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE);");
          const ticket = queue.prepare("INSERT INTO tickets (token) VALUES (?) RETURNING seq").get(token);
          if (!ticket) throw new Error("Directory merge admission ticket was not created.");
          seq = Number(ticket.seq);
        }
        ahead = Number(queue.prepare("SELECT COUNT(*) AS n FROM tickets WHERE seq < ?").get(seq)?.n ?? 0);
        // Probe a ticket only after it has stayed oldest for a while, except
        // right after removing a dead one: crashes are rare, handoffs are not.
        let probeNow = false;
        while (true) {
          const older = queue.prepare("SELECT seq, token FROM tickets WHERE seq < ? ORDER BY seq LIMIT 1").get(seq);
          if (!older) return true;
          const olderToken = String(older.token);
          const now = performance.now();
          if (!probeNow) {
            if (watched.token !== olderToken) {
              watched = { token: olderToken, since: now };
              return false;
            }
            if (now - watched.since < ADMISSION_PROBE_INTERVAL_MS) return false;
          }
          watched = { token: olderToken, since: now };
          const valid = WAITER_TOKEN.test(olderToken);
          if (valid && await waiterIsLive(lockDir, olderToken)) return false;
          queue.prepare("DELETE FROM tickets WHERE seq = ? AND token = ?").run(Number(older.seq), olderToken);
          if (valid) await fs.rm(waiterFilePath(lockDir, olderToken), { force: true });
          probeNow = true;
        }
      } catch (error) {
        if (isSqliteBusy(error)) return false;
        throw error;
      }
    },
    async leave() {
      if (left) return;
      left = true;
      try {
        if (queue && seq !== null) await removeOwnTicket(queue, seq);
      } finally {
        queue?.close();
        // Closing ends the waiter file's lock; the file is no longer needed.
        waiter?.close();
        await fs.rm(waiterFilePath(lockDir, token), { force: true }).catch(() => undefined);
      }
    },
  };
}

/** One progress report while a caller waits for a held directory merge lock. */
export interface DirectoryMergeLockWait {
  waitedMs: number;
  /** Contenders queued ahead of this one, when admission has counted them. */
  ahead?: number;
  /** How long the current holder has held the lock, when its record is readable. */
  holderAgeMs?: number;
}

async function acquireDirectoryMergeLock(
  lockDir: string,
  operation?: DirectoryMergeLockOperation,
  waitMs: number = LOCK_WAIT_MS,
  onWait?: (wait: DirectoryMergeLockWait) => void | Promise<void>,
): Promise<() => Promise<void>> {
  const startedAt = performance.now();
  // `waitMs` bounds the time without queue progress, not the whole wait: FIFO
  // admission means a contender only waits for the finite set of tickets ahead
  // of it, so a queue of healthy holders never times it out, while a stuck
  // holder or head still does. Each ticket that leaves restarts the budget.
  const waitStartedAt = Date.now();
  let deadline = waitStartedAt + waitMs;
  let nextProgressAt = waitStartedAt + LOCK_WAIT_PROGRESS_INTERVAL_MS;
  const databasePath = `${lockDir}.sqlite`;
  const ownerPath = `${lockDir}.owner.json`;
  async function waitForLock(diagnosticOwnerPath: string, progressed = false, ahead?: number) {
    const now = Date.now();
    if (progressed) deadline = now + waitMs;
    if (now >= deadline) {
      const timeoutError: NodeJS.ErrnoException & { workspaceRestoreLock?: Record<string, string | number | boolean> } = new Error(
        `Timed out waiting for workspace restore lock at ${lockDir}`,
      );
      timeoutError.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
      // Keep the original timeout if the diagnostic read itself fails.
      timeoutError.workspaceRestoreLock = await directoryMergeLockDiagnostics(lockDir, performance.now() - startedAt, diagnosticOwnerPath).catch(() => undefined);
      if (operation && timeoutError.workspaceRestoreLock) timeoutError.workspaceRestoreLock.operation = operation;
      throw timeoutError;
    }
    if (onWait && now >= nextProgressAt) {
      nextProgressAt = now + LOCK_WAIT_PROGRESS_INTERVAL_MS;
      const holderAgeMs = (await directoryMergeLockDiagnostics(lockDir, 0, diagnosticOwnerPath).catch(() => undefined))?.ownerAgeMs;
      // Progress is advisory: a failing sink, sync or async, must not end the wait.
      try {
        await onWait({
          waitedMs: now - waitStartedAt,
          ...(ahead !== undefined && Number.isFinite(ahead) ? { ahead } : {}),
          ...(typeof holderAgeMs === "number" ? { holderAgeMs } : {}),
        });
      } catch { /* the wait continues */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // SQLite's RESERVED file lock is the authority, including across processes
  // and PID namespaces. It is released by the OS on a crash. The empty database
  // is permanent: unlinking it would let contenders lock different inodes.
  // node:sqlite is already required for workspace manifests; no native add-on
  // or external flock command is needed on macOS, Linux, or Windows.
  const database = await openLockRootDatabase(databasePath);
  const admission = joinDirectoryMergeAdmission(lockDir);
  try {
    let lastAhead: number | null = null;
    while (true) {
      if (await admission.isNext()) {
        try {
          database.exec("BEGIN IMMEDIATE;");
          break;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
        }
      }
      const progressed = lastAhead !== null && admission.ahead < lastAhead;
      lastAhead = admission.ahead;
      await waitForLock(ownerPath, progressed, admission.ahead);
    }
    await admission.leave();

    // Old processes do not participate in the SQLite protocol. Never infer
    // that a legacy owner is dead from PID existence, age, or missing metadata.
    // Drain old writers before upgrading. A leftover legacy directory requires
    // explicit offline cleanup; a live legacy holder can still release normally.
    while (await fs.lstat(lockDir).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) await waitForLock(path.join(lockDir, "owner.json"));

    const owner = await fs.open(ownerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await owner.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    } finally { await owner.close(); }
    activeDirectoryMergeLocks.add(lockDir);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        // This sidecar is diagnostic only. A failed removal cannot retain
        // ownership, and the next holder replaces it while holding the DB lock.
        await fs.unlink(ownerPath).catch(() => undefined);
      } finally {
        activeDirectoryMergeLocks.delete(lockDir);
        database.close();
      }
    };
  } catch (error) {
    await admission.leave();
    database.close();
    throw error;
  }
}

const DIRECTORY_MERGE_LOCK_ROOT_MODE = 0o700;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the private, instance-scoped root for every directory-merge lock:
 * `<instance root>/locks/directory-merge`. Every process that can mutate one
 * target directory must resolve to the same `PAPERCLIP_HOME` and
 * `PAPERCLIP_INSTANCE_ID`. That shared resolution is what keeps mutual
 * exclusion true for all five callers of `withDirectoryMergeLock`, including
 * the three Codex credential call sites that never touch a workspace.
 *
 * This never falls back to `os.tmpdir()` and never places the lock beside the
 * target directory: both paths funnel through this one instance-scoped root,
 * so a read-only target parent (the workspace-restore bug) cannot block a
 * lock acquisition.
 *
 * The root reads `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` from `env`, so an
 * environment-parameterized caller (a Codex credential call site that builds
 * its own `env` object instead of reading `process.env`) resolves its lock
 * root under the same instance root as the directory it protects. This never
 * reads `process.env` when the caller passes an `env`: every fallback inside
 * the resolver also reads from that same `env` object. A caller that omits
 * `env` gets `process.env`, which keeps the resolution unchanged for the
 * workspace-restore call site.
 *
 * The root is validated, not trusted: `lstat` rejects a symlink and rejects
 * any non-directory before use (fail closed). `fs.mkdir` does not change the
 * mode of a directory that already exists, so an existing valid directory
 * keeps whatever mode it already has; only a freshly created root gets mode
 * `0o700`.
 *
 * The existence check and the `mkdir` below are two separate calls, so a
 * racing writer can plant a symlink at `lockRoot` in between them. `fs.mkdir`
 * with `recursive: true` does not fail on a leaf that already exists as a
 * symlink to a real directory, so a successful `mkdir` call alone does not
 * prove the path is a plain directory. The `lstat` after `mkdir` closes that
 * window: it validates what is actually at `lockRoot` (never a `stat`, which
 * would follow the symlink) before any caller treats it as the lock root.
 */
async function resolveDirectoryMergeLockRoot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const lockRoot = path.join(instanceRoot, "locks", "directory-merge");
  const existing = await fs.lstat(lockRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Directory merge lock root at ${lockRoot} is not a plain directory.`);
    }
    return lockRoot;
  }
  await fs.mkdir(lockRoot, { recursive: true, mode: DIRECTORY_MERGE_LOCK_ROOT_MODE });
  const created = await fs.lstat(lockRoot);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Directory merge lock root at ${lockRoot} is not a plain directory.`);
  }
  return lockRoot;
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: (canonicalTargetDir: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  diagnosticOperation?: DirectoryMergeLockOperation,
  // How long acquisition waits before it reports a timeout. Short critical
  // sections keep the 30 s default; workspace restores pass their own budget.
  waitMs: number = LOCK_WAIT_MS,
  // Called about every 30 s while acquisition waits for another holder.
  onWait?: (wait: DirectoryMergeLockWait) => void | Promise<void>,
): Promise<T> {
  // Canonicalize before we hash or lock: a retargeted symlink must not let the
  // lock protect one directory while the caller mutates another.
  const canonicalTargetDir = await fs.realpath(targetDir);
  const lockRoot = await resolveDirectoryMergeLockRoot(env);
  const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
  const releaseLock = await acquireDirectoryMergeLock(path.join(lockRoot, `${lockKey}.lock`), diagnosticOperation, waitMs, onWait);
  try {
    return await fn(canonicalTargetDir);
  } finally {
    await releaseLock();
  }
}

/**
 * Refuses a mutation of `targetDir/relative` unless every ancestor of it is a
 * real directory inside the target. Each component is checked with `lstat`,
 * which does not follow a link, and the parent's `realpath` must stay under
 * the target. Node has no `openat`, so a path handed to `rename`, `rm`, or
 * `mkdir` is resolved again by the system; call this immediately before each
 * mutation, not only in a preflight, so a link swapped in after the preflight
 * is refused. With `create`, missing ancestors are made one level at a time,
 * never with a following `mkdir -p`. Throws {@link DirectoryMergeConflict}
 * naming the first ancestor that is a link, or is not a directory. A removal
 * passes `absentBelowFile`: a plain file in the way means the entry to remove
 * is not there, and `false` is returned, as `ENOTDIR` once meant. A link is
 * always refused. Returns `false` when nothing can exist at `relative`.
 */
async function assertRealAncestors(
  targetDir: string, relative: string, options: { create?: boolean; absentBelowFile?: boolean } = {},
): Promise<boolean> {
  const create = options.create ?? false;
  if (!isSafeSnapshotRelativePath(relative)) throw new DirectoryMergeConflict([relative]);
  const segments = relative.split("/").slice(0, -1);
  let current = targetDir;
  let walked = "";
  for (const segment of segments) {
    current = path.join(current, segment);
    walked = walked ? `${walked}/${segment}` : segment;
    let stats = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      if (error.code === "ENOTDIR") throw new DirectoryMergeConflict([walked]);
      throw error;
    });
    if (!stats) {
      // Nothing exists below a missing ancestor, so there is nothing to change.
      if (!create) return false;
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      stats = await fs.lstat(current);
    }
    if (!stats.isDirectory()) {
      if (options.absentBelowFile && !stats.isSymbolicLink()) return false;
      throw new DirectoryMergeConflict([walked]);
    }
  }
  if (segments.length === 0) return true;
  const [realTarget, realParent] = await Promise.all([fs.realpath(targetDir), fs.realpath(current)]);
  const inside = path.relative(realTarget, realParent);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new DirectoryMergeConflict([walked]);
  }
  return true;
}

type DirectoryHandle = Awaited<ReturnType<typeof fs.open>>;

const FD_PATH_ROOT = "/proc/self/fd";
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
let descriptorPinning: boolean | undefined;

/**
 * Whether an open directory can serve as the base of a path on this system.
 * Linux resolves `/proc/self/fd/<n>/name` through the descriptor itself, so the
 * path keeps meaning the directory that was opened even if its old path is
 * swapped for a link afterwards. Node has no `openat`; macOS has no such path.
 * Elsewhere the merge falls back to checking the path again before each
 * operation, which narrows the window but cannot close it.
 */
export function descriptorPinningSupported(): boolean {
  descriptorPinning ??= process.platform === "linux" && existsSync(FD_PATH_ROOT);
  return descriptorPinning;
}

/** A directory the merge validated. Operate on `path.join(dir, name)`, then `close()`. */
interface PinnedDirectory {
  readonly dir: string;
  /** True when `dir` is bound to the validated directory, whatever happens to its old path. */
  readonly pinned: boolean;
  close(): Promise<void>;
}

const unpinned = (dir: string): PinnedDirectory => ({ dir, pinned: false, close: async () => undefined });

/**
 * Validates the directory that holds `targetDir/relative` and returns it for
 * the caller's one operation. Where descriptors can be path bases, each
 * component is opened from the previous descriptor with `O_DIRECTORY` and
 * `O_NOFOLLOW`, so no component is resolved through a path another writer can
 * swap; missing directories are made one level at a time the same way. Elsewhere
 * the ancestors are checked with {@link assertRealAncestors}. Returns `null`
 * when nothing can exist there (a missing ancestor without `create`, or a plain
 * file in the way with `absentBelowFile`). Throws {@link DirectoryMergeConflict}
 * for a link, or a file the caller did not tolerate.
 */
async function pinParentDirectory(
  targetDir: string, relative: string, options: { create?: boolean; absentBelowFile?: boolean } = {},
): Promise<PinnedDirectory | null> {
  if (!isSafeSnapshotRelativePath(relative)) throw new DirectoryMergeConflict([relative]);
  const segments = relative.split("/").slice(0, -1);
  if (!descriptorPinningSupported()) {
    if (!await assertRealAncestors(targetDir, relative, options)) return null;
    return unpinned(path.join(targetDir, ...segments));
  }
  let handle: DirectoryHandle | null = await fs.open(targetDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  let walked = "";
  try {
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment;
      const child = `${FD_PATH_ROOT}/${handle!.fd}/${segment}`;
      let next: DirectoryHandle | null = null;
      for (let attempt = 0; next === null; attempt += 1) {
        try {
          next = await fs.open(child, DIRECTORY_OPEN_FLAGS);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            if (!options.create) return null;
            if (attempt > 0) throw error;
            await fs.mkdir(child).catch((mkdirError: NodeJS.ErrnoException) => {
              if (mkdirError.code !== "EEXIST") throw mkdirError;
            });
            continue;
          }
          if (code === "ELOOP" || code === "ENOTDIR") {
            const stats = await fs.lstat(child).catch(() => null);
            if (stats && !stats.isSymbolicLink() && options.absentBelowFile) return null;
            throw new DirectoryMergeConflict([walked]);
          }
          throw error;
        }
      }
      await handle!.close();
      handle = next;
    }
    const kept: DirectoryHandle = handle!;
    handle = null;
    return { dir: `${FD_PATH_ROOT}/${kept.fd}`, pinned: true, close: () => kept.close() };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/** The directory `targetDir/relative` itself, validated the same way; `""` is the target. */
async function pinDirectory(
  targetDir: string, relative: string, options: { absentBelowFile?: boolean } = {},
): Promise<PinnedDirectory | null> {
  return relative ? await pinParentDirectory(targetDir, `${relative}/_`, options) : unpinned(targetDir);
}

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = path.join(sourceDir, relative);
  const name = path.posix.basename(relative);
  const parent = await pinParentDirectory(targetDir, relative, { create: true });
  if (!parent) throw new DirectoryMergeConflict([relative]);
  try {
    const targetPath = path.join(parent.dir, name);
    if (entry.kind === "dir") {
      const existing = await fs.lstat(targetPath).catch(() => null);
      if (existing?.isDirectory()) {
        return;
      }
      if (existing) {
        await fs.rm(targetPath, { force: true }).catch(() => undefined);
      }
      await fs.mkdir(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      return;
    }

    if (entry.kind === "symlink") {
      await removeReplacedEntry(parent, targetDir, relative);
      await fs.symlink(entry.target, targetPath);
      return;
    }
    // An interrupted restore must not leave a truncated current file. Keep the
    // incoming tree until its owner records success; exact retries deduplicate.
    // The copy is staged in the pinned directory. Without pinning it is staged
    // in the target root, whose path has no ancestor to swap, so a copy that
    // takes a long time can never write through a link.
    const temporary = path.join(parent.pinned ? parent.dir : targetDir, `${MERGE_STAGING_PREFIX}${randomUUID()}`);
    try {
      await fs.copyFile(sourcePath, temporary, fsConstants.COPYFILE_FICLONE).catch(async () => {
        await fs.copyFile(sourcePath, temporary);
      });
      await fs.chmod(temporary, entry.mode);
      const file = await fs.open(temporary, "r");
      try { await file.sync(); } finally { await file.close(); }
      if (!parent.pinned) await assertRealAncestors(targetDir, relative);
      const existing = await fs.lstat(targetPath).catch(() => null);
      if (existing?.isDirectory()) await removeReplacedEntry(parent, targetDir, relative);
      if (!parent.pinned) await assertRealAncestors(targetDir, relative);
      try {
        await fs.rename(temporary, targetPath);
      } catch (error) {
        // The root and the destination are on different filesystems.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV" || parent.pinned) throw error;
        const local = path.join(parent.dir, `${MERGE_STAGING_PREFIX}${randomUUID()}`);
        try {
          await fs.copyFile(temporary, local);
          await fs.chmod(local, entry.mode);
          await assertRealAncestors(targetDir, relative);
          await fs.rename(local, targetPath);
        } finally { await fs.rm(local, { force: true }); }
      }
    } finally { await fs.rm(temporary, { force: true }); }
  } finally { await parent.close(); }
}

// A merge killed between staging a copy and renaming it leaves its
// `.paperclip-merge-<uuid>` file behind. Snapshot walks hide these names, so a
// leftover is invisible to the baseline, yet it keeps its directory non-empty.
// Only the caller holding the target's merge lock may call this. The age floor
// keeps a file that another lock's merge is still copying, such as one inside
// a nested repository this merge does not own.
const STALE_STAGING_MIN_AGE_MS = 15 * 60_000;

/** Removes stale staging files directly inside `root/relative`; returns how
 * many. It refuses a path with a link in it, and removes only a regular file
 * owned by this user, so it never follows or removes a link, and never
 * recurses. */
async function removeStaleStagingFiles(root: string, relative: string): Promise<number> {
  const directory = await pinDirectory(root, relative, { absentBelowFile: true }).catch((error: unknown) => {
    if (error instanceof DirectoryMergeConflict) return null;
    throw error;
  });
  if (!directory) return 0;
  try {
    const uid = process.getuid?.();
    let removed = 0;
    for (const name of await fs.readdir(directory.dir).catch(() => [])) {
      if (!MERGE_STAGING_NAME.test(name)) continue;
      const candidate = path.join(directory.dir, name);
      const stats = await fs.lstat(candidate).catch(() => null);
      if (!stats?.isFile() || (uid !== undefined && stats.uid !== uid)) continue;
      if (Date.now() - stats.mtimeMs < STALE_STAGING_MIN_AGE_MS) continue;
      await fs.rm(candidate, { force: true });
      removed += 1;
    }
    return removed;
  } finally { await directory.close(); }
}

// Removes an empty directory. When stale staging files kept it non-empty it
// removes them and retries once; a directory that still holds anything else is
// reported as ENOTEMPTY, never emptied.
async function removeDirectoryDroppingStaleStaging(root: string, relative: string): Promise<void> {
  const parent = await pinParentDirectory(root, relative, { absentBelowFile: true });
  if (!parent) return;
  try {
    const directory = path.join(parent.dir, path.posix.basename(relative));
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || await removeStaleStagingFiles(root, relative) === 0) throw error;
      await fs.rmdir(directory);
    }
  } finally { await parent.close(); }
}

// A file or symlink replacing a directory removes it non-recursively. The
// merge has already deleted the unchanged entries it owns there, and
// `blockedDirectoryReplacements` refused anything else, so a non-empty
// directory here means content appeared concurrently and must not be lost.
async function removeReplacedEntry(parent: PinnedDirectory, targetDir: string, relative: string): Promise<void> {
  const targetPath = path.join(parent.dir, path.posix.basename(relative));
  const existing = await fs.lstat(targetPath).catch(() => null);
  if (existing?.isDirectory()) await removeDirectoryDroppingStaleStaging(targetDir, relative);
  else await fs.rm(targetPath, { force: true });
}

/** Source files and symlinks that would replace a target directory still
 * holding entries this merge does not own: excluded or ignored trees such as
 * `node_modules`, or files created or edited outside this restore. Replacing
 * such a directory would delete them, so the merge refuses before writing. */
async function blockedDirectoryReplacements(
  targetDir: string, baseline: DirectorySnapshot, source: DirectorySnapshot,
): Promise<string[]> {
  const ignored = workspacePathMatcher(baseline.ignoredPaths);
  const holdsUnownedEntry = async (relative: string): Promise<boolean> => {
    await removeStaleStagingFiles(targetDir, relative);
    // A link in the path means the directory is not the one the run saw.
    const directory = await pinDirectory(targetDir, relative).catch((error: unknown) => {
      if (error instanceof DirectoryMergeConflict) return null;
      throw error;
    });
    if (!directory) return true;
    const names = await fs.readdir(directory.dir).finally(() => directory.close());
    for (const name of names) {
      const child = path.posix.join(relative, name);
      const owned = baseline.entries.get(child);
      if (!owned || shouldExcludePath(child, baseline.exclude) || ignored.matches(child)) return true;
      if (!entriesMatch(await readSnapshotEntry(targetDir, child), owned)) return true;
      if (owned.kind === "dir" && await holdsUnownedEntry(child)) return true;
    }
    return false;
  };
  try {
    const blocked: string[] = [];
    for (const [relative, entry] of orderedEntries(source)) {
      // Unchanged entries are never applied, so they replace nothing.
      if (entry.kind === "dir" || entriesMatch(baseline.entries.get(relative), entry)) continue;
      const existing = await fs.lstat(path.join(targetDir, relative)).catch(() => null);
      if (existing?.isDirectory() && await holdsUnownedEntry(relative)) blocked.push(relative);
    }
    return blocked;
  } finally { ignored.close(); }
}

/** Directories the merge would write below that are no longer the real
 * directories the run saw, because another restore left a link or a file there.
 * A directory the merge itself replaces first is not one of them. Nothing is
 * written until this is empty. */
async function linkedAncestorConflicts(
  targetDir: string, baseline: DirectorySnapshot, source: DirectorySnapshot,
  isApplied: (relative: string, entry: SnapshotEntry) => boolean,
): Promise<string[]> {
  const verdicts = new Map<string, boolean>();
  const usable = async (ancestor: string): Promise<boolean> => {
    const known = verdicts.get(ancestor);
    if (known !== undefined) return known;
    const stats = await fs.lstat(path.join(targetDir, ancestor)).catch(() => null);
    const incoming = source.entries.get(ancestor);
    const replaced = incoming?.kind === "dir" && !entriesMatch(baseline.entries.get(ancestor), incoming);
    const verdict = !stats || stats.isDirectory() || replaced;
    verdicts.set(ancestor, verdict);
    return verdict;
  };
  const bad = new Set<string>();
  for (const [relative, entry] of orderedEntries(source)) {
    if (!isApplied(relative, entry)) continue;
    const ancestors: string[] = [];
    for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) ancestors.unshift(parent);
    for (const ancestor of ancestors) {
      // A run's own tree cannot hold an entry below a link or a file.
      const incoming = source.entries.get(ancestor);
      if (incoming && incoming.kind !== "dir") { bad.add(ancestor); break; }
      if (!await usable(ancestor)) { bad.add(ancestor); break; }
      // Below a missing or replaced directory nothing exists yet to follow.
      const stats = await fs.lstat(path.join(targetDir, ancestor)).catch(() => null);
      if (!stats?.isDirectory()) break;
    }
  }
  return [...bad].sort();
}

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[]; ignoredPaths?: WorkspacePaths; diskBacked?: boolean } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  const ignored = workspacePathMatcher(options.ignoredPaths);
  let writer: WorkspaceManifestWriter | null = null;
  try {
    writer = options.diskBacked ? await createWorkspaceManifest("paperclip-workspace-baseline-") : null;
    const memory = new Map<string, SnapshotEntry>();
    for await (const [relative, entry] of walkDirectory(rootDir, exclude, ignored)) {
      if (writer) writer.add("baseline", relative, JSON.stringify(entry));
      else memory.set(relative, entry);
    }
    const manifest = writer?.paths("baseline");
    writer?.close();
    const snapshot: DirectorySnapshot = {
      exclude, ignoredPaths: options.ignoredPaths,
      entries: manifest ? new WorkspaceManifestMap(manifest, parseManifestEntry) : memory,
    };
    if (writer) ownedDirectorySnapshots.set(snapshot, path.dirname(writer.filePath));
    return snapshot;
  } catch (error) {
    writer?.close(false);
    if (writer) await fs.rm(path.dirname(writer.filePath), { recursive: true, force: true });
    throw error;
  } finally { ignored.close(); }
}

/** A disk-backed subset for independent nested-repository merges. */
export async function selectDirectorySnapshot(snapshot: DirectorySnapshot, options: {
  prefix?: string; omit?: string[]; exclude: string[]; ignoredPaths?: WorkspacePaths;
}): Promise<DirectorySnapshot> {
  const writer = await createWorkspaceManifest("paperclip-workspace-baseline-");
  try {
    for (const [relative, entry] of snapshot.entries) {
      if (options.prefix && !relative.startsWith(options.prefix)) continue;
      if (options.omit?.some((omit) => relative === omit || relative.startsWith(`${omit}/`))) continue;
      writer.add("baseline", options.prefix ? relative.slice(options.prefix.length) : relative, JSON.stringify(entry));
    }
    const result: DirectorySnapshot = { exclude: options.exclude, ignoredPaths: options.ignoredPaths,
      entries: new WorkspaceManifestMap(writer.paths("baseline"), parseManifestEntry) };
    writer.close();
    ownedDirectorySnapshots.set(result, path.dirname(writer.filePath));
    return result;
  } catch (error) {
    writer.close(false);
    await fs.rm(path.dirname(writer.filePath), { recursive: true, force: true });
    throw error;
  }
}

function orderedEntries(snapshot: DirectorySnapshot, reverse = false): Iterable<[string, SnapshotEntry]> {
  if (snapshot.entries instanceof WorkspaceManifestMap) return snapshot.entries.entries(reverse);
  return [...snapshot.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0) * (reverse ? -1 : 1));
}

export class DirectoryMergeConflict extends Error {
  readonly code = "DIRECTORY_MERGE_CONFLICT";
  constructor(readonly paths: string[]) {
    super("Directory contents changed concurrently");
  }
}

/** Preflight the entire delta before writing. Identical replays are safe after
 * an interrupted apply; unrelated edits are left alone. No history is retained. */
export function directoryMergeConflicts(baseline: DirectorySnapshot, source: DirectorySnapshot, current: DirectorySnapshot): string[] {
  const same = (a: SnapshotEntry | undefined, b: SnapshotEntry | undefined) =>
    (!a && !b) || entriesMatch(a, b);
  const conflicts = new Set<string>();
  function* changedPaths() {
    for (const [name] of baseline.entries) yield name;
    for (const [name] of source.entries) if (!baseline.entries.has(name)) yield name;
  }
  for (const relative of changedPaths()) {
    const before = baseline.entries.get(relative);
    const incoming = source.entries.get(relative);
    const present = current.entries.get(relative);
    if (same(before, incoming) || same(incoming, present)) continue;
    if (!same(before, present)) conflicts.add(relative);
    // A parent removed/replaced by another writer must never be traversed.
    for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) {
      if (current.entries.get(parent)?.kind !== "dir" &&
          !same(current.entries.get(parent), baseline.entries.get(parent))) conflicts.add(parent);
    }
  }
  // Stream each current entry once. A replacement must not remove children
  // omitted from the baseline, including excluded or newly created files.
  for (const [child, entry] of current.entries) {
    if (same(entry, baseline.entries.get(child)) || same(entry, source.entries.get(child))) continue;
    for (let parent = path.posix.dirname(child); parent !== "."; parent = path.posix.dirname(parent)) {
      if (baseline.entries.get(parent)?.kind === "dir" && source.entries.get(parent)?.kind !== "dir") {
        conflicts.add(child);
        break;
      }
    }
  }
  return [...conflicts].sort();
}

/** How long a workspace restore waits without queue progress before its lock
 * times out: 10 minutes, or `PAPERCLIP_WORKSPACE_RESTORE_LOCK_WAIT_MS` (1 s to 1 h). */
export function workspaceRestoreLockWaitMs(): number {
  const configured = Number(process.env.PAPERCLIP_WORKSPACE_RESTORE_LOCK_WAIT_MS);
  return Number.isFinite(configured) && configured >= 1000 ? Math.min(configured, 60 * 60_000) : WORKSPACE_RESTORE_LOCK_WAIT_MS;
}

function snapshotsMatch(left: DirectorySnapshot, right: DirectorySnapshot): boolean {
  if (left.entries.size !== right.entries.size) return false;
  for (const [relative, entry] of left.entries) {
    if (!entriesMatch(entry, right.entries.get(relative))) return false;
  }
  return true;
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  conflictPolicy?: "reject";
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
  /** Test seam only: runs after every preflight check and before the first write. */
  afterPreflight?: () => Promise<void>;
  /** Caller holds the target's writer lock and validated an immutable sparse
   * source. Unchanged entries need no payload and are never copied. */
  snapshots?: { source: DirectorySnapshot; current: DirectorySnapshot };
  /** Run log of a workspace copy-back: gets a line about every 30 s while the
   * merge waits for the target's lock, so a long teardown says why it waits. */
  onLockWaitProgress?: RuntimeProgressSink;
}): Promise<void> {
  const options = { exclude: input.baseline.exclude, ignoredPaths: input.baseline.ignoredPaths, diskBacked: true };
  const source = input.snapshots?.source ?? await captureDirectorySnapshot(input.sourceDir, options);
  try {
    // A source equal to its baseline deletes and copies nothing and cannot
    // conflict. With no hooks to run, it skips the lock, so read-only runs do
    // not queue behind other restores into the same workspace.
    if (!input.beforeApply && !input.afterApply && snapshotsMatch(input.baseline, source)) {
      await disposeDirectorySnapshot(input.snapshots?.current ?? null);
      return;
    }
    await withDirectoryMergeLock(input.targetDir, async (canonicalTargetDir) => {
      await input.beforeApply?.();
      // Strict preflight must see excluded children before a directory is
      // replaced. The merge still applies only the filtered source/baseline.
      const current = input.snapshots?.current ?? await captureDirectorySnapshot(canonicalTargetDir,
        input.conflictPolicy === "reject" ? { exclude: [], diskBacked: true } : options);
      try {
        if (input.conflictPolicy === "reject") {
          const conflicts = directoryMergeConflicts(input.baseline, source, current);
          if (conflicts.length) throw new DirectoryMergeConflict(conflicts);
        }
        const blocked = await blockedDirectoryReplacements(canonicalTargetDir, input.baseline, source);
        if (blocked.length) throw new DirectoryMergeConflict(blocked);
        const isApplied = (relative: string, entry: SnapshotEntry) =>
          !entriesMatch(input.baseline.entries.get(relative), entry) &&
          !(input.conflictPolicy === "reject" && entriesMatch(current.entries.get(relative), entry));
        const linked = await linkedAncestorConflicts(canonicalTargetDir, input.baseline, source, isApplied);
        if (linked.length) throw new DirectoryMergeConflict(linked);
        await input.afterPreflight?.();
        // A copy that was staged in the target root and then interrupted.
        await removeStaleStagingFiles(canonicalTargetDir, "");
        for (const [relative, baselineEntry] of orderedEntries(input.baseline)) {
          if (baselineEntry.kind === "dir" || source.entries.has(relative)) continue;
          if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
          const parent = await pinParentDirectory(canonicalTargetDir, relative, { absentBelowFile: true });
          if (!parent) continue;
          try {
            await fs.rm(path.join(parent.dir, path.posix.basename(relative)), { force: true });
          } finally { await parent.close(); }
        }
        // Reverse path order visits descendants before their parent directory.
        for (const [relative, entry] of orderedEntries(input.baseline, true)) {
          if (entry.kind === "dir" && !source.entries.has(relative)) await removeDirectoryDroppingStaleStaging(canonicalTargetDir, relative).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "ENOTDIR") throw error;
          });
        }
        for (const [relative, entry] of orderedEntries(source)) {
          if (isApplied(relative, entry)) await copySnapshotEntry(input.sourceDir, canonicalTargetDir, relative, entry);
        }
        await input.afterApply?.();
      } finally { await disposeDirectorySnapshot(current); }
    }, process.env, undefined, workspaceRestoreLockWaitMs(), input.onLockWaitProgress
      ? (wait) => input.onLockWaitProgress?.(describeDirectoryMergeLockWait(wait))
      : undefined);
  } finally { await disposeDirectorySnapshot(source); }
}

/** A run-log line: wait times and queue length only, never the lock path or a PID. */
function describeDirectoryMergeLockWait(wait: DirectoryMergeLockWait): string {
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  const details = [
    wait.holderAgeMs === undefined ? "another run holds it" : `another run has held it for ${seconds(wait.holderAgeMs)}`,
    ...(wait.ahead ? [`${wait.ahead} queued ahead`] : []),
  ];
  return `[paperclip] Waiting for the workspace merge lock: ${details.join(", ")} (waited ${seconds(wait.waitedMs)}).\n`;
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
