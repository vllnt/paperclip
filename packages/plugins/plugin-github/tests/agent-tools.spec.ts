import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { GitHubClient } from "../src/github.js";
import { registerAgentBots } from "../src/agent-bots.js";
import { registerAgentTools } from "../src/agent-tools.js";

const repo = {
  id: 22, name: "repo", fullName: "org/repo", url: "https://github.com/org/repo",
  installationId: 33, owner: "org", private: true,
  permissions: { metadata: "read", issues: "write", pull_requests: "write", contents: "write", checks: "write" },
  issuesWrite: true,
};
const runCtx = { agentId: "a1", runId: "run-1", companyId: "c1", projectId: "p1" };
const catalog = { app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false };

describe("GitHub agent tools", () => {
  function fixture() {
    const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
    h.seed({ agents: [{ id: "a1", companyId: "c1", name: "Engineer", status: "idle" }] as any });
    vi.spyOn(h.ctx.chat, "listEndpoints").mockResolvedValue({ chatConnectorsEnabled: true, endpoints: [{ id: "ep-a1", companyId: "c1", connectionId: "conn-a1", provider: "github", status: "active", assignedAgentId: "a1", botUsername: "engineer-bot", capabilities: {} }] });
    const github = new GitHubClient();
    vi.spyOn(github, "scopedToken").mockResolvedValue("installation-token");
    const request = vi.spyOn(github, "request").mockResolvedValue({ data: { id: 101, number: 3, title: "Created" }, next: false } as any);
    registerAgentBots(h.ctx);
    registerAgentTools(h.ctx, github, async () => ({ id: "12", pem: "fixture" }), async () => catalog as any);
    return { h, request };
  }

  it("rejects cross-company parameters before reaching GitHub", async () => {
    const { h, request } = fixture();
    await expect(h.executeTool("github_read_issue", { repository: "org/repo", number: 3, companyId: "other" }, runCtx)).resolves.toMatchObject({ error: expect.stringContaining("another company") });
    expect(request).not.toHaveBeenCalled();
  });

  it("requires the current SHA for review and merge operations", async () => {
    const { h, request } = fixture();
    await expect(h.executeTool("github_submit_review", { repository: "org/repo", number: 3, event: "APPROVE" }, runCtx)).resolves.toMatchObject({ error: expect.stringContaining("current pull request commit SHA") });
    await expect(h.executeTool("github_merge_pull_request", { repository: "org/repo", number: 3, method: "squash", confirm: "org/repo#3" }, runCtx)).resolves.toMatchObject({ error: expect.stringContaining("current pull request commit SHA") });
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves an agent identity to a GitHub assignee without exposing credentials", async () => {
    const { h, request } = fixture();
    const board = { companyId: "c1", actor: { type: "user" as const, userId: "u1", companyId: "c1", agentId: null, runId: null } };
    await h.performAction("save-agent-bot", { agentId: "a1", login: "engineer-bot" }, board);
    await expect(h.executeTool("github_create_issue", { repository: "org/repo", title: "Fix", assigneeAgentIds: ["a1"] }, runCtx)).resolves.toMatchObject({ data: { number: 3 } });
    expect(request).toHaveBeenCalledWith("/repos/org/repo/issues", "installation-token", expect.objectContaining({ assignees: ["engineer-bot"] }), "POST");
    expect(JSON.stringify(h.activity)).not.toContain("fixture");
  });
});
