import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { seedConnection } from "./connection.js";
import { GitHubClient, GitHubError } from "../src/github.js";
import { matchingRule, mergeSnapshots, validateSettings } from "../src/sync.js";
import type { AutomationRule, GitHubIssue } from "../src/contracts.js";
const companyId = "c1";
const actor = { companyId, actor: { type: "user" as const, userId: "u1", companyId, agentId: null, runId: null } };
const repo = { id: 22, name: "repo", fullName: "org/repo", ownerId: 1, url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true, issuesWrite: true };
const issue = (id: number, patch: Partial<GitHubIssue> = {}): GitHubIssue => ({ id, number: id, title: `Issue ${id}`, body: "Description", state: "open", stateReason: null, labels: ["bug"], assignees: ["alex"], url: `${repo.url}/issues/${id}`, repository: repo.fullName, updatedAt: "2026-10-04T12:00:00Z", ...patch });
async function fixture() {
  const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
  vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("fixture-pem");
  h.seed({ projects: [{ id: "p1", companyId, name: "One" }, { id: "p2", companyId, name: "Two" }] as any,
    projectWorkspaces: [{ id: "w1", companyId, projectId: "p1", repoUrl: repo.url }, { id: "w2", companyId, projectId: "p2", repoUrl: repo.url }] as any,
    agents: [{ id: "a1", companyId, name: "Engineer", status: "idle" }, { id: "foreign", companyId: "c2", name: "Other", status: "idle" }] as any });
  const remote = new Map<number, GitHubIssue>([[1, issue(1)]]);
  const client = new GitHubClient();
  const catalog = vi.spyOn(client, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false });
  const list = vi.spyOn(client, "issues").mockImplementation(async () => ({ issues: [...remote.values()], nextPage: null, repository: repo.fullName }));
  const get = vi.spyOn(client, "getIssue").mockImplementation(async (_id, _pem, _repo, number) => { if (!remote.has(number)) throw new GitHubError(404); return remote.get(number)!; });
  const create = vi.spyOn(client, "createIssue").mockImplementation(async (_id, _pem, _repo, input) => { const next = issue(100 + remote.size, { title: input.title, body: input.body }); remote.set(next.number, next); return next; });
  const update = vi.spyOn(client, "updateIssue").mockImplementation(async (_id, _pem, _repo, number, input) => {
    const current = remote.get(number)!;
    const next = { ...current, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.state ? { state: input.state, stateReason: input.state_reason } : {}), updatedAt: "2026-10-04T12:01:00Z" };
    remote.set(number, next); return next;
  });
  await seedConnection(h, companyId, "12");
  const service = register(h.ctx, client);
  const native = () => h.ctx.issues.list({ companyId });
  return { h, client, service, remote, list, create, update, get, catalog, native };
}
const settingsKey = { scopeKind: "company" as const, scopeId: companyId, namespace: "sync", stateKey: "settings" };
const rule: AutomationRule = { id: "route-alex", name: "Alex to Engineer", enabled: true, if: { assignee: "alex", label: "bug", repository: repo.fullName }, then: { agentId: "a1", status: "todo", priority: "high", wake: true } };

