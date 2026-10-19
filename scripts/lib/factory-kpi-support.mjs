// Supporting metrics for scripts/factory-throughput-kpi.mjs: where open PRs are stuck and how long
// reviews take. They explain the headline number and never feed the done/not-done verdict.

import { GhError, fetchOpenPrs, mapLimit } from "./factory-kpi-github.mjs";
import { DAY_MS, HOUR_MS, median, percentile } from "./factory-kpi-metrics.mjs";

/** One state per open PR, first match wins: the thing that has to move first. */
export const OPEN_STATES = ["draft", "conflicts", "ci_failing", "ci_pending", "changes_requested", "waiting_review", "ready"];

const CI_FAILING = new Set(["FAILURE", "ERROR"]);
const CI_PENDING = new Set(["PENDING", "EXPECTED"]);

export function classifyOpenPr(pr) {
  if (pr.draft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  if (CI_FAILING.has(pr.checks)) return "ci_failing";
  if (CI_PENDING.has(pr.checks)) return "ci_pending";
  // GitHub's own decision wins; it is null when the branch does not require reviews, and then the
  // latest decision of each reviewer stands in: one open change request blocks, an approval releases.
  const decisions = pr.decisions ?? [];
  const decision =
    pr.reviewDecision ??
    (decisions.includes("CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : decisions.includes("APPROVED") ? "APPROVED" : null);
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "APPROVED") return "ready";
  return "waiting_review";
}

/**
 * Counts by state, plus the PR that has waited longest for a first review.
 * `mergeableUnknown`: GitHub computes mergeability lazily, so those PRs may still hide a conflict.
 */
export function summarizeOpen(prs, nowMs) {
  const byState = Object.fromEntries(OPEN_STATES.map((state) => [state, 0]));
  let oldest = null;
  let mergeableUnknown = 0;
  for (const pr of prs) {
    byState[classifyOpenPr(pr)] += 1;
    if (!pr.draft && pr.mergeable === "UNKNOWN") mergeableUnknown += 1;
    if (!pr.draft && !pr.reviewed) {
      const waitingHours = (nowMs - pr.readyAtMs) / HOUR_MS;
      if (!oldest || waitingHours > oldest.hours) oldest = { number: pr.number, hours: waitingHours };
    }
  }
  return { total: prs.length, byState, mergeableUnknown, oldestUnreviewed: oldest };
}

/** Ready-for-review to first review by someone else, over PRs merged in the window. */
export function reviewLatency(mergedPrs, endMs, windowMs = DAY_MS) {
  const merged = mergedPrs.filter((pr) => pr.mergedAtMs > endMs - windowMs && pr.mergedAtMs <= endMs);
  const hours = merged
    .filter((pr) => pr.firstReviewAtMs !== null)
    .map((pr) => Math.max(0, (pr.firstReviewAtMs - pr.readyAtMs) / HOUR_MS));
  return {
    merged: merged.length,
    reviewed: hours.length,
    unreviewed: merged.length - hours.length,
    p50Hours: median(hours),
    p90Hours: percentile(hours, 90),
  };
}

/**
 * Open-PR states per repo and review latency across repos. A repo whose open PRs cannot be read
 * is listed with its error: a missing supporting number is shown as missing, never as zero.
 */
export async function collectSupport(gh, { repos, mergedPrs, endMs }) {
  const open = await mapLimit(repos, (repo) =>
    fetchOpenPrs(gh, repo).then(
      (r) => ({ repo, complete: r.complete, ...summarizeOpen(r.prs, endMs) }),
      (error) => ({ repo, error: { kind: error instanceof GhError ? error.kind : "other", message: error.message } }),
    ),
  );
  const readable = open.filter((r) => !r.error);
  const byState = Object.fromEntries(OPEN_STATES.map((state) => [state, readable.reduce((n, r) => n + r.byState[state], 0)]));
  const oldest = readable
    .filter((r) => r.oldestUnreviewed)
    .map((r) => ({ repo: r.repo, ...r.oldestUnreviewed }))
    .sort((a, b) => b.hours - a.hours)[0];
  return {
    open: {
      repos: open,
      total: readable.reduce((n, r) => n + r.total, 0),
      byState,
      oldestUnreviewed: oldest ?? null,
      complete: open.every((r) => !r.error && r.complete),
    },
    review: reviewLatency(mergedPrs, endMs),
  };
}
