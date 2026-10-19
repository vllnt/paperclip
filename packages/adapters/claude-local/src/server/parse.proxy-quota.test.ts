import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
} from "./parse.js";

const NOW = new Date("2026-10-08T23:52:00.000Z");

/** The line the Claude CLI printed in production when every proxy credential was exhausted. */
const PROXY_COOLDOWN_LINE =
  "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: 429 rate_limit_error)";
const PROXY_COOLDOWN_BODY = JSON.stringify({
  error: {
    code: "model_cooldown",
    message: "All credentials for model claude-opus-5-5 are cooling down via provider claude",
    model: "claude-opus-5-5",
    reset_time: "16m0s",
    reset_seconds: 960,
  },
});

describe("Claude provider quota classification behind a credential proxy", () => {
  it("classifies the proxy cooldown 429 as provider quota, not transient upstream", () => {
    const input = { errorMessage: PROXY_COOLDOWN_LINE, stdout: "", stderr: "" };
    expect(isClaudeProviderQuotaError(input)).toBe(true);
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
  });

  it("reads the proxy cooldown reset from the response body", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: PROXY_COOLDOWN_LINE, stderr: PROXY_COOLDOWN_BODY }, NOW),
    ).toEqual(new Date(NOW.getTime() + 960_000));
  });

  it("reads the epoch reset of a Claude subscription usage limit", () => {
    const input = { errorMessage: "Claude AI usage limit reached|1791514800" };
    expect(isClaudeProviderQuotaError(input)).toBe(true);
    expect(extractClaudeRetryNotBefore(input, NOW)).toEqual(new Date(1_791_514_800_000));
  });

  it("classifies an Anthropic rate_limit_error that names a usage-limit reset as provider quota", () => {
    const input = {
      errorMessage:
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Usage limit exceeded. Limit resets at 2026-10-09T05:00:00Z"}}',
    };
    expect(isClaudeProviderQuotaError(input)).toBe(true);
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
    expect(extractClaudeRetryNotBefore(input, NOW)).toEqual(new Date("2026-10-09T05:00:00Z"));
  });

  it("keeps a short-term rate_limit_error transient", () => {
    const input = {
      errorMessage:
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization. Please try again later."}}',
    };
    expect(isClaudeProviderQuotaError(input)).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });
});
