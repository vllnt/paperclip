import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { registerAgentBots, resolveAgentBots } from "../src/agent-bots.js";

const actor = { companyId: "c1", actor: { type: "user" as const, userId: "u1", companyId: "c1", agentId: null, runId: null } };
function setup() {
  const h = createTestHarness({ manifest });
  h.seed({ agents: [{ id: "a1", companyId: "c1", name: "Reviewer A", status: "idle" }, { id: "a2", companyId: "c1", name: "Reviewer B", status: "idle" }, { id: "foreign", companyId: "c2", name: "Foreign", status: "idle" }] as any });
  registerAgentBots(h.ctx);
  return h;
}

describe("GitHub agent bot identities", () => {
  it("stores only a login mapping and lists it with agent options", async () => {
    const h = setup();
    await expect(h.performAction("save-agent-bot", { agentId: "a1", login: "review-bot", identity: "github-app" }, actor)).resolves.toMatchObject({ agentId: "a1", login: "review-bot", identity: "github-app", enabled: true });
    const options: any = await h.performAction("agent-bot-options", {}, actor);
    expect(options.mappings).toEqual([expect.objectContaining({ agentId: "a1", login: "review-bot" })]);
    expect(JSON.stringify(h.logs)).not.toContain("token");
  });

  it("rejects foreign agents, malformed handles and unmapped reviewers", async () => {
    const h = setup();
    await expect(h.performAction("save-agent-bot", { agentId: "foreign", login: "bot" }, actor)).rejects.toThrow("available");
    await expect(h.performAction("save-agent-bot", { agentId: "a1", login: "bad login" }, actor)).rejects.toThrow("valid GitHub login");
    await expect(resolveAgentBots(h.ctx, "c1", ["a1"])).rejects.toThrow("Configure a GitHub bot identity");
  });

  it("resolves multiple distinct reviewers and prevents duplicate GitHub identities", async () => {
    const h = setup();
    await h.performAction("save-agent-bot", { agentId: "a1", login: "review-a" }, actor);
    await h.performAction("save-agent-bot", { agentId: "a2", login: "review-b" }, actor);
    await expect(resolveAgentBots(h.ctx, "c1", ["a1", "a2"])).resolves.toMatchObject({ logins: ["review-a", "review-b"] });
    await h.performAction("save-agent-bot", { agentId: "a2", login: "review-a" }, actor);
    await expect(resolveAgentBots(h.ctx, "c1", ["a1", "a2"])).rejects.toThrow("different GitHub login");
  });

  it("removes a mapping", async () => {
    const h = setup();
    await h.performAction("save-agent-bot", { agentId: "a1", login: "review-a" }, actor);
    await h.performAction("remove-agent-bot", { agentId: "a1" }, actor);
    expect((await h.performAction("agent-bot-options", {}, actor) as any).mappings).toEqual([]);
  });
});
