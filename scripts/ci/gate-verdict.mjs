/**
 * Verdict logic of the `CI gate` job (entry point: evaluate-gate.mjs).
 *
 * The gate is the one required check, so it must never pass by accident:
 * the classifier has to succeed with a known mode, every job in `needs` must be
 * known here, always-on jobs must be `success`, conditional jobs must be
 * `success` when the classifier asked for them and `skipped` when it did not.
 * Anything else (failure, cancelled, an unexpected skip) fails the gate.
 *
 * To add a job: add it to the `jobs:` list and to the gate's `needs:` in ci.yml,
 * and to ALWAYS (or CONDITIONAL plus a classifier output) below.
 * ci-workflow.test.mjs fails if the three disagree.
 */

export const MODES = ["none", "affected", "full"];
export const ALWAYS = ["scripts", "secrets"];
// job id -> classifier output that says whether the job must run
export const CONDITIONAL = { sentry: "need_sentry", "perf-guards": "need_perf_guards" };

// Failing steps that belong to the runner or an action, not to the repository's own checks.
const SETUP_STEP = /^(set up job|complete job|post |run actions\/)/i;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export function evaluate(needs) {
  const known = new Set(["changes", ...ALWAYS, ...Object.keys(CONDITIONAL)]);
  const problems = Object.keys(needs)
    .filter((job) => !known.has(job))
    .map((job) => `unknown job "${job}" in needs; add it to ALWAYS or CONDITIONAL in scripts/ci/gate-verdict.mjs`);
  const resultOf = (job) => needs[job]?.result ?? "missing";

  if (resultOf("changes") !== "success") {
    // Without the classifier nothing else can be judged; report the root cause only.
    problems.push(`changes: ${resultOf("changes")} (the classifier must succeed)`);
    return { ok: false, mode: undefined, rows: [{ job: "changes", result: resultOf("changes"), expected: "success" }], problems };
  }

  const outputs = needs.changes.outputs ?? {};
  if (!MODES.includes(outputs.mode)) problems.push(`changes: unknown mode "${outputs.mode}"`);
  const rows = [{ job: "changes", result: "success", expected: "success" }];
  for (const job of ALWAYS) rows.push({ job, result: resultOf(job), expected: "success" });
  for (const [job, output] of Object.entries(CONDITIONAL)) {
    if (outputs[output] !== "true" && outputs[output] !== "false") {
      problems.push(`changes: output ${output} is "${outputs[output]}", expected true or false`);
    }
    rows.push({ job, result: resultOf(job), expected: outputs[output] === "false" ? "skipped" : "success" });
  }
  for (const row of rows) {
    if (row.result !== row.expected) problems.push(`${row.job}: ${row.result} (expected ${row.expected})`);
  }
  return { ok: problems.length === 0, mode: outputs.mode, rows, problems };
}

export async function failedSteps({ fetchImpl = fetch, apiUrl, repository, runId, token }) {
  const failed = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/actions/runs/${runId}/jobs?per_page=${PAGE_SIZE}&filter=latest&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`jobs API answered ${response.status}`);
    const { jobs } = await response.json();
    failed.push(...jobs.filter((job) => ["failure", "cancelled", "timed_out"].includes(job.conclusion)));
    if (jobs.length < PAGE_SIZE) break;
  }
  return failed.map((job) => {
    const step = (job.steps ?? []).find((candidate) => candidate.conclusion === "failure");
    let kind = "check: read the log; a re-run only helps for a network or registry error";
    let rerun = false;
    if (job.conclusion === "cancelled") ({ kind, rerun } = { kind: "cancelled (superseded or stopped by hand)", rerun: true });
    else if (job.conclusion === "timed_out" || !step) ({ kind, rerun } = { kind: "infrastructure: no step failed (runner lost or timed out)", rerun: true });
    else if (SETUP_STEP.test(step.name)) ({ kind, rerun } = { kind: "setup: a re-run may help", rerun: true });
    return { job: job.name, step: step?.name ?? "-", kind, rerun, url: job.html_url };
  });
}

// Names come from workflow files and the API; keep them from breaking the table or the log.
const cell = (value) => String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

export function render({ result, details, detailsError, runUrl, runId }) {
  const lines = [`## CI gate: ${result.ok ? "passed" : "FAILED"}`, "", `Mode: \`${cell(result.mode ?? "unknown")}\``, "", "| job | result | expected |", "|---|---|---|"];
  for (const row of result.rows) lines.push(`| ${cell(row.job)} | ${cell(row.result)} | ${cell(row.expected)} |`);
  if (result.problems.length > 0) lines.push("", "### Why it failed", ...result.problems.map((problem) => `- ${cell(problem)}`));
  if (details.length > 0) {
    lines.push("", "### Failing jobs", "", "| job | step | looks like | log |", "|---|---|---|---|");
    for (const item of details) lines.push(`| ${cell(item.job)} | ${cell(item.step)} | ${cell(item.kind)} | [log](${cell(item.url)}) |`);
  }
  if (detailsError) lines.push("", `Could not list the failing steps (${cell(detailsError)}); open the run: ${runUrl}`);
  if (!result.ok) {
    lines.push("", details.some((item) => item.rerun)
      ? `Re-run only the failed jobs: \`gh run rerun ${runId} --failed\` (${runUrl}).`
      : `Fix the cause and push (${runUrl}); re-running will not change a real failure.`);
  }
  return `${lines.join("\n")}\n`;
}

// Workflow-command data escaping, so a name cannot start a command of its own.
export const commandData = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
