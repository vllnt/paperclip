/**
 * The limits and the cursor logic that keep one scheduled sync inside the host's time budget for a job (300 s per run of the job,
 * for every company together). A run walks what changed on GitHub since the last run, not the whole history, and ends at its own
 * budget with its place saved; the next run goes on from there.
 */

/** One company's run ends at the first check after this. */
export const RUN_BUDGET_MS = 120_000;
/** The job starts no company after this; a run that is already going stops at its own budget. Leaves room for one slow call. */
export const JOB_BUDGET_MS = 200_000;
/** Every issue is looked at again this often, in case an event or a GitHub update was missed. */
export const SWEEP_INTERVAL_MS = 6 * 3_600_000;
/** A full pass that listed nothing starts the recent-changes cursor this far before the pass began (GitHub's clock is not ours). */
export const HEAD_MARGIN_MS = 3_600_000;
/** GitHub's `since` may or may not include the exact second; asking one second earlier makes sure it does. */
export const CURSOR_OVERLAP_MS = 1_000;
export const SYNC_PAGE_SIZE = 100;
/** Tasks that need a second look (edited here, or failed last time). Beyond this, the full pass finds the rest. */
export const QUEUE_LIMIT = 500;
export const QUEUE_PER_REPOSITORY = 100;
/** An issue in a repository that no project links is only fetched one by one: at most this many per run, none more often than this. */
export const TRACKED_PER_RUN = 10;
export const TRACKED_RECHECK_MS = 300_000;

/** Where a repository's sync stands. Times are GitHub update times (ISO 8601), except `startedAt` and `sweptAt` (this worker's clock). */
export interface RepoCursor {
  /** The newest update time that the recent-changes walk has finished. None until the first full pass ends: that pass is the first walk. */
  head?: string;
  /** A full pass in progress: `since` is how far it has got. */
  sweep?: { startedAt: string; since?: string };
  /** When the last full pass started. */
  sweptAt?: string;
}

export interface UpdatedPage<T> {
  items: T[];
  nextPage: number | null;
  /** The newest update time on the page, pull requests included; null when the page is empty. */
  cursor: string | null;
}
export type WalkEnd = "done" | "budget" | "stopped";
export interface UpdatedWalk<T extends { updatedAt: string }> {
  from: string | undefined;
  deadline: number;
  /** Null stops the walk (the company was disconnected). */
  fetchPage(since: string | undefined, page: number): Promise<UpdatedPage<T> | null>;
  /** Handles one page in order and returns how many of its items it finished: fewer than all when the deadline came first. */
  visit(items: T[]): Promise<number>;
  /** Saves the place after a page is finished, or after the last item finished when the deadline came mid-page. */
  commit(since: string): Promise<void>;
}

/**
 * Walks a listing sorted by update time, oldest first, in steps that can stop anywhere and resume. After a page the walk asks
 * again from that page's newest update time instead of turning to the next page: an issue that changes during the walk moves
 * to the end of the listing, and a page number would then skip the issue that took its place. Only a page whose issues all
 * share the cursor's time (no progress) turns to the next page.
 * @returns "done" at the end of the listing, "budget" at the deadline, "stopped" when `fetchPage` returned null.
 */
export async function walkUpdated<T extends { updatedAt: string }>(walk: UpdatedWalk<T>): Promise<WalkEnd> {
  let since = walk.from, page = 1;
  const later = (time: string | null): time is string => time !== null && (since === undefined || Date.parse(time) > Date.parse(since));
  for (;;) {
    if (Date.now() >= walk.deadline) return "budget";
    const result = await walk.fetchPage(since, page);
    if (!result) return "stopped";
    const finished = await walk.visit(result.items);
    if (finished < result.items.length) {
      // The finished items are the oldest of the page. Asking again from just before the last of them re-lists the items that
      // share its time, so the next run goes on from there instead of redoing the page.
      const last = newestUpdate(result.items.slice(0, finished));
      if (later(last)) await walk.commit(last);
      return "budget";
    }
    const { cursor, nextPage } = result;
    const advanced = later(cursor);
    if (advanced) { since = cursor; await walk.commit(cursor); }
    if (nextPage === null) return "done";
    page = advanced ? 1 : nextPage;
  }
}

/** The newest update time among listed issues, for a listing that did not report one. */
export function newestUpdate(items: ReadonlyArray<{ updatedAt: string }>): string | null {
  return items.reduce<string | null>((newest, item) => Number.isFinite(Date.parse(item.updatedAt)) && (newest === null || Date.parse(item.updatedAt) > Date.parse(newest)) ? item.updatedAt : newest, null);
}

/** `since` for the request that resumes at a cursor. */
export function resumeFrom(cursor: string): string {
  return new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString();
}

/** A saved time, or undefined when it is missing or does not parse (the walk then starts from the beginning). */
export function validTime(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * The full pass to work on, if one is due: the one in progress, a new one when the interval ended or a re-read was asked for
 * (`resyncAt`: the settings were saved), or none. A pass that started before the ask is started again.
 */
export function currentSweep(cursor: RepoCursor, resyncAt: string | undefined, now: number): RepoCursor["sweep"] | undefined {
  const askedAfter = (time: string) => resyncAt !== undefined && Date.parse(resyncAt) > Date.parse(time);
  const fresh = { startedAt: new Date(now).toISOString() };
  if (cursor.sweep) return askedAfter(cursor.sweep.startedAt) ? fresh : cursor.sweep;
  const swept = validTime(cursor.sweptAt);
  return swept === undefined || now - Date.parse(swept) >= SWEEP_INTERVAL_MS || askedAfter(swept) ? fresh : undefined;
}
