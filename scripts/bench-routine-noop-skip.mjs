#!/usr/bin/env node
/**
 * Before/after estimate for the routine no-op skip.
 *
 * Usage: node scripts/bench-routine-noop-skip.mjs <efficiency-report.json> [noopRate] [briefRuns]
 *
 * Input: a per-loop 24h efficiency report `{ window, loops: { <name>: { runs, cost_usd, tokens } } }`
 * where loop names starting with "routine:" are routine runs. `noopRate` is the share of
 * eligible routine runs whose inputs and issue outcome match the last run (default 107/112).
 * The report records cost and runs, not whether a run changed anything, so the rate is an
 * input and the output is an estimate, not a measurement.
 *
 * Scenarios, by which routines opt in:
 *   brief      only `briefRuns` runs/day (default 112) are eligible, priced at the mean routine run cost
 *   all        every routine opts in (upper bound)
 *   frequent   only routines that run at least every 2 hours (>= 12 runs/day)
 * Names are replaced by routine-N; nothing identifying is printed.
 */
import { readFileSync } from "node:fs";

const [path, rateArg, briefArg] = process.argv.slice(2);
const briefRuns = briefArg === undefined ? 112 : Number(briefArg);
if (!path) {
  console.error("usage: bench-routine-noop-skip.mjs <report.json> [noopRate]");
  process.exit(2);
}
const noopRate = rateArg === undefined ? 107 / 112 : Number(rateArg);
if (!(noopRate >= 0 && noopRate <= 1)) {
  console.error("noopRate must be between 0 and 1");
  process.exit(2);
}

const report = JSON.parse(readFileSync(path, "utf8"));
const total = report.loops.TOTAL;
const routinesOnly = Object.entries(report.loops)
  .filter(([name]) => name.startsWith("routine:"))
  .map(([, loop], index) => ({ id: `routine-${index + 1}`, runs: loop.runs, usd: loop.cost_usd }));

const sum = (rows, key) => rows.reduce((acc, row) => acc + row[key], 0);
const round = (value, digits = 2) => Number(value.toFixed(digits));

function scenario(label, rows) {
  const runs = sum(rows, "runs");
  const usd = sum(rows, "usd");
  const skippedRuns = runs * noopRate;
  const skippedUsd = usd * noopRate;
  return {
    scenario: label,
    routines: rows.length,
    runsPerDayBefore: runs,
    runsPerDayAfter: round(runs - skippedRuns, 1),
    skippedRunsPerDay: round(skippedRuns, 1),
    usdPerDayBefore: round(usd),
    usdPerDayAfter: round(usd - skippedUsd),
    skippedUsdPerDay: round(skippedUsd),
    skippedUsdPerMonth30d: round(skippedUsd * 30, 0),
    shareOfAllRunsSkipped: round((skippedRuns / total.runs) * 100, 1),
    shareOfAllUsdSkipped: round((skippedUsd / total.cost_usd) * 100, 1),
  };
}

const meanUsdPerRun = sum(routinesOnly, "usd") / sum(routinesOnly, "runs");
const brief = [{ id: "eligible", runs: briefRuns, usd: briefRuns * meanUsdPerRun }];
const frequent = routinesOnly.filter((row) => row.runs >= 12);
console.log(JSON.stringify({
  windowHours: report.window.hours,
  noopRate: round(noopRate, 4),
  allWork: { runsPerDay: total.runs, usdPerDay: round(total.cost_usd) },
  results: [scenario("brief", brief), scenario("frequent", frequent), scenario("all", routinesOnly)],
}, null, 2));
