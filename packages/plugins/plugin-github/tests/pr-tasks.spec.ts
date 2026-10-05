import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { GitHubClient } from "../src/github.js";
import { GitHubReadCache } from "../src/read-cache.js";
import { registerRecordTasks } from "../src/pr-tasks.js";
import manifest from "../src/manifest.js";

const companyId = "c1", options = { companyId, actor: { type: "user" as const, companyId, userId: "u1" } };
const repo = { id: 22, name: "repo", fullName: "org/repo", url: "https://github.com/org/repo", owner: "org", installationId: 33, private: true, permissions: { issues: "read", pull_requests: "read" } };
const remote = { id: 55, number: 7, title: "Improve UI", body: "Details", state: "open", merged: false };
function fixture(permissions = repo.permissions) {
  const h = createTestHarness({ manifest });
  h.seed({ projects: [{ id: "p1", companyId, name: "Repo" }] as any });
  vi.spyOn(h.ctx.projects, "listWorkspaces").mockResolvedValue([{ repoUrl: repo.url }] as any);
  const github = new GitHubClient();
  const credentials = vi.fn(async () => ({ id: "12", pem: "secret" }));
  vi.spyOn(github, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [{ ...repo, permissions }], warnings: [], truncated: false });
  vi.spyOn(github, "scopedToken").mockResolvedValue("token");
  const requests = vi.spyOn(github, "request").mockResolvedValue({ data: remote, next: false } as any);
  const ensureTasks = vi.fn(async () => new Map([[55, { paperclipTask: { id: "issue-task", identifier: "GIT-1", status: "todo" } }]]));
  registerRecordTasks(h.ctx, github, credentials, new GitHubReadCache(), ensureTasks);
  return { h, credentials, requests, ensureTasks };
}
const params = { repositoryId: 22, kind: "pull", number: 7 };
describe("native GitHub record tasks", () => {
  it("creates one tracking task across concurrent opens and returns the native panel", async () => {
    const { h, requests } = fixture();
    const results = await Promise.all([h.performAction<any>("open-record-task", params, options), h.performAction<any>("open-record-task", params, options)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].panel).toEqual({ slotId: "github-record", recordId: "22:pull:7" });
    const tasks = await h.ctx.issues.list({ companyId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ projectId: "p1", status: "todo", title: "Improve UI", originKind: "plugin:vllnt.paperclip-github:pull", originId: "55" });
    expect(await h.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: `review:${tasks[0].id}` })).toMatchObject({ repositoryId: 22, number: 7 });
    expect(requests.mock.calls.every(c => !c[3])).toBe(true);
  });
  it.each([{ state: "closed", merged: false }, { state: "closed", merged: true }])("imports a closed or merged PR as Done %j", async state => {
    const { h, requests } = fixture(); requests.mockResolvedValue({ data: { ...remote, ...state }, next: false } as any);
    await h.performAction("open-record-task", params, options);
    expect((await h.ctx.issues.list({ companyId }))[0].status).toBe("done");
  });
  it("uses issue sync associations for legacy issue navigation", async () => {
    const { h, ensureTasks } = fixture();
    const result = await h.performAction<any>("open-record-task", { ...params, kind: "issue" }, options);
    expect(result).toEqual({ id: "issue-task", identifier: "GIT-1", panel: { slotId: "github-record", recordId: "22:issue:7" } });
    expect(ensureTasks).toHaveBeenCalledWith(companyId, repo, [expect.objectContaining({ id: 55, number: 7 })]);
    expect(await h.ctx.issues.list({ companyId })).toHaveLength(0);
  });
  it("rejects agents, company mismatch, missing access, and foreign projects without creating tasks", async () => {
    const { h, credentials } = fixture();
    await expect(h.performAction("open-record-task", params, { companyId, actor: { type: "agent", companyId } })).rejects.toThrow();
    await expect(h.performAction("open-record-task", { ...params, companyId: "foreign" }, { actor: options.actor })).rejects.toThrow();
    expect(credentials).not.toHaveBeenCalled();
    await expect(h.performAction("open-record-task", { ...params, repositoryId: 99 }, options)).rejects.toThrow("accessible");
    await expect(h.performAction("open-record-task", { ...params, projectId: "foreign" }, options)).rejects.toThrow("linked");
    expect(await h.ctx.issues.list({ companyId })).toHaveLength(0);
    const missing = fixture({ issues: "read", pull_requests: "" });
    await expect(missing.h.performAction("open-record-task", params, options)).rejects.toThrow("pull requests");
    expect(missing.requests).not.toHaveBeenCalled();
  });
  it("recovers an interrupted mapping write without duplicating the native task", async () => {
    const { h } = fixture();
    const original = h.ctx.state.set.bind(h.ctx.state);
    let failed = false;
    vi.spyOn(h.ctx.state, "set").mockImplementation(async (key, value) => {
      if (key.stateKey.startsWith("pull:") && !failed) { failed = true; throw new Error("Storage unavailable"); }
      return original(key, value);
    });
    await expect(h.performAction("open-record-task", params, options)).rejects.toThrow("Storage unavailable");
    await h.performAction("open-record-task", params, options);
    expect(await h.ctx.issues.list({ companyId })).toHaveLength(1);
  });
  it("rejects a mapping to an unrelated native task", async () => {
    const { h } = fixture();
    h.seed({ issues: [{ id: "unrelated", companyId, title: "Other", status: "todo", originKind: "plugin:vllnt.paperclip-github:pull", originId: "999" }] as any });
    await h.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: "pull:22:55" }, { issueId: "unrelated", repositoryId: 22, number: 7 });
    await expect(h.performAction("open-record-task", params, options)).rejects.toThrow("invalid");
    expect(await h.ctx.issues.list({ companyId })).toHaveLength(1);
  });
  it("does not resurrect a deleted association", async () => {
    const { h } = fixture();
    await h.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: "pull:22:55" }, { issueId: "deleted" });
    await expect(h.performAction("open-record-task", params, options)).rejects.toThrow("deleted");
    expect(await h.ctx.issues.list({ companyId })).toHaveLength(0);
  });
});
