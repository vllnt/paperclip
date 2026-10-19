import assert from "node:assert/strict";
import test from "node:test";
import { GhError, normalizeCheck } from "./factory-kpi-github.mjs";
import {
  classifyChange,
  computeVerdict,
  countChanges,
  evaluateMerge,
  evaluateRegression,
  parseBaseline,
  resolveEnforcement,
  summarizeRepoGuard,
  worstState,
} from "./factory-kpi-guard.mjs";

const MERGED = Date.parse("2026-10-18T10:00:00Z");
const before = (minutes) => MERGED - minutes * 60_000;
const after = (minutes) => MERGED + minutes * 60_000;
const check = (name, outcome, atMs) => ({ name, outcome, atMs });
const enforced = (over = {}) => ({
  state: "enforced",
  requiredChecks: ["ci"],
  requiredApprovals: 0,
  mergeQueue: false,
  partial: false,
  errors: [],
  ...over,
});
const detail = (over = {}) => ({ author: "agent", mergedAtMs: MERGED, reviews: [], checks: [], checksTruncated: false, ...over });

test("classifyChange uses explicit markers only", () => {
  const kind = (title, headRef = "feat/x", labels = []) => classifyChange({ title, headRef, labels });
  for (const title of ['Revert "feat: add x"', "revert: add x", "revert(ui): add x", "Revert 'x'", "REVERT: x"]) {
    assert.equal(kind(title), "revert", title);
  }
  assert.equal(kind("chore: undo", "revert-123-feature"), "revert", "the branch GitHub's Revert button creates");
  assert.equal(kind("chore: undo", "revert/feature"), "revert");
  assert.equal(kind("chore: undo", "feat/x", ["Revert"]), "revert");
  for (const title of ["hotfix: broken deploy", "hotfix(api)!: broken deploy", "Hotfix: x"]) assert.equal(kind(title), "hotfix", title);
  assert.equal(kind("chore: patch", "hotfix/db-pool"), "hotfix");
  assert.equal(kind("chore: patch", "feat/x", ["hotfix"]), "hotfix");
  for (const [title, head] of [
    ["fix: revert button colour", "feat/a"],
    ['docs: never revert "main" by hand', "docs/a"],
    ["docs: hotfix: policy", "docs/b"],
    ["feat: button style", "feat/revert-button-style"],
    ["feat: undo button", "revert-button"],
    ["feat: undo button", "revert-the-thing"],
    ["docs: explain the hotfix policy", "docs/hotfix-policy"],
    ["fix(api): handle null", "fix/null"],
    ["feat: reverting is easier", "feat/reverting"],
    ["", ""],
  ]) {
    assert.equal(kind(title, head), "normal", `${title} / ${head}`);
  }
});

test("countChanges sums reverts and hotfixes against all merges", () => {
  const prs = [{ title: 'Revert "x"' }, { title: "hotfix: y" }, { title: "feat: z" }, { title: "feat: w" }];
  assert.deepEqual(countChanges(prs), { reverts: 1, hotfixes: 1, total: 4, events: 2 });
});

test("evaluateRegression never alarms on small samples and always returns the counts", () => {
  const base = { events: 2, total: 39 };
  assert.equal(evaluateRegression({ current: { events: 5, total: 20 }, baseline: base }).state, "insufficient_data");
  assert.equal(evaluateRegression({ current: { events: 2, total: 200 }, baseline: base }).state, "insufficient_data");
  assert.equal(evaluateRegression({ current: { events: 5, total: 20 }, baseline: null }).state, "no_baseline");
  assert.equal(evaluateRegression({ current: { events: 5, total: 20 }, baseline: { events: 0, total: 0 } }).state, "no_baseline");
  const r = evaluateRegression({ current: { events: 5, total: 20 }, baseline: base });
  assert.equal(r.current.events, 5);
  assert.equal(r.baseline.total, 39);
});

test("evaluateRegression rejects a baseline that cannot detect anything", () => {
  const current = { events: 20, total: 100 };
  assert.equal(evaluateRegression({ current, baseline: { events: 2, total: 29 } }).state, "no_baseline", "under 30 merges");
  assert.equal(evaluateRegression({ current, baseline: { events: 2, total: 30 } }).state, "regression", "30 merges is enough");
  assert.equal(evaluateRegression({ current, baseline: { events: 16, total: 30 } }).state, "no_baseline", "more than half would make 2x impossible");
  assert.notEqual(evaluateRegression({ current, baseline: { events: 15, total: 30 } }).state, "no_baseline", "exactly half is allowed");
});

