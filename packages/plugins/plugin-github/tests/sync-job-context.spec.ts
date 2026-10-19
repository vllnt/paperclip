import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { seedConnection } from "./connection.js";
import { GitHubClient } from "../src/github.js";
import type { GitHubIssue } from "../src/contracts.js";

// A sync runs only in the scheduled job. Anything else that asks for one (an event, "Sync now", saving the settings, a write
// through the management actions) is queued, and the job does the work on its next run. Work that a handler starts and leaves
// running keeps the identity of that handler's invocation: the host drops it when the handler returns (or 15 minutes after an
// event), and every later host call of the run is then denied. The job has no invocation, so its run cannot lose one.

const companyId = "c1";
const actor = { companyId, actor: { type: "user" as const, userId: "u1", companyId, agentId: null, runId: null } };
const permissions = { metadata: "read", issues: "write" };
const repo = { id: 22, name: "repo", fullName: "org/repo", ownerId: 1, url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true, issuesWrite: true, permissions };
const issue = (id: number): GitHubIssue => ({ id, number: id, title: `Issue ${id}`, body: "Description", state: "open", stateReason: null, labels: [], assignees: [], url: `${repo.url}/issues/${id}`, repository: repo.fullName, updatedAt: "2026-10-04T12:00:00Z" });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

async function fixture() {
  const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
  vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("fixture-pem");
  h.seed({ projects: [{ id: "p1", companyId, name: "One" }] as any, projectWorkspaces: [{ id: "w1", companyId, projectId: "p1", repoUrl: repo.url }] as any });
  const remote = new Map<number, GitHubIssue>([[1, issue(1)], [2, issue(2)]]);
  const client = new GitHubClient();
  vi.spyOn(client, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false });
  const list = vi.spyOn(client, "issues").mockImplementation(async () => ({ issues: [...remote.values()], nextPage: null, repository: repo.fullName }));
  vi.spyOn(client, "getIssue").mockImplementation(async (_id, _pem, _repo, number) => remote.get(number)!);
  vi.spyOn(client, "scopedToken").mockResolvedValue("token");
  const request = vi.spyOn(client, "request").mockResolvedValue({ data: { id: 55, node_id: "I", number: 7, title: "One", body: "", state: "open" }, next: false } as any);
  await seedConnection(h, companyId, "12");
  const service = register(h.ctx, client);
  const status = () => h.performAction<any>("sync-status", { companyId }, actor);
  return { h, service, list, request, status };
}

describe("a sync is queued by everything but the scheduled job", () => {
  it("does not start a sync when an issue event arrives", async () => {
    const f = await fixture();

    await f.h.emit("issue.updated", { id: "i1" }, { companyId, actorType: "user" } as any);
    await flush();

    expect(f.list).not.toHaveBeenCalled();
    expect((await f.status()).busy).toBe(false);
  });

  it("answers Sync now at once with a queued request, and the job runs it", async () => {
    const f = await fixture();

    const answer = await f.h.performAction<any>("sync-now", { companyId, refresh: true }, actor);
    await flush();

    expect(answer).toEqual({ queued: true, queuedAt: expect.any(String), busy: false, lastRunAt: null });
    expect(f.list).not.toHaveBeenCalled();
    expect(await f.status()).toMatchObject({ queued: true, queuedAt: answer.queuedAt, busy: false });

    await f.h.runJob("github-sync");

    expect(f.list).toHaveBeenCalledTimes(1);
    expect(await f.status()).toMatchObject({ queued: false, queuedAt: null, busy: false, report: { at: expect.any(String) } });
  });

  it("queues nothing for a Sync now that follows a report of the last minute, and says when it last ran", async () => {
    const f = await fixture();
    await f.h.runJob("github-sync");
    f.list.mockClear();

    const answer = await f.h.performAction<any>("sync-now", { companyId }, actor);

    expect(answer).toEqual({ queued: false, queuedAt: null, busy: false, lastRunAt: (await f.status()).report.at });
    expect(f.list).not.toHaveBeenCalled();
  });

  it("keeps a request that arrives during a run for the next run", async () => {
    const f = await fixture();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = f.list.getMockImplementation()!;
    f.list.mockImplementationOnce(async (...args) => { await gate; return first(...args); });
    const running = f.h.runJob("github-sync");
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));

    const answer = await f.h.performAction<any>("sync-now", { companyId, refresh: true }, actor);
    expect(answer).toMatchObject({ queued: true, busy: true });
    release();
    await running;

    expect(await f.status()).toMatchObject({ queued: true, busy: false });
    await f.h.runJob("github-sync");
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(await f.status()).toMatchObject({ queued: false });
  });

  it("queues the sync when the settings are saved, and for sync.trigger", async () => {
    const f = await fixture();

    await f.h.performAction("save-sync-settings", { companyId, settings: { enabled: true, rules: [] } }, actor);
    await flush();
    expect(f.list).not.toHaveBeenCalled();
    expect(await f.status()).toMatchObject({ queued: true });
    await f.h.runJob("github-sync");

    const trigger = await f.h.performAction<any>("sync.trigger", { companyId, refresh: true }, actor);
    await flush();
    expect(trigger).toEqual({ queued: true, queuedAt: expect.any(String), busy: false, lastRunAt: expect.any(String), companyId });
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it("queues the sync after a write through the management actions", async () => {
    const f = await fixture();

    await f.h.performAction("manage-repository", { op: "create-issue", repositoryId: 22, requestId: "request-1234", title: "One", body: "Text" }, actor);
    await flush();

    expect(f.request).toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(await f.status()).toMatchObject({ queued: true });
  });
});
