#!/usr/bin/env node
/**
 * Fails unless a Vitest JSON report (`--reporter=json`) shows that each listed
 * test file ran and that every test in it passed: no failed, skipped or todo
 * test, and no missing file.
 *
 * The query plan and statement budget guards need embedded Postgres, and they
 * skip themselves on a host where it cannot start. Vitest then exits 0. In the
 * CI job that runs them, a skip must fail the job instead of passing quietly.
 *
 * usage: assert-vitest-ran.mjs <report.json> <test file>...
 * With $GITHUB_STEP_SUMMARY set, it appends one line per file to it.
 */
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The problems of a report for the expected repository-relative test files, and a per-file summary. */
export function checkReport(report, expectedFiles) {
  const problems = [];
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  const summary = [];
  if (expectedFiles.length === 0) problems.push("no test files were expected");
  for (const expected of expectedFiles) {
    const matches = files.filter((file) => typeof file.name === "string" && (file.name === expected || file.name.endsWith(`/${expected}`)));
    if (matches.length !== 1) {
      problems.push(`${expected}: ${matches.length === 0 ? "not in the report" : `${matches.length} entries in the report`}`);
      continue;
    }
    const tests = Array.isArray(matches[0].assertionResults) ? matches[0].assertionResults : [];
    const byStatus = {};
    for (const test of tests) byStatus[test.status] = (byStatus[test.status] ?? 0) + 1;
    const passed = byStatus.passed ?? 0;
    summary.push(`${expected}: ${passed} passed, ${tests.length - passed} not passed`);
    if (tests.length === 0) problems.push(`${expected}: no tests ran`);
    for (const [status, count] of Object.entries(byStatus)) {
      if (status !== "passed") problems.push(`${expected}: ${count} ${status} test(s)`);
    }
    if (matches[0].status !== "passed") problems.push(`${expected}: file status ${matches[0].status}`);
  }
  if (report?.numPendingTests) problems.push(`${report.numPendingTests} skipped test(s) in the report`);
  if (report?.numTodoTests) problems.push(`${report.numTodoTests} todo test(s) in the report`);
  if (report?.numFailedTests) problems.push(`${report.numFailedTests} failed test(s) in the report`);
  return { ok: problems.length === 0, problems, summary };
}

function main(argv, env) {
  const [reportPath, ...expectedFiles] = argv;
  if (!reportPath || expectedFiles.length === 0) {
    console.error("usage: assert-vitest-ran.mjs <report.json> <test file>...");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`cannot read the Vitest report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { ok, problems, summary } = checkReport(report, expectedFiles);
  for (const line of summary) console.log(line);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [`### Guards ${ok ? "ran" : "did not all run"}`, "", ...summary.map((line) => `- ${line}`), ...problems.map((line) => `- ${line}`), ""].join("\n"));
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
