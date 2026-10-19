const STORAGE_PREFIX = "paperclip:live-run-cards";

function storageKey(companyId: string, scope: string): string {
  return `${STORAGE_PREFIX}:${companyId}:${scope}`;
}

/**
 * How many run cards the live-run panel showed the last time its runs loaded
 * for this company and scope, or `null` when that is not known. The query cache
 * is empty on a fresh page load, so the browser keeps the count to size the
 * loading placeholder like the content that will replace it.
 */
export function readLiveRunCardCount(companyId: string, scope: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey(companyId, scope));
    return raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** Remembers the card count of a finished load. Storage failures are ignored. */
export function writeLiveRunCardCount(companyId: string, scope: string, count: number): void {
  try {
    const key = storageKey(companyId, scope);
    if (window.localStorage.getItem(key) !== String(count)) {
      window.localStorage.setItem(key, String(count));
    }
  } catch {
    // The count only sizes a placeholder; a full or blocked store changes nothing else.
  }
}
