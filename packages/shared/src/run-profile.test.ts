import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_TIER,
  companyRunTiersSchema,
  issueRunProfileFromOverrides,
  resolveRunProfile,
  runProfileSchema,
  type CompanyRunTiers,
} from "./run-profile.js";
import { issueAssigneeAdapterOverridesSchema } from "./validators/issue.js";

const TIERS: CompanyRunTiers = {
  tiers: {
    fast: { adapterType: "codex_local", model: "grok-4.7", effort: "low" },
    standard: { adapterType: "claude_local", model: "claude-sonnet-5-5" },
  },
  agentAllowlist: ["fast"],
};

describe("runProfileSchema", () => {
  it("accepts a tier name or an explicit target, never both", () => {
    expect(runProfileSchema.safeParse({ tier: "fast" }).success).toBe(true);
    expect(runProfileSchema.safeParse({ adapterType: "codex_local", model: "gpt-5.5", effort: "low" }).success).toBe(true);
    expect(runProfileSchema.safeParse({ model: "gpt-5.5" }).success).toBe(true);
    expect(runProfileSchema.safeParse({ tier: "fast", model: "gpt-5.5" }).success).toBe(false);
    expect(runProfileSchema.safeParse({}).success).toBe(false);
    expect(runProfileSchema.safeParse({ tier: "Fast Lane" }).success).toBe(false);
    expect(runProfileSchema.safeParse({ tier: "fast", extra: 1 }).success).toBe(false);
  });

  it("rejects Anthropic models on Codex and non-Anthropic models on Claude (400 at the API)", () => {
    const anthropicOnCodex = runProfileSchema.safeParse({ adapterType: "codex_local", model: "claude-opus-5-5" });
    expect(anthropicOnCodex.success).toBe(false);
    expect(JSON.stringify(anthropicOnCodex.error?.issues)).toContain("Anthropic models never run through codex_local");
    expect(runProfileSchema.safeParse({ adapterType: "claude_local", model: "gpt-5.5" }).success).toBe(false);
    expect(runProfileSchema.safeParse({ adapterType: "grok_local", model: "grok-4.7" }).success).toBe(true);
    expect(runProfileSchema.safeParse({ adapterType: "opencode_local", model: "gpt-5.5" }).success).toBe(false);
  });

  it("requires a model when it names another harness", () => {
    expect(runProfileSchema.safeParse({ adapterType: "codex_local" }).success).toBe(false);
  });
});

describe("companyRunTiersSchema", () => {
  it("validates every tier target with the harness/model matrix", () => {
    expect(companyRunTiersSchema.safeParse(TIERS).success).toBe(true);
    const bad = companyRunTiersSchema.safeParse({
      tiers: { fast: { adapterType: "codex_local", model: "claude-sonnet-5-5" } },
      agentAllowlist: [],
    });
    expect(bad.success).toBe(false);
  });

  it("reserves the default tier and rejects an allowlist that names an unknown tier", () => {
    expect(companyRunTiersSchema.safeParse({ tiers: { [DEFAULT_RUN_TIER]: { adapterType: "codex_local", model: "gpt-5.5" } }, agentAllowlist: [] }).success).toBe(false);
    expect(companyRunTiersSchema.safeParse({ tiers: TIERS.tiers, agentAllowlist: ["turbo"] }).success).toBe(false);
    expect(companyRunTiersSchema.safeParse({ tiers: TIERS.tiers, agentAllowlist: [DEFAULT_RUN_TIER] }).success).toBe(true);
  });
});

describe("resolveRunProfile", () => {
  it("resolves a tier to its target and an explicit profile to itself", () => {
    expect(resolveRunProfile({ tier: "fast" }, TIERS)).toEqual({ ok: true, target: { adapterType: "codex_local", model: "grok-4.7", effort: "low", tier: "fast" } });
    expect(resolveRunProfile({ adapterType: "codex_local", model: "gpt-5.5" }, TIERS)).toEqual({
      ok: true,
      target: { adapterType: "codex_local", model: "gpt-5.5" },
    });
    expect(resolveRunProfile({ model: "gpt-5.5" }, null)).toEqual({ ok: true, target: { model: "gpt-5.5" } });
  });

  it("treats the default tier as no override", () => {
    expect(resolveRunProfile({ tier: DEFAULT_RUN_TIER }, TIERS)).toEqual({ ok: true, target: null });
  });

  it("reports an unknown tier instead of guessing", () => {
    expect(resolveRunProfile({ tier: "turbo" }, TIERS)).toEqual({ ok: false, reason: "unknown_tier", tier: "turbo" });
    expect(resolveRunProfile({ tier: "fast" }, null)).toEqual({ ok: false, reason: "unknown_tier", tier: "fast" });
  });
});

describe("issueRunProfileFromOverrides", () => {
  it("prefers an explicit runProfile", () => {
    expect(issueRunProfileFromOverrides({ runProfile: { tier: "fast" }, adapterConfig: { model: "gpt-5.5" } })).toEqual({
      profile: { tier: "fast" },
      origin: "run_profile",
    });
  });

  it("reads model and effort of the legacy adapterConfig override as an issue-level profile", () => {
    expect(issueRunProfileFromOverrides({ adapterConfig: { model: "grok-4.7", effort: "low", cwd: "/x" } })).toEqual({
      profile: { model: "grok-4.7", effort: "low" },
      origin: "legacy_adapter_config",
    });
    expect(issueRunProfileFromOverrides({ adapterConfig: { modelReasoningEffort: "high" } })).toEqual({
      profile: { effort: "high" },
      origin: "legacy_adapter_config",
    });
  });

  it("returns null when the issue sets no model-level override", () => {
    expect(issueRunProfileFromOverrides(null)).toBeNull();
    expect(issueRunProfileFromOverrides({ useProjectWorkspace: true, adapterConfig: { cwd: "/x" } })).toBeNull();
  });
});

describe("issue overrides schema", () => {
  it("accepts a runProfile next to the existing keys and still rejects unknown keys", () => {
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ runProfile: { tier: "fast" }, useProjectWorkspace: true }).success).toBe(true);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ adapterConfig: { model: "gpt-5.5" } }).success).toBe(true);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ runProfile: { adapterType: "codex_local", model: "claude-opus-5-5" } }).success).toBe(false);
    expect(issueAssigneeAdapterOverridesSchema.safeParse({ runProfiel: {} }).success).toBe(false);
  });
});
