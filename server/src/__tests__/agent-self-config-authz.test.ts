import { describe, expect, it } from "vitest";
import {
  agentProtectedConfigAfterPatch,
  collectAgentPermissionChanges,
  collectAgentProtectedConfigChanges,
  type AgentProtectedConfigState,
} from "../routes/agent-self-config-authz.js";

const aiConnection = { provider: "anthropic", method: "api_key", mode: "responsible_user" };

const stored: AgentProtectedConfigState = {
  adapterType: "claude_local",
  adapterConfig: { model: "small-model", effort: "low", cwd: "/work", env: { A: "1" } },
  runtimeConfig: { aiConnection, heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1 } },
  budgetMonthlyCents: 1_000,
  spentMonthlyCents: 700,
  role: "engineer",
  status: "idle",
};

function changesFor(patch: Record<string, unknown>, replaceAdapterConfig = false) {
  return collectAgentProtectedConfigChanges(stored, agentProtectedConfigAfterPatch(stored, patch, replaceAdapterConfig));
}

describe("agent self-config protected field diff", () => {
  it("ignores unprotected keys and unchanged protected values", () => {
    expect(changesFor({ adapterConfig: { cwd: "/elsewhere", env: { A: "2" } } })).toEqual([]);
    expect(changesFor({
      adapterType: "claude_local",
      adapterConfig: { model: "small-model" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 5 } },
      budgetMonthlyCents: 1_000,
      spentMonthlyCents: 700,
    })).toEqual([]);
  });

  it("keeps the stored aiConnection when the patch leaves it empty, like the route does", () => {
    expect(changesFor({ runtimeConfig: { heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1 } } })).toEqual([]);
    expect(changesFor({ runtimeConfig: { aiConnection: null, heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1 } } }))
      .toEqual([]);
    expect(changesFor({
      runtimeConfig: { aiConnection: { ...aiConnection, provider: "openai" }, heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1 } },
    })).toEqual(["runtimeConfig.aiConnection"]);
  });

  it("treats a replaced adapterConfig that omits a protected key as a change", () => {
    expect(changesFor({ adapterConfig: { model: "small-model", cwd: "/work" } }, true)).toEqual(["adapterConfig.effort"]);
  });

  it("flags CLI argument overrides, adapter switches, and heartbeat aliases", () => {
    expect(changesFor({ adapterConfig: { extraArgs: ["--model", "large-model"] } })).toEqual(["adapterConfig.extraArgs"]);
    expect(changesFor({ adapterType: "codex_local" })).toEqual([
      "adapterType",
      "adapterConfig.model",
      "adapterConfig.effort",
    ]);
    expect(changesFor({ runtimeConfig: { heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1, dailyRunLimit: 900 } } }))
      .toEqual(["runtimeConfig.heartbeat.dailyRunLimit"]);
  });

  it("flags a role change and leaving paused, but not other status changes", () => {
    expect(changesFor({ role: "ceo", metadata: {} })).toEqual(["role"]);
    expect(changesFor({ status: "paused" })).toEqual([]);
    const paused = { ...stored, status: "paused" };
    expect(collectAgentProtectedConfigChanges(paused, agentProtectedConfigAfterPatch(paused, { status: "idle" }, false)))
      .toEqual(["status"]);
    expect(collectAgentProtectedConfigChanges(paused, agentProtectedConfigAfterPatch(paused, { status: "paused" }, false)))
      .toEqual([]);
  });

  it("lists only the permission keys whose value changes", () => {
    const before = { canCreateAgents: false, canCreateSkills: true, canAssignTasks: true };
    expect(collectAgentPermissionChanges(before, { ...before })).toEqual([]);
    expect(collectAgentPermissionChanges(before, { ...before, canCreateAgents: true, trustPreset: "standard" }))
      .toEqual(["permissions.canCreateAgents", "permissions.trustPreset"]);
  });
});
