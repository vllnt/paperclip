/**
 * In-process sliding-window counter keyed by an arbitrary string. The window is
 * split into one-second buckets, so memory per key is bounded by the window
 * length no matter how large the limit is (a source may allow 100k/min). The
 * key space is bounded too: spoofable inputs such as client IPs cannot grow the
 * map without limit.
 */

export interface SlidingWindowResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface SlidingWindowLimiter {
  /** Counts one hit against `key` unless the window is already at `limit`. */
  consume(key: string, limit: number): SlidingWindowResult;
}

const BUCKET_MS = 1000;

export function createSlidingWindowLimiter(options: {
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  /** Keys that are never evicted to make room (a shared ceiling that one sender must not be able to reset). */
  pinnedKeys?: readonly string[];
} = {}): SlidingWindowLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const bucketsPerWindow = Math.max(1, Math.ceil(windowMs / BUCKET_MS));
  const pinned = new Set(options.pinnedKeys ?? []);
  const hitsByKey = new Map<string, Map<number, number>>();

  function prune(buckets: Map<number, number>, currentBucket: number) {
    for (const index of buckets.keys()) {
      if (index <= currentBucket - bucketsPerWindow) buckets.delete(index);
    }
  }

  function evictIfFull(currentBucket: number) {
    if (hitsByKey.size < maxKeys) return;
    for (const [key, buckets] of hitsByKey) {
      prune(buckets, currentBucket);
      if (buckets.size === 0) hitsByKey.delete(key);
    }
    // Still full of live keys: drop the least recently used one rather than refuse service.
    if (hitsByKey.size >= maxKeys) {
      for (const key of hitsByKey.keys()) {
        if (pinned.has(key)) continue;
        hitsByKey.delete(key);
        break;
      }
    }
  }

  return {
    consume(key, limit) {
      const currentBucket = Math.floor(now() / BUCKET_MS);
      let buckets = hitsByKey.get(key);
      if (!buckets) {
        evictIfFull(currentBucket);
        buckets = new Map();
        hitsByKey.set(key, buckets);
      } else {
        prune(buckets, currentBucket);
        // Re-insert on touch so the oldest-inserted key is the least recently used one.
        hitsByKey.delete(key);
        hitsByKey.set(key, buckets);
      }
      let total = 0;
      let oldestBucket = currentBucket;
      for (const [index, count] of buckets) {
        total += count;
        if (index < oldestBucket) oldestBucket = index;
      }
      if (total >= limit) {
        return {
          allowed: false,
          limit,
          remaining: 0,
          retryAfterSeconds: Math.max(1, oldestBucket + bucketsPerWindow - currentBucket),
        };
      }
      buckets.set(currentBucket, (buckets.get(currentBucket) ?? 0) + 1);
      return { allowed: true, limit, remaining: Math.max(0, limit - total - 1), retryAfterSeconds: 0 };
    },
  };
}
