import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkReport } from "./assert-vitest-ran.mjs";

const script = fileURLToPath(new URL("./assert-vitest-ran.mjs", import.meta.url));
const A = "server/src/__tests__/a.test.ts";
const B = "packages/db/src/b.test.ts";

function report(files, totals = {}) {
  return {
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, ...totals,
    testResults: Object.entries(files).map(([name, statuses]) => ({
      name: `/work/repo/${name}`,
      status: statuses.every((status) => status === "passed") && statuses.length > 0 ? "passed" : "failed",
      assertionResults: statuses.map((status) => ({ status })),
    })),
  };
}

test("passes when every expected file ran and every test passed", () => {
  const result = checkReport(report({ [A]: ["passed", "passed"], [B]: ["passed"] }), [A, B]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, [`${A}: 2 passed, 0 not passed`, `${B}: 1 passed, 0 not passed`]);
});

test("fails on skipped tests, as when embedded Postgres cannot start", () => {
  const skipped = { ...report({ [A]: ["skipped", "skipped"] }, { numPendingTests: 2 }) };
  skipped.testResults[0].status = "skipped";
  const result = checkReport(skipped, [A]);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes(`${A}: 2 skipped test(s)`));
  assert.ok(result.problems.includes("2 skipped test(s) in the report"));
});

test("fails on a missing file, an empty file, todo or failed tests", () => {
  assert.ok(checkReport(report({ [A]: ["passed"] }), [A, B]).problems.includes(`${B}: not in the report`));
  assert.ok(checkReport(report({ [A]: [] }), [A]).problems.includes(`${A}: no tests ran`));
  assert.ok(checkReport(report({ [A]: ["passed", "todo"] }, { numTodoTests: 1 }), [A]).problems.includes(`${A}: 1 todo test(s)`));
  assert.ok(checkReport(report({ [A]: ["failed"] }, { numFailedTests: 1 }), [A]).problems.includes(`${A}: 1 failed test(s)`));
  assert.equal(checkReport({}, [A]).ok, false);
  assert.equal(checkReport(report({ [A]: ["passed"] }), []).ok, false);
});

test("matches a file by its whole path, not a suffix of a name", () => {
  const result = checkReport(report({ "server/src/__tests__/extra-a.test.ts": ["passed"] }), ["a.test.ts"]);
  assert.equal(result.ok, false);
});

test("cli exits 0 on a full run, 1 on a skipped one, 2 on bad usage, and writes the step summary", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "assert-vitest-ran-"));
  try {
    const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env } });
    const ok = path.join(directory, "ok.json");
    const skipped = path.join(directory, "skipped.json");
    const summary = path.join(directory, "summary.md");
    writeFileSync(ok, JSON.stringify(report({ [A]: ["passed"] })));
    writeFileSync(skipped, JSON.stringify(report({ [A]: ["skipped"] }, { numPendingTests: 1 })));
    assert.equal(run([ok, A], { GITHUB_STEP_SUMMARY: summary }).status, 0);
    assert.match(readFileSync(summary, "utf8"), /a\.test\.ts: 1 passed, 0 not passed/);
    assert.equal(run([skipped, A]).status, 1);
    assert.equal(run([path.join(directory, "missing.json"), A]).status, 1);
    assert.equal(run([ok]).status, 2);
    assert.equal(run([]).status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
