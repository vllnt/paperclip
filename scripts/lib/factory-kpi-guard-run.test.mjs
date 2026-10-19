import assert from "node:assert/strict";
import test from "node:test";
import { GhError, normalizeMergedPr } from "./factory-kpi-github.mjs";
import { collectGuard, collectRegression } from "./factory-kpi-guard-run.mjs";
import { HOUR, checkRun, detailNode, fakeGh, mergedNode } from "./factory-kpi-test-helpers.mjs";

const END = Date.parse("2026-10-18T12:00:00Z");
const DAY = 24 * HOUR;
const RULES = "REST repos/o/a/rules/branches/main";
const PROTECTION = "REST repos/o/a/branches/main/protection";
const requireCi = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } };
const notProtected = new GhError("notfound", "Branch not protected", 404);

// PR `n` merged n hours before END, with a green "ci" run finished 10 minutes before the merge.
const mergedAt = (n) => END - n * HOUR;
const prNode = (n) => mergedNode(n, mergedAt(n));
const greenDetail = (n, over = {}) =>
  detailNode(n, mergedAt(n), { checks: [checkRun("ci", "SUCCESS", mergedAt(n) - 10 * 60_000)], ...over });
const repoFixture = (numbers, details) => ({
  merged: numbers.map(prNode),
  details: Object.fromEntries(numbers.map((n) => [n, details?.[n] ?? greenDetail(n)])),
});
const fetchedFor = (repo, numbers) => ({
  repo,
  defaultBranch: "main",
  prs: numbers.map((n) => normalizeMergedPr(repo, prNode(n))),
});
const prKeys = (cache) => Object.keys(cache).filter((key) => !key.startsWith("@"));
const detailCalls = (gh) => gh.calls.filter((c) => c.kind === "graphql");
const collect = (gh, numbers, over = {}) =>
  collectGuard(gh, { fetched: [fetchedFor("o/a", numbers)], endMs: END, guardDays: 3, cache: {}, detailBudget: 120, ...over });

test("collectGuard passes a repo whose merges all had green required checks", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2, 3]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const guard = await collect(gh, [1, 2, 3]);
  assert.equal(guard.overall, "pass");
  assert.equal(guard.repos[0].merges, 3);
  assert.deepEqual(guard.repos[0].counts, { ok: 3, violation: 0, unknown: 0, unenforced: 0 });
  assert.equal(detailCalls(gh).length, 1, "three PRs share one aliased request");
});

