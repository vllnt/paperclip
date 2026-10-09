import { describe, expect, it } from "vitest";
import {
  HARNESS_ALLOWED_MODEL_VENDORS,
  MAX_AGENT_FALLBACKS,
  agentFallbacksSchema,
  checkHarnessModelCompatibility,
  classifyModelVendor,
  fallbackEffortConfigKey,
  harnessTargetKey,
  readModelOverridesFromArgs,
} from "./harness-fallback.js";

const SECRET_ID = "11111111-1111-4111-8111-111111111111";

describe("classifyModelVendor", () => {
  it.each([
    ["claude-opus-5-5", "anthropic"],
    ["claude-sonnet-5[1m]", "anthropic"],
    ["claude-fable-5-1", "anthropic"],
    ["anthropic/claude-haiku-4-5", "anthropic"],
    ["openrouter/anthropic/claude-sonnet-4-5", "anthropic"],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic"],
    ["claude-sonnet-4@20250514", "anthropic"],
    ["opus", "anthropic"],
    ["Sonnet", "anthropic"],
    ["haiku", "anthropic"],
    ["opusplan", "anthropic"],
    ["gpt-5.5", "openai"],
    ["gpt-6.1-sol", "openai"],
    ["openai/gpt-5.4", "openai"],
    ["o3", "openai"],
    ["o4-mini", "openai"],
    ["codex-mini-latest", "openai"],
    ["gpt-oss-120b", "openai"],
    ["grok-4.7", "xai"],
    ["grok-build", "xai"],
    ["xai/grok-4.6", "xai"],
    ["x-ai/grok-code-fast-1", "xai"],
    ["gemini-2.5-pro", "unknown"],
    ["qwen3-coder-plus", "unknown"],
    ["", "unknown"],
  ] as const)("%s → %s", (model, vendor) => {
    expect(classifyModelVendor(model)).toBe(vendor);
  });
});

describe("readModelOverridesFromArgs", () => {
  it("reads every CLI form that selects a model", () => {
    expect(
      readModelOverridesFromArgs([
        "--model",
        "claude-opus-5-5",
        "--model=gpt-5.5",
        "-m",
        "grok-4.7",
        "-c",
        'model="o3"',
        "--config=model=o4-mini",
        "-c",
        "model_reasoning_effort=high",
      ]),
    ).toEqual(["claude-opus-5-5", "gpt-5.5", "grok-4.7", "o3", "o4-mini"]);
  });

  it("ignores non-arrays and unrelated flags", () => {
    expect(readModelOverridesFromArgs(undefined)).toEqual([]);
    expect(readModelOverridesFromArgs("--model claude-opus-5-5")).toEqual([]);
    expect(readModelOverridesFromArgs(["--max-turns", "5", "--search"])).toEqual([]);
  });
});

describe("harness ↔ model compatibility matrix", () => {
  it("keeps the documented matrix", () => {
    expect(HARNESS_ALLOWED_MODEL_VENDORS).toEqual({
      claude_local: ["anthropic"],
      codex_local: ["openai", "xai"],
      grok_local: ["xai"],
    });
  });

  it.each([
    ["claude_local", "claude-opus-5-5", true],
    ["claude_local", "opus", true],
    ["claude_local", "gpt-5.5", false],
    ["claude_local", "grok-4.7", false],
    ["codex_local", "gpt-5.5", true],
    ["codex_local", "grok-4.7", true],
    ["codex_local", "claude-opus-5-5", false],
    ["codex_local", "anthropic/claude-sonnet-4-5", false],
    ["codex_local", "sonnet", false],
    ["grok_local", "grok-4.7", true],
    ["grok_local", "grok-build", true],
    ["grok_local", "gpt-5.5", false],
    ["grok_local", "claude-sonnet-5", false],
  ] as const)("strict: %s + %s → %s", (adapterType, model, ok) => {
    expect(checkHarnessModelCompatibility({ adapterType, model }, { requireKnownVendor: true }).ok).toBe(ok);
  });

  it("rejects Anthropic model ids on every non-Claude harness, even when the vendor check is lenient", () => {
    for (const adapterType of ["codex_local", "grok_local", "opencode_local", "gemini_local", "cursor", "pi_local"]) {
      const result = checkHarnessModelCompatibility(
        { adapterType, model: "claude-opus-5-5" },
        { requireKnownVendor: false },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("harness_model_incompatible");
        expect(result.message).toContain("Anthropic");
      }
    }
  });

  it("rejects an Anthropic model smuggled through extraArgs on Codex", () => {
    const result = checkHarnessModelCompatibility(
      { adapterType: "codex_local", model: "gpt-5.5", extraArgs: ["-c", "model=claude-opus-5-5"] },
      { requireKnownVendor: false },
    );
    expect(result).toMatchObject({ ok: false, model: "claude-opus-5-5", vendor: "anthropic" });
  });

  it("lets a lenient check run an unrecognised model but not a known-incompatible one", () => {
    expect(
      checkHarnessModelCompatibility({ adapterType: "codex_local", model: "qwen3-coder-plus" }, { requireKnownVendor: false }).ok,
    ).toBe(true);
    expect(
      checkHarnessModelCompatibility({ adapterType: "codex_local", model: "qwen3-coder-plus" }, { requireKnownVendor: true }).ok,
    ).toBe(false);
    expect(
      checkHarnessModelCompatibility({ adapterType: "claude_local", model: "gpt-5.5" }, { requireKnownVendor: false }).ok,
    ).toBe(false);
  });

  it("treats an empty model as the harness default", () => {
    expect(checkHarnessModelCompatibility({ adapterType: "codex_local", model: "" }, { requireKnownVendor: false }).ok).toBe(true);
    expect(checkHarnessModelCompatibility({ adapterType: "claude_local" }, { requireKnownVendor: false }).ok).toBe(true);
  });

  it("does not restrict harnesses outside the matrix beyond the Anthropic rule", () => {
    expect(
      checkHarnessModelCompatibility({ adapterType: "opencode_local", model: "openai/gpt-5.5" }, { requireKnownVendor: true }).ok,
    ).toBe(true);
    expect(
      checkHarnessModelCompatibility({ adapterType: "claude_local", model: "claude-sonnet-5" }, { requireKnownVendor: true }).ok,
    ).toBe(true);
  });
});

