#!/usr/bin/env node
/**
 * Workflow policy: every `uses:` is pinned to a full commit SHA (or a local path,
 * or a docker digest), and the privileged triggers `pull_request_target` and
 * `workflow_run` are not used (they run fork-controllable code with secrets).
 * Prints one line per problem and exits 1 if there is any.
 */
import { readdirSync, readFileSync } from "node:fs";
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const directory = process.argv[2] ?? ".github/workflows";
  const problems = readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => findProblems(path.join(directory, file), readFileSync(path.join(directory, file), "utf8")));
  for (const problem of problems) console.log(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