test("collectGuard reports the PR and the reason when a required check was failing", async () => {
  const bad = detailNode(2, mergedAt(2), { checks: [checkRun("ci", "FAILURE", mergedAt(2) - 10 * 60_000)] });
  const gh = fakeGh({ "o/a": repoFixture([1, 2, 3], { 2: bad }), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const guard = await collect(gh, [1, 2, 3]);
  assert.equal(guard.overall, "fail");
  assert.deepEqual(guard.repos[0].violations, [{ number: 2, reasons: ['required check "ci" failing'] }]);
});

test("collectGuard calls a repo with no required checks unenforced and counts failing checks", async () => {
  const bad = detailNode(1, mergedAt(1), { checks: [checkRun("build", "FAILURE", mergedAt(1) - 10 * 60_000)] });
  const gh = fakeGh({ "o/a": repoFixture([1, 2], { 1: bad }), [RULES]: [], [PROTECTION]: notProtected });
  const guard = await collect(gh, [1, 2]);
  assert.equal(guard.overall, "unenforced");
  assert.equal(guard.repos[0].failingAtHead, 1);
});

test("collectGuard says unknown, never pass, when the rules cannot be read", async () => {
  const denied = new GhError("forbidden", "Resource not accessible by integration", 403);
  const gh = fakeGh({ "o/a": repoFixture([1]), [RULES]: denied, [PROTECTION]: denied });
  const guard = await collect(gh, [1]);
  assert.equal(guard.overall, "unknown");
  assert.match(guard.repos[0].enforcement.errors[0], /forbidden/);
});

test("collectGuard caches judged merges and does not fetch them twice", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = {};
  await collect(gh, [1, 2], { cache });
  assert.deepEqual(Object.keys(cache).sort(), ["@rules:o/a", "o/a#1", "o/a#2"]);
  const before = detailCalls(gh).length;
  const again = await collect(gh, [1, 2], { cache });
  assert.equal(detailCalls(gh).length, before, "no new detail request");
  assert.equal(again.overall, "pass");
  assert.equal(again.repos[0].merges, 2);
});

test("collectGuard keeps a cached violation visible", async () => {
  const bad = detailNode(1, mergedAt(1), { checks: [] });
  const gh = fakeGh({ "o/a": repoFixture([1], { 1: bad }), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = {};
  await collect(gh, [1], { cache });
  const calls = detailCalls(gh).length;
  const again = await collect(gh, [1], { cache });
  assert.equal(detailCalls(gh).length, calls, "the violation came from the cache");
  assert.equal(again.overall, "fail");
  assert.deepEqual(again.repos[0].violations, [{ number: 1, reasons: ['required check "ci" missing'] }]);
});

test("collectGuard does not cache an unverifiable merge, so the next run tries again", async () => {
  const late = detailNode(1, mergedAt(1), { checks: [checkRun("ci", "SUCCESS", mergedAt(1) + 20 * 60_000)] });
  const gh = fakeGh({ "o/a": repoFixture([1], { 1: late }), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = {};
  const first = await collect(gh, [1], { cache });
  assert.equal(first.overall, "unknown");
  assert.deepEqual(prKeys(cache), []);
  await collect(gh, [1], { cache });
  assert.equal(detailCalls(gh).length, 2);
});

test("collectGuard stays inside the detail budget, newest merges first, and says what is missing", async () => {
  const numbers = [1, 2, 3, 4, 5];
  const gh = fakeGh({ "o/a": repoFixture(numbers), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const guard = await collect(gh, numbers, { detailBudget: 2 });
  assert.equal(guard.overall, "unknown");
  assert.equal(guard.repos[0].pending, 3);
  assert.equal(guard.repos[0].merges, 5);
  const asked = [...detailCalls(gh)[0].query.matchAll(/p(\d+):pullRequest/g)].map((m) => Number(m[1]));
  assert.deepEqual(asked, [1, 2], "the most recent merges are judged first");
});

test("collectGuard fills the cache across runs until nothing is pending", async () => {
  const numbers = [1, 2, 3, 4];
  const gh = fakeGh({ "o/a": repoFixture(numbers), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = {};
  assert.equal((await collect(gh, numbers, { cache, detailBudget: 2 })).overall, "unknown");
  assert.equal((await collect(gh, numbers, { cache, detailBudget: 2 })).overall, "pass");
});

test("the detail budget is shared equally across repositories", async () => {
  const gh = fakeGh({
    "o/a": repoFixture([1, 2, 3]),
    "o/b": repoFixture([4, 5, 6]),
    [RULES]: [requireCi],
    [PROTECTION]: notProtected,
    "REST repos/o/b/rules/branches/main": [requireCi],
    "REST repos/o/b/branches/main/protection": notProtected,
  });
  const guard = await collectGuard(gh, {
    fetched: [fetchedFor("o/a", [1, 2, 3]), fetchedFor("o/b", [4, 5, 6])],
    endMs: END,
    guardDays: 3,
    cache: {},
    detailBudget: 4,
  });
  assert.deepEqual(guard.repos.map((r) => r.pending), [1, 1], "a busy first repo cannot starve the second");
  assert.equal(guard.overall, "unknown");
});

test("what one repository does not use goes to the next", async () => {
  const gh = fakeGh({
    "o/a": repoFixture([1]),
    "o/b": repoFixture([4, 5, 6, 7, 8]),
    [RULES]: [requireCi],
    [PROTECTION]: notProtected,
    "REST repos/o/b/rules/branches/main": [requireCi],
    "REST repos/o/b/branches/main/protection": notProtected,
  });
  const guard = await collectGuard(gh, {
    fetched: [fetchedFor("o/a", [1]), fetchedFor("o/b", [4, 5, 6, 7, 8])],
    endMs: END,
    guardDays: 3,
    cache: {},
    detailBudget: 4,
  });
  assert.deepEqual(guard.repos.map((r) => r.pending), [0, 2]);
});

test("a failing detail request leaves the merges pending and the repo unknown, with the reason", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const failing = {
    ...gh,
    graphql: async (query, vars) => {
      if (vars.first === undefined) throw new GhError("ratelimit", "API rate limit exceeded", 403);
      return gh.graphql(query, vars);
    },
  };
  const guard = await collect(failing, [1, 2]);
  assert.equal(guard.overall, "unknown");
  assert.equal(guard.repos[0].pending, 2);
  assert.match(guard.repos[0].detailError, /ratelimit: API rate limit exceeded/);
});

test("a merge whose detail is missing from the response stays pending", async () => {
  const gh = fakeGh({ "o/a": { merged: [prNode(1)], details: {} }, [RULES]: [requireCi], [PROTECTION]: notProtected });
  const guard = await collect(gh, [1]);
  assert.equal(guard.repos[0].pending, 1);
  assert.equal(guard.overall, "unknown");
});

test("merges older than the guard window are ignored and stale cache entries are dropped", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 72, 100, -1]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = { "o/a#99": { v: "ok", r: [], f: 0, at: END - 5 * DAY }, "o/a#98": { v: "ok", r: [], f: 0, at: END - 3 * DAY } };
  const guard = await collect(gh, [1, 72, 100, -1], { cache });
  assert.equal(guard.repos[0].merges, 1, "merged exactly 72 h ago, 100 h ago or after the end is outside the (end-3d, end] window");
  assert.deepEqual(prKeys(cache), ["o/a#1"], "entries at or beyond the window edge are pruned");
  assert.ok(cache["@rules:o/a"], "the rules fingerprint is not pruned with the verdicts");
});

test("an unexpected failure in one repo is reported for that repo and does not hide the others", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const guard = await collectGuard(gh, {
    fetched: [{ repo: "o/x", defaultBranch: "main" }, fetchedFor("o/a", [1])],
    endMs: END,
    guardDays: 3,
    cache: {},
    detailBudget: 120,
  });
  assert.equal(guard.overall, "unknown");
  assert.equal(guard.repos[0].state, "unknown");
  assert.match(guard.repos[0].detailError, /^other: /);
  assert.equal(guard.repos[1].state, "pass");
});

test("a thrown error while reading the rules makes the repo unknown, not passing", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const broken = { ...gh, rest: () => { throw new TypeError("boom"); } };
  const guard = await collect(broken, [1]);
  assert.equal(guard.overall, "unknown");
  assert.match(guard.repos[0].enforcement.errors[0], /other: boom/);
});

test("an empty repository list, a truncated listing and an unreadable repository are never a pass", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const none = await collectGuard(gh, { fetched: [], endMs: END, guardDays: 3, cache: {}, detailBudget: 120 });
  assert.equal(none.overall, "unknown");
  const truncated = await collect(gh, [1], { fetched: [{ ...fetchedFor("o/a", [1]), complete: false }] });
  assert.equal(truncated.overall, "unknown");
  assert.equal(truncated.repos[0].truncated, true);
  const failed = await collect(gh, [1], { fetched: [fetchedFor("o/a", [1]), { repo: "o/z", error: { kind: "forbidden", message: "denied" } }] });
  assert.equal(failed.overall, "unknown");
  assert.equal(failed.repos[1].detailError, "forbidden: denied");
});

test("rules that are only partly modeled give unknown and are not cached", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2]), [RULES]: [requireCi, { type: "workflows", parameters: {} }], [PROTECTION]: notProtected });
  const cache = {};
  const guard = await collect(gh, [1, 2], { cache });
  assert.equal(guard.overall, "unknown");
  assert.equal(guard.repos[0].counts.unknown, 2);
  assert.deepEqual(Object.keys(cache), [], "judged under partial rules, so asked again once they are readable");
});

