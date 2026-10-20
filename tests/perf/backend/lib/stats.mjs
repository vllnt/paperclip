/**
 * Statistics for the backend perf harness. Node built-ins only.
 */

/** Linear-interpolated quantile of an unsorted list, `q` in [0, 1]. */
export function quantile(values, q) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values) {
  return quantile(values, 0.5);
}

function binomialCdf(k, n) {
  let total = 0;
  let term = 0.5 ** n;
  for (let i = 0; i <= k; i += 1) {
    total += term;
    term = (term * (n - i)) / (i + 1);
  }
  return total;
}

/**
 * The largest rank k (1-based) whose distribution-free interval for the
 * median, from the k-th smallest to the k-th largest of n values, covers at
 * least `coverage`. Returns 0 when no such interval exists (n < 6 at 95%).
 */
export function medianIntervalRank(n, coverage = 0.95) {
  let best = 0;
  for (let k = 1; k <= Math.floor(n / 2); k += 1) {
    if (1 - 2 * binomialCdf(k - 1, n) >= coverage) best = k;
  }
  return best;
}

/**
 * Decides a gated row from paired differences (percent, positive = worse),
 * as section 8 of the plan states: pass when the upper end of the 95%
 * interval of the median is at most the threshold, fail when the lower end
 * is above it, inconclusive otherwise.
 */
export function decideRow(differences, thresholdPercent) {
  const n = differences.length;
  const k = medianIntervalRank(n);
  if (k === 0) return { n, verdict: "inconclusive", reason: "too few pairs", median: median(differences) };
  const sorted = [...differences].sort((a, b) => a - b);
  const low = sorted[k - 1];
  const high = sorted[n - k];
  const verdict = high <= thresholdPercent ? "pass" : low > thresholdPercent ? "fail" : "inconclusive";
  return { n, k, median: median(differences), low, high, threshold: thresholdPercent, verdict };
}

/** Pairs a gated row needs, from the standard deviation of its A/A differences. */
export function pairsNeeded(aaDifferences, thresholdPercent) {
  const n = aaDifferences.length;
  const mean = aaDifferences.reduce((sum, value) => sum + value, 0) / n;
  const variance = aaDifferences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  return { sd, needed: Math.max(10, Math.ceil(((3.5 * sd) / thresholdPercent) ** 2)) };
}

/** (candidate - base) as a percent of base. */
export function percentChange(base, candidate) {
  return ((candidate - base) / base) * 100;
}
