import { describe, expect, it } from "vitest";
import {
  agentProtectedConfigAfterPatch,
  collectAgentConfigRollbackChanges,
  collectAgentPermissionChanges,
  collectAgentProtectedConfigChanges,
  collectNewAgentProtectedFields,
  type AgentProtectedConfigState,
} from "../services/agent-self-config-authz.js";

const aiConnection = { provider: "anthropic", method: "api_key", mode: "responsible_user" };

const stored: AgentProtectedConfigState = {
  adapterType: "claude_local",
  adapterConfig: { model: "small-model", effort: "low", cwd: "/work", env: { A: "1" } },
  runtimeConfig: { aiConnection, heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1 } },
  budgetMonthlyCents: 1_000,
  spentMonthlyCents: 700,
  role: "engineer",
  status: "idle",
  defaultEnvironmentId: "env-1",
};

function changesFor(patch: Record<string, unknown>, replaceAdapterConfig = false) {
  return collectAgentProtectedConfigChanges(stored, agentProtectedConfigAfterPatch(stored, patch, replaceAdapterConfig));
}

describe("agent self-config protected field diff", () => {
  it("ignores unprotected keys and unchanged protected values", () => {
    expect(changesFor({ adapterConfig: { search: true, notes: "x" } })).toEqual([]);
    expect(changesFor({
      adapterType: "claude_local",
      adapterConfig: { model: "small-model", env: { A: "1" } },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 5 } },
      budgetMonthlyCents: 1_000,
      spentMonthlyCents: 700,
      defaultEnvironmentId: "env-1",
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
    expect(changesFor({ adapterConfig: { model: "small-model", cwd: "/work" } }, true))
      .toEqual(["adapterConfig.effort", "adapterConfig.env.A"]);
  });

  it("flags CLI argument overrides, adapter switches, and heartbeat aliases", () => {
    expect(changesFor({ adapterConfig: { extraArgs: ["--model", "large-model"] } })).toEqual(["adapterConfig.extraArgs"]);
    expect(changesFor({ adapterType: "codex_local" })).toEqual([
      "adapterType",
      "adapterConfig.effort",
      "adapterConfig.model",
    ]);
    expect(changesFor({ runtimeConfig: { heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1, dailyRunLimit: 900 } } }))
      .toEqual(["runtimeConfig.heartbeat.dailyRunLimit"]);
  });

  it("flags session compaction limits set outside heartbeat", () => {
    expect(changesFor({
      runtimeConfig: {
        aiConnection,
        heartbeat: { maxDailyRuns: 5, maxConcurrentRuns: 1 },
        sessionCompaction: { maxRawInputTokens: 10_000_000, enabled: false },
      },
    })).toEqual(["runtimeConfig.sessionCompaction.enabled", "runtimeConfig.sessionCompaction.maxRawInputTokens"]);
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

  it("flags environment selection and env variables per key", () => {
    expect(changesFor({ defaultEnvironmentId: null })).toEqual(["defaultEnvironmentId"]);
    expect(changesFor({ defaultEnvironmentId: "env-2" })).toEqual(["defaultEnvironmentId"]);
    expect(changesFor({ adapterConfig: { env: { A: "1", CODEX_HOME: "/tmp/other" } } }))
      .toEqual(["adapterConfig.env.CODEX_HOME"]);
    expect(changesFor({ adapterConfig: { env: { A: "2" } } })).toEqual(["adapterConfig.env.A"]);
    expect(changesFor({ adapterConfig: { env: {} } })).toEqual(["adapterConfig.env.A"]);
  });

  it("flags permission bypass, sandbox, endpoint, and any dangerously* adapter key", () => {
    expect(changesFor({
      adapterConfig: {
        dangerouslySkipPermissions: true,
        dangerouslyBypassApprovalsAndSandbox: true,
        permissionMode: "bypassPermissions",
        sandbox: false,
        filesystemSandboxCommand: "/tmp/not-bwrap",
        command: "/tmp/wrapper",
        url: "wss://other-gateway",
        dangerouslyEnableFutureEscapeHatch: true,
      },
    })).toEqual([
      "adapterConfig.command",
      "adapterConfig.dangerouslyBypassApprovalsAndSandbox",
      "adapterConfig.dangerouslyEnableFutureEscapeHatch",
      "adapterConfig.dangerouslySkipPermissions",
      "adapterConfig.filesystemSandboxCommand",
      "adapterConfig.permissionMode",
      "adapterConfig.sandbox",
      "adapterConfig.url",
    ]);
  });

  it("flags executables, state directories, tool sets, runner limits, and sandbox scope", () => {
    expect(changesFor({
      adapterConfig: {
        acpAgentCommand: "/tmp/acp",
        hermesCommand: "/tmp/hermes",
        stateDir: "/tmp/state",
        acpStateDir: "/tmp/acp-state",
        toolsets: "all",
        enabledToolsets: ["terminal"],
        engine: "cli",
        acpxPermissionMode: "approve-all",
        codexPermissionMode: "allow",
        maxEstimatedSessionCostUsd: 1000,
        maxIterations: 8,
        idleTimeoutMs: 1,
        managedProfileId: "other-profile",
        agentCoreRetentionAcknowledged: true,
        networkScope: "allow",
        filesystemScope: "host",
        cwd: "/",
        acpWarmHandleIdleMs: 600_000,
        warmHandleIdleMs: 600_000,
        lifecycleMode: "warm",
        runtimeEnvType: "machine",
        runtimeEnvName: "other-machine",
        filesystemExtraPaths: ["/"],
        networkAllowlist: ["*"],
      },
    })).toEqual([
      "adapterConfig.acpAgentCommand",
      "adapterConfig.acpStateDir",
      "adapterConfig.acpWarmHandleIdleMs",
      "adapterConfig.acpxPermissionMode",
      "adapterConfig.agentCoreRetentionAcknowledged",
      "adapterConfig.codexPermissionMode",
      "adapterConfig.cwd",
      "adapterConfig.enabledToolsets",
      "adapterConfig.engine",
      "adapterConfig.filesystemExtraPaths",
      "adapterConfig.filesystemScope",
      "adapterConfig.hermesCommand",
      "adapterConfig.idleTimeoutMs",
      "adapterConfig.lifecycleMode",
      "adapterConfig.managedProfileId",
      "adapterConfig.maxEstimatedSessionCostUsd",
      "adapterConfig.maxIterations",
      "adapterConfig.networkAllowlist",
      "adapterConfig.networkScope",
      "adapterConfig.runtimeEnvName",
      "adapterConfig.runtimeEnvType",
      "adapterConfig.stateDir",
      "adapterConfig.toolsets",
      "adapterConfig.warmHandleIdleMs",
    ]);
  });

  it("flags unlisted keys that match a protected name pattern", () => {
    expect(changesFor({
      adapterConfig: {
        futureCommand: "/tmp/x",
        futurePermissionMode: "allow",
        maxFutureSpendUsd: 1,
        probeTimeoutSec: 1,
        futureProfileId: "p",
        futureRetentionAcknowledged: true,
        futureIdleMs: 1,
        notes: "unprotected",
      },
    })).toEqual([
      "adapterConfig.futureCommand",
      "adapterConfig.futureIdleMs",
      "adapterConfig.futurePermissionMode",
      "adapterConfig.futureProfileId",
      "adapterConfig.futureRetentionAcknowledged",
      "adapterConfig.maxFutureSpendUsd",
      "adapterConfig.probeTimeoutSec",
    ]);
  });

  it("lists every field a rollback would change, including environment and profile fields", () => {
    const existing = {
      name: "Worker",
      title: "Builder",
      adapterType: "process",
      adapterConfig: { cwd: "/work", env: { A: "1" } },
      runtimeConfig: { heartbeat: { maxDailyRuns: 5 } },
      defaultEnvironmentId: null,
      budgetMonthlyCents: 1_000,
      metadata: null,
    };
    expect(collectAgentConfigRollbackChanges(existing, { ...existing })).toEqual([]);
    expect(collectAgentConfigRollbackChanges(existing, {
      ...existing,
      title: "Old title",
      adapterConfig: { cwd: "/old", env: { A: "1", B: "2" } },
      runtimeConfig: { heartbeat: { maxDailyRuns: 50 } },
      defaultEnvironmentId: "env-1",
    })).toEqual([
      "adapterConfig.cwd",
      "adapterConfig.env.B",
      "defaultEnvironmentId",
      "runtimeConfig.heartbeat.maxDailyRuns",
      "title",
    ]);
  });

  it("lists only the permission keys whose value changes", () => {
    const before = { canCreateAgents: false, canCreateSkills: true, canAssignTasks: true };
    expect(collectAgentPermissionChanges(before, { ...before })).toEqual([]);
    expect(collectAgentPermissionChanges(before, { ...before, canCreateAgents: true, trustPreset: "standard" }))
      .toEqual(["permissions.canCreateAgents", "permissions.trustPreset"]);
  });
});

describe("collectNewAgentProtectedFields", () => {
  it("flags limits, model, budget, bypass flags, canCreateAgents, and the ceo role on a new agent", () => {
    expect(collectNewAgentProtectedFields({
      adapterType: "codex_local",
      adapterConfig: { model: "big", effort: "max", dangerouslyBypassApprovalsAndSandbox: true },
      runtimeConfig: { heartbeat: { maxDailyRuns: 9_999 }, sessionCompaction: { maxSessionRuns: 500 } },
      budgetMonthlyCents: 5_000,
      role: "ceo",
      permissions: { canCreateAgents: true },
    }).sort()).toEqual([
      "adapterConfig.dangerouslyBypassApprovalsAndSandbox",
      "adapterConfig.effort",
      "adapterConfig.model",
      "budgetMonthlyCents",
      "permissions.canCreateAgents",
      "role",
      "runtimeConfig.heartbeat.maxDailyRuns",
      "runtimeConfig.sessionCompaction.maxSessionRuns",
    ]);
  });

  it("flags nothing for a request that only picks the settings every create needs", () => {
    expect(collectNewAgentProtectedFields({
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "anthropic", acpxAgent: "claude", engine: "cli", cwd: "/work", env: { A: { type: "plain", value: "1" } } },
      runtimeConfig: { aiConnection, heartbeat: { enabled: false } },
      role: "engineer",
      permissions: { canCreateAgents: false },
    })).toEqual([]);
  });

  it("still flags a heartbeat the request turns on", () => {
    expect(collectNewAgentProtectedFields({
      adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: true } },
    })).toEqual(["runtimeConfig.heartbeat.enabled"]);
  });
});
