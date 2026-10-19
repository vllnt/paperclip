import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HEARTBEAT_MS,
  INCOMPLETE_RUNS_BEFORE_SPEAKING,
  configFingerprint,
  decideGate,
  gateSignature,
  renderGate,
} from "./factory-kpi-gate.mjs";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-18T12:00:00Z");

const signature = (over = {}) => ({
  atMs: T0,
  config: "c1",
  avg24: 2,
  min6: 1,
  target: 6,
  sustained: 0,
  done: false,
  guard: "pass",
  regression: "ok",
  violations: [],
  incomplete: false,
  ...over,
});
const later = (hours, over = {}) => signature({ atMs: T0 + hours * HOUR, ...over });
const decide = (current, previous = signature(), extra = {}) => decideGate({ current, previous, ...extra });

test("the first run speaks and saves what it saw", () => {
  const current = signature();
  assert.deepEqual(decideGate({ current, previous: null }), { post: true, reasons: ["first run"], streak: 0, save: current });
});

test("nothing changed is silent", () => {
  const d = decide(later(0.5));
  assert.deepEqual([d.post, d.reasons], [false, []]);
});

test("small drift is silent, a full step of movement since the last line speaks", () => {
  assert.equal(decide(later(0.5, { avg24: 2.9 })).post, false, "0.9/h is below the step");
  assert.match(decide(later(0.5, { avg24: 3 })).reasons[0], /24h rate 2\.0 -> 3\.0\/h/);
  assert.match(decide(later(0.5, { avg24: 1 })).reasons[0], /24h rate 2\.0 -> 1\.0\/h/);
  assert.match(decide(later(0.5, { min6: 2 })).reasons[0], /rolling 6h min 1\.0 -> 2\.0\/h/);
});

test("a step of exactly one is a step, even when the floats are not exact", () => {
  const d = decide(later(0.5, { min6: 41 / 6 }), signature({ min6: 35 / 6 }));
  assert.match(d.reasons[0], /rolling 6h min 5\.8 -> 6\.8\/h/);
  assert.equal(decide(later(0.5, { min6: 41 / 6 - 0.01 }), signature({ min6: 35 / 6 })).post, false);
  assert.equal(decide(later(0.5, { avg24: 2.5 }), signature(), { rateStep: 0.5 }).post, true, "the step is configurable");
});

test("a step short of one by float error only is still a step, and the tolerance is inclusive", () => {
  assert.ok(4.1 - 3.1 < 1, "the float difference is just under one");
  assert.equal(decide(later(0.5, { avg24: 4.1 }), signature({ avg24: 3.1 })).post, true);
  assert.equal(decide(later(0.5, { avg24: 1 - 1e-9 }), signature({ avg24: 0 })).post, true);
  assert.equal(decide(later(0.5, { avg24: 1 - 2e-9 }), signature({ avg24: 0 })).post, false);
});

test("drift is measured from the last line, so slow drift cannot hide", () => {
  const lastLine = signature({ avg24: 2 });
  assert.equal(decide(later(1, { avg24: 2.6 }), lastLine).post, false);
  assert.equal(decide(later(2, { avg24: 3.2 }), lastLine).post, true);
});

test("crossing the target by a small move is not news on its own; a verdict flip is", () => {
  assert.equal(decide(later(0.5, { avg24: 6 }), signature({ avg24: 5.8 })).post, false);
  assert.equal(decide(later(0.5, { avg24: 5.7 }), signature({ avg24: 6.1 })).post, false);
  assert.match(decide(later(0.5, { avg24: 6, done: true }), signature({ avg24: 5.8 })).reasons[0], /done no -> yes/);
});

test("a verdict, guard, revert/hotfix or sustained-day change speaks", () => {
  assert.match(decide(later(0.5, { done: true })).reasons[0], /done no -> yes/);
  assert.match(decide(later(0.5, { done: null })).reasons[0], /done no -> unknown/);
  assert.match(decide(later(0.5, { guard: "fail" })).reasons[0], /guard pass -> fail/);
  assert.match(decide(later(0.5, { guard: null }), signature()).reasons[0], /guard pass -> off/);
  assert.match(decide(later(0.5, { regression: "regression" })).reasons[0], /revert\/hotfix ok -> regression/);
  assert.match(decide(later(0.5, { sustained: 1 })).reasons[0], /sustained days 0 -> 1/);
});

