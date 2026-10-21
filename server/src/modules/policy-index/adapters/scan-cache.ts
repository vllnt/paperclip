/**
 * A bounded cache of `policy://` scans of stored text, keyed by what the text is: a content hash, or
 * a revision id. The key names the content, so a company never reads another company's entry: the
 * cached value is only the keys the text mentions. Hits move to the newest slot, and the oldest entry
 * goes first when the cache is full.
 */
export interface MentionScanCache {
  /** The cached keys, or undefined when this content was never scanned. A hit becomes the newest entry. */
  peek(cacheKey: string): string[] | undefined;
  set(cacheKey: string, keys: string[]): void;
  /** The cached keys, or the result of `scan`, which is then cached. */
  get(cacheKey: string, scan: () => string[] | Promise<string[]>): Promise<string[]>;
  readonly size: number;
}

export const MENTION_SCAN_CACHE_MAX_ENTRIES = 500;

export function createMentionScanCache(maxEntries = MENTION_SCAN_CACHE_MAX_ENTRIES): MentionScanCache {
  const entries = new Map<string, string[]>();
  const cache: MentionScanCache = {
    peek(cacheKey) {
      const hit = entries.get(cacheKey);
      if (!hit) return undefined;
      entries.delete(cacheKey);
      entries.set(cacheKey, hit);
      return hit;
    },
    set(cacheKey, keys) {
      entries.delete(cacheKey);
      entries.set(cacheKey, keys);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    async get(cacheKey, scan) {
      const hit = cache.peek(cacheKey);
      if (hit) return hit;
      const keys = await scan();
      cache.set(cacheKey, keys);
      return keys;
    },
    get size() {
      return entries.size;
    },
  };
  return cache;
}

/** Content-addressed, so one cache serves every caller in the process. */
export const sharedMentionScanCache: MentionScanCache = createMentionScanCache();