describe("agentFallbacksSchema", () => {
  const codexEntry = {
    adapterType: "codex_local",
    model: "gpt-5.5",
    effort: "high",
    adapterConfig: { engine: "cli" },
    env: {
      OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      CODEX_HOME: "/srv/paperclip/codex-home",
    },
  };

  it("accepts an ordered list of supported harness targets", () => {
    const parsed = agentFallbacksSchema.parse([codexEntry, { adapterType: "grok_local", model: "grok-4.7" }]);
    expect(parsed.map((entry) => harnessTargetKey(entry))).toEqual(["codex_local:gpt-5.5", "grok_local:grok-4.7"]);
  });

  it("rejects Anthropic models on a Codex fallback with a clear message", () => {
    const result = agentFallbacksSchema.safeParse([{ ...codexEntry, model: "claude-opus-5-5" }]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("Anthropic models never run through codex_local");
  });

  it("rejects an unrecognised model on a fallback", () => {
    expect(agentFallbacksSchema.safeParse([{ adapterType: "codex_local", model: "qwen3-coder-plus" }]).success).toBe(false);
  });

  it("rejects harnesses outside the fallback matrix", () => {
    expect(agentFallbacksSchema.safeParse([{ adapterType: "opencode_local", model: "openai/gpt-5.5" }]).success).toBe(false);
    expect(agentFallbacksSchema.safeParse([{ adapterType: "paperclip_runner", model: "gpt-5.5" }]).success).toBe(false);
  });

  it("keeps model, effort and env out of adapterConfig", () => {
    for (const key of ["model", "env", "modelReasoningEffort"]) {
      expect(
        agentFallbacksSchema.safeParse([{ ...codexEntry, adapterConfig: { [key]: "x" } }]).success,
      ).toBe(false);
    }
  });

  it("rejects a model override inside adapterConfig.extraArgs", () => {
    expect(
      agentFallbacksSchema.safeParse([
        { ...codexEntry, adapterConfig: { extraArgs: ["--model", "claude-sonnet-5"] } },
      ]).success,
    ).toBe(false);
  });

  it("bounds the chain length and rejects duplicate targets", () => {
    const many = Array.from({ length: MAX_AGENT_FALLBACKS + 1 }, (_, index) => ({
      adapterType: "codex_local",
      model: `gpt-5.${index}`,
    }));
    expect(agentFallbacksSchema.safeParse(many).success).toBe(false);
    expect(agentFallbacksSchema.safeParse([codexEntry, codexEntry]).success).toBe(false);
  });

  it("rejects unknown entry keys", () => {
    expect(agentFallbacksSchema.safeParse([{ ...codexEntry, apiKey: "sk-live" }]).success).toBe(false);
  });
});

describe("fallbackEffortConfigKey", () => {
  it("maps effort to each harness's own config key", () => {
    expect(fallbackEffortConfigKey("claude_local")).toBe("effort");
    expect(fallbackEffortConfigKey("codex_local")).toBe("modelReasoningEffort");
    expect(fallbackEffortConfigKey("grok_local")).toBe("reasoningEffort");
  });
});