test("evaluateRegression applies its sample minimums inclusively", () => {
  const base = { events: 1, total: 40 }; // 2.5%: threshold is max(5%, 7.5%) = 7.5%
  const state = (events, total) => evaluateRegression({ current: { events, total }, baseline: base }).state;
  assert.equal(state(3, 30), "regression", "30 merges and 3 events is enough");
  assert.equal(state(3, 29), "insufficient_data");
  assert.equal(state(2, 30), "insufficient_data");
});

test("evaluateRegression flags a share above both 2x baseline and baseline + 5 points", () => {
  const base = { events: 4, total: 40 }; // 10%: threshold is max(20%, 15%) = 20%
  const state = (events, total) => evaluateRegression({ current: { events, total }, baseline: base }).state;
  assert.equal(state(20, 100), "ok", "exactly at the threshold is not a regression");
  assert.equal(state(21, 100), "regression");
  assert.equal(state(15, 100), "ok");
  const zero = { events: 0, total: 40 }; // threshold falls back to +5 points
  assert.equal(evaluateRegression({ current: { events: 5, total: 100 }, baseline: zero }).state, "ok");
  assert.equal(evaluateRegression({ current: { events: 6, total: 100 }, baseline: zero }).state, "regression");
});

test("parseBaseline accepts EVENTS/TOTAL only", () => {
  assert.deepEqual(parseBaseline("2/39"), { events: 2, total: 39 });
  assert.deepEqual(parseBaseline(" 0/10 "), { events: 0, total: 10 });
  assert.deepEqual(parseBaseline("5/5"), { events: 5, total: 5 });
  for (const bad of ["", "2", "2/0", "0/0", "5/3", "a/b", "2/39/1", null, undefined]) assert.equal(parseBaseline(bad), null, String(bad));
});

test("resolveEnforcement merges rulesets and classic protection", () => {
  const e = resolveEnforcement({
    rules: [
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "lint" }] } },
      { type: "pull_request", parameters: { required_approving_review_count: 1 } },
      { type: "required_signatures" },
    ],
    protection: { required_status_checks: { contexts: ["legacy"], checks: [{ context: "ci" }, { context: "types" }] }, required_pull_request_reviews: { required_approving_review_count: 2 } },
  });
  assert.equal(e.state, "enforced");
  assert.deepEqual(e.requiredChecks, ["ci", "legacy", "lint", "types"]);
  assert.equal(e.requiredApprovals, 2);
  assert.equal(e.mergeQueue, false);
});

test("resolveEnforcement counts approvals from either source and treats them as enforcement", () => {
  const fromRules = resolveEnforcement({ rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }] });
  assert.equal(fromRules.state, "enforced");
  assert.equal(fromRules.requiredApprovals, 1);
  const fromProtection = resolveEnforcement({
    rules: [],
    protection: { required_pull_request_reviews: { required_approving_review_count: 2 } },
  });
  assert.equal(fromProtection.state, "enforced");
  assert.equal(fromProtection.requiredApprovals, 2);
});

test("resolveEnforcement tells unenforced from unreadable", () => {
  const notProtected = new GhError("notfound", "Branch not protected", 404);
  assert.equal(resolveEnforcement({ rules: [], protectionError: notProtected }).state, "unenforced");
  assert.equal(resolveEnforcement({ rules: [{ type: "required_signatures" }], protectionError: notProtected }).state, "unenforced");
  const denied = new GhError("forbidden", "Resource not accessible by integration", 403);
  assert.equal(resolveEnforcement({ rules: [], protectionError: denied }).state, "unknown");
  assert.equal(resolveEnforcement({ rulesError: denied, protectionError: notProtected }).state, "unknown");
  assert.equal(resolveEnforcement({ rules: [], protectionError: new GhError("notfound", "Not Found", 404) }).state, "unknown");
});

test("resolveEnforcement stays enforced but partial when one source is unreadable", () => {
  const e = resolveEnforcement({
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }],
    protectionError: new GhError("forbidden", "denied", 403),
  });
  assert.equal(e.state, "enforced");
  assert.equal(e.partial, true);
  assert.match(e.errors[0], /forbidden/);
  assert.equal(resolveEnforcement({ rules: [{ type: "merge_queue" }] }).mergeQueue, true);
});

