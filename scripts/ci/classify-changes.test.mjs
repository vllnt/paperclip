import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify, parsePaths } from "./classify-changes.mjs";

const script = fileURLToPath(new URL("./classify-changes.mjs", import.meta.url));
const pr = (...paths) => classify({ event: "pull_request", paths });

test("docs and screenshots only is the only way to skip work", () => {
  assert.equal(pr("docs/a.md").mode, "none");
  assert.equal(pr("docs/deep/a.md", "screenshots/b.png").mode, "none");
  assert.equal(pr("docs/a.md").need_sentry, false);
});

test("anything else is full", () => {
  for (const changed of ["doc/a.md", "README.md", "docs-extra/a.md", "docsx/a.md", "Docs/a.md", "server/src/a.ts", "pnpm-lock.yaml"]) {
    assert.equal(pr(changed).mode, "full", changed);
  }
  assert.equal(pr("docs/a.md", "server/src/a.ts").mode, "full");
});

test("fails closed on odd input", () => {
  assert.equal(pr().mode, "full");
  assert.equal(pr("docs/../server/a.ts").mode, "full");
  assert.equal(pr("../docs/a.md").mode, "full");
  assert.equal(pr("/docs/a.md").mode, "full");
});

test("every other event is full with sentry", () => {
  for (const event of ["push", "merge_group", "workflow_dispatch", "schedule", ""]) {
    assert.deepEqual(classify({ event, paths: ["docs/a.md"] }), {
      mode: "full",
      need_sentry: true,
      reason: `event ${event} always runs everything`,
    });
  }
});

test("sentry job follows the old path filter, the lockfile and ci.yml", () => {
  for (const changed of [
    "server/package.json",
    "server/src/sentry.ts",
    "server/src/sentry-init.ts",
    "server/src/peer-version-check.ts",
    "server/src/__tests__/run-failure-sentry-real-sdk.test.ts",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(pr(changed).need_sentry, true, changed);
  }
  for (const changed of ["server/src/other.ts", "server/src/sentry/nested.ts", "server/src/__tests__/other.test.ts", "ui/package.json"]) {
    assert.equal(pr(changed).need_sentry, false, changed);
  }
});

test("parsePaths splits on NUL, keeps spaces and newlines, drops empties", () => {
  assert.deepEqual(parsePaths("docs/a b.md\0docs/c\nd.md\0"), ["docs/a b.md", "docs/c\nd.md"]);
  assert.deepEqual(parsePaths(""), []);
});

test("cli reads NUL paths from stdin and prints one JSON object", () => {
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  const ok = run(["--event", "pull_request"], "docs/a.md\0");
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).mode, "none");
  assert.equal(JSON.parse(run(["--event", "pull_request"], "").stdout).mode, "full");
  assert.equal(run([], "").status, 2);
  assert.equal(run(["--event"], "").status, 2);
  assert.equal(run(["--event", "push", "extra"], "").status, 2);
});
