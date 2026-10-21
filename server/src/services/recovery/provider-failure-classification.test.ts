import { classifyRunLiveness } from "../run-liveness.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
  resolveStrandedRecoveryCause,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";

describe("classifyAdapterFailureForRecovery", () => {
  it.each(["acpx_auth_required", "claude_auth_required", "codex_auth_required", "adapter_auth_missing", "refresh_token_reused", "authentication_required"])("does not automatically retry provider authentication failure %s", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: true });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(true);
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });

  it.each(["kimi_auth_required", "acpx_auth_required", "gemini_auth_required"])("preserves recovery when %s did not produce an inline repair card", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: false });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(false);
    expect(classifyContinuationFailure(run as never).kind).toBe("default");
  });

  it("uses a typed ACP quota reset without needing the provider's original message", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-07-15T21:30:00.000Z",
        providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the existing backoff for a typed ACP quota failure with no reset timestamp", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
  it("holds invalid provider definitions for repair even with stale transient metadata", () => {
    const run = { errorCode: "provider_tool_definition_invalid", error: "Tool name is too long.",
      resultJson: { errorFamily: "transient_upstream" } };
    expect(classifyAdapterFailureForRecovery(run)).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });
  it("never continues a context overflow, even with stale transient metadata", () => {
    const run = { errorCode: "context_window_exceeded", error: "Claude run failed: subtype=success: Prompt is too long",
      resultJson: { errorFamily: "transient_upstream" } };
    expect(classifyAdapterFailureForRecovery(run)).toBeNull();
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });
});

// A failed run stores a fuller error (the short message plus a stderr tail) and
// keeps the short message in resultJson.errorSummary. Recovery classifies by the
// short message, so a limit or credential phrase that only the stderr tail shows
// must not change the verdict. A row written before the summary existed has no
// errorSummary, and its error is the short message.
describe("recovery classification reads the run's short error summary", () => {
  const SHORT = "Agent exited with code 1: Tool execution failed";
  const withTail = (line: string) => `${SHORT}\nLast lines of stderr:\n${line}`;
  const QUOTA_LINE = "You've hit your usage limit. Try again at 4:30 PM (UTC).";
  const CONFIG_LINE = "API key is not set";

  it.each([
    ["a usage-limit phrase", QUOTA_LINE],
    ["a missing-credential phrase", CONFIG_LINE],
  ])("does not classify by %s that only the stderr tail shows", (_name, line) => {
    const run = {
      errorCode: "adapter_failed",
      error: withTail(line),
      resultJson: { errorSummary: SHORT },
    };

    expect(classifyAdapterFailureForRecovery(run)).toBeNull();
    expect(resolveStrandedRecoveryCause(run as never)).toBe("stranded_assigned_issue");
  });

  it("still classifies an old row that has no errorSummary by its stored error", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const quota = { errorCode: "adapter_failed", error: QUOTA_LINE, resultJson: null };
    const config = { errorCode: "adapter_failed", error: CONFIG_LINE, resultJson: {} };

    expect(classifyAdapterFailureForRecovery(quota, now)).toMatchObject({ kind: "provider_quota" });
    expect(resolveStrandedRecoveryCause(quota as never)).toBe("provider_quota");
    expect(classifyAdapterFailureForRecovery(config)).toEqual({ kind: "configuration_incomplete" });
  });

  it("classifies by a limit phrase in the short summary itself", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const summary = "Claude run failed: You've hit your limit · resets 2:30am (UTC)";
    const run = {
      errorCode: "adapter_failed",
      error: withTail("unrelated stderr line"),
      resultJson: { errorSummary: summary },
    };

    expect(classifyAdapterFailureForRecovery(run, now)).toMatchObject({ kind: "provider_quota", parsedResetTime: true });
    expect(resolveStrandedRecoveryCause(run as never)).toBe("provider_quota");
  });
});
