/**
 * In-process cache of event sources and their resolved secrets. Authenticating
 * an ingress request must not touch the database (an unauthenticated flood
 * would otherwise become a database flood), and resolving a secret writes an
 * access event, so both are done once per source and then served from here.
 *
 * Freshness: every source create, update, rotate or archive invalidates its
 * entry immediately; the TTL is only a backstop for writes this process did not
 * see. Unknown ids are negative-cached so probing with random ids costs one
 * lookup per id per TTL, and the negative cache is bounded.
 */

export const EVENT_SOURCE_CACHE_TTL_MS = 30_000;
const NEGATIVE_CACHE_MAX_ENTRIES = 10_000;

export interface EventSourceCache<T> {
  get(publicId: string): Promise<T | null>;
  /** Drops one source, or all of them when called with no id. */
  invalidate(publicId?: string): void;
  /** Warm the cache with every loadable source (called at boot). */
  preload(): Promise<number>;
}

export function createEventSourceCache<T>(options: {
  load: (publicId: string) => Promise<T | null>;
  loadAll: () => Promise<Array<{ publicId: string; value: T }>>;
  ttlMs?: number;
  now?: () => number;
}): EventSourceCache<T> {
  const ttlMs = options.ttlMs ?? EVENT_SOURCE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const unknown = new Map<string, number>();
  // A load that started before an invalidation must not repopulate the cache with what it read.
  let generation = 0;

  return {
    async get(publicId) {
      const currentTime = now();
      const hit = entries.get(publicId);
      if (hit && hit.expiresAt > currentTime) return hit.value;
      const missUntil = unknown.get(publicId);
      if (missUntil !== undefined && missUntil > currentTime) return null;

      const startedGeneration = generation;
      const value = await options.load(publicId);
      const stillCurrent = startedGeneration === generation;
      if (value === null) {
        entries.delete(publicId);
        if (stillCurrent) {
          if (unknown.size >= NEGATIVE_CACHE_MAX_ENTRIES) unknown.clear();
          unknown.set(publicId, now() + ttlMs);
        }
        return null;
      }
      if (stillCurrent) {
        unknown.delete(publicId);
        entries.set(publicId, { value, expiresAt: now() + ttlMs });
      }
      return value;
    },
    invalidate(publicId) {
      generation += 1;
      if (publicId === undefined) {
        entries.clear();
        unknown.clear();
        return;
      }
      entries.delete(publicId);
      unknown.delete(publicId);
    },
    async preload() {
      const startedGeneration = generation;
      const all = await options.loadAll();
      if (startedGeneration !== generation) return 0;
      const expiresAt = now() + ttlMs;
      for (const { publicId, value } of all) entries.set(publicId, { value, expiresAt });
      return all.length;
    },
  };
}
