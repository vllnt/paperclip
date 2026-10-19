import { describe, expect, it } from "vitest";
import {
  agentEnvBindingPrefix,
  applyClaimedHarnessDispatch,
  buildHarnessTargetAgentView,
  dispatchForSelection,
  listHarnessTargets,
  overridesForHarnessTarget,
  primaryHarnessDispatch,
  profileUnavailableReason,
  selectHarnessTarget,
  type ProfileTargetInput,
} from "../services/harness-fallback.js";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const SECRET_ID = "11111111-1111-4111-8111-111111111111";

const agent = {
  adapterType: "claude_local",
  adapterConfig: {
    model: "claude-opus-5-5",
    effort: "high",
    cwd: "/work",
    env: { ANTHROPIC_BASE_URL: "http://proxy.invalid" },
  },
  runtimeConfig: { heartbeat: { maxDailyRuns: 10 }, aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } },
  fallbacks: [
    { adapterType: "codex_local", model: "gpt-5.5", env: { OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID }, CODEX_HOME: "/srv/codex" } },
  ],
};

const codexFast: ProfileTargetInput = { adapterType: "codex_local", model: "grok-4.7", effort: "low", tier: "fast", source: "issue_profile" };
const sonnet: ProfileTargetInput = { model: "claude-sonnet-5-5", source: "issue_profile" };

