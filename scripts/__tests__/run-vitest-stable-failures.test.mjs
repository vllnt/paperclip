import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Run with: node --test scripts/__tests__/run-vitest-stable-failures.test.mjs
//
// The runner starts one `pnpm exec vitest run` per project or suite. These
// tests put a stub `pnpm` first on PATH, so no Vitest process starts. The stub
// logs its arguments and exits with the code given for a project in STUB_FAIL
// ("project:code" pairs, space separated).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const lane = ["--mode", "general", "--group", "general-workspaces-a"];
const laneProjects = ["@paperclipai/ui", "paperclipai"];

const stubPnpm = [
  "#!/bin/sh",
  'echo "$*" >> "$STUB_LOG"',
  "for pair in $STUB_FAIL; do",
  '  case "$*" in',
  '    *"--project ${pair%%:*}") exit "${pair##*:}" ;;',
  "  esac",
  "done",
  "exit 0",
  "",
].join("\n");

function runLane(failures) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-vitest-stub-"));
  try {
    writeFileSync(path.join(dir, "pnpm"), stubPnpm, { mode: 0o755 });
    const log = path.join(dir, "calls.log");
    writeFileSync(log, "");
    const result = spawnSync(process.execPath, [script, ...lane], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        STUB_LOG: log,
        STUB_FAIL: failures.join(" "),
      },
    });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertEveryProjectRan(calls) {
  assert.equal(calls.length, laneProjects.length, `expected one call per project, got: ${calls.join(" | ")}`);
  for (const project of laneProjects) {
    assert.ok(calls.some((call) => call.endsWith(`--project ${project}`)), `${project} did not run`);
  }
}

const skip = process.platform === "win32" ? "the stub pnpm is a POSIX shell script" : false;

test("a passing lane exits 0 and prints no failure summary", { skip }, () => {
  const result = runLane([]);
  assert.equal(result.status, 0, result.stderr);
  assertEveryProjectRan(result.calls);
  assert.doesNotMatch(result.stderr, /invocations failed/);
});

test("a failing invocation does not stop the ones after it", { skip }, () => {
  const result = runLane([`${laneProjects[0]}:1`]);
  assertEveryProjectRan(result.calls);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[test:run\] 1 of 2 Vitest invocations failed:/);
  assert.match(result.stderr, /\[test:run\] {3}general-workspaces-a project @paperclipai\/ui \(exit 1\)/);
  assert.doesNotMatch(result.stderr, /general-workspaces-a project paperclipai \(/);
});

test("a failure in the last invocation still fails the run", { skip }, () => {
  const result = runLane([`${laneProjects[1]}:1`]);
  assertEveryProjectRan(result.calls);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 of 2 Vitest invocations failed/);
  assert.match(result.stderr, /general-workspaces-a project paperclipai \(exit 1\)/);
});

test("every failure is listed and the first one sets the exit code", { skip }, () => {
  const result = runLane([`${laneProjects[0]}:3`, `${laneProjects[1]}:2`]);
  assertEveryProjectRan(result.calls);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /2 of 2 Vitest invocations failed/);
  assert.match(result.stderr, /project @paperclipai\/ui \(exit 3\)/);
  assert.match(result.stderr, /project paperclipai \(exit 2\)/);
});

test("the summary adds no line the unit-test report step would count as a failing test", { skip }, () => {
  // unit-tests.yml collects failing tests with: grep -E '^ *FAIL '
  const result = runLane(laneProjects.map((project) => `${project}:1`));
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /^ *FAIL /m);
});
