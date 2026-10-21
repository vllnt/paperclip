import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { seedConnection } from "./connection.js";
import { GitHubClient, GitHubError } from "../src/github.js";
import type { GitHubIssue } from "../src/contracts.js";
import { JOB_BUDGET_MS } from "../src/sync-window.js";

// The host gives one run of the job 300 s for every company together. The job starts no company after JOB_BUDGET_MS, and the
// next run starts with the companies that it skipped.

const repo = { id: 22, name: "repo", fullName: "org/repo", ownerId: 1, url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true, issuesWrite: true };
const issue = (id: number): GitHubIssue => ({ id, number: id, title: `Issue ${id}`, body: "Description", state: "open", stateReason: null, labels: [], assignees: [], url: `${repo.url}/issues/${id}`, repository: repo.fullName, updatedAt: "2026-10-04T12:00:00Z" });
const apps: Record<string, string> = { c1: "12", c2: "13" };

async function fixture() {
  const h = createTestHarness({ manifest });
  vi.spyOn(h.ctx.config, "get").mockImplementation(async company => ({ appId: apps[company ?? ""], privateKey: { type: "secret_ref", secretId: "key" } }));
  vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("fixture-pem");
  h.seed({ projects: Object.keys(apps).map(id => ({ id: `p-${id}`, companyId: id, name: id })) as any,
    projectWorkspaces: Object.keys(apps).map(id => ({ id: `w-${id}`, companyId: id, projectId: `p-${id}`, repoUrl: repo.url })) as any });
  const client = new GitHubClient();
  const catalog = vi.spyOn(client, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false });
  const real = Date.now.bind(Date); let skew = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
  const advance = (milliseconds: number) => { skew += milliseconds; };
  const list = vi.spyOn(client, "issues").mockImplementation(async () => { advance(JOB_BUDGET_MS + 50_000); return { issues: [issue(1)], nextPage: null, repository: repo.fullName, cursor: issue(1).updatedAt }; });
  const get = vi.spyOn(client, "getIssue").mockImplementation(async (_id, _pem, _repo, number) => issue(number));
  for (const [companyId, appId] of Object.entries(apps)) await seedConnection(h, companyId, appId);
  register(h.ctx, client);
  const syncedApps = () => catalog.mock.calls.map(call => call[0]);
  return { h, list, get, advance, syncedApps };
}

afterEach(() => vi.restoreAllMocks());

describe("the scheduled job's time budget", () => {
  it("starts no company after the budget, and the next run starts with the one it skipped", async () => {
    const f = await fixture();
    await f.h.runJob("github-sync");
    expect(f.syncedApps()).toEqual(["12"]);
    expect(f.h.logs.some(entry => entry.level === "warn" && entry.message.includes("time budget"))).toBe(true);
    await f.h.runJob("github-sync");
    expect(f.syncedApps()).toEqual(["12", "13"]);
    expect(f.list).toHaveBeenCalledTimes(2);
  });
  it("leaves a company that starts with little of the job's time enough of it for GitHub's changes, whatever its queue holds", async () => {
    const f = await fixture();
    // The first company's run takes all but 30 s of the job's budget.
    f.list.mockImplementation(async appId => { if (appId === "12") f.advance(JOB_BUDGET_MS - 30_000); return { issues: [issue(1)], nextPage: null, repository: repo.fullName, cursor: issue(1).updatedAt }; });
    // The second company asked for 30 issues to be looked at again, and each look fails after 3 s.
    await f.h.ctx.state.set({ scopeKind: "company", scopeId: "c2", namespace: "sync", stateKey: "queue" },
      Object.fromEntries(Array.from({ length: 30 }, (_, index) => [String(100 + index), { repositoryId: repo.id, number: 100 + index, at: 0 }])));
    f.get.mockImplementation(async () => { f.advance(3_000); throw new GitHubError(502); });
    await f.h.runJob("github-sync");
    expect(f.list.mock.calls.map(call => call[0])).toEqual(["12", "13"]);
    expect(f.get.mock.calls.length).toBeLessThanOrEqual(4);
    expect(await f.h.ctx.issues.list({ companyId: "c2" })).toMatchObject([{ originId: "1" }]);
  });
});