test("a change of required checks makes merges from before it unknown instead of judging them by the new rules", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2, 3]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = { "@rules:o/a": { fp: "0000000000000000", since: null }, "o/a#1": { v: "ok", r: [], f: 0, at: mergedAt(1) } };
  const guard = await collect(gh, [1, 2, 3], { cache });
  assert.deepEqual(guard.repos[0].counts, { ok: 1, violation: 0, unknown: 2, unenforced: 0 }, "the cached verdict stays; the rest cannot be judged");
  assert.equal(guard.overall, "unknown");
  assert.equal(detailCalls(gh).length, 0, "nothing is fetched for merges that cannot be judged");
  assert.equal(cache["@rules:o/a"].since, END);
  // The next run: same rules, still unknown for the older merges, but a merge after the change is judged.
  const gh2 = fakeGh({ "o/a": repoFixture([1, 2, 3]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const later = await collect(gh2, [1, 2, 3], { cache, endMs: END + HOUR });
  assert.equal(later.repos[0].counts.unknown, 2);
  assert.equal(cache["@rules:o/a"].since, END);
});

test("a rules change older than the whole guard window no longer matters", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = {};
  await collect(gh, [1, 2], { cache });
  cache["@rules:o/a"].since = END - 4 * DAY;
  delete cache["o/a#1"];
  const guard = await collect(gh, [1, 2], { cache });
  assert.equal(guard.overall, "pass");
  assert.equal(cache["@rules:o/a"].since, null);
});

