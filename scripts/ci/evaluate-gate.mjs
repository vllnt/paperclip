#!/usr/bin/env node
/**
 * Entry point of the `CI gate` job. Reads `toJSON(needs)` from $NEEDS_JSON, prints and
 * writes the verdict, and exits 1 unless the gate passes. It has no import guard on
 * purpose: this file always runs, so it cannot exit 0 without evaluating anything.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { commandData, evaluate, failedSteps, render } from "./gate-verdict.mjs";

async function main(env) {
  const needs = JSON.parse(env.NEEDS_JSON ?? "null");
  if (needs === null || typeof needs !== "object" || Array.isArray(needs)) throw new Error("NEEDS_JSON is missing or not an object");
  const result = evaluate(needs);

  let details = [];
  let detailsError;
  if (!result.ok && env.GITHUB_TOKEN) {
    try {
      details = await failedSteps({ apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, token: env.GITHUB_TOKEN });
    } catch (error) {
      detailsError = error.message;
    }
  }
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const text = render({ result, details, detailsError, runUrl, runId: env.GITHUB_RUN_ID });

  const stop = randomUUID();
  console.log(`::stop-commands::${stop}\n${text}::${stop}::`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    } catch (error) {
      console.log(`::warning title=CI gate::could not write the job summary: ${commandData(error.message)}`);
    }
  }
  for (const problem of result.problems) console.log(`::error title=CI gate::${commandData(problem)}`);
  return result.ok ? 0 : 1;
}

process.exitCode = await main(process.env).catch((error) => {
  console.log(`::error title=CI gate::${commandData(error.message)}`);
  return 1;
});
