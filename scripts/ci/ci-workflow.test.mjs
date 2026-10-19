import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ALWAYS, CONDITIONAL } from "./gate-verdict.mjs";

const text = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobsSection = text.slice(text.indexOf("\njobs:\n"));
const jobIds = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((match) => match[1]);
const gateBlock = jobsSection.slice(jobsSection.indexOf("\n  gate:\n"));
const gateNeeds = (/^ {4}needs:\s*\[([^\]]*)\]/m.exec(gateBlock)?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);

test("ci.yml has no path filters: a required check that never starts blocks the PR", () => {
  assert.doesNotMatch(text, /^\s*paths(-ignore)?:/m);
});

test("every job except the gate is in the gate's needs", () => {
  assert.ok(jobIds.includes("gate"), "the gate job exists");
  assert.deepEqual([...gateNeeds].sort(), jobIds.filter((id) => id !== "gate").sort());
});

test("the gate's needs are exactly the jobs the verdict knows", () => {
  assert.deepEqual([...gateNeeds].sort(), ["changes", ...ALWAYS, ...Object.keys(CONDITIONAL)].sort());
});

test("the gate is named exactly CI gate and cannot be skipped", () => {
  assert.match(gateBlock, /^ {4}name: CI gate$/m);
  assert.match(gateBlock, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
});