test("a failing second batch keeps the verdicts of the first and reports the error", async () => {
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  const gh = fakeGh({ "o/a": repoFixture(numbers), [RULES]: [requireCi], [PROTECTION]: notProtected });
  let batches = 0;
  const flaky = {
    ...gh,
    graphql: async (query, vars) => {
      if (vars.first !== undefined) return gh.graphql(query, vars);
      batches += 1;
      if (batches === 2) throw new GhError("network", "cannot reach GitHub");
      return gh.graphql(query, vars);
    },
  };
  const cache = {};
  const guard = await collect(flaky, numbers, { cache });
  assert.equal(guard.repos[0].counts.ok, 15);
  assert.equal(guard.repos[0].pending, 5);
  assert.match(guard.repos[0].detailError, /network: cannot reach GitHub/);
  assert.equal(prKeys(cache).length, 15, "what was read is kept");
});

test("collectRegression compares the last 7 days with a pinned baseline", () => {
  const prs = [];
  for (let i = 1; i <= 40; i += 1) {
    prs.push({ mergedAtMs: END - i * HOUR, title: i <= 8 ? "hotfix: x" : `feat: ${i}`, headRef: "feat/x", labels: [] });
  }
  prs.push({ mergedAtMs: END - 8 * DAY, title: "hotfix: old", headRef: "x", labels: [] });
  const r = collectRegression({ prs, endMs: END, baseline: { events: 2, total: 39 }, baselineAtMs: null });
  assert.equal(r.baselineSource, "pinned");
  assert.deepEqual([r.current.events, r.current.total], [8, 40]);
  assert.equal(r.state, "regression", "20% against a 5% baseline");
});

test("collectRegression can compute the baseline from the week before a pinned moment", () => {
  const atMs = END - 7 * DAY;
  const prs = [];
  for (let i = 1; i <= 40; i += 1) prs.push({ mergedAtMs: atMs - i * HOUR, title: i === 1 ? "revert: y" : `feat: ${i}`, headRef: "x", labels: [] });
  prs.push({ mergedAtMs: atMs - 10 * DAY, title: "revert: older than the baseline week", headRef: "x", labels: [] });
  for (let i = 1; i <= 40; i += 1) prs.push({ mergedAtMs: END - i * HOUR, title: `feat: ${i}`, headRef: "x", labels: [] });
  const r = collectRegression({ prs, endMs: END, baseline: null, baselineAtMs: atMs });
  assert.equal(r.baselineSource, "computed");
  assert.deepEqual([r.baseline.events, r.baseline.total], [1, 40]);
  assert.equal(r.state, "insufficient_data", "no revert or hotfix this week, nothing to alarm on");
  assert.equal(collectRegression({ prs, endMs: END, baseline: null, baselineAtMs: null }).state, "no_baseline");
});

