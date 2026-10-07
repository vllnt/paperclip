import { describe, it, expect, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { seedConnection } from "./connection.js";
import { GitHubClient } from "../src/github.js";
const companyId = "c1", actor = { type: "user" as const, userId: "u1", companyId };
const options = { companyId, actor };
const repo = { id: 22, fullName: "org/repo", name: "repo", url: "https://github.com/org/repo", owner: "org", ownerId: 1, installationId: 33, private: true, permissions: { issues: "write", pull_requests: "read" } };
async function fixture(permissions = repo.permissions) {
  const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "s1" } } });
  const secrets = vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("secret");
  h.seed({ issues: [1,2].map(n => ({ id: `t${n}`, companyId, originKind: "plugin:vllnt.paperclip-github:issue", originId: String(n), title: "Issue", status: "todo" })) as any });
  for (const n of [1,2]) await h.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: `link:${n}` }, { issueId: `t${n}`, githubId: n, number: n, repositoryId: 22, base: { state: "open" } });
  const github = new GitHubClient();
  vi.spyOn(github, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [{ ...repo, permissions }], warnings: [], truncated: false });
  vi.spyOn(github, "scopedToken").mockResolvedValue("token");
  const graph = vi.spyOn(github, "graphql").mockResolvedValue({ repository: { i1: { closedByPullRequestsReferences: { nodes: [{ number: 7, title: "Fix", state: "MERGED", isDraft: false, repository: { nameWithOwner: "org/repo" } }], pageInfo: { hasNextPage: false } } }, i2: { closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  await seedConnection(h, companyId, "12");
  register(h.ctx, github);
  return { h, graph, secrets, github };
}
describe("task links", () => {
  it("returns direct issue and closing PR links in a cached batch", async () => {
    const { h, graph } = await fixture();
    const result = await h.performAction<any>("task-links", { issueIds: ["t1", "t2"] }, options);
    expect(result.tasks[0].issue).toMatchObject({ url: "https://github.com/org/repo/issues/1", panel: { slotId: "github-record", recordId: "22:issue:1" } });
    expect(result.tasks[0].pullRequests[0]).toMatchObject({ url: "https://github.com/org/repo/pull/7", state: "merged", panel: { slotId: "github-record", recordId: "22:pull:7" }, viewPath: "/github-projects?repository=22&kind=pull&number=7" });
    expect(result.tasks[1].pullRequests).toEqual([]);
    await h.performAction("task-links", { issueIds: ["t2", "t1"] }, options);
    expect(graph).toHaveBeenCalledTimes(1);
  });
  it("opens PR review tasks through the same record panel", async () => {
    const { h, graph } = await fixture();
    h.seed({ issues: [{ id: "review", companyId, originKind: "plugin:vllnt.paperclip-github:pull", originId: "42", title: "Review", status: "todo" }] as any });
    await h.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: "review:review" }, { issueId: "review", repositoryId: 22, number: 7 });
    const result = await h.performAction<any>("task-links", { issueIds: ["review"] }, options);
    expect(result.tasks[0]).toMatchObject({ issueId: "review", pullRequestsStatus: "ready", pullRequests: [{ panel: { slotId: "github-record", recordId: "22:pull:7" } }] });
    expect(result.tasks[0].issue).toBeUndefined();
    expect(graph).not.toHaveBeenCalled();
  });
  it("keeps inaccessible cross-repository PRs external only", async () => {
    const { h, graph } = await fixture();
    graph.mockResolvedValue({ repository: { i1: { closedByPullRequestsReferences: { nodes: [{ number: 9, title: "Fix", state: "OPEN", isDraft: false, repository: { nameWithOwner: "other/repo" } }], pageInfo: { hasNextPage: false } } } } });
    const result = await h.performAction<any>("task-links", { issueIds: ["t1"] }, options);
    expect(result.tasks[0].pullRequests[0].url).toBe("https://github.com/other/repo/pull/9");
    expect(result.tasks[0].pullRequests[0].panel).toBeUndefined();
    expect(result.tasks[0].pullRequests[0].viewPath).toBeUndefined();
  });
  it("distinguishes missing PR permission from no linked PRs", async () => {
    const { h, graph } = await fixture({ issues: "write", pull_requests: "" });
    const result = await h.performAction<any>("task-links", { issueIds: ["t1"] }, options);
    expect(result.tasks[0]).toMatchObject({ pullRequestsStatus: "access_required", issue: { label: "#1" } });
    expect(graph).not.toHaveBeenCalled();
  });
  it("rejects foreign tasks and agents before using credentials", async () => {
    const { h, secrets } = await fixture();
    await expect(h.performAction("task-links", { issueIds: ["foreign"] }, options)).rejects.toThrow("company");
    await expect(h.performAction("task-links", { issueIds: ["t1"] }, { companyId, actor: { type: "agent", companyId } })).rejects.toThrow();
    expect(secrets).not.toHaveBeenCalled();
  });
  it("rejects a saved mapping belonging to another task", async () => {
    const { h, graph } = await fixture();
    await h.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: "link:1" }, { issueId: "t2", number: 7, repositoryId: 22 });
    const result = await h.performAction<any>("task-links", { issueIds: ["t1"] }, options);
    expect(result.tasks[0].pullRequestsStatus).toBe("error");
    expect(result.tasks[0].issue).toBeUndefined();
    expect(graph).not.toHaveBeenCalled();
  });
  it("keeps issue links available when GitHub PR reads fail", async () => {
    const { h, graph } = await fixture(); graph.mockRejectedValue(new Error("unavailable"));
    const result = await h.performAction<any>("task-links", { issueIds: ["t1"] }, options);
    expect(result.tasks[0]).toMatchObject({ pullRequestsStatus: "error", issue: { label: "#1" } });
  });
});
