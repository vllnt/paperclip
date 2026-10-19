// Gate for scripts/factory-throughput-kpi.mjs --gate. Pure functions, no I/O.
//
// The routine only needs to speak when something worth reading changed, so the gate compares the
// current snapshot with the last one that was *posted* (not the last one seen): a rate that drifts
// a little every run never posts, and slow drift cannot hide because the distance to the last
// post keeps growing. A heartbeat guarantees one line every few hours even when nothing moves.

import { createHash } from "node:crypto";
import { HOUR_MS } from "./factory-kpi-metrics.mjs";
import { clean } from "./factory-kpi-render.mjs";

export const DEFAULT_HEARTBEAT_MS = 4 * HOUR_MS;
export const DEFAULT_RATE_STEP = 1; // merges/hour of movement that is worth a line
export const INCOMPLETE_RUNS_BEFORE_SPEAKING = 2; // one failed read is a blip, two in a row is a problem

const EPSILON = 1e-9;
const rateText = (n) => (n === null || n === undefined ? "n/a" : n.toFixed(1));
const doneText = (d) => (d === true ? "yes" : d === false ? "no" : "unknown");

/** What the numbers mean depends on these options; a different set makes old and new incomparable. */
export function configFingerprint(options) {
  const parts = {
    repos: [...options.repos].map((r) => r.toLowerCase()).sort(),
    org: options.discoverOrg ?? null,
    target: options.targetPerHour,
    sustain: options.sustainDays,
    guard: options.guard ? options.guardDays : null,
    baseline: options.baseline ?? null,
    baselineAt: options.baselineAtMs ?? null,
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

/** The few numbers and verdicts the gate compares. Small on purpose: it is stored between runs. */
export function gateSignature(snapshot, { atMs, config = null }) {
  const { rates, rolling6hMin, sustained, targetPerHour } = snapshot.throughput;
  const violations = (snapshot.guard?.repos ?? []).flatMap((r) => r.violations.map((v) => `${r.repo}#${v.number}`)).sort();
  return {
    atMs,
    config,
    avg24: rates[2].perHour,
    min6: rolling6hMin.minPerHour,
    target: targetPerHour,
    sustained: sustained.consecutive,
    done: snapshot.verdict.done,
    guard: snapshot.guard?.overall ?? null,
    regression: snapshot.regression?.state ?? null,
    violations,
    incomplete: !snapshot.complete || snapshot.guard?.overall === "unknown",
  };
}

const newViolations = (current, previous) => current.violations.filter((v) => !previous.violations.includes(v));

function violationReason(fresh) {
  return `new violation ${fresh.slice(0, 5).join(", ")}${fresh.length > 5 ? ` (+${fresh.length - 5})` : ""}`;
}

/**
 * Decide whether the run has something to say.
 * previous: the signature saved when the gate last posted, or null.
 * streak: how many runs in a row were incomplete before this one.
 * Returns { post, reasons, streak, save } where `save` is the signature to keep as "last posted"
 * if the run posts. While a read is incomplete the numbers are lower bounds, so only definite facts
 * (a violation, a failed guard, a regression) are compared and the last complete numbers are kept.
 */
export function decideGate({ current, previous, streak = 0, heartbeatMs = DEFAULT_HEARTBEAT_MS, rateStep = DEFAULT_RATE_STEP }) {
  const nextStreak = current.incomplete ? streak + 1 : 0;
  if (!previous) return { post: true, reasons: ["first run"], streak: nextStreak, save: current };
  if (current.config !== previous.config) {
    return { post: true, reasons: ["configuration changed, numbers are not comparable with the last line"], streak: nextStreak, save: current };
  }
  const reasons = [];
  const aheadOfClock = previous.atMs > current.atMs;
  if (aheadOfClock) reasons.push("saved time is ahead of the clock");

  const fresh = newViolations(current, previous);
  if (fresh.length) reasons.push(violationReason(fresh));
  if (current.guard !== previous.guard && (!current.incomplete || current.guard === "fail")) {
    reasons.push(`guard ${previous.guard ?? "off"} -> ${current.guard ?? "off"}`);
  }
  if (current.regression !== previous.regression && (!current.incomplete || current.regression === "regression")) {
    reasons.push(`revert/hotfix ${previous.regression ?? "off"} -> ${current.regression ?? "off"}`);
  }

  if (current.incomplete) {
    if (nextStreak >= INCOMPLETE_RUNS_BEFORE_SPEAKING && !previous.incomplete) {
      reasons.push(`collection incomplete for ${nextStreak} runs in a row`);
    }
  } else {
    if (previous.incomplete) reasons.push("collection is complete again");
    if (current.done !== previous.done) reasons.push(`done ${doneText(previous.done)} -> ${doneText(current.done)}`);
    if (current.sustained !== previous.sustained) reasons.push(`sustained days ${previous.sustained} -> ${current.sustained}`);
    for (const [label, key] of [["24h rate", "avg24"], ["rolling 6h min", "min6"]]) {
      const now = current[key];
      const before = previous[key];
      if (now === null || before === null) {
        if (now !== before) reasons.push(`${label} ${rateText(before)} -> ${rateText(now)}`);
      } else if (Math.abs(now - before) >= rateStep - EPSILON) {
        reasons.push(`${label} ${rateText(before)} -> ${rateText(now)}/h`);
      }
    }
  }
  if (!aheadOfClock && current.atMs - previous.atMs >= heartbeatMs) {
    reasons.push(`heartbeat (${Math.round((current.atMs - previous.atMs) / HOUR_MS)} h since the last line)`);
  }

  const save = current.incomplete
    ? {
        ...previous,
        atMs: current.atMs,
        incomplete: true,
        violations: [...new Set([...previous.violations, ...current.violations])].sort(),
        guard: current.guard === "fail" ? "fail" : previous.guard,
        regression: current.regression === "regression" ? "regression" : previous.regression,
      }
    : current;
  return { post: reasons.length > 0, reasons, streak: nextStreak, save };
}

/** What a posting run prints: one KPI line, why, then the facts a reader needs to act on it. */
export function renderGate({ line, reasons, snapshot }) {
  const out = [line, `why: ${reasons.map(clean).join("; ")}`];
  for (const blocker of snapshot.verdict.blockers) out.push(`blocked by: ${clean(blocker)}`);
  for (const repo of snapshot.guard?.repos ?? []) {
    for (const v of repo.violations) out.push(`violation ${clean(repo.repo)}#${v.number}: ${v.reasons.map(clean).join("; ")}`);
  }
  for (const e of snapshot.errors) out.push(`error ${clean(e.repo)}: ${clean(e.kind)}: ${clean(e.message)}`);
  return out.join("\n");
}
