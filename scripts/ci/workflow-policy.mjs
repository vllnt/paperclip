#!/usr/bin/env node
/**
 * Workflow policy (workflows and composite actions): every `uses:` is pinned to a full commit SHA (or a local path,
 * or a docker digest), and the privileged triggers `pull_request_target` and
 * `workflow_run` are not used (they run fork-controllable code with secrets).
 * Prints one line per problem and exits 1 if there is any.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const USES = /^\s*(?:-\s*)?uses:\s*(\S+)/;
const PINNED = [/^\.\.?\//, /@[0-9a-f]{40}$/, /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/];
const BANNED_TRIGGER = /\b(pull_request_target|workflow_run)\b/;

export function findProblems(name, text) {
  const problems = [];
  text.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const where = `${name}:${index + 1}`;
    const uses = USES.exec(line);
    if (uses && !PINNED.some((pattern) => pattern.test(uses[1]))) problems.push(`${where}: "${uses[1]}" is not pinned to a commit SHA`);
    if (BANNED_TRIGGER.test(line)) problems.push(`${where}: pull_request_target and workflow_run are not allowed`);
  });
  return problems;
}

const yamlIn = (directory) =>
  existsSync(directory) ? readdirSync(directory).filter((file) => /\.ya?ml$/.test(file)).map((file) => path.join(directory, file)) : [];

// Workflows and the composite actions under .github/actions/<name>/.
export function policyFiles(root = ".github") {
  const actions = path.join(root, "actions");
  const composites = existsSync(actions) ? readdirSync(actions, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
  return [path.join(root, "workflows"), ...composites.map((entry) => path.join(actions, entry.name))].flatMap(yamlIn);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = policyFiles(process.argv[2]).flatMap((file) => findProblems(file, readFileSync(file, "utf8")));
  for (const problem of problems) console.log(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
