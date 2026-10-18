#!/usr/bin/env node
/**
 * Verdict of the `CI gate` job. Reads `toJSON(needs)` from $NEEDS_JSON.
 *
 * The gate is the one required check, so it must never pass by accident:
 * the classifier has to succeed with a known mode, every job in `needs` must be
 * known here, always-on jobs must be `success`, conditional jobs must be
 * `success` when the classifier asked for them and `skipped` when it did not.
 * Anything else (failure, cancelled, an unexpected skip) fails the gate.
 *
 * On failure it explains itself: failing jobs and steps, whether the failing
 * step looks like setup/infrastructure or a real check, and how to re-run.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const MODES = ["none", "affected", "full"];
export const ALWAYS = ["secrets"];
// job id -> classifier output that says whether the job must run
export const CONDITIONAL = { sentry: "need_sentry" };

const SETUP_STEP = /^(set up job|run actions\/|checkout|setup |install |pull |download |restore |cache |login |free )/i;

export function evaluate(needs) {
  const problems = [];
  const rows = [];
  const known = new Set(["changes", ...ALWAYS, ...Object.keys(CONDITIONAL)]);

  for (const job of Object.keys(needs)) {
    if (!known.has(job)) problems.push(`unknown job "${job}" in needs; teach scripts/ci/evaluate-gate.mjs about it`);
  }
  const resultOf = (job) => needs[job]?.result ?? "missing";

  const mode = needs.changes?.outputs?.mode;
  if (resultOf("changes") !== "success") problems.push(`changes: ${resultOf("changes")} (the classifier must succeed)`);
  else if (!MODES.includes(mode)) problems.push(`changes: unknown mode "${mode}"`);
  rows.push({ job: "changes", result: resultOf("changes"), expected: "success" });

  for (const job of ALWAYS) {
    rows.push({ job, result: resultOf(job), expected: "success" });
  }
  for (const [job, output] of Object.entries(CONDITIONAL)) {
    const wanted = needs.changes?.outputs?.[output];
    if (wanted !== "true" && wanted !== "false") problems.push(`changes: output ${output} is "${wanted}", expected true or false`);
    rows.push({ job, result: resultOf(job), expected: wanted === "true" ? "success" : wanted === "false" ? "skipped" : "success" });
  }
  for (const row of rows) {
    if (row.result !== row.expected) problems.push(`${row.job}: ${row.result} (expected ${row.expected})`);
  }
  return { ok: problems.length === 0, mode, rows, problems: [...new Set(problems)] };
}

export async function failedSteps({ fetchImpl = fetch, apiUrl, repository, runId, token }) {
  const response = await fetchImpl(`${apiUrl}/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&filter=latest`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`jobs API answered ${response.status}`);
  const { jobs } = await response.json();
  return jobs
    .filter((job) => ["failure", "cancelled", "timed_out"].includes(job.conclusion))
    .map((job) => {
      const step = (job.steps ?? []).find((candidate) => candidate.conclusion === "failure");
      const kind = !step || SETUP_STEP.test(step.name) ? "setup or infrastructure (re-run may help)" : "check (read the log)";
      return { job: job.name, conclusion: job.conclusion, step: step?.name ?? "no step failed (runner lost or timed out)", kind, url: job.html_url };
    });
}

export function render({ result, details, runUrl, runId }) {
  const lines = [`## CI gate: ${result.ok ? "passed" : "FAILED"}`, "", `Mode: \`${result.mode ?? "unknown"}\``, "", "| job | result | expected |", "|---|---|---|"];
  for (const row of result.rows) lines.push(`| ${row.job} | ${row.result} | ${row.expected} |`);
  if (result.problems.length > 0) lines.push("", "### Why it failed", ...result.problems.map((problem) => `- ${problem}`));
  if (details.length > 0) {
    lines.push("", "### Failing jobs", "", "| job | step | looks like | log |", "|---|---|---|---|");
    for (const item of details) lines.push(`| ${item.job} | ${item.step} | ${item.kind} | [log](${item.url}) |`);
  }
  if (!result.ok) lines.push("", `Re-run only the failed jobs: \`gh run rerun ${runId} --failed\` (${runUrl}).`);
  return `${lines.join("\n")}\n`;
}

async function main(env) {
  const needs = JSON.parse(env.NEEDS_JSON ?? "null");
  if (needs === null || typeof needs !== "object") throw new Error("NEEDS_JSON is missing or not an object");
  const result = evaluate(needs);
  let details = [];
  if (!result.ok && env.GITHUB_TOKEN) {
    try {
      details = await failedSteps({ apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, token: env.GITHUB_TOKEN });
    } catch (error) {
      console.log(`::warning title=CI gate::could not list failing steps: ${error.message}`);
    }
  }
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const text = render({ result, details, runUrl, runId: env.GITHUB_RUN_ID });
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  for (const problem of result.problems) console.log(`::error title=CI gate::${problem}`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.env).catch((error) => {
    console.log(`::error title=CI gate::${error.message}`);
    return 1;
  });
}
