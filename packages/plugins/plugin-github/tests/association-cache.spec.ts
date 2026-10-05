import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { GitHubClient } from "../src/github.js";
const actor = { companyId: "c1", actor: { type: "user" as const, userId: "u1", companyId: "c1", agentId: null, runId: null } };
const repo = { id: 22, name: "repo", fullName: "org/repo", url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true, issuesWrite: true, permissions: { issues: "write" } };
const row = { id: 101, number: 1, title: "Remote issue", body: "Description", state: "open", updated_at: "2026-10-04T12:00:00Z", html_url: repo.url + "/issues/1", assignees: [], labels: [] };
function fixture() {
  const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
  vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("pem");
  const github = new GitHubClient();
  const catalog = vi.spyOn(github, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false });
  vi.spyOn(github, "scopedToken").mockResolvedValue("token");
  const request = vi.spyOn(github, "request").mockImplementation(async (path, _token, _body, method) => ({ data: method || !path.includes("?") ? row : [row], next: false }) as any);
  const service = register(h.ctx, github);
  const read = (p: Record<string, unknown> = {}, scope = actor) => h.performAction("manage-repository", { repositoryId: 22, op: "issues", ...p }, scope) as Promise<any>;
  return { h, github, catalog, request, service, read };
}
describe("issue associations and read caching", () => {
  it("shares discovery and page reads across visits and associates one Todo task without a project", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.read(), f.read()]);
    expect(a.rows[0].paperclipTask).toMatchObject({ id: expect.any(String), status: "todo" });
    expect(b.rows[0].paperclipTask.id).toBe(a.rows[0].paperclipTask.id);
    expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(1);
    expect(f.catalog).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("bypasses cache on explicit refresh and rejects agent access before reading it", async () => {
    const f = fixture(); await f.read(); await f.read();
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.read({ refresh: true }); expect(f.request).toHaveBeenCalledTimes(2);
    await expect(f.read({}, { ...actor, actor: { ...actor.actor, type: "agent" as any } })).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("does not import pull requests as issue tasks", async () => {
    const f = fixture(); f.request.mockResolvedValue({ data: { ...row, pull_request: {} }, next: false });
    const result = await f.read({ op: "issue", number: 1 });
    expect(result.paperclipTask).toBeUndefined();
    expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(0);
  });
});

it("keeps discovered issues synchronized without importing unrelated repository issues", async () => {
  const f = fixture(); const first = await f.read();
  const get = vi.spyOn(f.github, "getIssue").mockResolvedValue(f.github.issue({ ...row, title: "Changed upstream" }, repo));
  const list = vi.spyOn(f.github, "issues");
  await f.service.sync("c1");
  expect(await f.h.ctx.issues.get(first.rows[0].paperclipTask.id, "c1")).toMatchObject({ title: "Changed upstream", status: "todo" });
  expect(get).toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(1);
});
it("moves a projectless task into a newly linked project without duplication", async () => {
  const f = fixture(); await f.read();
  f.h.seed({ projects: [{ id: "p1", companyId: "c1", name: "Project" }] as any, projectWorkspaces: [{ id: "w1", projectId: "p1", companyId: "c1", repoUrl: repo.url }] as any });
  vi.spyOn(f.github, "issues").mockResolvedValue({ issues: [f.github.issue(row, repo)], nextPage: null, repository: repo.fullName });
  const report = await f.service.sync("c1");
  expect(report?.warnings).toEqual([]);
  expect(await f.h.ctx.issues.list({ companyId: "c1" })).toMatchObject([{ projectId: "p1" }]);
});
it("reuses a task across issue detail and creation retries, and invalidates cached pages after writes", async () => {
  const f = fixture(); await f.read();
  const before = f.request.mock.calls.length;
  const detail = await f.read({ op: "issue", number: 1 });
  const created = await f.read({ op: "create-issue", title: row.title, requestId: "create-request-123" });
  const replay = await f.read({ op: "create-issue", title: row.title, requestId: "create-request-123" });
  expect(created.paperclipTask.id).toBe(detail.paperclipTask.id); expect(replay.paperclipTask.id).toBe(detail.paperclipTask.id);
  expect(f.request.mock.calls.filter(c => c[3] === "POST")).toHaveLength(1);
  await f.read(); expect(f.request.mock.calls.length).toBeGreaterThan(before + 1);
  expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(1);
});
it("shows deleted-task tombstones and retries association failures without losing issue data", async () => {
  const f = fixture(); const first = await f.read();
  const get = vi.spyOn(f.h.ctx.issues, "get").mockResolvedValue(null);
  const deleted = await f.read(); expect(deleted.rows[0].paperclipTaskError).toBe("Associated task was deleted.");
  expect(deleted.rows[0].paperclipTask).toBeUndefined(); expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(1);
  get.mockRestore(); expect((await f.read()).rows[0].paperclipTask.id).toBe(first.rows[0].paperclipTask.id);
  const g = fixture(), create = vi.spyOn(g.h.ctx.issues, "create"); create.mockRejectedValueOnce(new Error("Database unavailable"));
  expect((await g.read()).rows[0].paperclipTaskError).toBe("Database unavailable");
  expect((await g.read()).rows[0].paperclipTask.id).toBeTruthy();
});
it("isolates cached issue content and native mappings by company", async () => {
  const f = fixture(); const a = await f.read();
  const b = await f.read({}, { ...actor, companyId: "c2", actor: { ...actor.actor, companyId: "c2" } });
  expect(a.rows[0].paperclipTask.id).not.toBe(b.rows[0].paperclipTask.id);
  expect(f.catalog).toHaveBeenCalledTimes(2);
  expect(await f.h.ctx.issues.get(a.rows[0].paperclipTask.id, "c2")).toBeNull();
});

it("associates accessible Project issue items and preserves restricted items without inventing tasks", async () => {
  const f = fixture();
  f.catalog.mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [{ id: 33, login: "org", suspended: false, accountType: "Organization", permissions: { organization_projects: "read" } }], repositories: [repo], warnings: [], truncated: false });
  vi.spyOn(f.github, "graphql").mockImplementation(async (_token, query) => query.includes("items(") ? { node: { items: { nodes: [
    { id: "ITEM", content: { __typename: "Issue", fullDatabaseId: "3000000001", number: row.number, title: row.title, body: row.body, issueState: "OPEN", repository: { nameWithOwner: repo.fullName } } },
    { id: "RESTRICTED", content: null },
    { id: "INACCESSIBLE", content: { __typename: "Issue", fullDatabaseId: "3000000002", repository: { nameWithOwner: "elsewhere/private" } } },
  ], pageInfo: { hasNextPage: false } } } } : { organization: { projectV2: { id: "PROJECT", title: "Roadmap", number: 1 } } } as any);
  const result = await f.h.performAction("manage-project", { op: "items", owner: "org", projectNumber: 1 }, actor) as any;
  expect(result.rows[0].paperclipTask).toMatchObject({ status: "todo" });
  expect(result.rows[1].paperclipTask).toBeUndefined();
  expect(result.rows[2].paperclipTaskError).toMatch(/Grant this App/);
  expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(1);
});
