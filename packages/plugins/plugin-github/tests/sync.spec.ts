import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { seedConnection } from "./connection.js";
import { GitHubClient, GitHubError } from "../src/github.js";
import { matchingRule, mergeSnapshots, validateSettings } from "../src/sync.js";
import { QUEUE_LIMIT, QUEUE_PER_REPOSITORY, QUEUE_RETRY_MS, resumeFrom } from "../src/sync-window.js";
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
  /** GitHub's listing: only what changed since `since`, oldest change first, in pages. */
  const list = vi.spyOn(client, "issues").mockImplementation(async (_id, _pem, _repo, page, _state, options = {}) => {
    const since = options.since ? Date.parse(options.since) : 0, size = options.perPage ?? 50;
    const rows = [...remote.values()].filter(row => Date.parse(row.updatedAt) >= since).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number);
    if (options.direction !== "asc") rows.reverse();
    const issues = rows.slice((page - 1) * size, page * size);
    return { issues, nextPage: page * size < rows.length ? page + 1 : null, repository: repo.fullName, cursor: issues.map(row => row.updatedAt).sort().at(-1) ?? null };
  });
  const get = vi.spyOn(client, "getIssue").mockImplementation(async (_id, _pem, _repo, number) => { if (!remote.has(number)) throw new GitHubError(404); return remote.get(number)!; });
  const create = vi.spyOn(client, "createIssue").mockImplementation(async (_id, _pem, _repo, input) => { const next = issue(100 + remote.size, { title: input.title, body: input.body }); remote.set(next.number, next); return next; });
  const update = vi.spyOn(client, "updateIssue").mockImplementation(async (_id, _pem, _repo, number, input) => {
    const current = remote.get(number)!;
    const next = { ...current, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.state ? { state: input.state, stateReason: input.state_reason } : {}), updatedAt: new Date(Math.max(...[...remote.values()].map(row => Date.parse(row.updatedAt))) + 60_000).toISOString() };
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

describe("incremental GitHub task sync", () => {
  const minute = (n: number) => new Date(Date.parse("2026-10-04T12:00:00Z") + n * 60_000).toISOString();
  const edited = (id: number, at: number, patch: Partial<GitHubIssue> = {}) => issue(id, { ...patch, updatedAt: minute(at) });
  const queueKey = (scopeId = companyId) => ({ scopeKind: "company" as const, scopeId, namespace: "sync", stateKey: "queue" });
  const pendingKey = { scopeKind: "company" as const, scopeId: companyId, namespace: "sync", stateKey: "pending" };
  /** Three issues that GitHub last changed at minutes 1 to 3, already imported. */
  async function synced() {
    const f = await fixture();
    f.remote.clear();
    for (const number of [1, 2, 3]) f.remote.set(number, edited(number, number));
    await f.service.sync(companyId);
    const natives = await f.native();
    const task = (number: number) => natives.find(item => item.originId === String(number))!;
    f.list.mockClear(); f.get.mockClear();
    return { ...f, task };
  }
  /** An edit made here: the task changes, and the host announces it. */
  async function editHere(f: Awaited<ReturnType<typeof synced>>, number: number, title: string) {
    const task = f.task(number);
    await f.h.ctx.issues.update(task.id, { title }, companyId);
    await f.h.emit("issue.updated", { id: task.id }, { companyId, actorType: "user", entityId: task.id });
  }
  /** Moves the clock the sync reads, as time that passed between two runs. */
  function skewClock() {
    const real = Date.now.bind(Date); let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    return (milliseconds: number) => { skew += milliseconds; };
  }
  afterEach(() => vi.restoreAllMocks());

  it("lists only what changed since the last run and reads no other issue", async () => {
    const f = await synced();
    const quiet = await f.service.sync(companyId);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.list.mock.calls[0][5]).toEqual({ direction: "asc", perPage: 100, since: resumeFrom(minute(3)) });
    expect(quiet).toMatchObject({ imported: 0, updated: 0, checked: 1, partial: false });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    f.remote.set(2, edited(2, 5, { title: "Changed on GitHub" }));
    expect(await f.service.sync(companyId)).toMatchObject({ updated: 1, checked: 2 });
    expect((await f.native()).map(item => item.title).sort()).toEqual(["Changed on GitHub", "Issue 1", "Issue 3"]);
  });
  it("ends a run at its time budget with its place saved, and the next run goes on from there", async () => {
    const f = await fixture();
    f.remote.clear();
    for (let number = 1; number <= 250; number++) f.remote.set(number, edited(number, number));
    const advance = skewClock(), create = f.h.ctx.issues.create.bind(f.h.ctx.issues);
    let created = 0;
    vi.spyOn(f.h.ctx.issues, "create").mockImplementation(async input => { const made = await create(input); if (++created % 100 === 0) advance(130_000); return made; });
    expect(await f.service.sync(companyId)).toMatchObject({ imported: 100, partial: true });
    expect(await f.native()).toHaveLength(100);
    expect(await f.service.sync(companyId)).toMatchObject({ imported: 100, partial: true });
    expect(f.list.mock.calls[1][5]?.since).toBe(resumeFrom(minute(100)));
    expect(await f.native()).toHaveLength(200);
    expect(await f.service.sync(companyId)).toMatchObject({ imported: 50, partial: false });
    expect(await f.native()).toHaveLength(250);
    expect(new Set((await f.native()).map(item => item.originId)).size).toBe(250);
  });
  /** Moves the clock past the run's budget after the given number of imports. */
  function budgetAfter(f: Awaited<ReturnType<typeof fixture>>, imports: (count: number) => boolean) {
    const advance = skewClock(), create = f.h.ctx.issues.create.bind(f.h.ctx.issues);
    let created = 0;
    vi.spyOn(f.h.ctx.issues, "create").mockImplementation(async input => { const made = await create(input); if (imports(++created)) advance(130_000); return made; });
  }
  it("saves the place of a run that ends mid-page at the last issue it finished, so the next run does not redo the page", async () => {
    const f = await fixture();
    f.remote.clear();
    for (let number = 1; number <= 150; number++) f.remote.set(number, edited(number, number));
    budgetAfter(f, count => count === 50);
    expect(await f.service.sync(companyId)).toMatchObject({ imported: 50, partial: true });
    expect(await f.service.sync(companyId)).toMatchObject({ imported: 100, checked: 101, partial: false });
    expect(f.list.mock.calls[1][5]?.since).toBe(resumeFrom(minute(50)));
    expect(new Set((await f.native()).map(item => item.originId)).size).toBe(150);
  });
  it("posts a ready publication while the repository's first full pass still takes several runs", async () => {
    const f = await fixture();
    f.remote.clear();
    for (let number = 1; number <= 250; number++) f.remote.set(number, edited(number, number));
    const local = await f.h.ctx.issues.create({ companyId, title: "Write the docs", projectId: "p1" });
    await f.h.ctx.state.set(pendingKey, { [local.id]: { issueId: local.id, repositoryId: repo.id, phase: "ready", title: local.title, body: "" } });
    budgetAfter(f, count => count % 100 === 0);
    expect(await f.service.sync(companyId)).toMatchObject({ partial: true });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(await f.h.ctx.state.get(pendingKey)).toEqual({});
    expect(await f.service.sync(companyId)).toMatchObject({ partial: true });
    expect(await f.service.sync(companyId)).toMatchObject({ partial: false });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(await f.native()).toHaveLength(251);
  });
  it("pushes an edit made here that the host announced, without GitHub listing the issue again", async () => {
    const f = await synced();
    await editHere(f, 1, "Local title");
    expect(await f.service.sync(companyId)).toMatchObject({ updated: 1, checked: 3 });
    expect(f.get.mock.calls.every(call => call[3] === 1)).toBe(true);
    expect(f.remote.get(1)?.title).toBe("Local title");
    await f.service.sync(companyId);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(await f.h.ctx.state.get(queueKey())).toEqual({});
  });
  it("finds an edit that no event announced in the next full pass", async () => {
    const f = await synced();
    await f.h.ctx.issues.update(f.task(1).id, { title: "Local title" }, companyId);
    await f.service.sync(companyId);
    expect(f.update).not.toHaveBeenCalled();
    skewClock()(6 * 3_600_000 + 60_000);
    await f.service.sync(companyId);
    expect(f.list.mock.calls.at(-1)?.[5]?.since).toBeUndefined();
    expect(f.remote.get(1)?.title).toBe("Local title");
  });
  it("retries an issue whose sync failed a minute later, though GitHub lists nothing new for it", async () => {
    const f = await synced();
    await editHere(f, 1, "Local title");
    f.update.mockRejectedValueOnce(new GitHubError(403));
    expect((await f.service.sync(companyId))?.warnings.join(" ")).toContain("denied");
    expect(f.remote.get(1)?.title).toBe("Issue 1");
    skewClock()(QUEUE_RETRY_MS);
    await f.service.sync(companyId);
    expect(f.remote.get(1)?.title).toBe("Local title");
  });
  it("looks at an issue that keeps failing later each time, and leaves it to the full pass after a few failures", async () => {
    const f = await synced();
    await editHere(f, 1, "Local title");
    f.update.mockRejectedValue(new GitHubError(403));
    const advance = skewClock(), looks: number[] = [];
    for (let minute = 0; minute < 160; minute++) {
      f.get.mockClear();
      await f.service.sync(companyId);
      if (f.get.mock.calls.length) looks.push(minute);
      advance(60_000);
    }
    expect(looks).toEqual([0, 1, 3, 7, 15, 31, 61, 91, 121, 151]);
    expect(await f.h.ctx.state.get(queueKey())).toEqual({});
  });
  it("counts a failure only when its look was due, also for the newest issue that every run lists again", async () => {
    const f = await synced();
    await editHere(f, 3, "Local title");
    f.update.mockRejectedValue(new GitHubError(403));
    const advance = skewClock();
    for (let minute = 0; minute < 10; minute++) {
      await f.service.sync(companyId);
      advance(60_000);
    }
    // The walk listed issue 3 on each of the 10 runs; its looks were due in runs 0, 1, 3 and 7.
    expect(f.list).toHaveBeenCalledTimes(10);
    expect((await f.h.ctx.state.get(queueKey()) as Record<string, { attempts?: number }>)["3"]?.attempts).toBe(4);
  });
  it("gives the issues that keep failing only a share of the run, so GitHub's changes still sync", async () => {
    const f = await fixture();
    f.remote.clear();
    for (let number = 1; number <= 60; number++) f.remote.set(number, edited(number, number));
    await f.service.sync(companyId);
    // Every task is marked done here, and the App may not write issues: each push fails, after 3 s per read.
    for (const task of await f.native()) {
      await f.h.ctx.issues.update(task.id, { status: "done" }, companyId);
      await f.h.emit("issue.updated", { id: task.id }, { companyId, actorType: "user", entityId: task.id });
    }
    f.update.mockRejectedValue(new GitHubError(403));
    const advance = skewClock();
    f.get.mockImplementation(async (_id, _pem, _repo, number) => { advance(3_000); return f.remote.get(number)!; });
    f.remote.set(61, edited(61, 70, { title: "New on GitHub" }));
    const read = () => new Set(f.get.mock.calls.map(call => call[3]));
    f.get.mockClear();
    expect(await f.service.sync(companyId)).toMatchObject({ imported: 1, partial: false });
    expect((await f.native()).find(task => task.originId === "61")?.title).toBe("New on GitHub");
    const first = read();
    expect(first.size).toBeLessThanOrEqual(QUEUE_PER_REPOSITORY);
    f.get.mockClear();
    await f.service.sync(companyId);
    expect([...read()].filter(number => first.has(number))).toEqual([]);
  });
  it("pushes an edit of a later repository in the same run, although an earlier repository's walk took a long time", async () => {
    const f = await fixture();
    // Repository "org/alpha" sorts first, and its walk takes 40 s once both repositories have had their first full pass.
    const alpha = { ...repo, id: 21, name: "alpha", fullName: "org/alpha", url: "https://github.com/org/alpha" };
    f.catalog.mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [alpha, repo], warnings: [], truncated: false });
    f.h.seed({ projectWorkspaces: [{ id: "w3", companyId, projectId: "p2", repoUrl: alpha.url }] as any });
    f.remote.clear();
    for (const number of [1, 2, 3]) f.remote.set(number, edited(number, number));
    const advance = skewClock(), listing = f.list.getMockImplementation()!;
    let slow = false;
    f.list.mockImplementation(async (...args) => {
      if (args[2].id !== alpha.id) return listing(...args);
      if (slow) advance(40_000);
      return { issues: [], nextPage: null, repository: alpha.fullName, cursor: null };
    });
    await f.service.sync(companyId);
    const task = (await f.native()).find(item => item.originId === "1")!;
    await f.h.ctx.issues.update(task.id, { title: "Local title" }, companyId);
    await f.h.emit("issue.updated", { id: task.id }, { companyId, actorType: "user", entityId: task.id });
    slow = true;
    expect(await f.service.sync(companyId)).toMatchObject({ partial: false });
    expect(f.remote.get(1)?.title).toBe("Local title");
  });
  it("drops the asks for issues of a repository that is no longer linked, so a full queue takes new edits again", async () => {
    const f = await synced();
    await f.h.ctx.state.set(queueKey(), Object.fromEntries(Array.from({ length: QUEUE_LIMIT }, (_, index) => [String(1000 + index), { repositoryId: 99, number: index + 1, at: 0 }])));
    await f.service.sync(companyId);
    expect(await f.h.ctx.state.get(queueKey())).toEqual({});
    // A repository that one catalog read missed keeps a recent ask.
    await f.h.ctx.state.set(queueKey(), { "2000": { repositoryId: 99, number: 1, at: Date.now() } });
    await f.service.sync(companyId);
    expect(Object.keys(await f.h.ctx.state.get(queueKey()) as object)).toEqual(["2000"]);
    await f.h.ctx.state.set(queueKey(), {});
    await editHere(f, 2, "Local title");
    await f.service.sync(companyId);
    expect(f.remote.get(2)?.title).toBe("Local title");
  });
  it("drops the ask for an issue that GitHub no longer has", async () => {
    const f = await synced();
    await editHere(f, 1, "Local title");
    f.remote.delete(1);
    await f.service.sync(companyId);
    expect(await f.h.ctx.state.get(queueKey())).toEqual({});
    expect(f.update).not.toHaveBeenCalled();
  });
  it("queues nothing for a task that GitHub does not know, the plugin's own write, or another company's task", async () => {
    const f = await synced();
    const local = await f.h.ctx.issues.create({ companyId, title: "Local only", projectId: "p1" });
    await f.h.emit("issue.updated", {}, { companyId, actorType: "user", entityId: local.id });
    await f.h.emit("issue.updated", {}, { companyId, actorType: "plugin", entityId: f.task(1).id });
    await f.h.emit("issue.updated", {}, { companyId, actorType: "user" });
    await f.h.emit("issue.updated", {}, { companyId: "c2", actorType: "user", entityId: f.task(1).id });
    expect(await f.h.ctx.state.get(queueKey())).toBeNull();
    expect(await f.h.ctx.state.get(queueKey("c2"))).toBeNull();
    await f.service.sync(companyId);
    expect(f.get).not.toHaveBeenCalled();
  });
  it("reads every issue again after the settings are saved, so a new rule reaches all of them", async () => {
    const f = await synced();
    f.h.seed({ agents: [{ id: "a1", companyId, name: "Engineer", status: "idle" }] as any });
    // The save comes after the last pass started; without this, a fast machine makes both happen in the same millisecond.
    await new Promise(resolve => setTimeout(resolve, 5));
    await f.h.performAction("save-sync-settings", { settings: { enabled: true, rules: [{ ...rule, then: { ...rule.then, wake: false } }] } }, actor);
    await f.service.sync(companyId);
    expect(f.list.mock.calls.at(-1)?.[5]?.since).toBeUndefined();
    expect((await f.native()).map(item => item.assigneeAgentId)).toEqual(["a1", "a1", "a1"]);
  });
  it("reports how long the run took and how many issues it looked at", async () => {
    const f = await synced();
    const report = await f.service.sync(companyId);
    expect(report).toMatchObject({ checked: 1, partial: false, durationMs: expect.any(Number) });
    expect(await f.h.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: "report" })).toMatchObject({ checked: 1, durationMs: expect.any(Number) });
  });
});