describe("run profile targets", () => {
  it("puts the profile target first, then the agent's own targets", () => {
    expect(listHarnessTargets(agent, codexFast).map((target) => [target.kind, target.key])).toEqual([
      ["profile", "codex_local:grok-4.7"],
      ["primary", "claude_local:claude-opus-5-5"],
      ["fallback", "codex_local:gpt-5.5"],
    ]);
    expect(listHarnessTargets(agent, null).map((target) => target.kind)).toEqual(["primary", "fallback"]);
  });

  it("runs a model-only profile on the agent's own harness and keeps its credentials", () => {
    const [profile] = listHarnessTargets(agent, sonnet);
    expect(profile).toMatchObject({ kind: "profile", adapterType: "claude_local", model: "claude-sonnet-5-5", envSourceIndex: null });
    const view = buildHarnessTargetAgentView(agent, profile);
    expect(view.adapterType).toBe("claude_local");
    expect(view.adapterConfig).toMatchObject({
      model: "claude-sonnet-5-5", effort: "high", cwd: "/work", env: { ANTHROPIC_BASE_URL: "http://proxy.invalid" },
    });
    expect(view.runtimeConfig).toHaveProperty("aiConnection");
  });

  it("applies the profile's effort under the harness's own effort key", () => {
    const [claudeEffort] = listHarnessTargets(agent, { model: "claude-sonnet-5-5", effort: "low", source: "issue_profile" });
    expect(buildHarnessTargetAgentView(agent, claudeEffort).adapterConfig).toMatchObject({ effort: "low" });
    const [codexTarget] = listHarnessTargets(agent, codexFast);
    expect(buildHarnessTargetAgentView(agent, codexTarget).adapterConfig).toMatchObject({ model: "grok-4.7", modelReasoningEffort: "low" });
  });

  it("switches harness with the agent's own fallback entry for that harness as env source, never the primary's env", () => {
    const [profile] = listHarnessTargets(agent, { adapterType: "codex_local", model: "grok-4.7", source: "routine_profile" });
    expect(profile).toMatchObject({ kind: "profile", adapterType: "codex_local", envSourceIndex: 0 });
    const view = buildHarnessTargetAgentView(agent, profile);
    expect(view.adapterType).toBe("codex_local");
    expect(view.adapterConfig).toMatchObject({
      model: "grok-4.7", cwd: "/work",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID }, CODEX_HOME: "/srv/codex" },
    });
    expect(JSON.stringify(view.adapterConfig)).not.toContain("ANTHROPIC");
    expect(view.runtimeConfig).not.toHaveProperty("aiConnection");
    expect(agentEnvBindingPrefix(agent, { target: "profile", targetKey: "codex_local:grok-4.7", profile: { adapterType: "codex_local", model: "grok-4.7", source: "routine_profile" } }))
      .toBe("fallbacks[0].");
  });

  it("skips a cross-harness profile the agent has no credentials for, and says why", () => {
    const grokProfile: ProfileTargetInput = { adapterType: "grok_local", model: "grok-4.7", source: "issue_profile" };
    expect(profileUnavailableReason(agent, grokProfile)).toBe("no_env_source");
    expect(listHarnessTargets(agent, grokProfile).map((target) => target.kind)).toEqual(["primary", "fallback"]);
    expect(profileUnavailableReason(agent, codexFast)).toBeNull();
    expect(profileUnavailableReason(agent, sonnet)).toBeNull();
  });

  it("falls through the chain when the profile target is cooling down, and labels the run", () => {
    const until = new Date(NOW.getTime() + 600_000);
    const cooling = new Map([["codex_local:grok-4.7", until]]);
    const selected = selectHarnessTarget(agent, cooling, NOW, codexFast);
    expect(selected).toMatchObject({ kind: "primary", key: "claude_local:claude-opus-5-5", heldUntil: null });
    expect(dispatchForSelection(selected, codexFast, "provider_usage_limit")).toMatchObject({
      target: "primary", source: "fallback", fallbackReason: "provider_usage_limit",
    });
    expect(selectHarnessTarget(agent, new Map(), NOW, codexFast).key).toBe("codex_local:grok-4.7");
  });

  it("holds the run when the profile target, the primary and the fallbacks are all cooling down", () => {
    const until = new Date(NOW.getTime() + 600_000);
    const cooling = new Map(listHarnessTargets(agent, codexFast).map((target) => [target.key, until]));
    expect(selectHarnessTarget(agent, cooling, NOW, codexFast)).toMatchObject({ allCoolingDown: true, heldUntil: until });
  });

  it("records where the target came from", () => {
    const profileSelection = selectHarnessTarget(agent, new Map(), NOW, codexFast);
    expect(dispatchForSelection(profileSelection, codexFast, null)).toMatchObject({ target: "profile", source: "issue_profile", fallbackReason: null });
    expect(dispatchForSelection(selectHarnessTarget(agent, new Map(), NOW, { ...codexFast, source: "routine_profile" }), { ...codexFast, source: "routine_profile" }, null))
      .toMatchObject({ source: "routine_profile" });
    expect(primaryHarnessDispatch(agent)).toMatchObject({ target: "primary", source: "agent_default" });
    const fallbackSelection = selectHarnessTarget(agent, new Map([["claude_local:claude-opus-5-5", new Date(NOW.getTime() + 1000)]]), NOW, null);
    expect(dispatchForSelection(fallbackSelection, null, "provider_usage_limit")).toMatchObject({ target: "fallback", source: "fallback" });
  });

  it("rebuilds the claimed profile target at run time", () => {
    const dispatch = dispatchForSelection(selectHarnessTarget(agent, new Map(), NOW, codexFast), codexFast, null);
    expect(applyClaimedHarnessDispatch(agent, dispatch)?.adapterType).toBe("codex_local");
    expect(applyClaimedHarnessDispatch(agent, primaryHarnessDispatch(agent))).toBe(agent);
  });

  it("drops model and environment overrides on a harness switch but keeps unrelated ones", () => {
    const overrides = { model: "claude-sonnet-5-5", env: { A: "1" }, extraArgs: ["--x"], workspaceStrategy: { type: "project_primary" } };
    expect(overridesForHarnessTarget(overrides, { target: "primary" })).toBe(overrides);
    expect(overridesForHarnessTarget(overrides, { target: "fallback" })).toEqual({ workspaceStrategy: { type: "project_primary" } });
    expect(overridesForHarnessTarget(overrides, { target: "profile", crossHarness: true })).toEqual({ workspaceStrategy: { type: "project_primary" } });
    expect(overridesForHarnessTarget(overrides, { target: "profile", crossHarness: false }))
      .toEqual({ env: { A: "1" }, extraArgs: ["--x"], workspaceStrategy: { type: "project_primary" } });
  });
});
