/**
 * Shared helpers for the web-app probes: arguments, statistics, the seed file and
 * the result file that gate.mjs reads.
 *
 * Every probe writes one JSON file: { meta, rows, results? }.
 *   meta.tool   the probe name ("measure", "nav-timing", "route-smoke", ...)
 *   meta.label  the run label (for example "b1-r1" or "m0-r1")
 *   rows        one object per measured cell, with a string `key` that is the same
 *               for the same cell in every run, so gate.mjs can pair base and head
 * Node built-ins only; the probes import Playwright themselves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** `--a 1 --b` → { a: "1", b: true }. A value may not start with `--`. */
export function parseArgs(list = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].startsWith("--")) continue;
    const next = list[i + 1];
    out[list[i].slice(2)] = next === undefined || next.startsWith("--") ? true : list[++i];
  }
  return out;
}

const finite = (xs) => xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);

export function median(xs) {
  const v = finite(xs);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Nearest-rank percentile, q in (0, 1]. */
export function percentile(xs, q) {
  const v = finite(xs);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}

export function spread(xs) {
  const v = finite(xs);
  return v.length ? { min: v[0], max: v[v.length - 1], n: v.length } : { min: null, max: null, n: 0 };
}

export function readSeed(file = path.join(ROOT, "tmp/perf/seed-out.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitCommit() {
  try {
    return execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Starts the meta block; call `finishMeta` before writing. */
export function startMeta(tool, args, extra = {}) {
  return {
    tool,
    label: String(args.label ?? "run"),
    base: args.base ?? null,
    commit: gitCommit(),
    at: new Date().toISOString(),
    host: { cpus: os.cpus().length, platform: process.platform },
    loadAvgStart: os.loadavg()[0],
    ...extra,
  };
}

export function finishMeta(meta) {
  meta.loadAvgEnd = os.loadavg()[0];
  meta.durationMs = Date.now() - Date.parse(meta.at);
  return meta;
}

/** Writes `<out>/<label>-<tool>.json` and returns the path. */
export function writeResult(meta, payload, outDir = "tmp/perf/results") {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${meta.label}-${meta.tool}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta: finishMeta(meta), ...payload }, null, 2));
  return file;
}

export const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d));

/** Console noise that section 2 of doc/plans/web-perf.md calls fixture noise. */
export const FIXTURE_NOISE = [/\/api\/heartbeat-runs\/[^/]+\/log\b.*404/, /documents\/plan.*404/];
export const isFixtureNoise = (text) => FIXTURE_NOISE.some((re) => re.test(text));
