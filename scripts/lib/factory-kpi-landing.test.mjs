import assert from "node:assert/strict";
import test from "node:test";
import { GhError, fetchMergedPrs, normalizeMergedPr } from "./factory-kpi-github.mjs";
import { classifyMerge, collectLanding, fetchCarriers, stackedUnderLanded, summarizeLanding } from "./factory-kpi-landing.mjs";
import { HOUR, fakeGh, mergedNode } from "./factory-kpi-test-helpers.mjs";

const END = Date.parse("2026-10-18T12:00:00Z");
const pr = (number, over = {}) => ({
  repo: "o/a",
  number,
  baseRef: "main",
  headRef: `feat/${number}`,
  headOid: null,
  mergeOid: null,
  crossRepo: false,
  mergedAtMs: END - HOUR,
  ...over,
});
const carrier = (number, over = {}) => ({ number, state: "OPEN", baseRef: "main", headOid: "tip", ...over });

test("normalizeMergedPr keeps the merge commit, the head commit and whether the head is a fork", () => {
  const got = normalizeMergedPr("o/a", mergedNode(7, END, { headOid: "h7", mergeOid: "m7", crossRepo: true }));
  assert.equal(got.headOid, "h7");
  assert.equal(got.mergeOid, "m7");
  assert.equal(got.crossRepo, true);
  const bare = normalizeMergedPr("o/a", mergedNode(8, END));
  assert.equal(bare.mergeOid, null);
  assert.equal(bare.headOid, null);
  assert.equal(bare.crossRepo, false);
});

test("fetchMergedPrs hands back the merges into other branches, not only their count", async () => {
  const repos = { "o/a": { merged: [mergedNode(1, END - HOUR), mergedNode(2, END - 2 * HOUR, { base: "feat/x" })] } };
  const got = await fetchMergedPrs(fakeGh(repos), "o/a", { sinceMs: END - 24 * HOUR });
  assert.deepEqual(got.prs.map((p) => p.number), [1]);
  assert.deepEqual(got.otherMerged.map((p) => p.number), [2]);
  assert.equal(got.otherBaseMerged, 1);
});

test("classifyMerge: a PR opened from the branch carries the merge, the exact tip is the strongest proof", () => {
  const x = pr(5, { baseRef: "feat/x", mergeOid: "abc" });
  assert.deepEqual(classifyMerge(x, new Map([["feat/x", [carrier(42, { headOid: "abc" })]]])), {
    class: "carried",
    carrier: 42,
    carrierState: "OPEN",
    evidence: "tip",
  });
  assert.deepEqual(classifyMerge(x, new Map([["feat/x", [carrier(42, { headOid: "later" })]]])), {
    class: "carried",
    carrier: 42,
    carrierState: "OPEN",
    evidence: "branch",
  });
  assert.deepEqual(classifyMerge(x, new Map([["feat/x", []]])), { class: "unattached" });
  assert.deepEqual(classifyMerge(x, new Map()), { class: "unattached" });
});

test("classifyMerge never lets a PR carry itself, prefers the tip match, and needs a merge commit to claim one", () => {
  const x = pr(5, { baseRef: "feat/x", mergeOid: "abc" });
  assert.equal(classifyMerge(x, new Map([["feat/x", [carrier(5)]]])).class, "unattached");
  const both = classifyMerge(x, new Map([["feat/x", [carrier(40, { headOid: "newer" }), carrier(41, { headOid: "abc", state: "MERGED" })]]]));
  assert.equal(both.carrier, 41);
  assert.equal(both.evidence, "tip");
  const noOid = pr(6, { baseRef: "feat/x", mergeOid: null });
  assert.equal(classifyMerge(noOid, new Map([["feat/x", [carrier(40, { headOid: null })]]])).evidence, "branch");
});

