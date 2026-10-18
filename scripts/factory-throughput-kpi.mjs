#!/usr/bin/env node
/**
 * factory-throughput-kpi.mjs
 *
 * Merge throughput KPI for a set of GitHub repositories: merged PRs per hour over
 * 1 h / 6 h / 24 h, the rolling 6 h minimum, and how many consecutive 24 h days
 * sustained the target. Read-only: it only issues GET and GraphQL queries through `gh`.
 *
 *   factory-throughput-kpi.mjs --repos owner/a,owner/b [--target 6] [--sustain-days 3]
 *                              [--discover-org owner] [--now ISO] [--json] [--line]
 *
 * Repositories may also come from FACTORY_KPI_REPOS (comma separated).
 * Gate mode (for a routine that must stay silent when nothing changed):
 *
 *   factory-throughput-kpi.mjs --gate --state-file FILE | --state-issue ISSUE_ID  [other options]
 *
 * prints nothing and exits 0 when nothing worth a line changed since the last printed line; otherwise
 * prints one KPI line, why, and the facts, and exits 10. The state (last printed numbers, per-PR
 * guard cache) is a local file or a Paperclip issue document (PAPERCLIP_API_URL / PAPERCLIP_API_KEY).
 *
 * Exit codes: 0 report printed (gate: nothing to say), 10 gate has something to say, 20 report printed
 * but collection was incomplete or the guard unverified, 2 usage error.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DAY_MS,
  DEFAULT_SUSTAIN_DAYS,
  DEFAULT_TARGET_PER_HOUR,
  buildThroughput,
} from "./lib/factory-kpi-metrics.mjs";
import {
  GhError,
  createGh,
  discoverActiveRepos,
  fetchMergedPrs,
  mapLimit,
  parseRepo,
  registerEnvSecrets,
} from "./lib/factory-kpi-github.mjs";
import { clean, isIncomplete, renderLine, renderReport } from "./lib/factory-kpi-render.mjs";
import { computeVerdict, parseBaseline } from "./lib/factory-kpi-guard.mjs";
import { collectAgents } from "./lib/factory-kpi-agents.mjs";
import { collectSupport } from "./lib/factory-kpi-support.mjs";
import { DEFAULT_HEARTBEAT_MS, DEFAULT_RATE_STEP, configFingerprint, decideGate, gateSignature, renderGate } from "./lib/factory-kpi-gate.mjs";
import { StateError, fileStore, issueDocumentStore } from "./lib/factory-kpi-state.mjs";
import { DEFAULT_DETAIL_BUDGET, collectGuard, collectRegression } from "./lib/factory-kpi-guard-run.mjs";

export { renderLine, renderReport };

export const EXIT_OK = 0;
export const EXIT_POST = 10;
export const EXIT_INCOMPLETE = 20;
export const EXIT_USAGE = 2;

const OPTIONS = {
  repos: { type: "string" },
  "discover-org": { type: "string" },
  target: { type: "string", default: String(DEFAULT_TARGET_PER_HOUR) },
  "sustain-days": { type: "string", default: String(DEFAULT_SUSTAIN_DAYS) },
  "guard-days": { type: "string" },
  "no-guard": { type: "boolean", default: false },
  "no-support": { type: "boolean", default: false },
  agents: { type: "boolean", default: false },
  baseline: { type: "string" },
  "baseline-at": { type: "string" },
  "detail-budget": { type: "string", default: String(DEFAULT_DETAIL_BUDGET) },
  gate: { type: "boolean", default: false },
  "state-file": { type: "string" },
  "state-issue": { type: "string" },
  "state-key": { type: "string", default: "kpi-state" },
  "heartbeat-hours": { type: "string", default: String(DEFAULT_HEARTBEAT_MS / 3_600_000) },
  "rate-step": { type: "string", default: String(DEFAULT_RATE_STEP) },
  now: { type: "string" },
  json: { type: "boolean", default: false },
  line: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
};

export class UsageError extends Error {}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;

export function parseOptions(argv, env = process.env, clock = Date.now) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return { help: true };
  const positiveNumber = (name, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
    return n;
  };
  const positiveInteger = (name, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a whole number of at least 1`);
    return n;
  };
  // A timestamp without a zone would be read in the runner's local time; refuse to guess.
  const instant = (name, text) => {
    if (!ISO_INSTANT.test(text)) throw new UsageError(`--${name} must be an ISO date or a timestamp with a zone, for example 2026-01-31T12:00:00Z`);
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) throw new UsageError(`--${name} must be an ISO timestamp`);
    return ms;
  };
  const listed = (values.repos ?? env.FACTORY_KPI_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const seen = new Set();
  const repos = listed.filter((repo) => !seen.has(repo.toLowerCase()) && seen.add(repo.toLowerCase()));
  for (const repo of repos) {
    try {
      parseRepo(repo);
    } catch {
      throw new UsageError(`invalid repository "${repo}", expected owner/name`);
    }
  }
  if (!repos.length && !values["discover-org"]) {
    throw new UsageError("name the repositories with --repos or FACTORY_KPI_REPOS, or use --discover-org");
  }
  if (values.now && values.gate) throw new UsageError("--now cannot be used with --gate: the state would be stamped with a fake time");
  const nowMs = values.now ? instant("now", values.now) : clock();
  const sustainDays = positiveInteger("sustain-days", values["sustain-days"]);
  const baselineText = values.baseline ?? env.FACTORY_KPI_BASELINE;
  const baseline = baselineText ? parseBaseline(baselineText) : null;
  if (baselineText && !baseline) throw new UsageError("--baseline must look like EVENTS/TOTAL, for example 2/39");
  const baselineAtText = values["baseline-at"] ?? env.FACTORY_KPI_BASELINE_AT;
  const baselineAtMs = baselineAtText ? instant("baseline-at", baselineAtText) : null;
  if (values.agents && !(env.PAPERCLIP_API_URL && env.PAPERCLIP_API_KEY && env.PAPERCLIP_COMPANY_ID)) {
    throw new UsageError("--agents needs PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID");
  }
  if (values.gate && !(values["state-file"] ?? env.FACTORY_KPI_STATE_FILE) && !(values["state-issue"] ?? env.FACTORY_KPI_STATE_ISSUE)) {
    throw new UsageError("--gate needs --state-file or --state-issue (a gate without state would always speak)");
  }
  return {
    help: values.help,
    repos,
    discoverOrg: values["discover-org"] ?? null,
    targetPerHour: positiveNumber("target", values.target),
    sustainDays,
    guard: !values["no-guard"],
    support: !values["no-support"],
    paperclip: values.agents
      ? { apiUrl: env.PAPERCLIP_API_URL, apiKey: env.PAPERCLIP_API_KEY, companyId: env.PAPERCLIP_COMPANY_ID }
      : null,
    // The guard must cover every day the throughput verdict relies on.
    guardDays: Math.max(sustainDays, values["guard-days"] !== undefined ? positiveInteger("guard-days", values["guard-days"]) : 0),
    baseline,
    baselineAtMs,
    detailBudget: positiveInteger("detail-budget", values["detail-budget"]),
    gate: values.gate,
    stateFile: values["state-file"] ?? env.FACTORY_KPI_STATE_FILE ?? null,
    stateIssue: values["state-issue"] ?? env.FACTORY_KPI_STATE_ISSUE ?? null,
    stateKey: values["state-key"],
    heartbeatMs: positiveNumber("heartbeat-hours", values["heartbeat-hours"]) * 3_600_000,
    rateStep: positiveNumber("rate-step", values["rate-step"]),
    nowMs,
    json: values.json,
    line: values.line,
  };
}

const REGRESSION_WINDOW_DAYS = 7;

/**
 * Collect and compute one snapshot. `gh` is injected so tests never touch the network;
 * `cache` holds per-PR guard verdicts and is mutated in place so the caller can persist it.
 */
