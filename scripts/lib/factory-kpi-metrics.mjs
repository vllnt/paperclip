// Pure metric helpers for scripts/factory-throughput-kpi.mjs.
// No I/O and no clock reads: callers pass the evaluation time in.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WINDOW_HOURS = [1, 6, 24];
export const DEFAULT_TARGET_PER_HOUR = 6;
export const DEFAULT_SUSTAIN_DAYS = 3;

const ROLLING_WINDOW_MS = 6 * HOUR_MS;
const TINY_PR_LINES = 10;

/**
 * A merged PR is `{ repo, number, mergedAtMs, createdAtMs, lines, ... }`.
 * Windows are half-open: (end - length, end].
 */
export function mergeTimes(prs) {
  return prs.map((pr) => pr.mergedAtMs).sort((a, b) => a - b);
}

// Index of the first element strictly greater than `value` in an ascending array.
function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function countBetween(sorted, startExclusive, endInclusive) {
  return upperBound(sorted, endInclusive) - upperBound(sorted, startExclusive);
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank percentile: always one of the observed values.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function windowRates(sorted, endMs, hours = WINDOW_HOURS) {
  return hours.map((h) => {
    const merged = countBetween(sorted, endMs - h * HOUR_MS, endMs);
    return { hours: h, merged, perHour: merged / h };
  });
}

/**
 * Minimum merges/hour over every 6 h window (t - 6 h, t] that lies fully inside (endMs - spanMs, endMs].
 * The count only rises when a merge enters the window and only falls when one leaves (at merge + 6 h),
 * so the minimum is at the first window or at the instant a merge leaves: those are the only
 * instants evaluated, which makes the result exact rather than sampled.
 */
export function rollingMinPerHour(sorted, endMs, spanMs = DAY_MS) {
  const first = endMs - spanMs + ROLLING_WINDOW_MS;
  if (first > endMs) return { windows: 0, minPerHour: null, worstEndMs: null };
  const instants = [first, endMs];
  for (const m of sorted) {
    const t = m + ROLLING_WINDOW_MS;
    if (t > first && t < endMs) instants.push(t);
  }
  let min = null;
  let worstEndMs = null;
  for (const t of instants) {
    const merged = countBetween(sorted, t - ROLLING_WINDOW_MS, t);
    if (min === null || merged < min) {
      min = merged;
      worstEndMs = t;
    }
  }
  return {
    windows: instants.length,
    minPerHour: min / (ROLLING_WINDOW_MS / HOUR_MS),
    worstEndMs,
  };
}

/**
 * Consecutive 24 h days (the newest ends at endMs) that meet the target. Day i meets it when every
 * 6 h window inside the newest i + 1 days has at least target * 6 merges, so a gap that straddles a
 * day boundary counts against both days. `complete` is false when any repo was truncated or failed:
 * counts are then lower bounds, so "met" is still true but "not met" is unknown.
 */
export function sustainedDays(sorted, endMs, { targetPerHour, days, complete }) {
  const perDay = [];
  for (let i = 0; i < days; i += 1) {
    const dayEnd = endMs - i * DAY_MS;
    const merged = countBetween(sorted, dayEnd - DAY_MS, dayEnd);
    const own = rollingMinPerHour(sorted, dayEnd, DAY_MS);
    const through = rollingMinPerHour(sorted, endMs, (i + 1) * DAY_MS);
    perDay.push({
      dayEndMs: dayEnd,
      merged,
      avgPerHour: merged / 24,
      rolling6hMinPerHour: own.minPerHour,
      throughDayMinPerHour: through.minPerHour,
      meetsTarget: through.minPerHour >= targetPerHour,
    });
  }
  let consecutive = 0;
  while (consecutive < days && perDay[consecutive].meetsTarget) consecutive += 1;
  const reached = consecutive >= days;
  return { days, consecutive, done: reached ? true : complete ? false : null, perDay };
}

// Size and lifetime of the merges in the last 24 h: a guard against inflating the count with trivial PRs.
export function prShape(prs, endMs) {
  const recent = prs.filter((pr) => pr.mergedAtMs > endMs - DAY_MS && pr.mergedAtMs <= endMs);
  const lines = recent.map((pr) => pr.lines);
  const lifetimesH = recent.map((pr) => (pr.mergedAtMs - pr.createdAtMs) / HOUR_MS);
  return {
    sample: recent.length,
    medianLines: median(lines),
    p90Lines: percentile(lines, 90),
    tinyShare: recent.length ? lines.filter((n) => n <= TINY_PR_LINES).length / recent.length : null,
    medianOpenToMergeHours: median(lifetimesH),
  };
}

export function buildThroughput({ prs, repos, endMs, targetPerHour, days, complete }) {
  const total = mergeTimes(prs);
  const byRepo = repos.map((repo) => {
    const times = mergeTimes(prs.filter((pr) => pr.repo === repo));
    return { repo, rates: windowRates(times, endMs) };
  });
  const rates = windowRates(total, endMs);
  const rolling = rollingMinPerHour(total, endMs, DAY_MS);
  return {
    targetPerHour,
    rates,
    rolling6hMin: rolling,
    byRepo,
    sustained: sustainedDays(total, endMs, { targetPerHour, days, complete }),
    shape: prShape(prs, endMs),
  };
}