test("stackedUnderLanded counts what went into a branch before its PR landed, through a stack of stacks", () => {
  const landed = [pr(149, { headRef: "feat/ci", mergedAtMs: END - HOUR })];
  const other = [
    pr(171, { baseRef: "feat/ci", headRef: "feat/ci-a", mergedAtMs: END - 3 * HOUR }),
    pr(172, { baseRef: "feat/ci-a", headRef: "feat/ci-a1", mergedAtMs: END - 4 * HOUR }),
  ];
  const under = stackedUnderLanded({ defaultBranch: "main", landed, other });
  assert.deepEqual(under.get(149), [171, 172]);
});

test("stackedUnderLanded ignores merges after the landing, forks, loops and branches nobody landed", () => {
  const landed = [pr(10, { headRef: "feat/f", mergedAtMs: END - 5 * HOUR })];
  const late = pr(11, { baseRef: "feat/f", headRef: "feat/late", mergedAtMs: END - HOUR });
  assert.equal(stackedUnderLanded({ defaultBranch: "main", landed, other: [late] }).size, 0);
  const fork = pr(12, { headRef: "feat/f", crossRepo: true, mergedAtMs: END });
  const viaFork = pr(13, { baseRef: "feat/f", headRef: "feat/z", mergedAtMs: END - 6 * HOUR });
  assert.equal(stackedUnderLanded({ defaultBranch: "main", landed: [fork], other: [viaFork] }).size, 0);
  const a = pr(20, { baseRef: "feat/b", headRef: "feat/a", mergedAtMs: END - 2 * HOUR });
  const b = pr(21, { baseRef: "feat/a", headRef: "feat/b", mergedAtMs: END - 2 * HOUR });
  assert.equal(stackedUnderLanded({ defaultBranch: "main", landed: [], other: [a, b] }).size, 0);
  const orphan = pr(30, { baseRef: "tmp/dead", mergedAtMs: END - 2 * HOUR });
  assert.equal(stackedUnderLanded({ defaultBranch: "main", landed, other: [orphan] }).size, 0);
});

test("stackedUnderLanded stops following a stack after ten links", () => {
  const landed = [pr(1, { headRef: "feat/l0", mergedAtMs: END })];
  const other = Array.from({ length: 12 }, (_, i) =>
    pr(100 + i, { baseRef: `feat/l${i}`, headRef: `feat/l${i + 1}`, mergedAtMs: END - (i + 1) * 60_000 }),
  );
  const under = stackedUnderLanded({ defaultBranch: "main", landed, other });
  // the PR sitting 10 links away from the landed branch is still counted, the one 11 links away is not
  assert.equal(under.get(1).includes(100), true);
  assert.equal(under.get(1).includes(109), true);
  assert.equal(under.get(1).includes(110), false);
});

