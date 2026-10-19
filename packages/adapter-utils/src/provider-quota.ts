/**
 * Provider quota detection shared by the local adapters and the server.
 *
 * A quota failure means the account (or every account behind a credential
 * proxy) is out of usage until a reset. Retrying the same harness and model
 * before the reset only spends runs, so callers wait for the reset instead.
 * Short-term rate limits, overload and capacity errors are not quota.
 */

const PROVIDER_QUOTA_RE = new RegExp(
  [
    String.raw`all\s+credentials\s+for\s+model\s+\S+\s+are\s+cooling\s+down`,
    String.raw`"code"\s*:\s*"model_cooldown"`,
    String.raw`you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit`,
    String.raw`usage\s+limit\s+(?:reached|exceeded)`,
    String.raw`(?:5[-\s]?hour|weekly|session)\s+limit\s+(?:reached|exceeded)`,
    String.raw`usage\s+cap\s+reached`,
    String.raw`out\s+of\s+extra\s+usage`,
    String.raw`insufficient_quota`,
    String.raw`exceeded\s+your\s+current\s+quota`,
    String.raw`anthropic-ratelimit-unified-status\s*:\s*rejected`,
  ].join("|"),
  "i",
);
const RATE_LIMIT_ERROR_RE = /rate_limit_error/i;
const USAGE_LIMIT_WORDING_RE = /usage\s+limit|limit\s+resets?|quota/i;

const DURATION_UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

function futureOrNull(at: Date, now: Date): Date | null {
  return Number.isFinite(at.getTime()) && at.getTime() > now.getTime() ? at : null;
}

function parseGoDurationMs(value: string): number | null {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
  if (parts.length === 0) return null;
  return parts.reduce((total, part) => total + Number(part[1]) * DURATION_UNIT_MS[part[2]], 0);
}

const RELATIVE_DURATION_MARKERS = ["try again in ", "retry in ", "resets in ", "reset in "];

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && char >= "a" && char <= "z";
}

function durationUnitMs(unit: string): number | null {
  if (unit === "d" || unit === "day" || unit === "days") return DURATION_UNIT_MS.d;
  if (unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours") return DURATION_UNIT_MS.h;
  if (unit === "m" || unit === "min" || unit === "mins" || unit === "minute" || unit === "minutes") return DURATION_UNIT_MS.m;
  if (unit === "s" || unit === "sec" || unit === "secs" || unit === "second" || unit === "seconds") return DURATION_UNIT_MS.s;
  return null;
}

/** Sums `<n><unit>` pairs such as "2 hours 15 minutes" or "1h, and 5m" in one pass. */
function sumDurationsMs(lower: string, from: number): number {
  let index = from;
  let total = 0;
  for (;;) {
    while (index < lower.length && (lower[index] === " " || lower[index] === "," || lower[index] === "\t")) index += 1;
    if (lower.startsWith("and ", index)) index += 4;
    while (index < lower.length && lower[index] === " ") index += 1;
    const digitsStart = index;
    while (isDigit(lower[index])) index += 1;
    if (index === digitsStart) return total;
    const amount = Number(lower.slice(digitsStart, index));
    while (lower[index] === " ") index += 1;
    const unitStart = index;
    while (isLetter(lower[index])) index += 1;
    const unitMs = durationUnitMs(lower.slice(unitStart, index));
    if (unitMs === null) return total;
    total += amount * unitMs;
  }
}

function parseRelativeDurationMs(text: string): number | null {
  const lower = text.toLowerCase();
  for (const marker of RELATIVE_DURATION_MARKERS) {
    const found = lower.indexOf(marker);
    if (found === -1) continue;
    const total = sumDurationsMs(lower, found + marker.length);
    if (total > 0) return total;
  }
  return null;
}

/**
 * Whether an error text reports a provider quota or usage limit. A
 * `rate_limit_error` counts only when it names a usage limit, quota or reset.
 *
 * @param text - Error message, stderr or response body.
 * @returns True for quota and usage-limit failures.
 * @example isProviderQuotaMessage("All credentials for model claude-opus-5-5 are cooling down") // true
 */
export function isProviderQuotaMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  if (PROVIDER_QUOTA_RE.test(text)) return true;
  return RATE_LIMIT_ERROR_RE.test(text) && USAGE_LIMIT_WORDING_RE.test(text);
}

/**
 * Reads when a quota resets from an error text: a credential proxy's
 * `reset_seconds`/`reset_time`, a `…|<epoch>` suffix, the Anthropic unified
 * reset header, an ISO timestamp, `Retry-After`, or "try again in …".
 *
 * @param text - Error message, stderr or response body.
 * @param now - Reference time for relative values.
 * @returns The reset time when it is in the future, else null.
 */
export function parseProviderQuotaResetAt(text: string | null | undefined, now: Date): Date | null {
  if (!text) return null;
  const candidates: Array<() => Date | null> = [
    () => {
      const match = /"reset_seconds"\s*:\s*(\d+)/.exec(text);
      return match ? new Date(now.getTime() + Number(match[1]) * 1000) : null;
    },
    () => {
      const match = /"reset_time"\s*:\s*"([^"]+)"/.exec(text);
      const ms = match ? parseGoDurationMs(match[1]) : null;
      return ms !== null ? new Date(now.getTime() + ms) : null;
    },
    () => {
      const match = /(?:\||unified-reset\s*:\s*)(\d{10})\b/i.exec(text);
      return match ? new Date(Number(match[1]) * 1000) : null;
    },
    () => {
      const match = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
      return match ? new Date(match[1]) : null;
    },
    () => {
      const match = /retry-after\s*:\s*(\d+)\b/i.exec(text);
      return match ? new Date(now.getTime() + Number(match[1]) * 1000) : null;
    },
    () => {
      const ms = parseRelativeDurationMs(text);
      return ms !== null ? new Date(now.getTime() + ms) : null;
    },
  ];
  for (const candidate of candidates) {
    const reset = candidate();
    const future = reset ? futureOrNull(reset, now) : null;
    if (future) return future;
  }
  return null;
}
