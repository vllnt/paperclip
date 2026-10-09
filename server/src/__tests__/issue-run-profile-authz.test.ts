import { describe, expect, it } from "vitest";
import type { CompanyRunTiers } from "@paperclipai/shared";
import { decideIssueRunProfileChange } from "../routes/issue-run-profile-authz.js";

const TIERS: CompanyRunTiers = {
  tiers: {
    fast: { adapterType: "codex_local", model: "grok-4.7" },
    standard: { adapterType: "claude_local", model: "claude-sonnet-5-5" },
  },
  agentAllowlist: ["fast"],
};
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

const board = { type: "board" as const };
const agentActor = { type: "agent" as const, agentId: AGENT, hasConfigureGrant: false };

function change(input: Partial<Parameters<typeof decideIssueRunProfileChange>[0]> & { actor: Parameters<typeof decideIssueRunProfileChange>[0]["actor"] }) {
  return decideIssueRunProfileChange({
    tiers: TIERS,
    existing: null,
    next: undefined,
    existingOverrides: null,
    assigneeAgentId: OTHER_AGENT,
    ...input,
  });
}

describe("decideIssueRunProfileChange", () => {
  it("does nothing when the overrides are not part of the change or the profile is unchanged", () => {
    expect(change({ actor: agentActor, next: undefined })).toEqual({ allowed: true, changed: false });
    expect(change({
      actor: agentActor,
      existingOverrides: { runProfile: { tier: "standard" } },
      next: { runProfile: { tier: "standard" }, useProjectWorkspace: true },
    })).toEqual({ allowed: true, changed: false });
    expect(change({ actor: agentActor, next: { useProjectWorkspace: true, adapterConfig: { cwd: "/x" } } })).toEqual({ allowed: true, changed: false });
  });

  it("lets a board user set any profile", () => {
    expect(change({ actor: board, next: { runProfile: { tier: "standard" } } })).toMatchObject({ allowed: true, changed: true });
    expect(change({ actor: board, next: { runProfile: { adapterType: "codex_local", model: "gpt-5.5" } } })).toMatchObject({ allowed: true, changed: true });
  });

  it("lets an agent set an allowlisted tier on an issue it creates", () => {
    expect(change({ actor: agentActor, creating: true, next: { runProfile: { tier: "fast" } } })).toMatchObject({
      allowed: true, changed: true, after: { tier: "fast" },
    });
  });

  it("lets an agent set an allowlisted tier on an issue it created, or dispatches to another agent", () => {
    const mine = { createdByAgentId: AGENT, assigneeAgentId: OTHER_AGENT };
    expect(change({ actor: agentActor, existing: mine, next: { runProfile: { tier: "fast" } } })).toMatchObject({ allowed: true });
    const theirs = { createdByAgentId: OTHER_AGENT, assigneeAgentId: OTHER_AGENT };
    expect(change({ actor: agentActor, existing: theirs, next: { runProfile: { tier: "fast" } } })).toMatchObject({ allowed: false, reason: "not_creator_or_dispatcher" });
    expect(change({ actor: agentActor, existing: theirs, dispatching: true, next: { runProfile: { tier: "fast" } } })).toMatchObject({ allowed: true });
  });

  it("refuses an agent a tier outside the allowlist or an explicit target", () => {
    expect(change({ actor: agentActor, creating: true, next: { runProfile: { tier: "standard" } } })).toMatchObject({ allowed: false, reason: "tier_not_allowlisted" });
    expect(change({ actor: agentActor, creating: true, next: { runProfile: { adapterType: "codex_local", model: "gpt-5.5" } } })).toMatchObject({ allowed: false, reason: "explicit_target_not_allowed" });
    expect(change({ actor: agentActor, creating: true, next: { runProfile: { model: "claude-opus-5-5" } } })).toMatchObject({ allowed: false, reason: "explicit_target_not_allowed" });
  });

  it("refuses an agent raising its own tasks: clearing a profile or overriding one it may not change", () => {
    expect(change({
      actor: agentActor, existing: { createdByAgentId: AGENT, assigneeAgentId: AGENT },
      existingOverrides: { runProfile: { tier: "fast" } }, next: {},
    })).toMatchObject({ allowed: false, reason: "tier_not_allowlisted" });
    expect(change({
      actor: agentActor, existing: { createdByAgentId: AGENT, assigneeAgentId: OTHER_AGENT },
      existingOverrides: { runProfile: { tier: "standard" } }, next: { runProfile: { tier: "fast" } },
    })).toMatchObject({ allowed: false, reason: "existing_profile_not_agent_set" });
    expect(change({
      actor: agentActor, existing: { createdByAgentId: AGENT, assigneeAgentId: OTHER_AGENT },
      existingOverrides: { runProfile: { adapterType: "codex_local", model: "gpt-5.5" } }, next: { runProfile: { tier: "fast" } },
    })).toMatchObject({ allowed: false, reason: "existing_profile_not_agent_set" });
  });

  it("treats the default tier as a clear, which an agent may do only when allowlisted", () => {
    const withDeep: CompanyRunTiers = { ...TIERS, agentAllowlist: ["fast", "deep"] };
    expect(change({ actor: agentActor, creating: true, next: { runProfile: { tier: "deep" } } })).toMatchObject({ allowed: false, reason: "tier_not_allowlisted" });
    expect(change({ actor: agentActor, creating: true, tiers: withDeep, next: { runProfile: { tier: "deep" } } })).toMatchObject({ allowed: true });
  });

  it("guards the legacy model and effort overrides the same way", () => {
    expect(change({ actor: agentActor, creating: true, next: { adapterConfig: { model: "claude-opus-5-5" } } })).toMatchObject({ allowed: false, reason: "explicit_target_not_allowed" });
    expect(change({ actor: agentActor, creating: true, next: { adapterConfig: { cwd: "/x" } } })).toMatchObject({ allowed: true, changed: false });
    expect(change({ actor: board, next: { adapterConfig: { model: "grok-4.7" } } })).toMatchObject({ allowed: true, changed: true });
  });

  it("lets an agent with agents:configure for the assignee set anything", () => {
    const granted = { ...agentActor, hasConfigureGrant: true };
    expect(change({ actor: granted, creating: true, next: { runProfile: { adapterType: "codex_local", model: "gpt-5.5" } } })).toMatchObject({ allowed: true, changed: true });
  });

  it("refuses an agent when the company has no tiers", () => {
    expect(change({ actor: agentActor, creating: true, tiers: null, next: { runProfile: { tier: "fast" } } })).toMatchObject({ allowed: false, reason: "tier_not_allowlisted" });
  });
});
