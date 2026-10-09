import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_BACKOFF_MAX_MINUTES,
  MAX_COOLDOWN_MS,
  buildHarnessTargetAgentView,
  classifyQuotaFailure,
  listHarnessTargets,
  overridesForHarnessTarget,
  readQuotaBackoffMaxMinutes,
  reclassifyProviderQuotaResult,
  resolveCooldownUntil,
  selectHarnessTarget,
} from "../services/harness-fallback.js";

const NOW = new Date("2026-10-08T23:30:00.000Z");
const SECRET_ID = "11111111-1111-4111-8111-111111111111";

const failed = {
  status: "failed",
  errorCode: null as string | null,
  errorFamily: null as string | null,
  errorMessage: null as string | null,
  retryNotBefore: null as Date | null,
  usefulWork: false,
};

describe("classifyQuotaFailure", () => {
  it.each([
    ["Claude usage limit", { errorCode: "provider_quota", errorFamily: "provider_quota", errorMessage: "Claude AI usage limit reached|1791514800" }, "usage_limit"],
    ["Claude 5-hour limit", { errorCode: "provider_quota", errorFamily: "provider_quota", errorMessage: "5-hour limit reached ∙ resets 3am" }, "usage_limit"],
    ["Codex usage limit", { errorCode: "provider_quota", errorFamily: "provider_quota", errorMessage: "You've hit your usage limit. Try again at 4:05 AM." }, "usage_limit"],
    ["bare provider_quota code", { errorCode: "provider_quota" }, "usage_limit"],
    ["429 with usage-limit wording", { errorCode: "adapter_failed", errorMessage: "HTTP 429: usage limit exceeded for this account" }, "usage_limit"],
    ["429 usage limit classified transient", { errorCode: "claude_transient_upstream", errorFamily: "transient_upstream", errorMessage: "429 rate_limit_error: weekly usage limit reached" }, "usage_limit"],
    ["the proxy cooldown 429 reported as transient (production 2026-10-08)", { errorCode: "claude_transient_upstream", errorFamily: "transient_upstream", errorMessage: "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last err…" }, "usage_limit"],
    ["Codex capacity", { errorCode: "provider_quota", errorFamily: "provider_quota", errorMessage: "Selected model is at capacity. Please try a different model." }, "capacity"],
    ["Claude overloaded", { errorCode: "claude_transient_upstream", errorFamily: "transient_upstream", errorMessage: "529 overloaded_error: Overloaded" }, "capacity"],
  ] as const)("triggers on %s", (_label, input, kind) => {
    const decision = classifyQuotaFailure({ ...failed, ...input });
    expect(decision).toMatchObject({ trigger: true, kind });
    if (decision.trigger) expect(decision.requiresRetryExhaustion).toBe(kind === "capacity");
  });

  it.each([
    ["an auth failure", { errorCode: "claude_auth_required", errorMessage: "Please run /login. usage limit" }, "auth"],
    ["a Codex refresh-token failure", { errorCode: "refresh_token_expired", errorFamily: "refresh_token_expired" }, "auth"],
    ["a task failure", { errorCode: "adapter_failed", errorMessage: "Tests failed: 3 assertions" }, "not_quota"],
    ["a plain transient failure", { errorCode: "codex_transient_upstream", errorFamily: "transient_upstream", errorMessage: "stream disconnected before completion" }, "not_quota"],
    ["a bare 429 rate limit", { errorCode: "claude_transient_upstream", errorFamily: "transient_upstream", errorMessage: "429 Too Many Requests" }, "not_quota"],
    ["a refusal", { errorCode: "claude_refusal", errorFamily: "model_refusal" }, "not_quota"],
    ["a quota hit after useful work", { errorCode: "provider_quota", errorFamily: "provider_quota", usefulWork: true }, "useful_work"],
    ["a timed-out run", { status: "timed_out", errorCode: "provider_quota" }, "not_failed"],
    ["a cancelled run", { status: "cancelled", errorCode: "provider_quota" }, "not_failed"],
    ["an incompatible harness", { errorCode: "harness_model_incompatible" }, "not_quota"],
  ] as const)("does not trigger on %s", (_label, input, reason) => {
    expect(classifyQuotaFailure({ ...failed, ...input })).toEqual({ trigger: false, reason });
  });

  it("uses the adapter reset time, or parses it from the message", () => {
    const adapterReset = new Date("2026-10-09T03:00:00.000Z");
    expect(classifyQuotaFailure({ ...failed, errorCode: "provider_quota", retryNotBefore: adapterReset }))
      .toMatchObject({ trigger: true, resetAt: adapterReset });
    expect(
      classifyQuotaFailure({ ...failed, errorCode: "provider_quota", errorMessage: "Claude AI usage limit reached|1791514800" }, NOW),
    ).toMatchObject({ trigger: true, resetAt: new Date(1_791_514_800_000) });
  });
});