export async function collectSnapshot(options, gh, { cache = {}, fetchImpl } = {}) {
  const endMs = options.nowMs;
  const fetchDays = options.guard ? Math.max(options.sustainDays, options.guardDays, REGRESSION_WINDOW_DAYS) : options.sustainDays;
  let sinceMs = endMs - fetchDays * DAY_MS;
  if (options.guard && !options.baseline && options.baselineAtMs !== null) {
    sinceMs = Math.min(sinceMs, options.baselineAtMs - REGRESSION_WINDOW_DAYS * DAY_MS);
  }
  const repos = [...options.repos];
  const known = new Set(repos.map((r) => r.toLowerCase()));
  const errors = [];
  let discoveryComplete = true;
  if (options.discoverOrg) {
    try {
      const found = await discoverActiveRepos(gh, options.discoverOrg, { sinceMs });
      discoveryComplete = found.complete;
      for (const repo of found.repos) {
        if (!known.has(repo.toLowerCase())) {
          known.add(repo.toLowerCase());
          repos.push(repo);
        }
      }
    } catch (error) {
      errors.push({ repo: `org:${options.discoverOrg}`, kind: error.kind ?? "other", message: error.message });
    }
  }
  if (!discoveryComplete) errors.push({ repo: `org:${options.discoverOrg}`, kind: "other", message: "more repositories than were listed" });
  const results = await mapLimit(repos, (repo) =>
    fetchMergedPrs(gh, repo, { sinceMs }).catch((error) => ({
      repo,
      error: { kind: error instanceof GhError ? error.kind : "other", message: error.message },
    })),
  );
  const prs = results.flatMap((r) => r.prs ?? []);
  const perRepo = results.map((r) => ({
    repo: r.repo,
    status: r.error ? "error" : r.complete ? "ok" : "truncated",
    ...(r.error ? { error: r.error } : { defaultBranch: r.defaultBranch, otherBaseMerged: r.otherBaseMerged }),
  }));
  for (const r of perRepo) if (r.error) errors.push({ repo: r.repo, ...r.error });
  const complete = perRepo.every((r) => r.status === "ok") && errors.length === 0;
  const throughput = buildThroughput({
    prs,
    repos: repos.filter((r) => results.find((x) => x.repo === r && !x.error)),
    endMs,
    targetPerHour: options.targetPerHour,
    days: options.sustainDays,
    complete,
  });
  let guard = null;
  let regression = null;
  if (options.guard) {
    guard = await collectGuard(gh, {
      fetched: results,
      endMs,
      guardDays: options.guardDays,
      cache,
      detailBudget: options.detailBudget,
    });
    regression = collectRegression({ prs, endMs, baseline: options.baseline, baselineAtMs: options.baselineAtMs });
  }
  // The gate line never shows open PRs or agents, so a gate run does not spend requests on them.
  const support = options.support && !options.gate
    ? await collectSupport(gh, { repos: results.filter((r) => !r.error).map((r) => r.repo), mergedPrs: prs, endMs })
    : null;
  const agents = options.paperclip && !options.gate ? await collectAgents({ ...options.paperclip, fetchImpl }) : null;
  return {
    version: 1,
    generatedAt: new Date(endMs).toISOString(),
    endMs,
    repos: perRepo,
    errors,
    complete,
    prs,
    throughput,
    guard,
    regression,
    support,
    agents,
    verdict: computeVerdict({ sustained: throughput.sustained, guard, regression, complete }),
  };
}

