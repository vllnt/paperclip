import { describe, expect, it } from "vitest";
import { isProviderQuotaMessage, parseProviderQuotaResetAt } from "./provider-quota.js";

const NOW = new Date("2026-10-08T23:52:00.000Z");

const PROXY_CLI_LINE =
  "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: 429 rate_limit_error: This request would exceed your account's rate limit)";
const PROXY_BODY = JSON.stringify({
  error: {
    code: "model_cooldown",
    message: "All credentials for model claude-opus-5-5 are cooling down via provider claude (last error: usage limit reached)",
    model: "claude-opus-5-5",
    reset_time: "14m30s",
    reset_seconds: 870,
  },
});

describe("isProviderQuotaMessage", () => {
  it.each([
    ["the CLIProxy cooldown line the Claude CLI prints", PROXY_CLI_LINE],
    ["the CLIProxy cooldown body", PROXY_BODY],
    ["a cooldown body without a message", '{"error":{"code":"model_cooldown"}}'],
    ["a Claude subscription limit", "Claude AI usage limit reached|1791514800"],
    ["a 5-hour limit", "5-hour limit reached ∙ resets 3am"],
    ["a weekly limit", "You've hit your weekly limit · resets Oct 10, 2am"],
    ["a Codex usage limit", "You've hit your usage limit. Try again at 4:05 AM."],
    [
      "a rate_limit_error that names a usage-limit reset",
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Usage limit exceeded. Limit resets at 2026-10-09T05:00:00Z"}}',
    ],
    [
      "a rate_limit_error with a unified reset header",
      "429 rate_limit_error anthropic-ratelimit-unified-status: rejected anthropic-ratelimit-unified-reset: 1791514800",
    ],
    ["an OpenAI insufficient_quota", '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'],
  ])("recognises %s", (_label, text) => {
    expect(isProviderQuotaMessage(text)).toBe(true);
  });

  it.each([
    ["a bare 429", "429 Too Many Requests"],
    [
      "a short-term rate_limit_error",
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization. Please try again later."}}',
    ],
    ["an overloaded error", "529 overloaded_error: Overloaded"],
    ["a capacity error", "Selected model is at capacity. Please try a different model."],
    ["a stream disconnect", "stream disconnected before completion"],
    ["nothing", ""],
  ])("does not treat %s as quota", (_label, text) => {
    expect(isProviderQuotaMessage(text)).toBe(false);
  });
});

describe("parseProviderQuotaResetAt", () => {
  it("reads the CLIProxy reset_seconds and Go-duration reset_time", () => {
    expect(parseProviderQuotaResetAt(PROXY_BODY, NOW)).toEqual(new Date(NOW.getTime() + 870_000));
    expect(parseProviderQuotaResetAt('{"error":{"code":"model_cooldown","reset_time":"1h2m3s"}}', NOW))
      .toEqual(new Date(NOW.getTime() + (3600 + 120 + 3) * 1000));
  });

  it("reads epoch suffixes, unified reset headers, ISO times and Retry-After", () => {
    expect(parseProviderQuotaResetAt("Claude AI usage limit reached|1791514800", NOW)).toEqual(new Date(1_791_514_800_000));
    expect(parseProviderQuotaResetAt("anthropic-ratelimit-unified-reset: 1791514800", NOW)).toEqual(new Date(1_791_514_800_000));
    expect(parseProviderQuotaResetAt("limit resets at 2026-10-09T05:00:00Z", NOW)).toEqual(new Date("2026-10-09T05:00:00Z"));
    expect(parseProviderQuotaResetAt("HTTP 429 Retry-After: 120", NOW)).toEqual(new Date(NOW.getTime() + 120_000));
  });

  it("reads relative durations", () => {
    expect(parseProviderQuotaResetAt("You've hit your usage limit. Try again in 2 hours 15 minutes.", NOW))
      .toEqual(new Date(NOW.getTime() + (2 * 60 + 15) * 60_000));
    expect(parseProviderQuotaResetAt("cooling down, retry in 45s", NOW)).toEqual(new Date(NOW.getTime() + 45_000));
    expect(parseProviderQuotaResetAt("try again in 3 days", NOW)).toEqual(new Date(NOW.getTime() + 3 * 86_400_000));
  });

  it("tries Retry-After when an earlier reset in the text is already in the past", () => {
    expect(parseProviderQuotaResetAt("limit resets at 2026-10-08T00:00:00Z. HTTP 429 Retry-After: 120", NOW))
      .toEqual(new Date(NOW.getTime() + 120_000));
  });

  it("returns null when no reset is named or it is in the past", () => {
    expect(parseProviderQuotaResetAt(PROXY_CLI_LINE, NOW)).toBeNull();
    expect(parseProviderQuotaResetAt('{"error":{"code":"model_cooldown","reset_seconds":0}}', NOW)).toBeNull();
    expect(parseProviderQuotaResetAt("limit resets at 2026-10-08T00:00:00Z", NOW)).toBeNull();
    expect(parseProviderQuotaResetAt(null, NOW)).toBeNull();
  });
});