test("resolveEnforcement does not call rules it cannot model, or a full page of rules, complete", () => {
  const ci = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } };
  for (const type of ["workflows", "required_deployments", "code_scanning"]) {
    const e = resolveEnforcement({ rules: [ci, { type }] });
    assert.equal(e.partial, true, type);
    assert.match(e.errors.join(" "), new RegExp(type));
  }
  assert.equal(resolveEnforcement({ rules: [{ type: "workflows" }], protectionError: new GhError("notfound", "Branch not protected", 404) }).state, "unknown");
  const page = Array.from({ length: 100 }, () => ({ type: "creation" }));
  const full = resolveEnforcement({ rules: [ci, ...page.slice(1)] });
  assert.equal(full.partial, true);
  assert.match(full.errors.join(" "), /more rules than one page/);
  assert.equal(resolveEnforcement({ rules: [ci, ...page.slice(2)] }).partial, false, "99 rules is a whole answer");
});

test("evaluateMerge says unknown, not ok, when the rules were only partly readable", () => {
  const green = detail({ checks: [check("ci", "pass", before(10))] });
  assert.equal(evaluateMerge({ detail: green, enforcement: enforced({ partial: true }) }).verdict, "unknown");
  const red = detail({ checks: [check("ci", "fail", before(10))] });
  assert.equal(evaluateMerge({ detail: red, enforcement: enforced({ partial: true }) }).verdict, "violation", "a definite miss stays a violation");
});

test("evaluateMerge passes when every required check was green before the merge", () => {
  const r = evaluateMerge({ detail: detail({ checks: [check("ci", "pass", before(10)), check("extra", "fail", before(5))] }), enforcement: enforced() });
  assert.equal(r.verdict, "ok", "a failing optional check is not a violation");
  assert.equal(r.failingAtHead, 1);
});

test("evaluateMerge flags failing, missing and unfinished required checks", () => {
  const verdict = (checks) => evaluateMerge({ detail: detail({ checks }), enforcement: enforced() });
  assert.match(verdict([check("ci", "fail", before(10))]).reasons[0], /"ci" failing/);
  assert.match(verdict([]).reasons[0], /"ci" missing/);
  assert.match(verdict([check("ci", "pending", null)]).reasons[0], /not finished at merge/);
  assert.match(verdict([check("ci", "pending", before(1))]).reasons[0], /not green/);
  for (const checks of [[check("ci", "fail", before(10))], [], [check("ci", "pending", null)]]) assert.equal(verdict(checks).verdict, "violation");
});

test("evaluateMerge treats a result and an approval at the exact merge instant as before the merge", () => {
  const ok = evaluateMerge({ detail: detail({ checks: [check("ci", "pass", MERGED)] }), enforcement: enforced() });
  assert.equal(ok.verdict, "ok");
  const approved = evaluateMerge({
    detail: detail({ reviews: [{ state: "APPROVED", submittedAtMs: MERGED, author: "reviewer" }] }),
    enforcement: enforced({ requiredChecks: [], requiredApprovals: 1 }),
  });
  assert.equal(approved.verdict, "ok");
  const failed = evaluateMerge({ detail: detail({ checks: [check("ci", "fail", MERGED)] }), enforcement: enforced() });
  assert.equal(failed.verdict, "violation");
});

test("evaluateMerge uses the last result before the merge, and says unknown for later ones", () => {
  const verdict = (checks) => evaluateMerge({ detail: detail({ checks }), enforcement: enforced() });
  assert.equal(verdict([check("ci", "fail", before(30)), check("ci", "pass", before(10))]).verdict, "ok", "a re-run fixed it before the merge");
  assert.equal(verdict([check("ci", "pass", before(30)), check("ci", "fail", before(10))]).verdict, "violation");
  const late = verdict([check("ci", "pass", after(20))]);
  assert.equal(late.verdict, "unknown", "a result that only exists after the merge proves nothing");
  assert.match(late.reasons[0], /after the merge/);
  assert.equal(verdict([check("ci", "fail", after(5)), check("ci", "pass", before(10))]).verdict, "ok", "a failure after the merge is ignored");
});

