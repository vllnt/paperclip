import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { GitHubClient } from "../src/github.js";
const companyId = "c1";
const options = { companyId, actor: { type: "user" as const, userId: "u1", companyId, agentId: null, runId: null } };
const repo = { id: 22, name: "repo", fullName: "org/repo", url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true };
const otherRepo = { ...repo, id: 23, name: "other", fullName: "org/other", url: "https://github.com/org/other" };
function fixture() {
  const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
  const secret = vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("fixture-pem");
  h.seed({ projects: [{ id: "p1", companyId, name: "One" }, { id: "p2", companyId, name: "Two" }, { id: "foreign", companyId: "c2", name: "Foreign" }] as any,
    projectWorkspaces: [{ id: "w1", companyId, projectId: "p1", repoUrl: repo.url }, { id: "w2", companyId, projectId: "p2", repoUrl: repo.url + ".git" },
      { id: "w3", companyId, projectId: "p2", repoUrl: otherRepo.url }] as any });
  const client = new GitHubClient();
  const catalog = vi.spyOn(client, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo, otherRepo], warnings: [], truncated: false });
  const issues = vi.spyOn(client, "issues").mockResolvedValue({ issues: [], nextPage: null, repository: repo.fullName });
  register(h.ctx, client);
  return { h, secret, catalog, issues };
}
describe("automatic task issue sources", () => {
  it("combines all linked repositories and preserves every project without duplicates", async () => {
    const { h } = fixture();
    const data = await h.performAction<any>("task-repositories", {}, options);
    expect(data.repositories).toHaveLength(2);
    expect(data.repositories[0].projects).toEqual([{ id: "p1", name: "One" }, { id: "p2", name: "Two" }]);
    expect(data.linkedCount).toBe(2);
    expect(JSON.stringify(data)).not.toContain("fixture-pem");
    const project = await h.performAction<any>("task-repositories", { projectId: "p1" }, options);
    expect(project.repositories).toHaveLength(1);
    expect(project.repositories[0].projects).toEqual([{ id: "p1", name: "One" }]);
  });
  it("discovers company project repositories for the Tasks PR picker", async () => {
    const { h } = fixture();
    const data = await h.performAction<any>("linked-repositories", {}, options);
    expect(data.repositories.map((r: any) => r.id)).toEqual([22, 23]);
    expect(data.linkedCount).toBe(2);
    const scoped = await h.performAction<any>("linked-repositories", { projectId: "p1" }, options);
    expect(scoped.repositories.map((r: any) => r.id)).toEqual([22]);
  });
  it("does not broaden projectless task repository access or accept foreign projects", async () => {
    const { h, secret } = fixture();
    h.seed({ issues: [{ id: "task", companyId, projectId: null, title: "Standalone", status: "todo" }] as any });
    expect(await h.performAction<any>("linked-repositories", { issueId: "task" }, options)).toMatchObject({ repositories: [], linkedCount: 0 });
    await expect(h.performAction("linked-repositories", { projectId: "foreign" }, options)).rejects.toThrow("project");
    expect(secret).not.toHaveBeenCalled();
  });
  it("paginates the PR picker repository discovery", async () => {
    const { h } = fixture();
    const list = vi.spyOn(h.ctx.projects, "list").mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: `empty-${i}`, companyId, name: "Empty" })) as any)
      .mockResolvedValueOnce([{ id: "p1", companyId, name: "Last" }] as any);
    const data = await h.performAction<any>("linked-repositories", {}, options);
    expect(data.repositories.map((r: any) => r.id)).toEqual([22]);
    expect(list).toHaveBeenLastCalledWith({ companyId, limit: 100, offset: 100 });
  });
  it("uses all issue states, shares discovery, and validates each page against current project links", async () => {
    const { h, catalog, issues } = fixture();
    await h.performAction("task-repositories", {}, options);
    await Promise.all([1, 2].map(page => h.performAction("task-issues", { repositoryId: 22, page }, options)));
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(issues).toHaveBeenCalledWith("12", "fixture-pem", repo, 2, "all");
    vi.spyOn(h.ctx.projects, "listWorkspaces").mockResolvedValue([]);
    await expect(h.performAction("task-issues", { repositoryId: 22 }, options)).rejects.toThrow("no longer linked");
    expect(issues).toHaveBeenCalledTimes(2);
  });
  it("does not use a cached catalog after credentials change and refreshes discovery explicitly", async () => {
    const { h, secret, catalog } = fixture();
    await h.performAction("task-repositories", {}, options);
    secret.mockResolvedValue("rotated-pem");
    await h.performAction("task-issues", { repositoryId: 22 }, options);
    expect(catalog).toHaveBeenCalledTimes(2);
    await h.performAction("task-repositories", { refresh: true }, options);
    expect(catalog).toHaveBeenCalledTimes(3);
  });
  it("reports denied repositories while preserving accessible sources", async () => {
    const { h, catalog, issues } = fixture();
    catalog.mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false });
    const result = await h.performAction<any>("task-repositories", {}, options);
    expect(result.repositories).toHaveLength(1);
    expect(result.warnings[0]).toContain("org/other");
    expect(result.warnings[0]).toContain("unlink it in Projects (Two)");
    await expect(h.performAction("task-issues", { repositoryId: 23 }, options)).rejects.toThrow("not linked");
    expect(issues).not.toHaveBeenCalled();
  });
  it("rejects agents, foreign projects, and invalid pages before reading secrets", async () => {
    const { h, secret } = fixture();
    await expect(h.performAction("task-repositories", { projectId: "foreign" }, options)).rejects.toThrow();
    await expect(h.performAction("task-repositories", {}, { companyId, actor: { type: "agent", companyId } })).rejects.toThrow();
    await expect(h.performAction("task-issues", { repositoryId: 22, page: -1 }, options)).rejects.toThrow();
    expect(secret).not.toHaveBeenCalled();
  });
  it("walks every project page and avoids GitHub calls when nothing is linked", async () => {
    const { h, catalog, secret } = fixture();
    const list = vi.spyOn(h.ctx.projects, "list").mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: `empty-${i}`, companyId, name: "Empty" })) as any)
      .mockResolvedValueOnce([{ id: "last", companyId, name: "Last" }] as any);
    vi.spyOn(h.ctx.projects, "listWorkspaces").mockResolvedValue([]);
    const data = await h.performAction<any>("task-repositories", {}, options);
    expect(list).toHaveBeenLastCalledWith({ companyId, limit: 100, offset: 100 });
    expect(data).toMatchObject({ configured: true, linkedCount: 0, repositories: [] });
    expect(catalog).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled();
  });
});
