import assert from "node:assert/strict";
import test from "node:test";
import { GhError, fetchOpenPrs, normalizeMergedPr, normalizeOpenPr } from "./factory-kpi-github.mjs";
import { OPEN_STATES, classifyOpenPr, collectSupport, reviewLatency, summarizeOpen } from "./factory-kpi-support.mjs";
import { HOUR, fakeGh, mergedNode, openNode } from "./factory-kpi-test-helpers.mjs";

const END = Date.parse("2026-10-18T12:00:00Z");
const open = (over = {}) => ({
  repo: "o/a",
  number: 1,
  draft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  createdAtMs: END - 10 * HOUR,
  readyAtMs: END - 10 * HOUR,
  reviewed: false,
  decisions: [],
  checks: "SUCCESS",
  ...over,
});

test("classifyOpenPr picks the first thing that has to move", () => {
  const state = (over) => classifyOpenPr(open(over));
  assert.equal(state({ draft: true, mergeable: "CONFLICTING", checks: "FAILURE" }), "draft");
  assert.equal(state({ mergeable: "CONFLICTING", checks: "FAILURE" }), "conflicts");
  assert.equal(state({ checks: "FAILURE", reviewDecision: "APPROVED" }), "ci_failing");
  assert.equal(state({ checks: "ERROR" }), "ci_failing");
  assert.equal(state({ checks: "PENDING", reviewDecision: "CHANGES_REQUESTED" }), "ci_pending");
  assert.equal(state({ checks: "EXPECTED" }), "ci_pending");
  assert.equal(state({ reviewDecision: "CHANGES_REQUESTED" }), "changes_requested");
  assert.equal(state({ reviewDecision: "APPROVED" }), "ready");
  assert.equal(state({ reviewDecision: "REVIEW_REQUIRED" }), "waiting_review");
  assert.equal(state({ reviewDecision: null }), "waiting_review", "no review rule and nobody reviewed yet");
  assert.equal(state({ reviewDecision: null, decisions: ["APPROVED"] }), "ready", "no review rule, but someone approved");
  assert.equal(state({ reviewDecision: null, decisions: ["APPROVED", "CHANGES_REQUESTED"] }), "changes_requested", "one open request blocks despite an approval");
  assert.equal(state({ reviewDecision: null, decisions: ["DISMISSED"] }), "waiting_review", "a dismissed review is no decision");
  assert.equal(state({ reviewDecision: "REVIEW_REQUIRED", decisions: ["APPROVED"] }), "waiting_review", "the rule says more review is needed");
  assert.equal(state({ reviewDecision: "APPROVED", decisions: ["CHANGES_REQUESTED"] }), "ready", "GitHub's own decision wins when there is one");
  assert.equal(state({ checks: null }), "waiting_review", "no checks reported");
  assert.equal(state({ mergeable: "UNKNOWN" }), "waiting_review", "unknown mergeability is not assumed to be a conflict");
});

test("summarizeOpen counts every PR once and finds the longest wait for a first review", () => {
  const prs = [
    open({ number: 1, draft: true, mergeable: "UNKNOWN", readyAtMs: END - 100 * HOUR }),
    open({ number: 2, mergeable: "CONFLICTING" }),
    open({ number: 3, readyAtMs: END - 30 * HOUR }),
    open({ number: 4, readyAtMs: END - 5 * HOUR, mergeable: "UNKNOWN" }),
    open({ number: 5, reviewed: true, decisions: ["APPROVED"], reviewDecision: "APPROVED", readyAtMs: END - 90 * HOUR }),
  ];
  const s = summarizeOpen(prs, END);
  assert.equal(s.total, 5);
  assert.deepEqual(s.byState, { draft: 1, conflicts: 1, ci_failing: 0, ci_pending: 0, changes_requested: 0, waiting_review: 2, ready: 1 });
  assert.equal(Object.values(s.byState).reduce((a, b) => a + b, 0), 5);
  assert.deepEqual(s.oldestUnreviewed, { number: 3, hours: 30 }, "drafts and reviewed PRs do not count");
  assert.equal(s.mergeableUnknown, 1);
  assert.deepEqual(Object.keys(s.byState), OPEN_STATES);
  assert.deepEqual(summarizeOpen([], END), { total: 0, byState: Object.fromEntries(OPEN_STATES.map((k) => [k, 0])), mergeableUnknown: 0, oldestUnreviewed: null });
});

test("reviewLatency measures ready-to-first-review over the window and counts unreviewed merges", () => {
  const pr = (mergedAgoH, readyAgoH, reviewAgoH) => ({
    mergedAtMs: END - mergedAgoH * HOUR,
    readyAtMs: END - readyAgoH * HOUR,
    firstReviewAtMs: reviewAgoH === null ? null : END - reviewAgoH * HOUR,
  });
  const merged = [pr(1, 5, 3), pr(2, 8, 4), pr(3, 12, 11), pr(4, 6, null), pr(30, 40, 39), pr(24, 30, 29), pr(0, 2, 1)];
  const r = reviewLatency(merged, END);
  assert.deepEqual([r.merged, r.reviewed, r.unreviewed], [5, 4, 1], "merges 24 h and 30 h old are outside the (end-24h, end] window");
  assert.equal(r.p50Hours, 1.5, "latencies 1, 1, 2, 4 hours");
  assert.equal(r.p90Hours, 4);
  const empty = reviewLatency([], END);
  assert.deepEqual([empty.merged, empty.p50Hours, empty.p90Hours], [0, null, null]);
  assert.equal(reviewLatency([pr(1, 2, 3)], END).p50Hours, 0, "a review before the ready event never gives a negative wait");
  assert.equal(reviewLatency([pr(1, 2, 1)], END, 30 * 60_000).merged, 0, "window is configurable");
});