test("evaluateMerge counts approvals by other people before the merge", () => {
  const e = enforced({ requiredChecks: [], requiredApprovals: 1 });
  const verdict = (reviews) => evaluateMerge({ detail: detail({ reviews }), enforcement: e });
  assert.equal(verdict([{ state: "APPROVED", submittedAtMs: before(5), author: "reviewer" }]).verdict, "ok");
  assert.equal(verdict([{ state: "APPROVED", submittedAtMs: before(5), author: "agent" }]).verdict, "violation", "self approval");
  assert.equal(verdict([{ state: "APPROVED", submittedAtMs: after(5), author: "reviewer" }]).verdict, "violation", "approved after merge");
  assert.equal(verdict([{ state: "COMMENTED", submittedAtMs: before(5), author: "reviewer" }]).verdict, "violation");
  assert.equal(verdict([{ state: "DISMISSED", submittedAtMs: before(5), author: "reviewer" }]).verdict, "violation");
  assert.match(verdict([]).reasons[0], /approvals 0\/1/);
  const twice = evaluateMerge({
    detail: detail({ reviews: [1, 2].map((n) => ({ state: "APPROVED", submittedAtMs: before(n), author: "same" })) }),
    enforcement: enforced({ requiredChecks: [], requiredApprovals: 2 }),
  });
  assert.equal(twice.verdict, "violation", "one person approving twice counts once");
});

test("evaluateMerge takes each reviewer's latest decision, as GitHub does", () => {
  const e = enforced({ requiredChecks: [], requiredApprovals: 1 });
  const r = (state, minutes, author = "reviewer") => ({ state, submittedAtMs: before(minutes), author });
  const verdict = (reviews, over = {}) => evaluateMerge({ detail: detail({ reviews, ...over }), enforcement: e }).verdict;
  assert.equal(verdict([r("APPROVED", 20), r("CHANGES_REQUESTED", 10)]), "violation", "approval withdrawn by a later change request");
  assert.equal(verdict([r("CHANGES_REQUESTED", 20), r("APPROVED", 10)]), "ok", "change request resolved by a later approval");
  assert.equal(verdict([r("APPROVED", 20), r("COMMENTED", 10)]), "ok", "a later comment does not take the approval back");
  assert.equal(verdict([r("APPROVED", 20), r("DISMISSED", 10)]), "violation");
  assert.equal(verdict([r("APPROVED", 5, null)]), "violation", "an account that no longer exists cannot be checked against the author");
  assert.equal(verdict([r("PENDING", 5)]), "violation");
  assert.equal(verdict([r("APPROVED", 20), r("CHANGES_REQUESTED", 5, "other")]), "ok", "another reviewer's request does not cancel it here");
  assert.equal(verdict([{ state: "APPROVED", submittedAtMs: before(10), author: "reviewer" }, { state: "CHANGES_REQUESTED", submittedAtMs: before(20), author: "reviewer" }]), "ok", "order in the list does not matter, time does");
  assert.equal(verdict([r("APPROVED", 5)], { reviewsTruncated: true }), "unknown", "50 reviews were read, there may be more");
  const noApprovalsNeeded = evaluateMerge({ detail: detail({ reviewsTruncated: true, checks: [check("ci", "pass", before(10))] }), enforcement: enforced() });
  assert.equal(noApprovalsNeeded.verdict, "ok", "reviews do not matter when none are required");
});

test("evaluateMerge refuses to guess for merge queues, truncated checks and unreadable rules", () => {
  assert.equal(evaluateMerge({ detail: detail(), enforcement: enforced({ mergeQueue: true }) }).verdict, "unknown");
  assert.equal(evaluateMerge({ detail: detail({ checksTruncated: true }), enforcement: enforced() }).verdict, "unknown");
  assert.equal(evaluateMerge({ detail: detail(), enforcement: { state: "unknown" } }).verdict, "unknown");
});

test("evaluateMerge marks a repo without required checks unenforced and still counts failing checks", () => {
  const r = evaluateMerge({
    detail: detail({ checks: [check("build", "fail", before(5)), check("lint", "pass", before(5)), check("late", "fail", after(5))] }),
    enforcement: { state: "unenforced", requiredChecks: [], requiredApprovals: 0, mergeQueue: false },
  });
  assert.equal(r.verdict, "unenforced");
  assert.equal(r.failingAtHead, 1);
});

