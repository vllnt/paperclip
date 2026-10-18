// Text rendering for scripts/factory-throughput-kpi.mjs. Pure: snapshot in, string out.

import { redact } from "./factory-kpi-github.mjs";

const MAX_TEXT = 300;

/**
 * Text that came from outside (a repository name, an API error) made safe to print: secrets removed,
 * control characters and line breaks flattened so it cannot add lines or terminal escapes, length capped.
 */
export function clean(text) {
  const flat = redact(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

const rate = (n) => (n === null || n === undefined ? "n/a" : n.toFixed(1));
const hours = (n) => (n === null || n === undefined ? "n/a" : `${n.toFixed(1)} h`);
const percent = (n) => (n === null || n === undefined ? "n/a" : `${(n * 100).toFixed(1)}%`);
const doneText = (done) => (done === true ? "yes" : done === false ? "no" : "unknown");

/** True when merges could not be fully read or the guard could not be verified. */
export const isIncomplete = (snapshot) => !snapshot.complete || snapshot.guard?.overall === "unknown";

function regressionText(r) {
  const base = r.baseline
    ? `${r.baseline.events}/${r.baseline.total} (${percent(r.baseline.share)}, ${r.baselineSource})`
    : "none";
  return `${r.current.events}/${r.current.total} (${percent(r.current.share)}) vs baseline ${base}  ${r.state.toUpperCase()}`;
}

function guardLines(guard) {
  const lines = [`guard       ${guard.overall.toUpperCase()}  (last ${guard.windowDays} days, merges judged at merge time)`];
  for (const g of guard.repos) {
    const e = g.enforcement;
    const rules = `${e.requiredChecks.length} required checks, ${e.requiredApprovals} approvals${e.mergeQueue ? ", merge queue" : ""}`;
    const extra = [
      g.counts.violation ? `${g.counts.violation} VIOLATION` : null,
      g.counts.unknown ? `${g.counts.unknown} unverifiable` : null,
      g.pending ? `${g.pending} not fetched yet` : null,
      g.state === "unenforced" ? `${g.failingAtHead} merged with failing checks` : null,
    ].filter(Boolean);
    lines.push(`  ${clean(g.repo)}   ${g.state.toUpperCase()}   ${g.merges} merges   ${rules}${extra.length ? `   ${extra.join(", ")}` : ""}`);
    for (const note of e.errors) lines.push(`    enforcement: ${clean(note)}`);
    if (g.detailError) lines.push(`    details: ${clean(g.detailError)}`);
    if (g.truncated) lines.push("    the merge list was cut short, so merges may be missing");
    for (const v of g.violations) lines.push(`    #${v.number}: ${v.reasons.map(clean).join("; ")}`);
  }
  return lines;
}

function supportLines(support) {
  const { open, review } = support;
  const states = (counts) => Object.entries(counts).map(([state, n]) => `${state} ${n}`).join("  ");
  const lines = [`open PRs     ${open.total}   ${states(open.byState)}`];
  for (const r of open.repos) {
    if (r.error) lines.push(`  ${clean(r.repo)}   unavailable (${clean(r.error.kind)}: ${clean(r.error.message)})`);
    else lines.push(`  ${clean(r.repo)}   ${r.total}   ${states(r.byState)}${r.mergeableUnknown ? `   (${r.mergeableUnknown} mergeability not computed yet)` : ""}`);
  }
  if (open.oldestUnreviewed) {
    const o = open.oldestUnreviewed;
    lines.push(`  longest wait for a first review: ${clean(o.repo)}#${o.number} ${hours(o.hours)}`);
  }
  lines.push(
    `review 24h   ${review.merged} merged   first review p50 ${hours(review.p50Hours)}  p90 ${hours(review.p90Hours)}   ${review.unreviewed} merged without a review by someone else`,
  );
  return lines;
}

function agentLines(agents) {
  if (agents.error) return [`agents       unavailable (${clean(agents.error.kind)}: ${clean(agents.error.message)})`];
  const a = agents.agents;
  const t = agents.tasks;
  return [
    `agents       idle ${a.idle}  running ${a.running}  paused ${a.paused}  error ${a.error}   tasks open ${t.open}  in_progress ${t.inProgress}  blocked ${t.blocked}`,
    "wakes        queued and deferred wakes are not readable with an agent token yet (follow-up)",
  ];
}

export function renderLine(snapshot) {
  const { rates, rolling6hMin, sustained } = snapshot.throughput;
  const [h1, h6, h24] = rates;
  return (
    `KPI merges 1h=${h1.merged} 6h=${h6.merged} 24h=${h24.merged} (${rate(h24.perHour)}/h) ` +
    `min6h=${rate(rolling6hMin.minPerHour)}/h sustained=${sustained.consecutive}/${sustained.days} ` +
    (snapshot.guard ? `guard=${snapshot.guard.overall} revert_hotfix=${snapshot.regression.state} ` : "") +
    `done=${doneText(snapshot.verdict.done)}` +
    (isIncomplete(snapshot) ? " collection=INCOMPLETE" : "")
  );
}

export function renderReport(snapshot) {
  const t = snapshot.throughput;
  const [h1, h6, h24] = t.rates;
  const verdict = snapshot.verdict;
  const lines = [
    `FACTORY THROUGHPUT ${snapshot.generatedAt}  target ${t.targetPerHour}/h`,
    `merges      1h ${h1.merged} (${rate(h1.perHour)}/h)   6h ${h6.merged} (${rate(h6.perHour)}/h)   24h ${h24.merged} (${rate(h24.perHour)}/h)   rolling-6h-min ${rate(t.rolling6hMin.minPerHour)}/h`,
    `sustained   ${t.sustained.consecutive}/${t.sustained.days} days   DONE ${doneText(verdict.done)}${verdict.scope === "throughput" ? " (throughput only, guard skipped)" : ""}`,
  ];
  for (const blocker of verdict.blockers) lines.push(`  blocked by: ${clean(blocker)}`);
  t.sustained.perDay.forEach((d, i) => {
    lines.push(
      `  day -${i}    ${d.merged} merged   avg ${rate(d.avgPerHour)}/h   rolling-6h-min ${rate(d.rolling6hMinPerHour)}/h (through this day ${rate(d.throughDayMinPerHour)}/h)   ${d.meetsTarget ? "meets" : "below"} target`,
    );
  });
  const s = t.shape;
  lines.push(
    `shape 24h   median ${rate(s.medianLines)} lines   p90 ${rate(s.p90Lines)} lines   tiny(<=10) ${Math.round((s.tinyShare ?? 0) * 100)}%   median open-to-merge ${hours(s.medianOpenToMergeHours)}`,
  );
  for (const r of t.byRepo) {
    const [a, b, c] = r.rates;
    lines.push(`repo        ${clean(r.repo)}   1h ${a.merged}   6h ${b.merged}   24h ${c.merged}`);
  }
  if (snapshot.guard) {
    lines.push(...guardLines(snapshot.guard));
    lines.push(`revert+hotfix 7d   ${regressionText(snapshot.regression)}`);
  }
  if (snapshot.support) lines.push(...supportLines(snapshot.support));
  if (snapshot.agents) lines.push(...agentLines(snapshot.agents));
  for (const e of snapshot.errors) lines.push(`ERROR       ${clean(e.repo)}: ${clean(e.kind)}: ${clean(e.message)}`);
  if (snapshot.support && !snapshot.support.open.complete && snapshot.support.open.repos.some((r) => !r.error)) {
    lines.push("WARN        open PR list truncated for at least one repo, counts are lower bounds");
  }
  for (const r of snapshot.repos) if (r.status === "truncated") lines.push(`WARN        ${clean(r.repo)}: page cap reached, counts are lower bounds`);
  return lines.join("\n");
}
