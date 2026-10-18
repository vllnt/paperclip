import assert from "node:assert/strict";
import test from "node:test";
import { findProblems } from "./workflow-policy.mjs";

const sha = "a".repeat(40);

test("accepts SHA pins, local paths, docker digests, comments and trailing comments", () => {
  const text = [
    `      - uses: actions/checkout@${sha} # v7`,
    `        uses: ./.github/workflows/security.yml`,
    `      - uses: docker://alpine@sha256:${"b".repeat(64)}`,
    `# uses: actions/checkout@v4`,
  ].join("\n");
  assert.deepEqual(findProblems("w.yml", text), []);
});

test("rejects tags, branches, short SHAs and tag-only docker images", () => {
  for (const ref of ["actions/checkout@v4", "actions/checkout@main", `actions/checkout@${"a".repeat(7)}`, "docker://alpine:3", "actions/checkout"]) {
    assert.equal(findProblems("w.yml", `      - uses: ${ref}`).length, 1, ref);
  }
});

test("rejects the privileged triggers in any spelling, with the line number", () => {
  assert.deepEqual(findProblems("w.yml", "on:\n  pull_request_target:\n"), ["w.yml:2: pull_request_target and workflow_run are not allowed"]);
  assert.equal(findProblems("w.yml", "on: [push, workflow_run]").length, 1);
  assert.equal(findProblems("w.yml", "# we never use workflow_run").length, 0);
});
