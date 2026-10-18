#!/usr/bin/env node
/**
 * Decides how much of CI a change needs.
 *
 * Reads the changed paths as NUL-separated text on stdin (from
 * `git diff --no-renames -z --name-only`) and prints one JSON object:
 *   { "mode": "none" | "full", "need_sentry": boolean, "reason": string }
 *
 * Fails closed: an unknown event, an empty list or an unsafe path means `full`.
 * `none` is a strict allowlist (only docs/ and screenshots/ at the repo root);
 * `doc/`, `README.md` and every other file are inputs to tests or builds.
 * ("affected" is reserved for a later change; the gate already accepts it.)
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

const NONE_PREFIXES = ["docs/", "screenshots/"];

// Mirrors the old sentry-contract.yml path filter (GitHub `*` does not match `/`),
// plus the lockfile and this workflow, which change how the job resolves.
const SENTRY_PATTERNS = [
  /^server\/package\.json$/,
  /^server\/src\/sentry[^/]*\.ts$/,
  /^server\/src\/peer-version-check\.ts$/,
  /^server\/src\/__tests__\/[^/]*sentry[^/]*\.test\.ts$/,
  /^pnpm-lock\.yaml$/,
  /^\.github\/workflows\/ci\.yml$/,
];

function isUnsafe(changedPath) {
  return changedPath.startsWith("/") || changedPath.split("/").includes("..");
}

export function parsePaths(text) {
  return text.split("\0").filter((entry) => entry !== "");
}

export function classify({ event, paths }) {
  if (event !== "pull_request") {
    return { mode: "full", need_sentry: true, reason: `event ${event} always runs everything` };
  }
  if (paths.length === 0) {
    return { mode: "full", need_sentry: true, reason: "no changed paths found" };
  }
  if (paths.some(isUnsafe)) {
    return { mode: "full", need_sentry: true, reason: "unsafe path in the change list" };
  }
  const needSentry = paths.some((changedPath) => SENTRY_PATTERNS.some((pattern) => pattern.test(changedPath)));
  const docsOnly = paths.every((changedPath) => NONE_PREFIXES.some((prefix) => changedPath.startsWith(prefix)));
  if (docsOnly) {
    return { mode: "none", need_sentry: false, reason: `${paths.length} path(s), all under docs/ or screenshots/` };
  }
  return { mode: "full", need_sentry: needSentry, reason: `${paths.length} path(s) outside docs/ and screenshots/` };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(argv) {
  const eventIndex = argv.indexOf("--event");
  const event = eventIndex >= 0 ? argv[eventIndex + 1] : undefined;
  if (!event || argv.length !== 2) {
    console.error("usage: classify-changes.mjs --event <github event name> < paths.nul");
    return 2;
  }
  process.stdout.write(`${JSON.stringify(classify({ event, paths: parsePaths(await readStdin()) }))}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