test("a new violation speaks once; the same violation staying open does not repeat", () => {
  const withOne = signature({ guard: "fail", violations: ["o/a#7"] });
  const first = decide(later(0.5, { guard: "fail", violations: ["o/a#7"] }));
  assert.ok(first.reasons.some((r) => /new violation o\/a#7/.test(r)));
  assert.equal(decide(later(1, { guard: "fail", violations: ["o/a#7"] }), withOne).post, false);
  assert.match(decide(later(1, { guard: "fail", violations: ["o/a#7", "o/b#2"] }), withOne).reasons[0], /new violation o\/b#2/);
  const many = decide(later(1, { guard: "fail", violations: ["o/a#1", "o/a#2", "o/a#3", "o/a#4", "o/a#5", "o/a#6", "o/a#7"] }), signature({ guard: "fail" }));
  assert.equal(many.reasons[0], "new violation o/a#1, o/a#2, o/a#3, o/a#4, o/a#5 (+2)");
});

test("a changed configuration is news and starts a fresh comparison", () => {
  const d = decide(later(0.5, { config: "c2", avg24: 9 }), signature());
  assert.match(d.reasons[0], /configuration changed/);
  assert.equal(d.save.config, "c2");
  assert.equal(d.save.avg24, 9, "the new numbers become the reference");
  assert.equal(decide(later(0.5, { config: "c2" }), signature({ config: undefined })).post, true, "a state without a configuration is replaced");
});

test("the same instant twice is not a time paradox", () => {
  assert.equal(decide(signature({ atMs: T0 }), signature({ atMs: T0 })).post, false);
});

test("a saved time ahead of the clock speaks once and is replaced by the real time", () => {
  const d = decide(signature({ atMs: T0 }), signature({ atMs: T0 + 10 * HOUR }));
  assert.match(d.reasons[0], /saved time is ahead of the clock/);
  assert.equal(d.reasons.length, 1, "no heartbeat on top of it");
  assert.equal(d.save.atMs, T0);
});

test("the first incomplete run is a blip; the second in a row speaks, and only once", () => {
  assert.equal(INCOMPLETE_RUNS_BEFORE_SPEAKING, 2);
  const blip = decide(later(0.5, { incomplete: true }), signature(), { streak: 0 });
  assert.deepEqual([blip.post, blip.streak], [false, 1]);
  const second = decide(later(1, { incomplete: true }), signature(), { streak: 1 });
  assert.match(second.reasons[0], /collection incomplete for 2 runs in a row/);
  assert.equal(second.streak, 2);
  assert.equal(second.save.incomplete, true);
  const third = decide(later(1.5, { incomplete: true }), second.save, { streak: 2 });
  assert.deepEqual([third.post, third.streak], [false, 3], "an outage that was already reported is not repeated");
  assert.equal(decide(later(1, {}), signature(), { streak: 7 }).streak, 0, "a complete run resets the count");
});

test("while a read is incomplete the numbers are lower bounds, so only definite facts are compared", () => {
  const incomplete = { incomplete: true, avg24: 0, min6: 0, sustained: 0, done: null, guard: "unknown" };
  const prev = signature({ avg24: 7, min6: 6, sustained: 3, done: true });
  const quiet = decide(later(0.5, incomplete), prev, { streak: 0 });
  assert.equal(quiet.post, false, "a lower bound is not a drop");
  assert.equal(decide(later(0.5, { ...incomplete, regression: "insufficient_data" }), prev).post, false, "a share that cannot be judged now is not a change");
  assert.equal(decide(later(0.5, { ...incomplete, guard: "fail", violations: ["o/a#4"] }), prev).post, true, "a definite violation speaks at once");
  assert.match(decide(later(0.5, { ...incomplete, guard: "fail" }), prev).reasons[0], /guard pass -> fail/);
  assert.match(decide(later(0.5, { ...incomplete, regression: "regression" }), prev).reasons[0], /revert\/hotfix ok -> regression/);
});

test("a line posted during an outage keeps the last complete numbers and the violations seen", () => {
  const prev = signature({ avg24: 7, min6: 6, sustained: 3, done: true, violations: ["o/a#1"], guard: "fail" });
  const d = decide(later(1, { incomplete: true, avg24: 0, min6: 0, sustained: 0, done: null, guard: "unknown", violations: ["o/b#2"] }), prev, { streak: 1 });
  assert.equal(d.post, true);
  assert.deepEqual(
    [d.save.avg24, d.save.min6, d.save.sustained, d.save.done, d.save.guard, d.save.incomplete],
    [7, 6, 3, true, "fail", true],
  );
  assert.deepEqual(d.save.violations, ["o/a#1", "o/b#2"]);
  assert.equal(d.save.atMs, T0 + HOUR);
});

test("coming back from an outage speaks, and compares with the last complete numbers", () => {
  const outage = signature({ avg24: 7, incomplete: true });
  assert.match(decide(later(1, { avg24: 7 }), outage).reasons[0], /complete again/);
  const moved = decide(later(1, { avg24: 4 }), outage);
  assert.ok(moved.reasons.some((r) => /24h rate 7\.0 -> 4\.0\/h/.test(r)));
});

test("the heartbeat speaks after four hours of silence and not before", () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 4 * HOUR);
  assert.equal(decide(later(3.9)).post, false);
  assert.match(decide(later(4)).reasons[0], /heartbeat \(4 h since the last line\)/);
  assert.equal(decide(later(1), signature(), { heartbeatMs: HOUR }).post, true, "the heartbeat is configurable");
});

test("an unknown rate is compared as unknown, not as zero", () => {
  assert.match(decide(later(0.5, { min6: null })).reasons[0], /rolling 6h min 1\.0 -> n\/a/);
  assert.equal(decide(later(0.5, { min6: null }), signature({ min6: null })).post, false);
});

test("gateSignature keeps only compact facts, unrounded, and sorts violations", () => {
  const snapshot = {
    throughput: { rates: [{}, {}, { perHour: 5.04 }], rolling6hMin: { minPerHour: 2.25 }, sustained: { consecutive: 2 }, targetPerHour: 6 },
    verdict: { done: false },
    guard: { overall: "fail", repos: [{ repo: "o/b", violations: [{ number: 3 }] }, { repo: "o/a", violations: [{ number: 9 }, { number: 2 }] }] },
    regression: { state: "ok" },
    complete: true,
  };
  assert.deepEqual(gateSignature(snapshot, { atMs: T0, config: "c1" }), {
    atMs: T0,
    config: "c1",
    avg24: 5.04,
    min6: 2.25,
    target: 6,
    sustained: 2,
    done: false,
    guard: "fail",
    regression: "ok",
    violations: ["o/a#2", "o/a#9", "o/b#3"],
    incomplete: false,
  });
  const noGuard = gateSignature({ ...snapshot, guard: null, regression: null, complete: false }, { atMs: T0 });
  assert.equal(noGuard.guard, null);
  assert.equal(noGuard.incomplete, true);
  assert.equal(gateSignature({ ...snapshot, guard: { overall: "unknown", repos: [] } }, { atMs: T0 }).incomplete, true);
});

test("configFingerprint ignores the order and case of repositories and changes with anything that changes the numbers", () => {
  const base = { repos: ["o/a", "o/B"], discoverOrg: null, targetPerHour: 6, sustainDays: 3, guard: true, guardDays: 3, baseline: { events: 2, total: 39 }, baselineAtMs: null };
  const same = configFingerprint({ ...base, repos: ["O/b", "o/a"] });
  assert.equal(configFingerprint(base), same);
  for (const change of [
    { repos: ["o/a"] },
    { discoverOrg: "o" },
    { targetPerHour: 5 },
    { sustainDays: 2 },
    { guard: false },
    { guardDays: 7 },
    { baseline: { events: 3, total: 39 } },
    { baselineAtMs: 5 },
  ]) {
    assert.notEqual(configFingerprint({ ...base, ...change }), same, JSON.stringify(change));
  }
  assert.match(same, /^[0-9a-f]{12}$/);
});

test("renderGate prints the line, the reasons and what to act on", () => {
  const text = renderGate({
    line: "KPI merges 1h=1",
    reasons: ["guard pass -> fail"],
    snapshot: {
      verdict: { blockers: ["quality guard: merge with failing or missing required checks"] },
      guard: { repos: [{ repo: "o/a", violations: [{ number: 7, reasons: ['required check "ci" failing'] }] }] },
      errors: [{ repo: "o/b", kind: "forbidden", message: "denied" }],
    },
  });
  assert.equal(
    text,
    [
      "KPI merges 1h=1",
      "why: guard pass -> fail",
      "blocked by: quality guard: merge with failing or missing required checks",
      'violation o/a#7: required check "ci" failing',
      "error o/b: forbidden: denied",
    ].join("\n"),
  );
  assert.equal(renderGate({ line: "L", reasons: ["r"], snapshot: { verdict: { blockers: [] }, guard: null, errors: [] } }), "L\nwhy: r");
});

test("renderGate cannot be made to print extra lines, terminal escapes or tokens by outside text", () => {
  const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0";
  const text = renderGate({
    line: "L",
    reasons: ["r"],
    snapshot: {
      verdict: { blockers: [] },
      guard: { repos: [{ repo: "o/a\nERROR forged", violations: [{ number: 1, reasons: ["bad\u001b[31m red"] }] }] },
      errors: [{ repo: "o/b", kind: "other", message: `line one\nwhy: forged ${token}` }],
    },
  });
  assert.equal(text.split("\n").length, 4, "one line each: the KPI line, why, the violation, the error");
  assert.ok(!text.includes("\u001b") && !text.includes(token));
  assert.match(text, /error o\/b: other: line one why: forged \[redacted\]/);
});
