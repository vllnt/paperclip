// Quality guard for scripts/factory-throughput-kpi.mjs. Pure functions, no I/O.
//
// A bare "0 violations" would also be printed when the guard could not look, so every
// verdict is one of: pass | fail | unenforced | unknown. Only `pass` lets the KPI be "done".

const PASSING_CHECK = new Set(["pass"]);
const MIN_REGRESSION_TOTAL = 30;
const MIN_REGRESSION_EVENTS = 3;
const MAX_BASELINE_SHARE = 0.5; // above this, "twice the baseline" is more than 100% and could never fire
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const RULES_PAGE = 100;
// Ruleset rules that can require checks or deployments this module does not model.
const UNMODELED_REQUIRED_RULES = new Set(["workflows", "required_deployments", "code_scanning"]);
const REGRESSION_FACTOR = 2;
const REGRESSION_DELTA = 0.05;

const REVERT_TITLE = /^revert(\([^)]*\))?!?:|^revert\s+["“']/i;
const REVERT_BRANCH = /^revert-\d+-|^revert\//i; // GitHub's "Revert" button names the branch revert-<number>-<name>
const HOTFIX_TITLE = /^hotfix(\([^)]*\))?!?:/i;
const HOTFIX_BRANCH = /^hotfix[-/]/i;

/** "revert" | "hotfix" | "normal". Explicit markers only: a plain `fix:` is not a hotfix. */
export function classifyChange(pr) {
  const labels = new Set((pr.labels ?? []).map((l) => l.toLowerCase()));
  if (labels.has("revert") || REVERT_TITLE.test(pr.title ?? "") || REVERT_BRANCH.test(pr.headRef ?? "")) return "revert";
  if (labels.has("hotfix") || HOTFIX_TITLE.test(pr.title ?? "") || HOTFIX_BRANCH.test(pr.headRef ?? "")) return "hotfix";
  return "normal";
}

export function countChanges(prs) {
  const counts = { reverts: 0, hotfixes: 0, total: prs.length };
  for (const pr of prs) {
    const kind = classifyChange(pr);
    if (kind === "revert") counts.reverts += 1;
    if (kind === "hotfix") counts.hotfixes += 1;
  }
  return { ...counts, events: counts.reverts + counts.hotfixes };
}

/**
 * Compare the trailing share of reverts + hotfixes with the baseline share.
 * Small samples never raise an alarm: below the minimum denominator or event count the
 * state is `insufficient_data`, and the counts are always returned for the reader.
 */
export function evaluateRegression({ current, baseline }) {
  const share = current.total ? current.events / current.total : null;
  const baseShare = baseline && baseline.total ? baseline.events / baseline.total : null;
  const out = { current: { ...current, share }, baseline: baseline ? { ...baseline, share: baseShare } : null };
  const unusable = !baseline || baseShare === null || baseline.total < MIN_REGRESSION_TOTAL || baseShare > MAX_BASELINE_SHARE;
  if (unusable) return { ...out, state: "no_baseline" };
  if (current.total < MIN_REGRESSION_TOTAL || current.events < MIN_REGRESSION_EVENTS) {
    return { ...out, state: "insufficient_data" };
  }
  const threshold = Math.max(baseShare * REGRESSION_FACTOR, baseShare + REGRESSION_DELTA);
  return { ...out, state: share > threshold ? "regression" : "ok" };
}

export function parseBaseline(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? "").trim());
  if (!match || Number(match[2]) === 0 || Number(match[1]) > Number(match[2])) return null;
  return { events: Number(match[1]), total: Number(match[2]) };
}

/**
 * Required checks and approvals for a branch from its rulesets and classic branch protection.
 * `unknown` means a source could not be read and the readable one required nothing.
 */
export function resolveEnforcement({ rules, rulesError, protection, protectionError }) {
  const checks = new Set();
  const notes = [];
  let approvals = 0;
  let mergeQueue = false;
  let unmodeled = false;
  if ((rules ?? []).length >= RULES_PAGE) {
    unmodeled = true;
    notes.push("more rules than one page");
  }
  for (const rule of rules ?? []) {
    if (UNMODELED_REQUIRED_RULES.has(rule.type)) {
      unmodeled = true;
      notes.push(`rule type ${rule.type} is not evaluated`);
    }
    if (rule.type === "required_status_checks") {
      for (const c of rule.parameters?.required_status_checks ?? []) checks.add(c.context);
    }
    if (rule.type === "pull_request") approvals = Math.max(approvals, rule.parameters?.required_approving_review_count ?? 0);
    if (rule.type === "merge_queue") mergeQueue = true;
  }
  const status = protection?.required_status_checks;
  for (const context of status?.contexts ?? []) checks.add(context);
  for (const c of status?.checks ?? []) checks.add(c.context);
  approvals = Math.max(approvals, protection?.required_pull_request_reviews?.required_approving_review_count ?? 0);

  // "Branch not protected" is an answer; any other failure is a source we could not read.
  const unprotected = protectionError?.kind === "notfound" && /not protected/i.test(protectionError.message);
  const unreadable = Boolean(rulesError) || (Boolean(protectionError) && !unprotected);
  const requiredChecks = [...checks].sort();
  const enforced = requiredChecks.length > 0 || approvals > 0;
  return {
    state: enforced ? "enforced" : unreadable || unmodeled ? "unknown" : "unenforced",
    requiredChecks,
    requiredApprovals: approvals,
    mergeQueue,
    partial: unreadable || unmodeled,
    errors: [rulesError, protectionError].filter(Boolean).map((e) => `${e.kind}: ${e.message}`).concat(notes),
  };
}