function buildStore(options, env, fetchImpl) {
  if (options.stateIssue) {
    return issueDocumentStore({
      apiUrl: env.PAPERCLIP_API_URL,
      apiKey: env.PAPERCLIP_API_KEY,
      issueId: options.stateIssue,
      key: options.stateKey,
      runId: env.PAPERCLIP_RUN_ID ?? null,
      fetchImpl,
    });
  }
  return fileStore(options.stateFile);
}

// The per-PR list stays internal: JSON output carries aggregates only.
function publicSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "prs"));
}

async function runGate(options, deps, out, err) {
  let store;
  try {
    store = deps.store ?? buildStore(options, deps.env ?? process.env, deps.fetch);
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
    err(`factory-throughput-kpi: ${error.message}`);
    return EXIT_USAGE;
  }
  // A gate that dies silently looks exactly like a gate with nothing to say, so a crash is a line too.
  try {
    return await gateOnce(options, deps, store, out);
  } catch (error) {
    out(`gate failed: ${clean(error instanceof Error ? error.message : String(error))}`);
    return EXIT_POST;
  }
}

async function gateOnce(options, deps, store, out) {
  let saved = null;
  let stateProblem = null;
  try {
    saved = await store.read();
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
    stateProblem = error.message;
  }
  const cache = saved?.cache ?? {};
  const snapshot = await collectSnapshot(options, deps.gh ?? createGh(), { cache, fetchImpl: deps.fetch });
  const current = gateSignature(snapshot, { atMs: snapshot.endMs, config: configFingerprint(options) });
  const previousStreak = saved?.incompleteStreak ?? 0;
  // Unreadable state must not silence the routine: speak, and say why.
  const decision = stateProblem
    ? { post: true, reasons: [`state unreadable (${stateProblem})`], streak: current.incomplete ? 1 : 0, save: current }
    : decideGate({ current, previous: saved?.lastPosted ?? null, streak: previousStreak, heartbeatMs: options.heartbeatMs, rateStep: options.rateStep });
  // A silent run still saves what it learned when that saves work next time (merges not judged yet)
  // or when the count of incomplete runs moved; it never touches the record of what was last posted.
  const backlog = (snapshot.guard?.repos ?? []).some((r) => r.pending > 0);
  const reasons = [...decision.reasons];
  let post = decision.post;
  if (post || backlog || decision.streak !== previousStreak) {
    try {
      await store.write({
        lastPosted: post ? decision.save : (saved?.lastPosted ?? null),
        cache,
        incompleteStreak: decision.streak,
      });
    } catch (error) {
      if (!(error instanceof StateError)) throw error;
      reasons.push(post ? `state not saved (${error.message}), the next run will speak again` : `state not saved (${error.message})`);
      post = true; // a gate that cannot remember is not healthy, whatever the numbers say
    }
  }
  if (!post) return EXIT_OK;
  out(
    options.json
      ? JSON.stringify({ gate: { reasons }, ...publicSnapshot(snapshot) }, null, 2)
      : renderGate({ line: renderLine(snapshot), reasons, snapshot }),
  );
  return EXIT_POST;
}

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  let options;
  registerEnvSecrets(deps.env ?? process.env);
  try {
    options = parseOptions(argv, deps.env ?? process.env, deps.clock ?? Date.now);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`factory-throughput-kpi: ${error.message}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    out(
      "usage: factory-throughput-kpi.mjs --repos owner/a,owner/b [--target N] [--sustain-days N] [--discover-org ORG] [--baseline E/T | --baseline-at ISO] [--no-guard] [--no-support] [--agents] [--now ISO] [--json] [--line]\n" +
        "       factory-throughput-kpi.mjs --gate (--state-file FILE | --state-issue ID) [--heartbeat-hours N] [--rate-step N] ...",
    );
    return EXIT_OK;
  }
  if (options.gate) return runGate(options, deps, out, err);
  const snapshot = await collectSnapshot(options, deps.gh ?? createGh(), { fetchImpl: deps.fetch });
  out(options.json ? JSON.stringify(publicSnapshot(snapshot), null, 2) : options.line ? renderLine(snapshot) : renderReport(snapshot));
  return isIncomplete(snapshot) ? EXIT_INCOMPLETE : EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not exit(): stdout is flushed before the process ends.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`factory-throughput-kpi: ${clean(error instanceof GhError ? error.message : (error?.stack ?? error))}\n`);
      process.exitCode = 1;
    },
  );
}
