import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-run temp entries that Paperclip creates directly in `os.tmpdir()`, and
 * the sweep that removes the ones a dead process left behind.
 *
 * A creator's `finally` cannot run when its process dies (a restart, a lost
 * run, a killed worker), so an entry under a swept prefix is held in a
 * process-wide registry while it is in use. The holding process refreshes the
 * entry's change time every {@link PAPERCLIP_TEMP_TOUCH_INTERVAL_MS}, well
 * inside the sweep's age limit. The sweep removes an entry only when this
 * process does not hold it and no process has changed it within the limit.
 */

/**
 * The prefixes the sweep may remove. Every creator of one of these prefixes
 * creates its entry with {@link createPaperclipTempDir}, so an entry in use is
 * held or recently touched. Key material comes first, so the sweep removes it
 * before anything else.
 */
export const SWEPT_PAPERCLIP_TEMP_PREFIXES = [
  "paperclip-ssh-key-",
  "paperclip-ssh-known-hosts-",
  "paperclip-ssh-sync-back-",
  "paperclip-ssh-bundle-",
  "paperclip-workspace-baseline-",
  "paperclip-codex-home-sync-",
  "paperclip-bridge-asset-",
] as const;

/** How often a process refreshes the change time of the entries it holds. */
export const PAPERCLIP_TEMP_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

/** The smallest age limit the sweep accepts: four touch intervals. */
export const MIN_PAPERCLIP_TEMP_SWEEP_MAX_AGE_MS = 4 * PAPERCLIP_TEMP_TOUCH_INTERVAL_MS;

/** The counts one sweep reports. `freedBytes` is the apparent size of the removed files. */
export interface PaperclipTempSweepResult {
  removed: number;
  freedBytes: number;
  /** Entries this process holds. */
  held: number;
  /** Entries some process changed within the age limit. */
  recent: number;
  failed: number;
}

// Kept on globalThis so two loaded copies of this module share one registry.
const HELD_ENTRIES_KEY = Symbol.for("paperclip.heldTempEntries");
let touchTimer: NodeJS.Timeout | null = null;

function heldEntries(): Set<string> {
  const existing: unknown = Reflect.get(globalThis, HELD_ENTRIES_KEY);
  if (existing instanceof Set) return existing;
  const created = new Set<string>();
  Reflect.set(globalThis, HELD_ENTRIES_KEY, created);
  return created;
}

function syncTouchTimer(): void {
  const held = heldEntries();
  if (held.size > 0 && !touchTimer) {
    touchTimer = setInterval(() => void touchHeldPaperclipTempEntries(), PAPERCLIP_TEMP_TOUCH_INTERVAL_MS);
    touchTimer.unref();
  } else if (held.size === 0 && touchTimer) {
    clearInterval(touchTimer);
    touchTimer = null;
  }
}

/**
 * Creates a `0700` directory in `os.tmpdir()` and holds it until
 * {@link removePaperclipTempDir} removes it.
 *
 * @param prefix - The entry name prefix, for example `paperclip-ssh-key-`.
 * @returns The absolute directory path.
 */
export async function createPaperclipTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  heldEntries().add(dir);
  syncTouchTimer();
  return dir;
}

/**
 * Removes a directory from {@link createPaperclipTempDir} and stops holding
 * it, even when the removal fails, so a later sweep can retry it.
 *
 * @param dir - The path {@link createPaperclipTempDir} returned.
 */
export async function removePaperclipTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    heldEntries().delete(dir);
    syncTouchTimer();
  }
}

/** Whether this process holds `entry`. */
export function isPaperclipTempEntryHeld(entry: string): boolean {
  return heldEntries().has(entry);
}

/**
 * Refreshes the change time of every entry this process holds, and stops
 * holding an entry that no longer exists.
 */
export async function touchHeldPaperclipTempEntries(): Promise<void> {
  const held = heldEntries();
  const now = new Date();
  await Promise.all([...held].map(async (entry) => {
    await fs.utimes(entry, now, now).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") held.delete(entry);
    });
  }));
  syncTouchTimer();
}

async function entryBytes(entry: string): Promise<number> {
  const stats = await fs.lstat(entry).catch(() => null);
  if (!stats) return 0;
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const child of await fs.readdir(entry).catch(() => [])) {
    total += await entryBytes(path.join(entry, child));
  }
  return total;
}

/**
 * Removes the swept-prefix directories in `tmpDir` that this process does not
 * hold and that no process changed within `maxAgeMs`. It skips symlinks,
 * files, and entries another user owns.
 *
 * @param options.maxAgeMs - The age limit, raised to {@link MIN_PAPERCLIP_TEMP_SWEEP_MAX_AGE_MS}.
 * @param options.tmpDir - The directory to sweep; `os.tmpdir()` by default.
 * @param options.now - The current time in milliseconds; `Date.now()` by default.
 * @returns The counts and the bytes freed.
 */
export async function sweepPaperclipTempEntries(options: {
  maxAgeMs: number;
  tmpDir?: string;
  now?: number;
}): Promise<PaperclipTempSweepResult> {
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = Math.max(options.maxAgeMs, MIN_PAPERCLIP_TEMP_SWEEP_MAX_AGE_MS);
  const uid = process.getuid?.();
  const result: PaperclipTempSweepResult = { removed: 0, freedBytes: 0, held: 0, recent: 0, failed: 0 };
  const candidates = (await fs.readdir(tmpDir).catch(() => []))
    .map((name) => ({ name, rank: SWEPT_PAPERCLIP_TEMP_PREFIXES.findIndex((prefix) => name.startsWith(prefix)) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank);
  for (const { name } of candidates) {
    const entry = path.join(tmpDir, name);
    if (isPaperclipTempEntryHeld(entry)) {
      result.held += 1;
      continue;
    }
    const stats = await fs.lstat(entry).catch(() => null);
    if (!stats?.isDirectory() || (uid !== undefined && stats.uid !== uid)) continue;
    // The change time, unlike the modification time, cannot be set back, so
    // an archive extracted into the entry cannot make it look old.
    if (now - stats.ctimeMs < maxAgeMs) {
      result.recent += 1;
      continue;
    }
    const bytes = await entryBytes(entry);
    try {
      await fs.rm(entry, { recursive: true, force: true });
      result.removed += 1;
      result.freedBytes += bytes;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
