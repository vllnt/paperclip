// Collects guard inputs from GitHub and applies factory-kpi-guard.mjs. Verdicts are cached by
// "repo#number" so a merged PR is fetched once (the caller persists the cache between runs).

import { createHash } from "node:crypto";
import { DAY_MS } from "./factory-kpi-metrics.mjs";
import {
  countChanges,
  evaluateMerge,
  evaluateRegression,
  resolveEnforcement,
  summarizeRepoGuard,
  worstState,
} from "./factory-kpi-guard.mjs";
import { fetchEnforcement, fetchMergeDetails } from "./factory-kpi-github.mjs";

export const DEFAULT_DETAIL_BUDGET = 120;
const CACHEABLE = new Set(["ok", "violation", "unenforced"]);

const cacheKey = (pr) => `${pr.repo}#${pr.number}`;
export const RULES_KEY_PREFIX = "@rules:"; // cache keys with this prefix hold a rules fingerprint, not a verdict

// What the rules asked for, as a short string. A verdict is only reusable under the rules it was judged by.
function fingerprint(enforcement) {
  const parts = [enforcement.state, enforcement.requiredApprovals, enforcement.mergeQueue ? "mq" : "", ...enforcement.requiredChecks];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

async function guardRepo(gh, fetched, { endMs, guardDays, cache, budget, share }) {
  const windowPrs = fetched.prs
    .filter((pr) => pr.mergedAtMs > endMs - guardDays * DAY_MS && pr.mergedAtMs <= endMs)
    .sort((a, b) => b.mergedAtMs - a.mergedAtMs);
  const enforcement = resolveEnforcement(await fetchEnforcement(gh, fetched.repo, fetched.defaultBranch));
  // The rules in force when an older merge happened are not recoverable. When the fingerprint changes
  // between two runs, merges not yet judged from before that moment are `unknown` rather than being
  // held to rules that did not exist yet (or excused by rules that no longer apply).
  const rulesKey = `${RULES_KEY_PREFIX}${fetched.repo}`;
  const rules = fingerprint(enforcement);
  const prior = cache[rulesKey];
  let since = prior?.since ?? null;
  if (!enforcement.partial && prior && prior.fp !== rules) since = endMs;
  if (since !== null && since <= endMs - guardDays * DAY_MS) since = null;
  const results = [];
  const todo = [];
  for (const pr of windowPrs) {
    const hit = cache[cacheKey(pr)];
    if (hit) results.push({ number: pr.number, verdict: hit.v, reasons: hit.r, failingAtHead: hit.f });
    else if (since !== null && pr.mergedAtMs < since) {
      results.push({ number: pr.number, verdict: "unknown", reasons: ["required checks changed after this merge"], failingAtHead: 0 });
    } else todo.push(pr);
  }
  const batch = todo.slice(0, Math.max(0, share));
  budget.left -= batch.length;
  let pending = todo.length - batch.length;
  let detailError = null;
  if (batch.length) {
    const { details, error } = await fetchMergeDetails(gh, fetched.repo, batch.map((pr) => pr.number));
    if (error) detailError = `${error.kind ?? "other"}: ${error.message}`;
    for (const pr of batch) {
      const detail = details.get(pr.number);
      if (!detail) {
        pending += 1;
        continue;
      }
      const judged = evaluateMerge({ detail, enforcement });
      results.push({ number: pr.number, ...judged });
      // A verdict from rules that were only partly readable could change once they are readable.
      if (CACHEABLE.has(judged.verdict) && !enforcement.partial) {
        cache[cacheKey(pr)] = { v: judged.verdict, r: judged.reasons, f: judged.failingAtHead ?? 0, at: pr.mergedAtMs };
      }
    }
  }
  if (!enforcement.partial) cache[rulesKey] = { fp: rules, since };
  return summarizeRepoGuard({
    repo: fetched.repo,
    enforcement,
    results,
    pending,
    detailError,
    truncated: fetched.complete === false,
  });
}

const UNREADABLE = { state: "unknown", requiredChecks: [], requiredApprovals: 0, mergeQueue: false, partial: true, errors: [] };

/** `fetched` holds one entry per repository, including the ones that could not be read (`error`). */
export async function collectGuard(gh, { fetched, endMs, guardDays, cache, detailBudget }) {
  const budget = { left: detailBudget };
  const repos = [];
  for (const [index, f] of fetched.entries()) {
    if (f.error) {
      repos.push(summarizeRepoGuard({ repo: f.repo, enforcement: UNREADABLE, results: [], detailError: `${f.error.kind}: ${f.error.message}` }));
      continue;
    }
    // Each repository gets an equal share of what is left, so a busy one cannot starve the others.
    const share = Math.ceil(budget.left / (fetched.length - index));
    try {
      repos.push(await guardRepo(gh, f, { endMs, guardDays, cache, budget, share }));
    } catch (error) {
      repos.push(
        summarizeRepoGuard({
          repo: f.repo,
          enforcement: UNREADABLE,
          results: [],
          detailError: `${error.kind ?? "other"}: ${error.message}`,
        }),
      );
    }
  }
  // Verdicts older than the window can never be asked for again. Rules fingerprints (`@` keys) stay.
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith(RULES_KEY_PREFIX) && entry.at <= endMs - guardDays * DAY_MS) delete cache[key];
  }
  // No repository to judge is not a pass.
  const overall = repos.length ? worstState(repos.map((r) => r.state)) : "unknown";
  return { windowDays: guardDays, overall, repos };
}

/** Trailing 7 day revert + hotfix share against a pinned or computed baseline. */
export function collectRegression({ prs, endMs, baseline, baselineAtMs }) {
  const week = 7 * DAY_MS;
  const current = countChanges(prs.filter((pr) => pr.mergedAtMs > endMs - week && pr.mergedAtMs <= endMs));
  let base = null;
  let source = null;
  if (baseline) {
    base = { ...baseline, reverts: null, hotfixes: null };
    source = "pinned";
  } else if (baselineAtMs !== null && baselineAtMs !== undefined) {
    base = countChanges(prs.filter((pr) => pr.mergedAtMs > baselineAtMs - week && pr.mergedAtMs <= baselineAtMs));
    source = "computed";
  }
  return { ...evaluateRegression({ current, baseline: base }), baselineSource: source };
}
