import { describe, expect, it } from "vitest";
import { planCodexToGrokSwitch } from "./switch-from-codex.js";

const SECRET = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };
const GH_SECRET = { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" };

function codexAgent(config: Record<string, unknown>, runtimeConfig: Record<string, unknown> = {}) {
  return { adapterType: "codex_local", adapterConfig: config, runtimeConfig };
}

const GROK_ON_CODEX = {
  model: "grok-4.7",
  modelReasoningEffort: "xhigh",
  cwd: "/work/app",
  instructionsFilePath: "/work/app/AGENTS.md",
  promptTemplate: "Do the work",
  timeoutSec: 3600,
  graceSec: 30,
  paperclipSkillSync: { desiredSkills: ["paperclip", "review"] },
  env: {
    OPENAI_BASE_URL: { type: "plain", value: "https://proxy.example/v1" },
    OPENAI_API_KEY: SECRET,
    CODEX_HOME: { type: "plain", value: "/var/codex" },
    GH_TOKEN: GH_SECRET,
  },
  search: true,
  fastMode: true,
  dangerouslyBypassApprovalsAndSandbox: true,
  engine: "cli",
};

describe("planCodexToGrokSwitch", () => {
  it("moves a codex_local agent running a grok model to grok_local with the same model, instructions and skills", () => {
    const plan = planCodexToGrokSwitch(codexAgent(GROK_ON_CODEX));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.patch).toEqual({
      adapterType: "grok_local",
      replaceAdapterConfig: true,
      adapterConfig: {
        model: "grok-4.7",
        reasoningEffort: "xhigh",
        cwd: "/work/app",
        instructionsFilePath: "/work/app/AGENTS.md",
        promptTemplate: "Do the work",
        timeoutSec: 3600,
        graceSec: 30,
        paperclipSkillSync: { desiredSkills: ["paperclip", "review"] },
        env: {
          GROK_XAI_API_BASE_URL: { type: "plain", value: "https://proxy.example/v1" },
          XAI_API_KEY: SECRET,
          GH_TOKEN: GH_SECRET,
        },
      },
    });
    expect(plan.changes.join("\n")).toMatch(/OPENAI_API_KEY.*XAI_API_KEY/);
    expect(plan.changes.join("\n")).toMatch(/search.*fastMode|fastMode.*search/);
    expect(plan.changes.join("\n")).not.toMatch(/gpt/i);
  });

  it("always sends an env object so the server does not copy the Codex env back", () => {
    const plan = planCodexToGrokSwitch(codexAgent({ model: "grok-4.6" }));
    expect(plan.ok && plan.patch.adapterConfig.env).toEqual({});
  });

  it("clamps an effort the Grok model does not take, and says so", () => {
    const clamp = (model: string, effort: string) => {
      const plan = planCodexToGrokSwitch(codexAgent({ model, modelReasoningEffort: effort }));
      if (!plan.ok) throw new Error(plan.message);
      return plan;
    };
    expect(clamp("grok-4.5", "xhigh").patch.adapterConfig.reasoningEffort).toBe("high");
    expect(clamp("grok-4.7", "max").patch.adapterConfig.reasoningEffort).toBe("xhigh");
    expect(clamp("grok-4.7", "ultra").patch.adapterConfig.reasoningEffort).toBe("xhigh");
    expect(clamp("grok-4.7", "medium").patch.adapterConfig.reasoningEffort).toBe("medium");
    expect(clamp("grok-4.5", "xhigh").changes.join("\n")).toMatch(/xhigh.*high/);
    expect("reasoningEffort" in clamp("grok-4.7", "turbo").patch.adapterConfig).toBe(false);
  });

  it("does not move a plain-text key, which the API only returns redacted, and tells the operator to bind a secret", () => {
    const plan = planCodexToGrokSwitch(codexAgent({
      model: "grok-4.7",
      env: { OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" } },
    }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.patch.adapterConfig.env).toEqual({});
    expect(plan.warnings.join("\n")).toMatch(/XAI_API_KEY/);
  });

  it("warns that a base URL the API returned redacted was not carried, and names the option that sets it", () => {
    const plan = planCodexToGrokSwitch(codexAgent({
      model: "grok-4.7",
      env: { OPENAI_BASE_URL: { type: "plain", value: "***REDACTED***" }, OPENAI_API_KEY: SECRET },
    }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.patch.adapterConfig.env).toEqual({ XAI_API_KEY: SECRET });
    expect(plan.warnings.join("\n")).toMatch(/OPENAI_BASE_URL.*--xai-base-url/s);
  });

  it("sets GROK_XAI_API_BASE_URL from the xaiBaseUrl option, over a redacted OPENAI_BASE_URL", () => {
    const plan = planCodexToGrokSwitch(
      codexAgent({ model: "grok-4.7", env: { OPENAI_BASE_URL: { type: "plain", value: "***REDACTED***" } } }),
      { xaiBaseUrl: " https://gateway.example/v1 " },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.patch.adapterConfig.env).toEqual({
      GROK_XAI_API_BASE_URL: { type: "plain", value: "https://gateway.example/v1" },
    });
    expect(plan.warnings.join("\n")).not.toMatch(/--xai-base-url/);
  });

  it.each(["gateway.example/v1", "ftp://gateway.example", "not a url"])("refuses xaiBaseUrl %j", (xaiBaseUrl) => {
    expect(planCodexToGrokSwitch(codexAgent({ model: "grok-4.7" }), { xaiBaseUrl })).toMatchObject({
      ok: false, reason: "invalid_base_url",
    });
  });

  it("warns when the agent has no API key to carry, and keeps an XAI_API_KEY it already has", () => {
    const none = planCodexToGrokSwitch(codexAgent({ model: "grok-4.7" }));
    expect(none.ok && none.warnings.join("\n")).toMatch(/XAI_API_KEY/);
    const have = planCodexToGrokSwitch(codexAgent({
      model: "grok-4.7",
      env: { XAI_API_KEY: GH_SECRET, OPENAI_API_KEY: SECRET },
    }));
    expect(have.ok && have.patch.adapterConfig.env).toEqual({ XAI_API_KEY: GH_SECRET });
  });

  it("warns about a custom command or extra args instead of carrying Codex flags to Grok", () => {
    const plan = planCodexToGrokSwitch(codexAgent({
      model: "grok-4.7", command: "/opt/codex", extraArgs: ["--oss"],
    }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.patch.adapterConfig).not.toHaveProperty("command");
    expect(plan.patch.adapterConfig).not.toHaveProperty("extraArgs");
    expect(plan.warnings.join("\n")).toMatch(/command/);
    expect(plan.warnings.join("\n")).toMatch(/extraArgs/);
  });

  it.each([
    ["an agent that is not on codex_local", { adapterType: "claude_local", adapterConfig: { model: "grok-4.7" }, runtimeConfig: {} }, "not_codex_local"],
    ["a GPT model", codexAgent({ model: "gpt-5.5" }), "not_xai_model"],
    ["no model, which means a Codex default", codexAgent({}), "not_xai_model"],
    ["a managed AI connection", codexAgent({ model: "grok-4.7" }, { aiConnection: { connectionId: "c" } }), "managed_connection"],
    ["a filesystem confinement setting", codexAgent({ model: "grok-4.7", filesystemScope: "workspace" }), "confinement_not_portable"],
    ["a network confinement setting", codexAgent({ model: "grok-4.7", networkScope: "deny" }), "confinement_not_portable"],
  ])("refuses %s", (_label, agent, reason) => {
    const plan = planCodexToGrokSwitch(agent);
    expect(plan).toMatchObject({ ok: false, reason });
    expect(plan.ok === false && plan.message.length).toBeGreaterThan(10);
  });

  it("does not change the agent it is given", () => {
    const agent = codexAgent(structuredClone(GROK_ON_CODEX));
    const before = structuredClone(agent);
    planCodexToGrokSwitch(agent);
    expect(agent).toEqual(before);
  });
});