describe("native GitHub task sync", () => {
  it("classifies pull request issue comments as PRs and check runs refresh the linked PR task", async () => {
    const f = await fixture();
    f.h.seed({ companies: [{ id: companyId, name: "Company", issuePrefix: "C", issueCounter: 1, status: "active" }] as any });
    const pull = issue(7, { title: "PR seven", url: `${repo.url}/pull/7` });
    const issueComment = { ...pull, pull_request: { url: `${repo.url}/pulls/7` } };
    const commentResult = await f.service.handleWebhook({ companyId, headers: { "x-github-delivery": "delivery-comment" }, requestId: "delivery-comment", parsedBody: { action: "created", repository: { id: repo.id }, issue: issueComment } });
expect(commentResult?.kind).toBe("pull");
    expect((await f.native()).every(task => task.originKind !== "plugin:vllnt.paperclip-github:issue")).toBe(true);
    f.get.mockResolvedValue(pull);
    const checkResult = await f.service.handleWebhook({ companyId, headers: { "x-github-delivery": "delivery-check" }, requestId: "delivery-check", parsedBody: { action: "completed", repository: { id: repo.id }, check_run: { check_suite: { pull_requests: [{ number: 7 }] } } } });
    expect(checkResult?.kind).toBe("pull");
    expect(checkResult?.taskId).toBeTruthy();
  });
  it("imports open issues as Todo and closed issues as Done/Cancelled once across projects and concurrent syncs", async () => {
    const f = await fixture();
    f.remote.set(2, issue(2, { state: "closed", stateReason: "completed", title: "Same title" }));
    f.remote.set(3, issue(3, { state: "closed", stateReason: "not_planned", title: "Same title" }));
    await Promise.all([f.service.sync(companyId), f.service.sync(companyId)]);
    await f.service.sync(companyId);
    expect(await f.native()).toMatchObject([{ status: "todo" }, { status: "done" }, { status: "cancelled" }]);
    expect(await f.native()).toHaveLength(3);
    expect((await f.native())[0]).toMatchObject({ projectId: "p1", description: "Description", originId: "1" });
    expect(f.update).not.toHaveBeenCalled();
  });
  it("walks all pages, including empty pages, and preserves other repositories after a partial failure", async () => {
    const f = await fixture();
    f.list.mockImplementation(async (_id, _pem, _repo, page) => ({ issues: page === 1 ? [] : [issue(2)], nextPage: page === 1 ? 2 : null, repository: repo.fullName }));
    await f.service.sync(companyId);
    expect(await f.native()).toHaveLength(1);
    expect(f.list).toHaveBeenCalledTimes(2);
    f.catalog.mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: ["org/other: denied"], truncated: false });
    await f.h.performAction("catalog", { refresh: true }, actor);
    expect((await f.service.sync(companyId))?.warnings).toContain("org/other: denied");
    expect(await f.native()).toHaveLength(1);
  });
  it("syncs edits in both directions, preserves in-progress statuses, and does not echo writes", async () => {
    const f = await fixture(); await f.service.sync(companyId); const [native] = await f.native();
    await f.h.ctx.issues.update(native.id, { title: "Local title", status: "in_progress" }, companyId);
    f.remote.set(1, issue(1, { body: "Remote body" }));
    await f.service.sync(companyId);
    expect((await f.native())[0]).toMatchObject({ title: "Local title", description: "Remote body", status: "in_progress" });
    expect(f.remote.get(1)).toMatchObject({ title: "Local title", body: "Remote body", state: "open" });
    await f.service.sync(companyId); expect(f.update).toHaveBeenCalledTimes(1);
    await f.h.ctx.issues.update(native.id, { status: "cancelled" }, companyId); await f.service.sync(companyId);
    expect(f.remote.get(1)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    f.remote.set(1, { ...f.remote.get(1)!, state: "open", stateReason: "reopened" }); await f.service.sync(companyId);
    expect((await f.native())[0].status).toBe("todo");
  });
  it("reports competing edits and resolves the chosen version explicitly", async () => {
    const f = await fixture(); await f.service.sync(companyId); const [native] = await f.native();
    await f.h.ctx.issues.update(native.id, { title: "Local" }, companyId); f.remote.set(1, issue(1, { title: "Remote" }));
    expect((await f.service.sync(companyId))?.warnings[0]).toContain("Conflicting title");
    expect((await f.native())[0].title).toBe("Local"); expect(f.update).not.toHaveBeenCalled();
    await f.h.performAction("resolve-task-sync", { issueId: native.id, keep: "github" }, actor);
    expect((await f.native())[0].title).toBe("Remote");
  });
  it("keeps pending native edits when GitHub denies write access and recovers after access returns", async () => {
    const f = await fixture(); await f.service.sync(companyId); const [native] = await f.native();
    await f.h.ctx.issues.update(native.id, { title: "Local" }, companyId);
    f.update.mockRejectedValueOnce(new GitHubError(403));
    expect((await f.service.sync(companyId))?.warnings[0]).toContain("denied");
    expect((await f.native())[0].title).toBe("Local");
    await f.service.sync(companyId); expect(f.remote.get(1)?.title).toBe("Local");
  });
  it("defers incoming changes while an agent holds the task", async () => {
    const f = await fixture(); await f.service.sync(companyId); const [native] = await f.native();
    f.h.seed({ issues: [{ ...native, checkoutRunId: "run" }] }); f.remote.set(1, issue(1, { title: "Later" }));
    expect((await f.service.sync(companyId))?.warnings[0]).toContain("agent is working");
    expect((await f.native())[0].title).toBe("Issue 1");
  });
  it("recovers the native creation receipt after a state-write crash", async () => {
    const f = await fixture(), save = f.h.ctx.state.set;
    const failing = vi.spyOn(f.h.ctx.state, "set").mockImplementation(async (key, value) => { if (key.stateKey === "link:1") throw new Error("Simulated storage failure"); return save(key, value); });
    await f.service.sync(companyId); expect(await f.native()).toHaveLength(1);
    failing.mockRestore(); await f.service.sync(companyId); expect(await f.native()).toHaveLength(1);
  });
  it("stops syncing a task moved to a project without this repository", async () => {
    const f = await fixture(); await f.service.sync(companyId); const [native] = await f.native();
    f.h.seed({ issues: [{ ...native, projectId: null, title: "Private local edit" }] });
    const report = await f.service.sync(companyId);
    expect(f.update).not.toHaveBeenCalled();
    expect(report?.warnings.join(" ")).toContain("no longer linked");
  });
  it("rechecks a changed issue before writing when the repository listing is stale", async () => {
    const f = await fixture(); await f.service.sync(companyId); const [native] = await f.native();
    await f.h.ctx.issues.update(native.id, { title: "Local" }, companyId);
    f.remote.set(1, issue(1, { title: "Remote changed after listing" }));
    f.list.mockResolvedValue({ issues: [issue(1)], nextPage: null, repository: repo.fullName });
    const report = await f.service.sync(companyId);
    expect(f.update).not.toHaveBeenCalled();
    expect(report?.warnings.join(" ")).toContain("Conflicting title");
  });
  it("pauses background work and never reads a foreign task before resolving credentials", async () => {
    const f = await fixture(); await f.h.ctx.state.set(settingsKey, { enabled: false, rules: [] });
    expect(await f.service.sync(companyId)).toBeNull(); expect(f.catalog).not.toHaveBeenCalled();
    const foreign = await f.h.ctx.issues.create({ companyId: "c2", title: "Foreign", projectId: "p1" });
    await expect(f.h.performAction("publish-task", { issueId: foreign.id, destinationId: "22" }, actor)).rejects.toThrow();
    await expect(f.h.performAction("sync-now", {}, { companyId, actor: { type: "agent", companyId } })).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe("publication and automation", () => {
  it("creates and links one GitHub issue, retaining a hidden receipt through subsequent edits", async () => {
    const f = await fixture(); const native = await f.h.ctx.issues.create({ companyId, projectId: "p1", title: "Created here" });
    await f.h.performAction("publish-task", { issueId: native.id, destinationId: "22" }, actor);
    await f.h.performAction("publish-task", { issueId: native.id, destinationId: "22" }, actor);
    await f.service.sync(companyId); expect(f.create).toHaveBeenCalledTimes(1); expect(await f.native()).toHaveLength(2);
    await f.h.ctx.issues.update(native.id, { description: "Edited here" }, companyId); await f.service.sync(companyId);
    const remote = [...f.remote.values()].find(i => i.title === "Created here")!;
    expect(remote.body).toContain("Edited here\n<!-- paperclip:c1:");
    expect((await f.native()).find(i => i.id === native.id)?.description).not.toContain("<!--");
  });
  it("recovers a successful GitHub POST whose response was lost without posting twice", async () => {
    const f = await fixture(); const native = await f.h.ctx.issues.create({ companyId, projectId: "p1", title: "Created here" });
    f.create.mockImplementationOnce(async (_id, _pem, _repo, input) => { f.remote.set(50, issue(50, input)); throw new Error("Response lost"); });
    const result = await f.h.performAction<any>("publish-task", { issueId: native.id, destinationId: "22" }, actor);
    expect(result.warning).toContain("Response lost");
    await f.service.sync(companyId); expect(f.create).toHaveBeenCalledTimes(1); expect(await f.native()).toHaveLength(2);
    expect((await f.h.ctx.issues.get(native.id, companyId))?.originId).toBe("50");
  });
  it("does not repost when a creation result is unknown, and retries definitive denials safely", async () => {
    const f = await fixture(); const native = await f.h.ctx.issues.create({ companyId, projectId: "p1", title: "Unknown" });
    f.create.mockRejectedValueOnce(new GitHubError(403)); await f.h.performAction("publish-task", { issueId: native.id, destinationId: "22" }, actor);
    f.create.mockRejectedValueOnce(new Error("Timeout")); await f.service.sync(companyId); await f.service.sync(companyId);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect((await f.service.sync(companyId))?.warnings.join(" ")).toContain("unconfirmed");
  });
  it("uses first matching rule, wakes once, and preserves manual routing until the match changes", async () => {
    const f = await fixture(); const wake = vi.spyOn(f.h.ctx.issues, "requestWakeup").mockResolvedValue({} as any);
    await f.h.ctx.state.set(settingsKey, { enabled: true, rules: [rule, { ...rule, id: "second", then: { status: "backlog" } }] });
    await f.service.sync(companyId); const [native] = await f.native();
    expect(native).toMatchObject({ assigneeAgentId: "a1", assigneeUserId: null, status: "todo", priority: "high" }); expect(wake).toHaveBeenCalledTimes(1);
    await f.h.ctx.issues.update(native.id, { status: "blocked" }, companyId); await f.service.sync(companyId);
    expect((await f.native())[0].status).toBe("blocked"); expect(wake).toHaveBeenCalledTimes(1);
    f.remote.set(1, issue(1, { assignees: [] })); await f.service.sync(companyId);
    f.remote.set(1, issue(1, { updatedAt: "2026-10-04T12:02:00Z" })); await f.service.sync(companyId);
    expect((await f.native())[0].status).toBe("todo"); expect(wake).toHaveBeenCalledTimes(2);
  });
  it("retries failed wakeups with the same idempotency key and rejects foreign agents", async () => {
    const f = await fixture(); const wake = vi.spyOn(f.h.ctx.issues, "requestWakeup").mockRejectedValueOnce(new Error("Host unavailable")).mockResolvedValue({} as any);
    await f.h.ctx.state.set(settingsKey, { enabled: true, rules: [rule] });
    await f.service.sync(companyId); await f.service.sync(companyId);
    expect(wake).toHaveBeenCalledTimes(2); expect(wake.mock.calls[0][2]?.idempotencyKey).toBe(wake.mock.calls[1][2]?.idempotencyKey);
    await expect(f.h.performAction("save-sync-settings", { settings: { enabled: true, rules: [{ ...rule, then: { agentId: "foreign" } }] } }, actor)).rejects.toThrow("company");
  });
  it("routes closed issues without reopening them or waking agents", async () => {
    const f = await fixture(); const wake = vi.spyOn(f.h.ctx.issues, "requestWakeup");
    f.remote.set(1, issue(1, { state: "closed", stateReason: "completed" }));
    await f.h.ctx.state.set(settingsKey, { enabled: true, rules: [rule] });
    await f.service.sync(companyId);
    expect((await f.native())[0]).toMatchObject({ status: "done", assigneeAgentId: "a1", priority: "high" });
    expect(wake).not.toHaveBeenCalled();
  });
  it.each(["closed", "unmatched", "reassigned"])("cancels a failed wake when the task becomes %s", async (change) => {
    const f = await fixture(); const wake = vi.spyOn(f.h.ctx.issues, "requestWakeup").mockRejectedValueOnce(new Error("Host unavailable")).mockResolvedValue({} as any);
    await f.h.ctx.state.set(settingsKey, { enabled: true, rules: [rule] });
    await f.service.sync(companyId); const [native] = await f.native();
    if (change === "closed") f.remote.set(1, issue(1, { state: "closed", stateReason: "completed" }));
    if (change === "unmatched") f.remote.set(1, issue(1, { assignees: [] }));
    if (change === "reassigned") await f.h.ctx.issues.update(native.id, { assigneeAgentId: null, assigneeUserId: "u1" }, companyId);
    await f.service.sync(companyId); await f.service.sync(companyId);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await f.h.ctx.state.get({ ...settingsKey, stateKey: "link:1" })).not.toHaveProperty("wakePending");
  });
  it("validates all conditions and rule actions rather than evaluating arbitrary expressions", () => {
    expect(matchingRule([rule], issue(1, { assignees: ["ALEX"], labels: ["BUG"] }))).toEqual(rule);
    expect(matchingRule([rule], issue(1, { labels: [] }))).toBeUndefined();
    expect(() => validateSettings({ enabled: true, rules: [{ ...rule, if: {} }] })).toThrow("IF");
    expect(() => validateSettings({ enabled: true, rules: [{ ...rule, then: { wake: true } }] })).toThrow("agent");
    expect(mergeSnapshots({ title: "A", body: "B", state: "open" }, { title: "C", body: "B", state: "open" }, { title: "A", body: "D", state: "open" })).toEqual({ toLocal: { body: "D" }, toRemote: { title: "C" }, conflicts: [] });
  });
});
