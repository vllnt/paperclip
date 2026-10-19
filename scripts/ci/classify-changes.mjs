#!/usr/bin/env node
/**
 * Decides how much of CI a change needs.
 *
 * Reads the changed paths as NUL-separated text on stdin (from
 * `git diff --no-renames -z --name-only`), prints one JSON object
 *   { "mode": "none" | "full", "need_sentry": boolean, "reason": string }
 * and, when $GITHUB_OUTPUT is set, appends `mode=` and `need_sentry=` to it.
 *
 * Fails closed: an unknown event, an empty list or an unsafe path means `full`.
 * `none` is a strict allowlist (only docs/ and screenshots/ at the repo root);
 * `doc/`, `README.md` and every other file are inputs to tests or builds.
 * ("affected" is reserved for a later change; the gate already accepts it.)
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const NONE_PREFIXES = ["docs/", "screenshots/"];

// The files the real-SDK Sentry contract test exercises (it imports
// run-failure-diagnostics, which imports adapter-stop-timeout), its manifest
// that pins the SDK version, and this workflow. GitHub's `*` does not match `/`.
const SENTRY_PATTERNS = [
  /^server\/package\.json$/,
  /^server\/src\/sentry[^/]*\.ts$/,
  /^server\/src\/peer-version-check\.ts$/,
  /^server\/src\/services\/(run-failure-diagnostics|adapter-stop-timeout)\.ts$/,
  /^server\/src\/__tests__\/[^/]*sentry[^/]*\.test\.ts$/,
  /^\.github\/workflows\/ci\.yml$/,
];

const full = (reason, needSentry = true) => ({ mode: "full", need_sentry: needSentry, reason });
const isUnsafe = (changedPath) => changedPath.startsWith("/") || changedPath.split("/").includes("..");

export function parsePaths(text) {
  return text.split("\0").filter((entry) => entry !== "");
}

export function classify({ event, paths }) {
  if (event !== "pull_request") return full(`event ${event} always runs everything`);
  if (paths.length === 0) return full("no changed paths found");
  if (paths.some(isUnsafe)) return full("unsafe path in the change list");
  if (paths.every((changedPath) => NONE_PREFIXES.some((prefix) => changedPath.startsWith(prefix)))) {
    return { mode: "none", need_sentry: false, reason: `${paths.length} path(s), all under docs/ or screenshots/` };
  }
  const needSentry = paths.some((changedPath) => SENTRY_PATTERNS.some((pattern) => pattern.test(changedPath)));
  return full(`${paths.length} path(s) outside docs/ and screenshots/`, needSentry);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(argv, env) {
  const eventIndex = argv.indexOf("--event");
  const event = eventIndex >= 0 ? argv[eventIndex + 1] : undefined;
  if (!event || argv.length !== 2) {
    console.error("usage: classify-changes.mjs --event <github event name> < paths.nul");
    return 2;
  }
  const result = classify({ event, paths: parsePaths(await readStdin()) });
  console.log(JSON.stringify(result));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${result.mode}\nneed_sentry=${result.need_sentry}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