test("normalizeMergedPr takes the earliest review by someone else and the last ready event", () => {
  const at = (h) => END - h * HOUR;
  const node = mergedNode(1, END, {
    author: "agent",
    readyMs: [at(10), at(6)],
    reviews: [
      { state: "COMMENTED", atMs: at(5), author: "agent" },
      { state: "PENDING", atMs: at(4.5), author: "reviewer" },
      { state: "COMMENTED", atMs: at(3), author: "reviewer" },
      { state: "APPROVED", atMs: at(1), author: "other" },
    ],
  });
  const pr = normalizeMergedPr("o/a", node);
  assert.equal(pr.readyAtMs, at(6));
  assert.equal(pr.firstReviewAtMs, at(3));
  const bare = normalizeMergedPr("o/a", mergedNode(2, END, { openMs: 2 * HOUR }));
  assert.equal(bare.readyAtMs, END - 2 * HOUR, "never a draft: ready when opened");
  assert.equal(bare.firstReviewAtMs, null);
  assert.equal(normalizeMergedPr("o/a", mergedNode(3, END, { reviews: [{ state: "APPROVED", atMs: at(1), author: "agent" }] })).firstReviewAtMs, null, "self review is not a review");
});

test("normalizeOpenPr reads draft, mergeability, decision, checks and reviews", () => {
  const pr = normalizeOpenPr(
    "o/a",
    openNode(9, {
      createdMs: END - 9 * HOUR,
      readyMs: END - 3 * HOUR,
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "CONFLICTING",
      checks: "FAILURE",
      reviews: [{ state: "CHANGES_REQUESTED", atMs: END - HOUR }],
    }),
  );
  assert.deepEqual(
    { n: pr.number, draft: pr.draft, m: pr.mergeable, d: pr.reviewDecision, c: pr.checks, r: pr.reviewed, a: pr.decisions, first: pr.firstReviewAtMs, ready: pr.readyAtMs },
    { n: 9, draft: false, m: "CONFLICTING", d: "CHANGES_REQUESTED", c: "FAILURE", r: true, a: ["CHANGES_REQUESTED"], first: END - HOUR, ready: END - 3 * HOUR },
  );
  const bare = normalizeOpenPr("o/a", { ...openNode(1, { checks: null }), mergeable: null, isDraft: undefined, reviewDecision: undefined });
  assert.deepEqual([bare.draft, bare.mergeable, bare.reviewDecision, bare.checks], [false, "UNKNOWN", null, null]);
});

test("fetchOpenPrs pages through open PRs and flags the cap", async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => openNode(i + 1));
  const gh = fakeGh({ "o/a": { merged: [], open: nodes } }, { pageSize: 5 });
  const all = await fetchOpenPrs(gh, "o/a", { pageSize: 5 });
  assert.equal(all.prs.length, 12);
  assert.equal(all.complete, true);
  assert.equal(gh.calls.length, 3);
  const capped = await fetchOpenPrs(fakeGh({ "o/a": { merged: [], open: nodes } }, { pageSize: 5 }), "o/a", { pageSize: 5, maxPages: 2 });
  assert.equal(capped.prs.length, 10);
  assert.equal(capped.complete, false);
  await assert.rejects(fetchOpenPrs(fakeGh({}), "o/missing"), /not visible/);
});

test("collectSupport keeps an unreadable repo as an error and sums the readable ones", async () => {
  const gh = fakeGh({
    "o/a": { merged: [], open: [openNode(1, { createdMs: END - 40 * HOUR }), openNode(2, { draft: true })] },
    "o/b": new GhError("forbidden", "denied", 403),
    "o/c": { merged: [], open: [openNode(3, { createdMs: END - 50 * HOUR, checks: "FAILURE" })] },
  });
  const mergedPrs = [normalizeMergedPr("o/a", mergedNode(10, END - HOUR, { readyMs: END - 3 * HOUR, reviews: [{ state: "APPROVED", atMs: END - 2 * HOUR }] }))];
  const s = await collectSupport(gh, { repos: ["o/a", "o/b", "o/c"], mergedPrs, endMs: END });
  assert.equal(s.open.total, 3);
  assert.deepEqual([s.open.byState.draft, s.open.byState.ci_failing, s.open.byState.waiting_review], [1, 1, 1]);
  assert.equal(s.open.repos.find((r) => r.repo === "o/b").error.kind, "forbidden");
  assert.equal(s.open.complete, false, "a repo that could not be read means the total is a lower bound");
  assert.deepEqual(s.open.oldestUnreviewed, { repo: "o/c", number: 3, hours: 50 });
  assert.equal(s.review.p50Hours, 1);
});