describe("reclassifyProviderQuotaResult", () => {
  const proxyFailure = {
    exitCode: 1,
    timedOut: false,
    errorCode: "claude_transient_upstream",
    errorFamily: "transient_upstream",
    errorMessage: "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down",
    resultJson: { stderr: '{"error":{"code":"model_cooldown","reset_seconds":600}}' },
  };

  it("turns a proxy cooldown reported as transient into provider_quota with its reset", () => {
    expect(reclassifyProviderQuotaResult(proxyFailure, NOW)).toMatchObject({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: new Date(NOW.getTime() + 600_000).toISOString(),
    });
  });

  it("leaves auth failures, other error codes, timeouts and non-quota failures alone", () => {
    for (const result of [
      { ...proxyFailure, errorCode: "claude_auth_required" },
      { ...proxyFailure, errorCode: "max_turns_exhausted" },
      { ...proxyFailure, timedOut: true },
      { ...proxyFailure, errorMessage: "429 Too Many Requests", resultJson: {} },
    ]) {
      expect(reclassifyProviderQuotaResult(result, NOW)).toBe(result);
    }
  });
});

describe("cooldown", () => {
  const MINUTE = 60_000;

  it("ends at the provider reset time when it is known", () => {
    const resetAt = new Date("2026-10-09T03:00:00.000Z");
    expect(resolveCooldownUntil({ now: NOW, resetAt, maxBackoffMinutes: 60, previous: null })).toEqual(resetAt);
  });

  it("backs off from five minutes, doubling while failures repeat, up to the maximum", () => {
    let previous: { setAt: Date; until: Date } | null = null;
    let now = NOW;
    const minutes: number[] = [];
    for (let failure = 0; failure < 6; failure += 1) {
      const until = resolveCooldownUntil({ now, resetAt: null, maxBackoffMinutes: 60, previous });
      minutes.push((until.getTime() - now.getTime()) / MINUTE);
      previous = { setAt: now, until };
      now = new Date(until.getTime() + MINUTE);
    }
    expect(minutes).toEqual([5, 10, 20, 40, 60, 60]);
  });

  it("restarts the backoff after the target stayed healthy for a while", () => {
    const previous = { setAt: new Date(NOW.getTime() - 200 * MINUTE), until: new Date(NOW.getTime() - 120 * MINUTE) };
    expect(resolveCooldownUntil({ now: NOW, resetAt: null, maxBackoffMinutes: 60, previous }))
      .toEqual(new Date(NOW.getTime() + 5 * MINUTE));
  });

  it("keeps an active cooldown when a run already in flight fails too", () => {
    const previous = { setAt: new Date(NOW.getTime() - MINUTE), until: new Date(NOW.getTime() + 4 * MINUTE) };
    expect(resolveCooldownUntil({ now: NOW, resetAt: null, maxBackoffMinutes: 60, previous })).toEqual(previous.until);
  });

  it("never cools a target down for more than seven days", () => {
    const resetAt = new Date(NOW.getTime() + 30 * 86_400_000);
    expect(resolveCooldownUntil({ now: NOW, resetAt, maxBackoffMinutes: 60, previous: null }))
      .toEqual(new Date(NOW.getTime() + MAX_COOLDOWN_MS));
  });

  it("reads the configurable maximum backoff from runtimeConfig.heartbeat", () => {
    expect(readQuotaBackoffMaxMinutes({})).toBe(DEFAULT_QUOTA_BACKOFF_MAX_MINUTES);
    expect(readQuotaBackoffMaxMinutes({ heartbeat: { quotaBackoffMaxMinutes: 15 } })).toBe(15);
    expect(readQuotaBackoffMaxMinutes({ heartbeat: { quotaBackoffMaxMinutes: 0 } })).toBe(DEFAULT_QUOTA_BACKOFF_MAX_MINUTES);
    expect(readQuotaBackoffMaxMinutes({ heartbeat: { quotaBackoffMaxMinutes: 100_000 } })).toBe(1440);
  });
});

const agent = {
  adapterType: "claude_local",
  adapterConfig: {
    model: "claude-opus-5-5",
    effort: "high",
    engine: "cli",
    cwd: "/work",
    instructionsFilePath: "/work/AGENTS.md",
    promptTemplate: "Do the task",
    timeoutSec: 900,
    paperclipSkillSync: { desiredSkills: ["paperclip"] },
    dangerouslySkipPermissions: true,
    env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: SECRET_ID } },
  },
  runtimeConfig: {
    heartbeat: { maxDailyRuns: 10 },
    aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
  },
  fallbacks: [
    {
      adapterType: "codex_local",
      model: "gpt-5.5",
      effort: "medium",
      adapterConfig: { dangerouslyBypassApprovalsAndSandbox: true },
      env: {
        OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID },
        CODEX_HOME: "/srv/codex-home",
      },
    },
    { adapterType: "grok_local", model: "grok-4.7" },
  ],
};

