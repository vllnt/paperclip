import { describe, expect, it } from "vitest";
import {
  extractCodexRetryNotBefore,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
} from "./parse.js";

const NOW = new Date("2026-10-08T23:52:00.000Z");

describe("Codex provider quota classification behind a credential proxy", () => {
  const body = JSON.stringify({
    error: {
      code: "model_cooldown",
      message: "All credentials for model gpt-5.5 are cooling down via provider codex",
      reset_time: "5m0s",
      reset_seconds: 300,
    },
  });

  it("classifies the proxy cooldown as provider quota and reads its reset", () => {
    const input = { stderr: `unexpected status 429 Too Many Requests: ${body}` };
    expect(isCodexProviderQuotaError(input)).toBe(true);
    expect(isCodexTransientUpstreamError(input)).toBe(false);
    expect(extractCodexRetryNotBefore(input, NOW)).toEqual(new Date(NOW.getTime() + 300_000));
  });

  it("classifies an OpenAI insufficient_quota as provider quota", () => {
    expect(
      isCodexProviderQuotaError({ stderr: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}' }),
    ).toBe(true);
  });
});