/**
 * Judge one merged PR from its head-commit checks and reviews as they stood at merge time.
 * detail: { author, mergedAtMs, reviews: [{state, submittedAtMs, author}],
 *           checks: [{name, outcome: pass|fail|pending, atMs}], checksTruncated }
 */
export function evaluateMerge({ detail, enforcement }) {
  if (enforcement.state === "unknown") return { verdict: "unknown", reasons: ["enforcement unreadable"] };
  if (enforcement.mergeQueue) return { verdict: "unknown", reasons: ["merge queue: checks ran on the queue branch"] };
  if (detail.checksTruncated) return { verdict: "unknown", reasons: ["more checks than were read"] };
  if (detail.reviewsTruncated && enforcement.requiredApprovals > 0) return { verdict: "unknown", reasons: ["more reviews than were read"] };

  const beforeMerge = (check) => check.atMs !== null && check.atMs <= detail.mergedAtMs;
  const latest = (list) => list.reduce((a, b) => (a === null || b.atMs > a.atMs ? b : a), null);
  const failingAtHead = detail.checks.filter((c) => c.outcome === "fail" && beforeMerge(c)).length;

  if (enforcement.state === "unenforced") {
    return { verdict: "unenforced", reasons: ["no required checks or approvals configured"], failingAtHead };
  }

  const reasons = [];
  const unknownReasons = [];
  for (const name of enforcement.requiredChecks) {
    const runs = detail.checks.filter((c) => c.name === name);
    if (!runs.length) {
      reasons.push(`required check "${name}" missing`);
      continue;
    }
    const done = latest(runs.filter(beforeMerge));
    if (!done) {
      if (runs.some((c) => c.atMs !== null)) unknownReasons.push(`required check "${name}" only finished after the merge`);
      else reasons.push(`required check "${name}" not finished at merge`);
      continue;
    }
    if (!PASSING_CHECK.has(done.outcome)) reasons.push(`required check "${name}" ${done.outcome === "fail" ? "failing" : "not green"}`);
  }
  if (enforcement.requiredApprovals > 0) {
    // GitHub counts each reviewer's latest decision; comments neither give nor take an approval.
    const latest = new Map();
    const ordered = [...detail.reviews].sort((a, b) => a.submittedAtMs - b.submittedAtMs);
    for (const r of ordered) {
      const counts = REVIEW_STATES.has(r.state) && r.author && r.author !== detail.author && r.submittedAtMs <= detail.mergedAtMs;
      if (counts) latest.set(r.author, r.state);
    }
    const approvals = [...latest.values()].filter((state) => state === "APPROVED").length;
    if (approvals < enforcement.requiredApprovals) reasons.push(`approvals ${approvals}/${enforcement.requiredApprovals} at merge`);
  }
  if (reasons.length) return { verdict: "violation", reasons, failingAtHead };
  if (unknownReasons.length) return { verdict: "unknown", reasons: unknownReasons, failingAtHead };
  // Rules that could only be read in part may hide a requirement this PR did not meet.
  if (enforcement.partial) return { verdict: "unknown", reasons: ["enforcement only partly readable"], failingAtHead };
  return { verdict: "ok", reasons: [], failingAtHead };
}

const RANK = { fail: 3, unenforced: 2, unknown: 1, pass: 0 };

export function worstState(states) {
  return states.reduce((worst, s) => (RANK[s] > RANK[worst] ? s : worst), "pass");
}

/** Roll the per-PR verdicts of one repo up to pass | fail | unenforced | unknown. */
export function summarizeRepoGuard({ repo, enforcement, results, pending = 0, detailError = null, truncated = false }) {
  const counts = { ok: 0, violation: 0, unknown: 0, unenforced: 0 };
  const violations = [];
  let failingAtHead = 0;
  for (const { number, verdict, reasons, failingAtHead: failing = 0 } of results) {
    counts[verdict] += 1;
    failingAtHead += failing;
    if (verdict === "violation") violations.push({ number, reasons });
  }
  let state = "pass";
  if (counts.violation) state = "fail";
  else if (enforcement.state === "unenforced" || counts.unenforced) state = "unenforced";
  else if (enforcement.state === "unknown" || counts.unknown || pending || detailError || truncated) state = "unknown";
  return { repo, state, enforcement, merges: results.length + pending, counts, pending, failingAtHead, violations, detailError, truncated };
}

/**
 * Overall answer to "is the KPI really done": true only when throughput, the guard and the
 * revert/hotfix share all pass. A definite failure is false; an unreadable guard is unknown.
 */
export function computeVerdict({ sustained, guard, regression, complete = true }) {
  if (!guard) return { done: sustained.done, scope: "throughput", blockers: [] };
  const blockers = [];
  if (!complete) blockers.push("collection incomplete: a repository could not be read in full");
  if (sustained.done === false) blockers.push("throughput below target");
  if (sustained.done === null) blockers.push("throughput unknown (collection incomplete)");
  if (guard.overall === "fail") blockers.push("quality guard: merge with failing or missing required checks");
  if (guard.overall === "unenforced") blockers.push("quality guard: repository without required checks cannot prove zero bypass");
  if (guard.overall === "unknown") blockers.push("quality guard: could not be verified");
  if (regression.state === "regression") blockers.push("revert/hotfix share above baseline");
  if (regression.state === "no_baseline") blockers.push("revert/hotfix baseline missing or too small to compare with");
  const definite =
    sustained.done === false || guard.overall === "fail" || guard.overall === "unenforced" || regression.state === "regression";
  return { done: blockers.length === 0 ? true : definite ? false : null, scope: "full", blockers };
}