describe("harness targets", () => {
  it("lists the primary first, then the fallbacks in order", () => {
    expect(listHarnessTargets(agent).map((target) => [target.kind, target.key])).toEqual([
      ["primary", "claude_local:claude-opus-5-5"],
      ["fallback", "codex_local:gpt-5.5"],
      ["fallback", "grok_local:grok-4.7"],
    ]);
  });

  it("selects the primary unless it is cooling down", () => {
    expect(selectHarnessTarget(agent, new Map(), NOW).key).toBe("claude_local:claude-opus-5-5");
    const until = new Date(NOW.getTime() + 60_000);
    expect(selectHarnessTarget(agent, new Map([["claude_local:claude-opus-5-5", until]]), NOW).key).toBe("codex_local:gpt-5.5");
  });

  it("skips cooled-down fallbacks and returns to the primary when its cooldown ends", () => {
    const later = new Date(NOW.getTime() + 60_000);
    const cooldowns = new Map([
      ["claude_local:claude-opus-5-5", later],
      ["codex_local:gpt-5.5", later],
    ]);
    expect(selectHarnessTarget(agent, cooldowns, NOW).key).toBe("grok_local:grok-4.7");
    expect(selectHarnessTarget(agent, cooldowns, new Date(later.getTime() + 1)).key).toBe("claude_local:claude-opus-5-5");
  });

  it("holds runs until the earliest recovery when every target is cooling down", () => {
    const targets = listHarnessTargets(agent);
    const cooldowns = new Map(targets.map((target, index) => [target.key, new Date(NOW.getTime() + (3 - index) * 60_000)]));
    expect(selectHarnessTarget(agent, cooldowns, NOW)).toMatchObject({
      kind: "primary",
      allCoolingDown: true,
      heldUntil: new Date(NOW.getTime() + 60_000),
    });
  });

  it("holds an agent without fallbacks while its only target cools down", () => {
    const solo = { ...agent, fallbacks: [] };
    const until = new Date(NOW.getTime() + 60_000);
    expect(selectHarnessTarget(solo, new Map([["claude_local:claude-opus-5-5", until]]), NOW))
      .toMatchObject({ kind: "primary", heldUntil: until });
    expect(selectHarnessTarget(solo, new Map(), NOW)).toMatchObject({ kind: "primary", heldUntil: null });
  });
});

describe("overridesForHarnessTarget", () => {
  const overrides = { model: "claude-opus-5-5", env: { A: "1" }, extraArgs: ["--x"], workspaceStrategy: { type: "project_primary" } };

  it("keeps every override for the primary and drops model and env overrides for a fallback", () => {
    expect(overridesForHarnessTarget(overrides, { target: "primary" })).toBe(overrides);
    expect(overridesForHarnessTarget(overrides, null)).toBe(overrides);
    expect(overridesForHarnessTarget(overrides, { target: "fallback" })).toEqual({ workspaceStrategy: { type: "project_primary" } });
    expect(overridesForHarnessTarget(undefined, { target: "fallback" })).toEqual({});
  });
});

describe("buildHarnessTargetAgentView", () => {
  it("returns the stored agent unchanged for the primary", () => {
    const [primary] = listHarnessTargets(agent);
    expect(buildHarnessTargetAgentView(agent, primary)).toBe(agent);
  });

  it("runs a fallback with its own harness, model, effort and env, keeping only harness-agnostic keys", () => {
    const [, codex] = listHarnessTargets(agent);
    const view = buildHarnessTargetAgentView(agent, codex);
    expect(view.adapterType).toBe("codex_local");
    expect(view.adapterConfig).toEqual({
      cwd: "/work",
      instructionsFilePath: "/work/AGENTS.md",
      promptTemplate: "Do the task",
      timeoutSec: 900,
      paperclipSkillSync: { desiredSkills: ["paperclip"] },
      engine: "cli",
      dangerouslyBypassApprovalsAndSandbox: true,
      model: "gpt-5.5",
      modelReasoningEffort: "medium",
      env: {
        OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID },
        CODEX_HOME: "/srv/codex-home",
      },
    });
    expect(view.runtimeConfig).toEqual({ heartbeat: { maxDailyRuns: 10 } });
    expect(JSON.stringify(view.adapterConfig)).not.toContain("ANTHROPIC");
    expect(view.adapterConfig).not.toHaveProperty("dangerouslySkipPermissions");
  });

  it("does not carry a CLI engine to Grok", () => {
    const [, , grok] = listHarnessTargets(agent);
    const view = buildHarnessTargetAgentView(agent, grok);
    expect(view.adapterConfig).not.toHaveProperty("engine");
    expect(view.adapterConfig).toMatchObject({ model: "grok-4.7", env: {} });
  });
});
