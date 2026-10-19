import type { EventRejectOutcome } from "@paperclipai/shared";

/**
 * Unauthenticated, rate-limited and duplicate requests are counted in memory
 * and flushed as one aggregated row per source per minute, so a flood costs no
 * per-request write while probing stays visible. The counters live in the
 * process: a restart loses the current minute, which is accepted.
 */

const MINUTE_MS = 60_000;
const MAX_BUCKETS = 2_000;

export interface RejectBucket {
  /** `null` for requests that matched no source. */
  sourceId: string | null;
  companyId: string | null;
  minuteStart: number;
  counts: Partial<Record<EventRejectOutcome, number>>;
  firstIp: string | null;
  lastIp: string | null;
}

export interface RejectCounters {
  record(input: { sourceId: string | null; companyId: string | null; outcome: EventRejectOutcome; ip: string | null }): void;
  /** Removes and returns the buckets of finished minutes (all of them with `all`). */
  drain(options?: { all?: boolean }): RejectBucket[];
}

export function createRejectCounters(options: { now?: () => number } = {}): RejectCounters {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, RejectBucket>();

  return {
    record({ sourceId, companyId, outcome, ip }) {
      const minuteStart = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
      const key = `${sourceId ?? "unknown"}:${minuteStart}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        // A flood of distinct minutes cannot happen, but the map stays bounded regardless.
        if (buckets.size >= MAX_BUCKETS) return;
        bucket = { sourceId, companyId, minuteStart, counts: {}, firstIp: ip, lastIp: ip };
        buckets.set(key, bucket);
      }
      bucket.counts[outcome] = (bucket.counts[outcome] ?? 0) + 1;
      bucket.lastIp = ip;
    },
    drain({ all = false } = {}) {
      const currentMinute = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
      const drained: RejectBucket[] = [];
      for (const [key, bucket] of buckets) {
        if (all || bucket.minuteStart < currentMinute) {
          drained.push(bucket);
          buckets.delete(key);
        }
      }
      return drained;
    },
  };
}