test("a merge at the very moment the rules changed is judged by them; one a millisecond earlier is unknown", async () => {
  const atChange = normalizeMergedPr("o/a", mergedNode(10, END));
  const before = normalizeMergedPr("o/a", mergedNode(11, END - 1));
  const gh = fakeGh({
    "o/a": { merged: [], details: { 10: detailNode(10, END, { checks: [checkRun("ci", "SUCCESS", END - 10 * 60_000)] }) } },
    [RULES]: [requireCi],
    [PROTECTION]: notProtected,
  });
  const cache = { "@rules:o/a": { fp: "0000000000000000", since: null } };
  const guard = await collect(gh, [], { cache, fetched: [{ repo: "o/a", defaultBranch: "main", prs: [atChange, before] }] });
  assert.deepEqual(guard.repos[0].counts, { ok: 1, violation: 0, unknown: 1, unenforced: 0 });
  assert.match(detailCalls(gh)[0].query, /p10:pullRequest/);
  assert.doesNotMatch(detailCalls(gh)[0].query, /p11:pullRequest/);
});

test("a rules change exactly one guard window old is forgotten", async () => {
  const gh = fakeGh({ "o/a": repoFixture([1, 2]), [RULES]: [requireCi], [PROTECTION]: notProtected });
  const cache = {};
  await collect(gh, [1, 2], { cache });
  cache["@rules:o/a"].since = END - 3 * DAY;
  await collect(gh, [1, 2], { cache });
  assert.equal(cache["@rules:o/a"].since, null);
});

test("a violation judged under rules that were only partly readable is reported but not cached", async () => {
  const denied = new GhError("forbidden", "Resource not accessible by integration", 403);
  const bad = detailNode(1, mergedAt(1), { checks: [] });
  const gh = fakeGh({ "o/a": repoFixture([1], { 1: bad }), [RULES]: [requireCi], [PROTECTION]: denied });
  const cache = {};
  const guard = await collect(gh, [1], { cache });
  assert.equal(guard.overall, "fail", "a definite miss stays a violation");
  assert.deepEqual(Object.keys(cache), [], "but it is judged again once the rules are readable");
});

test("a repository's share of the budget is rounded up, so an odd budget is spent in full", async () => {
  const gh = fakeGh({
    "o/a": repoFixture([1, 2, 3, 4]),
    "o/b": repoFixture([5, 6, 7, 8]),
    [RULES]: [requireCi],
    [PROTECTION]: notProtected,
    "REST repos/o/b/rules/branches/main": [requireCi],
    "REST repos/o/b/branches/main/protection": notProtected,
  });
  const guard = await collectGuard(gh, {
    fetched: [fetchedFor("o/a", [1, 2, 3, 4]), fetchedFor("o/b", [5, 6, 7, 8])],
    endMs: END,
    guardDays: 3,
    cache: {},
    detailBudget: 5,
  });
  assert.deepEqual(guard.repos.map((r) => r.pending), [1, 2], "3 + 2, not 2 + 3");
});

test("renaming a required check is a rules change, even though the number of checks stays the same", async () => {
  const build = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } };
  const cache = {};
  await collect(fakeGh({ "o/a": repoFixture([1]), [RULES]: [requireCi], [PROTECTION]: notProtected }), [1], { cache });
  const renamed = fakeGh({ "o/a": repoFixture([1, 2]), [RULES]: [build], [PROTECTION]: notProtected });
  const guard = await collect(renamed, [1, 2], { cache });
  assert.deepEqual(guard.repos[0].counts, { ok: 1, violation: 0, unknown: 1, unenforced: 0 }, "merge 2 is not held to the new name");
  assert.equal(detailCalls(renamed).length, 0);
});
