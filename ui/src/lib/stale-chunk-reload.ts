/** Session storage key that remembers when the page last reloaded for a missing chunk. */
export const STALE_CHUNK_RELOAD_KEY = "paperclip:stale-chunk-reload-at";

/** A second reload inside this window is skipped, so a chunk that is really missing cannot loop. */
export const STALE_CHUNK_RELOAD_COOLDOWN_MS = 30_000;

interface ReloadTarget {
  addEventListener(type: "vite:preloadError", listener: (event: Event) => void): void;
  removeEventListener(type: "vite:preloadError", listener: (event: Event) => void): void;
  location: { reload(): void };
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
  navigator?: { onLine: boolean };
}

/**
 * Decides whether a missing-chunk error may reload the page now.
 *
 * @param lastReloadAt - The stored timestamp, or null when the page never reloaded for this reason.
 * @param now - The current time in milliseconds.
 * @returns True when no reload happened inside the cooldown window.
 */
export function canReloadForStaleChunk(lastReloadAt: string | null, now: number): boolean {
  if (lastReloadAt === null) return true;
  const previous = Number(lastReloadAt);
  return !Number.isFinite(previous) || now - previous >= STALE_CHUNK_RELOAD_COOLDOWN_MS;
}

/**
 * Reloads the page once when a lazy route chunk cannot be fetched.
 *
 * A tab that stays open across a deploy still runs the old entry script. The
 * old chunk names no longer exist on the server, so the first visit to a page
 * the tab never opened fails. A reload fetches the new entry script, which
 * names the current chunks. Without the reload, the route error boundary shows
 * an error until the user reloads by hand.
 *
 * @param target - The window to watch. Defaults to the global window.
 * @param now - A clock, for tests.
 * @returns A function that removes the listener.
 */
export function installStaleChunkReload(
  target: ReloadTarget = window,
  now: () => number = Date.now,
): () => void {
  const onPreloadError = (event: Event): void => {
    if (target.navigator?.onLine === false) return;
    let lastReloadAt: string | null = null;
    try {
      lastReloadAt = target.sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY);
    } catch {
      return;
    }
    if (!canReloadForStaleChunk(lastReloadAt, now())) return;
    event.preventDefault();
    try {
      target.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(now()));
    } catch {
      return;
    }
    target.location.reload();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
