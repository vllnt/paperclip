import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALWAYS, CONDITIONAL, commandData, evaluate, failedSteps, render } from "./gate-verdict.mjs";

const entry = fileURLToPath(new URL("./evaluate-gate.mjs", import.meta.url));

// Every classifier output of a conditional job, set to one value.
const conditionalOutputs = (value) => Object.fromEntries(Object.values(CONDITIONAL).map((output) => [output, value]));
// A passing `needs` built from the verdict's own job lists, so a new job needs no fixture edit.
const green = (overrides = {}) => {
  const outputs = { mode: "full", ...conditionalOutputs("true") };
  return {
    changes: { result: "success", outputs },
    ...Object.fromEntries([...ALWAYS, ...Object.keys(CONDITIONAL)].map((job) => [job, { result: "success" }])),
    ...overrides,
  };
};
const [always] = ALWAYS;
const [[conditional, output]] = Object.entries(CONDITIONAL);

test("passes when everything the classifier asked for succeeded", () => {
  assert.equal(evaluate(green()).ok, true);
  assert.equal(evaluate(green({ changes: { result: "success", outputs: { mode: "affected", ...conditionalOutputs("true") } } })).ok, true);
});

test("a conditional job the classifier did not ask for must be skipped", () => {
  const needs = green({ changes: { result: "success", outputs: { mode: "none", ...conditionalOutputs("true"), [output]: "false" } }, [conditional]: { result: "skipped" } });
  assert.equal(evaluate(needs).ok, true);
  assert.equal(evaluate({ ...needs, [conditional]: { result: "success" } }).ok, false);
});

test("fails on failure, cancelled and skipped for an always-on or a needed job", () => {
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(evaluate(green({ [always]: { result } })).ok, false, `${always} ${result}`);
    assert.equal(evaluate(green({ [conditional]: { result } })).ok, false, `${conditional} ${result}`);
  }
});

test("fails when the classifier failed or returned something unusable", () => {
  for (const changes of [
    { result: "failure", outputs: {} },
    { result: "skipped", outputs: {} },
    { result: "success", outputs: { mode: "fast", [output]: "true" } },
    { result: "success", outputs: { [output]: "true" } },
    { result: "success", outputs: { mode: "full" } },
    { result: "success", outputs: { mode: "full", [output]: "yes" } },
  ]) {
    assert.equal(evaluate(green({ changes })).ok, false, JSON.stringify(changes));
  }
});

test("a classifier failure reports only the root cause", () => {
  const result = evaluate(green({ changes: { result: "failure", outputs: {} } }));
  assert.deepEqual(result.problems, ["changes: failure (the classifier must succeed)"]);
  assert.equal(result.rows.length, 1);
});

test("fails on a job it does not know and on a missing job", () => {
  assert.match(evaluate(green({ "not-a-job": { result: "success" } })).problems.join(), /unknown job "not-a-job"/);
  const { [always]: omitted, ...without } = green();
  assert.equal(evaluate(without).ok, false);
});

test("failing steps are told apart: setup, check, infrastructure, cancelled", async () => {
  const jobs = [
    { name: "Secrets", conclusion: "failure", html_url: "u1", steps: [{ name: "Set up job", conclusion: "success" }, { name: "Verify guard", conclusion: "failure" }] },
    { name: "Sentry", conclusion: "failure", html_url: "u2", steps: [{ name: "Run actions/checkout@abc", conclusion: "failure" }] },
    { name: "Install", conclusion: "failure", html_url: "u3", steps: [{ name: "Install workspace dependencies", conclusion: "failure" }] },
    { name: "Lost", conclusion: "timed_out", html_url: "u4", steps: [] },
    { name: "Superseded", conclusion: "cancelled", html_url: "u5", steps: [] },
    { name: "Fine", conclusion: "success", html_url: "u6", steps: [] },
  ];
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), { ok: true, json: async () => ({ jobs }) });
  const found = await failedSteps({ fetchImpl, apiUrl: "https://api.github.com", repository: "o/r", runId: "1", token: "t" });
  assert.deepEqual(found.map((item) => [item.job, item.kind.split(/[:( ]/)[0], item.rerun]), [
    ["Secrets", "check", false],
    ["Sentry", "setup", true],
    ["Install", "check", false],
    ["Lost", "infrastructure", true],
    ["Superseded", "cancelled", true],
  ]);
  assert.equal(calls.length, 1);
  await assert.rejects(failedSteps({ fetchImpl: async () => ({ ok: false, status: 403 }), apiUrl: "x", repository: "o/r", runId: "1", token: "t" }), /403/);
});

test("failing jobs are read page by page", async () => {
  const page = (count, name) => Array.from({ length: count }, (_, index) => ({ name: `${name}${index}`, conclusion: "failure", html_url: "u", steps: [] }));
  const pages = [page(100, "a"), page(3, "b")];
  const found = await failedSteps({ fetchImpl: async () => ({ ok: true, json: async () => ({ jobs: pages.shift() }) }), apiUrl: "x", repository: "o/r", runId: "1", token: "t" });
  assert.equal(found.length, 103);
});

test("render explains a failure; the re-run line appears only when a re-run can help", () => {
  const result = evaluate(green({ [always]: { result: "failure" } }));
  const base = { result, runUrl: "https://example/run/9", runId: "9" };
  assert.match(render({ ...base, details: [] }), new RegExp(`${always}: failure \\(expected success\\)`));
  assert.doesNotMatch(render({ ...base, details: [] }), /rerun/);
  assert.match(render({ ...base, details: [{ job: "j", step: "s", kind: "setup", rerun: true, url: "u" }] }), /gh run rerun 9 --failed/);
  assert.doesNotMatch(render({ ...base, details: [{ job: "j", step: "s", kind: "check", rerun: false, url: "u" }] }), /rerun/);
  assert.match(render({ ...base, details: [], detailsError: "jobs API answered 403" }), /Could not list the failing steps/);
  assert.doesNotMatch(render({ result: evaluate(green()), details: [], runUrl: "u", runId: "9" }), /rerun|Fix the cause/);
});

test("names cannot break the table or start a workflow command", () => {
  const text = render({
    result: evaluate(green()),
    details: [{ job: "a|b\n::add-mask::x", step: "Run a | b", kind: "check", rerun: false, url: "u" }],
    runUrl: "u",
    runId: "1",
  });
  assert.ok(text.split("\n").every((line) => !line.startsWith("::")));
  assert.match(text, /a\\\|b ::add-mask::x/);
  assert.equal(commandData("a\nb%c"), "a%0Ab%25c");
});

test("the entry point exits 0 on green and 1 on red, on garbage and on nothing", () => {
  const run = (needs) => spawnSync(process.execPath, [entry], { env: { ...process.env, NEEDS_JSON: needs, GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "" }, encoding: "utf8" });
  assert.equal(run(JSON.stringify(green())).status, 0);
  assert.equal(run(JSON.stringify(green({ [always]: { result: "failure" } }))).status, 1);
  for (const bad of ["not json", "null", "[]", ""]) assert.equal(run(bad).status, 1, bad);
  assert.equal(spawnSync(process.execPath, [entry], { env: { PATH: process.env.PATH }, encoding: "utf8" }).status, 1);
});
