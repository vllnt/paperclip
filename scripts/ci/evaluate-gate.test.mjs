import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, failedSteps, render } from "./evaluate-gate.mjs";

const script = fileURLToPath(new URL("./evaluate-gate.mjs", import.meta.url));
const green = (overrides = {}) => ({
  changes: { result: "success", outputs: { mode: "full", need_sentry: "true" } },
  secrets: { result: "success" },
  sentry: { result: "success" },
  ...overrides,
});

test("passes when everything the classifier asked for succeeded", () => {
  assert.equal(evaluate(green()).ok, true);
});

test("a conditional job the classifier did not ask for must be skipped", () => {
  const needs = green({ changes: { result: "success", outputs: { mode: "none", need_sentry: "false" } }, sentry: { result: "skipped" } });
  assert.equal(evaluate(needs).ok, true);
  assert.equal(evaluate({ ...needs, sentry: { result: "success" } }).ok, false);
});

test("fails on failure, cancelled and any skip of a job that is needed", () => {
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(evaluate(green({ secrets: { result } })).ok, false, `secrets ${result}`);
    assert.equal(evaluate(green({ sentry: { result } })).ok, result === "success", `sentry ${result}`);
  }
});

test("fails when the classifier failed or returned a bad mode", () => {
  assert.equal(evaluate(green({ changes: { result: "failure", outputs: {} } })).ok, false);
  assert.equal(evaluate(green({ changes: { result: "skipped", outputs: {} } })).ok, false);
  assert.equal(evaluate(green({ changes: { result: "success", outputs: { mode: "fast", need_sentry: "true" } } })).ok, false);
  assert.equal(evaluate(green({ changes: { result: "success", outputs: { need_sentry: "true" } } })).ok, false);
  assert.equal(evaluate(green({ changes: { result: "success", outputs: { mode: "full" } } })).ok, false);
});

test("fails on a job it does not know and on a missing job", () => {
  assert.equal(evaluate(green({ typecheck: { result: "success" } })).ok, false);
  const { secrets, ...withoutSecrets } = green();
  assert.equal(evaluate(withoutSecrets).ok, false);
});

test("failing steps are split into setup versus check", async () => {
  const jobs = [
    { name: "Secrets", conclusion: "failure", html_url: "u1", steps: [{ name: "Set up job", conclusion: "success" }, { name: "Verify guard and scan new fork history", conclusion: "failure" }] },
    { name: "Sentry", conclusion: "failure", html_url: "u2", steps: [{ name: "Install workspace dependencies", conclusion: "failure" }] },
    { name: "Lost", conclusion: "cancelled", html_url: "u3", steps: [] },
    { name: "Fine", conclusion: "success", html_url: "u4", steps: [] },
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ jobs }) });
  const found = await failedSteps({ fetchImpl, apiUrl: "https://api.github.com", repository: "o/r", runId: "1", token: "t" });
  assert.deepEqual(found.map((item) => [item.job, item.kind.split(" ")[0]]), [["Secrets", "check"], ["Sentry", "setup"], ["Lost", "setup"]]);
  await assert.rejects(failedSteps({ fetchImpl: async () => ({ ok: false, status: 403 }), apiUrl: "x", repository: "o/r", runId: "1", token: "t" }), /403/);
});

test("render explains a failure and offers the re-run command", () => {
  const result = evaluate(green({ secrets: { result: "failure" } }));
  const text = render({ result, details: [], runUrl: "https://example/run/9", runId: "9" });
  assert.match(text, /CI gate: FAILED/);
  assert.match(text, /secrets: failure \(expected success\)/);
  assert.match(text, /gh run rerun 9 --failed/);
  assert.doesNotMatch(render({ result: evaluate(green()), details: [], runUrl: "u", runId: "9" }), /rerun/);
});

test("cli exits 0 on green, 1 on red, 1 on garbage input", () => {
  const run = (needs) => spawnSync(process.execPath, [script], { env: { ...process.env, NEEDS_JSON: needs, GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "" }, encoding: "utf8" });
  assert.equal(run(JSON.stringify(green())).status, 0);
  assert.equal(run(JSON.stringify(green({ secrets: { result: "failure" } }))).status, 1);
  assert.equal(run("not json").status, 1);
  assert.equal(run("null").status, 1);
});