test("normalizeCheck maps GitHub conclusions and statuses", () => {
  const run = (conclusion, status = "COMPLETED") => normalizeCheck({ __typename: "CheckRun", name: "c", status, conclusion, completedAt: "2026-10-18T09:00:00Z" });
  for (const ok of ["SUCCESS", "NEUTRAL", "SKIPPED"]) assert.equal(run(ok).outcome, "pass", ok);
  for (const bad of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]) assert.equal(run(bad).outcome, "fail", bad);
  assert.equal(run(null, "IN_PROGRESS").outcome, "pending");
  assert.equal(run(null, "IN_PROGRESS").atMs, null);
  assert.equal(run("SOMETHING_NEW").outcome, "pending", "an unrecognised conclusion is never read as green");
  assert.equal(run(null).outcome, "pending");
  assert.equal(run("SUCCESS").atMs, Date.parse("2026-10-18T09:00:00Z"));
  const status = (state) => normalizeCheck({ __typename: "StatusContext", context: "s", state, createdAt: "2026-10-18T09:00:00Z" });
  assert.equal(status("SUCCESS").outcome, "pass");
  assert.equal(status("ERROR").outcome, "fail");
  assert.equal(status("PENDING").outcome, "pending");
  assert.equal(status("EXPECTED").outcome, "pending");
});

test("summarizeRepoGuard never reports pass without evidence", () => {
  const ok = (n) => ({ number: n, verdict: "ok", reasons: [] });
  const sum = (over) => summarizeRepoGuard({ repo: "o/r", enforcement: enforced(), results: [ok(1)], ...over }).state;
  assert.equal(sum({}), "pass");
  assert.equal(sum({ results: [] }), "pass", "an enforced repo with no merges has nothing to violate");
  assert.equal(sum({ results: [ok(1), { number: 2, verdict: "violation", reasons: ["x"] }] }), "fail");
  assert.equal(sum({ results: [ok(1), { number: 2, verdict: "unknown", reasons: ["x"] }] }), "unknown");
  assert.equal(sum({ pending: 3 }), "unknown");
  assert.equal(sum({ truncated: true }), "unknown", "the merge list itself was cut short");
  assert.equal(sum({ detailError: "ratelimit: slow" }), "unknown");
  assert.equal(sum({ enforcement: { ...enforced(), state: "unknown" } }), "unknown");
  assert.equal(sum({ enforcement: { ...enforced(), state: "unenforced" } }), "unenforced");
  assert.equal(sum({ results: [{ number: 1, verdict: "unenforced", reasons: [] }] }), "unenforced", "old unverified merges still count after rules arrive");
  const failing = summarizeRepoGuard({
    repo: "o/r",
    enforcement: enforced(),
    results: [{ number: 7, verdict: "violation", reasons: ["required check \"ci\" failing"] }],
  });
  assert.deepEqual(failing.violations, [{ number: 7, reasons: ['required check "ci" failing'] }]);
});

test("worstState orders fail > unenforced > unknown > pass", () => {
  assert.equal(worstState([]), "pass");
  assert.equal(worstState(["pass", "unknown"]), "unknown");
  assert.equal(worstState(["unknown", "unenforced", "pass"]), "unenforced");
  assert.equal(worstState(["unenforced", "fail", "unknown"]), "fail");
});

test("computeVerdict is done only when throughput, guard and revert share all pass", () => {
  const sustained = (done) => ({ done });
  const guard = (overall) => ({ overall });
  const reg = (state) => ({ state });
  const v = (s, g, r) => computeVerdict({ sustained: sustained(s), guard: guard(g), regression: reg(r) });
  assert.equal(v(true, "pass", "ok").done, true);
  assert.equal(v(true, "pass", "insufficient_data").done, true);
  assert.equal(v(false, "pass", "ok").done, false);
  assert.equal(v(true, "fail", "ok").done, false);
  assert.equal(v(true, "unenforced", "ok").done, false, "zero bypass cannot be proven without required checks");
  assert.match(v(true, "unenforced", "ok").blockers[0], /cannot prove zero bypass/);
  assert.equal(v(true, "pass", "regression").done, false);
  assert.equal(v(true, "unknown", "ok").done, null);
  assert.equal(v(null, "pass", "ok").done, null);
  assert.equal(v(true, "pass", "no_baseline").done, null);
  assert.deepEqual(computeVerdict({ sustained: sustained(true), guard: null, regression: null }), { done: true, scope: "throughput", blockers: [] });
  const incomplete = computeVerdict({ sustained: sustained(true), guard: guard("pass"), regression: reg("ok"), complete: false });
  assert.equal(incomplete.done, null, "a repository that could not be read can hide a violation");
  assert.match(incomplete.blockers[0], /collection incomplete/);
  assert.equal(computeVerdict({ sustained: sustained(false), guard: guard("pass"), regression: reg("ok"), complete: false }).done, false, "a definite failure stays one");
  assert.match(v(true, "pass", "no_baseline").blockers[0], /missing or too small/);
});
