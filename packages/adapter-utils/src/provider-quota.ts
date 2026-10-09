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

function parseRelativeDurationMs(text: string): number | null {
  const match = /(?:try\s+again|retry|resets?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!match) return null;
  let ms = 0;
  for (const part of match[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    const unit = part[2].toLowerCase();
    const key = unit.startsWith("d") ? "d" : unit.startsWith("h") ? "h" : unit.startsWith("m") ? "m" : "s";
    ms += Number(part[1]) * DURATION_UNIT_MS[key];
  }
  return ms > 0 ? ms : null;
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
  const resetSeconds = /"reset_seconds"\s*:\s*(\d+)/.exec(text);
  if (resetSeconds) return futureOrNull(new Date(now.getTime() + Number(resetSeconds[1]) * 1000), now);
  const resetTime = /"reset_time"\s*:\s*"([^"]+)"/.exec(text);
  const resetTimeMs = resetTime ? parseGoDurationMs(resetTime[1]) : null;
  if (resetTimeMs !== null) return futureOrNull(new Date(now.getTime() + resetTimeMs), now);
  const epoch = /(?:\||unified-reset\s*:\s*)(\d{10})\b/i.exec(text);
  if (epoch) return futureOrNull(new Date(Number(epoch[1]) * 1000), now);
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
  if (iso) return futureOrNull(new Date(iso[1]), now);
  const retryAfter = /retry-after\s*:\s*(\d+)\b/i.exec(text);
  if (retryAfter) return futureOrNull(new Date(now.getTime() + Number(retryAfter[1]) * 1000), now);
  const relativeMs = parseRelativeDurationMs(text);
  return relativeMs !== null ? new Date(now.getTime() + relativeMs) : null;
}
