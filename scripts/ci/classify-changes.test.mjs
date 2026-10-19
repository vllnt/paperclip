import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify, parsePaths } from "./classify-changes.mjs";

const script = fileURLToPath(new URL("./classify-changes.mjs", import.meta.url));
const pr = (...paths) => classify({ event: "pull_request", paths });

test("docs and screenshots only is the only way to skip work", () => {
  assert.equal(pr("docs/a.md").mode, "none");
  assert.equal(pr("docs/deep/a.md", "screenshots/b.png").mode, "none");
  assert.equal(pr("docs/a.md").need_sentry, false);
  assert.equal(pr("docs/a.md").need_perf_guards, false);
});

test("anything else is full", () => {
  for (const changed of ["doc/a.md", "README.md", "docs-extra/a.md", "docsx/a.md", "Docs/a.md", "server/src/a.ts", "pnpm-lock.yaml"]) {
    assert.equal(pr(changed).mode, "full", changed);
  }
  assert.equal(pr("docs/a.md", "server/src/a.ts").mode, "full");
});

test("fails closed on odd input", () => {
  for (const paths of [[], ["docs/../server/a.ts"], ["../docs/a.md"], ["/docs/a.md"]]) {
    const result = pr(...paths);
    assert.equal(result.mode, "full", paths.join());
    assert.equal(result.need_sentry, true, paths.join());
    assert.equal(result.need_perf_guards, true, paths.join());
  }
});

test("every other event is full with sentry and the perf guards", () => {
  for (const event of ["push", "merge_group", "workflow_dispatch", "schedule", ""]) {
    const result = classify({ event, paths: ["docs/a.md"] });
    assert.equal(result.mode, "full", event);
    assert.equal(result.need_sentry, true, event);
    assert.equal(result.need_perf_guards, true, event);
  }
});

test("perf guards follow the server, the schema, shared types, bundled skills, dependencies, workspace setup and ci.yml", () => {
  for (const changed of [
    "server/src/routes/agents.ts",
    "server/package.json",
    "packages/db/src/schema/heartbeat_runs.ts",
    "packages/db/src/migrations/0314_a.sql",
    "packages/shared/src/index.ts",
    "skills/paperclip/SKILL.md",
    "skills-releases/paperclip/registry.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/ensure-workspace-package-links.ts",
    "scripts/ensure-plugin-build-deps.mjs",
    "vitest.config.ts",
    "scripts/ci/assert-vitest-ran.mjs",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(pr(changed).need_perf_guards, true, changed);
  }
  for (const changed of [
    "ui/src/App.tsx",
    "ui/package.json",
    "cli/src/index.ts",
    "cli/skills/a.md",
    "packages/adapters/claude-local/src/a.ts",
    "doc/DATABASE.md",
    "skillsx/a.md",
    "skills-releasesx/a.json",
    "packages/database/a.ts",
    "scripts/other.ts",
  ]) {
    assert.equal(pr(changed).need_perf_guards, false, changed);
  }
});

test("sentry job follows the files the real-SDK test exercises, plus ci.yml", () => {
  for (const changed of [
    "server/package.json",
    "server/src/sentry.ts",
    "server/src/sentry-init.ts",
    "server/src/peer-version-check.ts",
    "server/src/services/run-failure-diagnostics.ts",
    "server/src/services/adapter-stop-timeout.ts",
    "server/src/__tests__/run-failure-sentry-real-sdk.test.ts",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(pr(changed).need_sentry, true, changed);
  }
  for (const changed of ["server/src/other.ts", "server/src/sentry/nested.ts", "server/src/__tests__/other.test.ts", "ui/package.json", "pnpm-lock.yaml"]) {
    assert.equal(pr(changed).need_sentry, false, changed);
  }
});

test("parsePaths splits on NUL, keeps spaces and newlines, drops empties", () => {
  assert.deepEqual(parsePaths("docs/a b.md\0docs/c\nd.md\0"), ["docs/a b.md", "docs/c\nd.md"]);
  assert.deepEqual(parsePaths(""), []);
});

test("cli reads NUL paths from stdin, prints JSON and writes GITHUB_OUTPUT", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "classify-"));
  try {
    const output = path.join(directory, "output");
    const run = (args, input, env = {}) => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", ...env } });
    const ok = run(["--event", "pull_request"], "docs/a.md\0", { GITHUB_OUTPUT: output });
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).mode, "none");
    assert.equal(readFileSync(output, "utf8"), "mode=none\nneed_sentry=false\nneed_perf_guards=false\n");
    assert.equal(JSON.parse(run(["--event", "pull_request"], "").stdout).mode, "full");
    assert.equal(run([], "").status, 2);
    assert.equal(run(["--event"], "").status, 2);
    assert.equal(run(["--event", "push", "extra"], "").status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
