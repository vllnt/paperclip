/**
 * Renders markdown from measure.mjs results.
 *
 *   node tests/perf/web-app/report.mjs baseline-desktop                 # one table
 *   node tests/perf/web-app/report.mjs baseline-desktop after-desktop   # before -> after with deltas
 *   node tests/perf/web-app/report.mjs baseline-desktop --api tasks-board   # per-endpoint latency for one page
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const apiIndex = argv.indexOf("--api");
const apiPage = apiIndex >= 0 ? argv[apiIndex + 1] : null;
const labels = argv.filter((a, i) => !a.startsWith("--") && (apiIndex < 0 || i !== apiIndex + 1));
const dir = process.env.PERF_RESULTS ?? "tmp/perf/results";
const load = (label) => JSON.parse(fs.readFileSync(path.join(dir, `${label}.json`), "utf8"));

const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "-" : v.toFixed(d));
const delta = (before, after, d = 0) => {
  if (before == null || after == null) return "-";
  const pct = before === 0 ? 0 : ((after - before) / before) * 100;
  return `${fmt(before, d)} → ${fmt(after, d)} (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`;
};

const COLUMNS = [
  ["FCP ms", (r) => r.fcpMs, 0],
  ["LCP ms", (r) => r.lcpMs, 0],
  ["CLS", (r) => r.cls, 3],
  ["TTI ms", (r) => r.ttiMs, 0],
  ["TBT ms", (r) => r.tbtMs, 0],
  ["settled ms", (r) => r.settledMs, 0],
  ["requests", (r) => r.requests, 0],
  ["API calls", (r) => r.apiRequests, 0],
  ["JS KB", (r) => r.jsKB, 0],
  ["API KB", (r) => r.apiKB, 0],
];

if (apiPage) {
  const data = load(labels[0]);
  for (const row of data.rows.filter((r) => r.page === apiPage)) {
    console.log(`\n${apiPage} (${row.profile}): ${fmt(row.apiRequests)} API calls/load, ${fmt(row.apiKB)} KB`);
    console.log("| endpoint | calls/load | p50 ms | p95 ms | KB |");
    console.log("|---|---|---|---|---|");
    for (const a of row.api.slice(0, 12)) {
      console.log(`| ${a.route.replace("/api/companies/:id", "/c/:id")} | ${fmt(a.perLoad, 1)} | ${fmt(a.totalP50)} | ${fmt(a.totalP95)} | ${fmt(a.kb, 1)} |`);
    }
  }
  process.exit(0);
}

const [beforeLabel, afterLabel] = labels;
const before = load(beforeLabel);
const after = afterLabel ? load(afterLabel) : null;
const meta = before.meta;
console.log(`<!-- ${beforeLabel}${afterLabel ? ` vs ${afterLabel}` : ""}: ${meta.runs} runs per cell, load avg ${meta.loadAvgStart.toFixed(1)}→${meta.loadAvgEnd.toFixed(1)} on ${meta.cpus} CPUs -->`);
console.log(`| page | profile | ${COLUMNS.map(([name]) => name).join(" | ")} |`);
console.log(`|---|---|${COLUMNS.map(() => "---").join("|")}|`);
for (const row of before.rows) {
  const other = after?.rows.find((r) => r.page === row.page && r.profile === row.profile);
  const cells = COLUMNS.map(([, get, d]) => (other ? delta(get(row), get(other), d) : fmt(get(row), d)));
  console.log(`| ${row.page} | ${row.profile} | ${cells.join(" | ")} |`);
}
