/**
 * In-process map of every enabled event source and its resolved secret. The
 * public ingress must not touch the database per request: an unauthenticated
 * flood of random ids would otherwise become a database flood, and resolving a
 * secret writes an access event.
 *
 * The map is complete, so an id that is not in it is unknown and answered
 * without a lookup. It is reloaded as a whole, by one single-flight `loadAll`:
 * - every source create, update, rotate or archive marks it dirty, and the next
 *   request reloads it, so a rotated or disabled source stops working at once;
 * - the TTL is a backstop for writes this process did not see (another instance).
 *
 * `loadAll` receives the previous map so it can keep a secret it has already
 * resolved instead of resolving every secret again on each reload.
 */

export const EVENT_SOURCE_CACHE_TTL_MS = 30_000;
/** After a failed backstop reload, keep serving the previous map for this long before trying again. */
const REFRESH_RETRY_MS = 5_000;

export interface EventSourceCache<T> {
  /** Resolves a source from the map. Never queries the database for an id it does not hold. */
  get(publicId: string): Promise<T | null>;
  /** Drops one source (or all of them when called with no id) and forces the next request to reload. */
  invalidate(publicId?: string): void;
  /** Loads the map (called at boot). Returns the number of sources loaded. */
  preload(): Promise<number>;
}

export function createEventSourceCache<T>(options: {
  loadAll: (previous: ReadonlyMap<string, T>) => Promise<Array<{ publicId: string; value: T }>>;
  ttlMs?: number;
  now?: () => number;
}): EventSourceCache<T> {
  const ttlMs = options.ttlMs ?? EVENT_SOURCE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let entries = new Map<string, T>();
  let loadedAt: number | null = null;
  // A mutation seen by this process: the map must not be served until it has been reloaded.
  let dirty = true;
  // A reload that started before an invalidation must not publish what it read.
  let generation = 0;
  let inflight: Promise<number> | null = null;

  function isStale(): boolean {
    return dirty || loadedAt === null || now() - loadedAt >= ttlMs;
  }

  function reload(): Promise<number> {
    if (!inflight) {
      const startedGeneration = generation;
      inflight = options
        .loadAll(entries)
        .then((all) => {
          if (startedGeneration !== generation) return 0;
          entries = new Map(all.map(({ publicId, value }) => [publicId, value]));
          loadedAt = now();
          dirty = false;
          return all.length;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function ensureFresh(): Promise<void> {
    while (isStale()) {
      try {
        await reload();
      } catch (err) {
        // A failed backstop reload keeps serving the previous map for a short while.
        // A map that a mutation made dirty, or that was never loaded, is never served.
        if (dirty || loadedAt === null) throw err;
        loadedAt = now() - ttlMs + REFRESH_RETRY_MS;
      }
    }
  }

  return {
    async get(publicId) {
      await ensureFresh();
      return entries.get(publicId) ?? null;
    },
    invalidate(publicId) {
      generation += 1;
      dirty = true;
      if (publicId === undefined) entries = new Map();
      else entries.delete(publicId);
    },
    async preload() {
      return reload();
    },
  };
}