test("fetchCarriers asks per branch with variables, in chunks of 20, and drops fork PRs", async () => {
  const bases = Array.from({ length: 25 }, (_, i) => `feat/b${i}`);
  const repos = {
    "o/a": {
      merged: [],
      carriers: {
        "feat/b0": [
          { number: 1, state: "OPEN", baseRefName: "main", headRefOid: "x", isCrossRepository: false },
          { number: 2, state: "OPEN", baseRefName: "main", headRefOid: "y", isCrossRepository: true },
        ],
      },
    },
  };
  const gh = fakeGh(repos);
  const got = await fetchCarriers(gh, "o/a", bases);
  assert.equal(gh.calls.length, 2);
  assert.match(gh.calls[0].query, /^query\(\$owner:String!,\$name:String!,\$h0:String!/);
  assert.match(gh.calls[0].query, /c19:pullRequests\(headRefName:\$h19,states:\[OPEN,MERGED\]/);
  assert.doesNotMatch(gh.calls[1].query, /c5:/);
  assert.equal(gh.calls[1].variables.h4, "feat/b24");
  assert.ok(!gh.calls[0].query.includes("feat/b0"), "branch names travel as variables, never inside the query text");
  assert.deepEqual(got.get("feat/b0"), [{ number: 1, state: "OPEN", baseRef: "main", headOid: "x" }]);
  assert.deepEqual(got.get("feat/b24"), []);
});

test("fetchCarriers fails loudly on a repository it cannot see, and makes no request without branches", async () => {
  await assert.rejects(fetchCarriers(fakeGh({}), "o/a", ["feat/x"]), (e) => e instanceof GhError && e.kind === "notfound");
  const gh = fakeGh({ "o/a": { merged: [] } });
  assert.equal((await fetchCarriers(gh, "o/a", [])).size, 0);
  assert.equal(gh.calls.length, 0);
});

// The case that started this: 15 merged in 24 h on GitHub, 5 into main, 10 into other branches.
function ctoDay() {
  const at = (n) => END - n * HOUR;
  const merged = [
    ...[139, 140, 151, 89].map((n, i) => mergedNode(n, at(i + 1))),
    mergedNode(149, at(5), { head: "feat/ci" }),
    mergedNode(153, at(6), { base: "tmp/signed-a", head: "feat/a" }),
    mergedNode(157, at(7), { base: "tmp/signed-b", head: "feat/b" }),
    mergedNode(158, at(8), { base: "chore/sign-c", head: "feat/c" }),
    mergedNode(170, at(9), { base: "chore/sign-d", head: "feat/d" }),
    ...[174, 175, 177, 178, 180].map((n, i) => mergedNode(n, at(10 + i), { base: "feat/convex-integration", head: `feat/cx-${n}` })),
    mergedNode(171, at(16), { base: "feat/ci", head: "feat/ci-a" }),
  ];
  return {
    merged,
    carriers: {
      "feat/convex-integration": [{ number: 42, state: "OPEN", baseRefName: "main", headRefOid: "t", isCrossRepository: false }],
      "tmp/signed-a": [{ number: 160, state: "MERGED", baseRefName: "main", headRefOid: "t", isCrossRepository: false }],
      "tmp/signed-b": [{ number: 161, state: "MERGED", baseRefName: "main", headRefOid: "t", isCrossRepository: false }],
      "chore/sign-c": [{ number: 162, state: "OPEN", baseRefName: "main", headRefOid: "t", isCrossRepository: false }],
      // chore/sign-d has no carrier: its PR was closed without merging, and only open or merged PRs count
      "feat/ci": [{ number: 149, state: "MERGED", baseRefName: "main", headRefOid: "t", isCrossRepository: false }],
    },
  };
}

async function landingFor(repo) {
  const gh = fakeGh({ "o/a": repo });
  const fetched = await fetchMergedPrs(gh, "o/a", { sinceMs: END - 72 * HOUR });
  return collectLanding(gh, [fetched], { endMs: END });
}

test("collectLanding reproduces the 15 raw / 5 landed / 10 not landed day", async () => {
  const landing = await landingFor(ctoDay());
  assert.equal(landing.raw24h, 15);
  assert.equal(landing.landed24h, 5);
  assert.equal(landing.other24h, 10);
  assert.equal(landing.carried, 9);
  assert.equal(landing.unattached, 1);
  assert.equal(landing.unknown, 0);
  const [r] = landing.repos;
  assert.deepEqual(r.byBase[0], { base: "feat/convex-integration", count: 5 });
  assert.deepEqual(r.stacked, [{ number: 149, stacked: 1 }]);
});

test("a failed carrier lookup keeps the counts and marks the rest unknown, in this section only", async () => {
  const repo = ctoDay();
  const gh = fakeGh({ "o/a": repo });
  const fetched = await fetchMergedPrs(gh, "o/a", { sinceMs: END - 72 * HOUR });
  const real = gh.graphql.bind(gh);
  gh.graphql = async (query, vars) => {
    if (vars.h0 !== undefined) throw new GhError("ratelimit", "API rate limit exceeded", 403);
    return real(query, vars);
  };
  const landing = await collectLanding(gh, [fetched], { endMs: END });
  assert.equal(landing.other24h, 10);
  assert.equal(landing.unknown, 10);
  assert.equal(landing.carried, 0);
  assert.equal(landing.repos[0].error.kind, "ratelimit");
  assert.equal(landing.landed24h, 5);
});

test("collectLanding skips repositories that failed and asks for nothing when every merge landed", async () => {
  const gh = fakeGh({ "o/a": { merged: [mergedNode(1, END - HOUR)] } });
  const fetched = await fetchMergedPrs(gh, "o/a", { sinceMs: END - 24 * HOUR });
  const landing = await collectLanding(gh, [fetched, { repo: "o/b", error: { kind: "notfound", message: "x" } }], { endMs: END });
  assert.equal(landing.repos.length, 1);
  assert.equal(landing.other24h, 0);
  assert.equal(landing.raw24h, 1);
  assert.ok(!gh.calls.some((c) => c.variables?.h0 !== undefined));
});

test("summarizeLanding counts only the last 24 h, lists the busiest branches first and flags a cut-short list", () => {
  const old = pr(1, { baseRef: "feat/old", mergedAtMs: END - 30 * HOUR });
  const fresh = [2, 3, 4].map((n) => pr(n, { baseRef: n === 4 ? "feat/b" : "feat/a", mergedAtMs: END - n * 60_000 }));
  const got = summarizeLanding({
    repo: "o/a",
    defaultBranch: "main",
    landed: [pr(9, { mergedAtMs: END - 25 * HOUR }), pr(10)],
    other: [old, ...fresh],
    carriers: new Map(),
    complete: false,
    endMs: END,
  });
  assert.equal(got.landed24h, 1);
  assert.equal(got.other24h, 3);
  assert.equal(got.unattached, 3);
  assert.equal(got.complete, false);
  assert.deepEqual(got.byBase, [
    { base: "feat/a", count: 2 },
    { base: "feat/b", count: 1 },
  ]);
});

test("summarizeLanding breaks a tie between branches by name and only lists landed PRs from the last 24 h", () => {
  const got = summarizeLanding({
    repo: "o/a",
    defaultBranch: "main",
    landed: [pr(5, { headRef: "feat/f", mergedAtMs: END - 40 * HOUR }), pr(6, { headRef: "feat/g", mergedAtMs: END - HOUR })],
    other: [
      pr(7, { baseRef: "feat/f", headRef: "x1", mergedAtMs: END - 41 * HOUR }),
      pr(8, { baseRef: "feat/g", headRef: "x2", mergedAtMs: END - 2 * HOUR }),
      pr(9, { baseRef: "zeta", headRef: "x3", mergedAtMs: END - 2 * HOUR }),
    ],
    carriers: new Map(),
    endMs: END,
  });
  assert.deepEqual(got.byBase.map((b) => b.base), ["feat/g", "zeta"]);
  assert.deepEqual(got.stacked, [{ number: 6, stacked: 1 }]);
});

test("a branch name used by two PRs belongs to the newest one", () => {
  const oldIncarnation = pr(5, { headRef: "feat/f", mergedAtMs: END - 20 * HOUR });
  const current = pr(6, { headRef: "feat/f", mergedAtMs: END - 2 * HOUR });
  const x = pr(7, { baseRef: "feat/f", headRef: "feat/x", mergedAtMs: END - 3 * HOUR });
  const under = stackedUnderLanded({ defaultBranch: "main", landed: [oldIncarnation, current], other: [x] });
  assert.deepEqual([...under], [[6, [7]]]);
});

test("the 24 h window is open at the start and closed at the end, in the counts and in the carrier lookup", async () => {
  const inside = (n, base, ms) => pr(n, { baseRef: base, headRef: `feat/h${n}`, mergedAtMs: ms });
  const got = summarizeLanding({
    repo: "o/a",
    defaultBranch: "main",
    landed: [pr(1, { mergedAtMs: END - 24 * HOUR }), pr(2, { mergedAtMs: END - 24 * HOUR + 1 }), pr(3, { mergedAtMs: END }), pr(4, { mergedAtMs: END + 1 })],
    other: [inside(5, "feat/a", END - 24 * HOUR), inside(6, "feat/a", END), inside(7, "feat/a", END + 1)],
    carriers: new Map(),
    endMs: END,
  });
  assert.equal(got.landed24h, 2);
  assert.equal(got.other24h, 1);
  const gh = fakeGh({
    "o/a": {
      merged: [
        mergedNode(1, END - 24 * HOUR, { base: "feat/edge" }),
        mergedNode(2, END + 60_000, { base: "feat/future" }),
        mergedNode(3, END - HOUR, { base: "feat/inside" }),
      ],
    },
  });
  await collectLanding(gh, [await fetchMergedPrs(gh, "o/a", { sinceMs: END - 72 * HOUR })], { endMs: END });
  const asked = gh.calls.filter((c) => c.variables?.h0 !== undefined).flatMap((c) => Object.entries(c.variables).filter(([k]) => /^h\d+$/.test(k)).map(([, v]) => v));
  assert.deepEqual(asked, ["feat/inside"]);
});

test("branches and landed PRs are ordered by count and then by name or number, and the lists are capped", () => {
  const other = [
    ...["zeta", "mid", "alpha", "e", "d", "c", "b"].map((base, i) => pr(100 + i, { baseRef: base, headRef: `h${i}`, mergedAtMs: END - (i + 1) * 60_000 })),
    pr(200, { baseRef: "mid", headRef: "h200", mergedAtMs: END - 20 * 60_000 }),
  ];
  const landed = Array.from({ length: 12 }, (_, i) => pr(300 + i, { headRef: `L${i}`, mergedAtMs: END - 60_000 }));
  const stacks = landed.flatMap((l, i) =>
    Array.from({ length: i === 5 ? 3 : i === 2 ? 2 : 1 }, (_, k) => pr(1000 + i * 10 + k, { baseRef: `L${i}`, headRef: `s${i}-${k}`, mergedAtMs: END - 2 * 60_000 })),
  );
  // reversed, so the landed PRs reach the sort out of number order
  const got = summarizeLanding({ repo: "o/a", defaultBranch: "main", landed, other: [...other, ...[...stacks].reverse()], carriers: new Map(), endMs: END });
  assert.deepEqual(got.byBase.map((b) => b.base), ["L5", "L2", "mid", "L0", "L1"]);
  assert.equal(got.byBase.length, 5);
  assert.deepEqual(got.stacked.map((s) => s.number), [305, 302, 300, 301, 303, 304, 306, 307, 308, 309]);
  assert.deepEqual(got.stacked.slice(0, 3), [{ number: 305, stacked: 3 }, { number: 302, stacked: 2 }, { number: 300, stacked: 1 }]);
});

test("collectLanding passes on whether the merge list was complete", async () => {
  const gh = fakeGh({ "o/a": { merged: [mergedNode(1, END - HOUR)] } });
  const fetched = await fetchMergedPrs(gh, "o/a", { sinceMs: END - 24 * HOUR });
  assert.equal((await collectLanding(gh, [fetched], { endMs: END })).repos[0].complete, true);
  assert.equal((await collectLanding(gh, [{ ...fetched, complete: false }], { endMs: END })).repos[0].complete, false);
});

test("the carrier lookup looks at the five newest PRs per branch", async () => {
  const gh = fakeGh({ "o/a": { merged: [] } });
  await fetchCarriers(gh, "o/a", ["feat/x"]);
  assert.match(gh.calls[0].query, /c0:pullRequests\(headRefName:\$h0,states:\[OPEN,MERGED\],first:5,orderBy:\{field:CREATED_AT,direction:DESC\}\)/);
});
