import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { seedConnection } from "./connection.js";
import { GitHubClient } from "../src/github.js";
import type { GitHubIssue } from "../src/contracts.js";

// Diagnostic spec for the production failure "the scheduled sync never finishes, then thousands of state.get calls are denied".
// The host denies a worker's call when the invocation that the call belongs to is gone ("missing, expired, or unknown invocation
// scope"). A sync that is started inside an event handler keeps that invocation's id for the 15 minutes of its TTL, and loses it
// in the middle of a run. These tests simulate that loss with the real error (JsonRpcCallError, code INVOCATION_SCOPE_DENIED).

const companyId = "c1";
const repo = { id: 22, name: "repo", fullName: "org/repo", ownerId: 1, url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true, issuesWrite: true };
const issue = (id: number): GitHubIssue => ({ id, number: id, title: `Issue ${id}`, body: "Description", state: "open", stateReason: null, labels: [], assignees: [], url: `${repo.url}/issues/${id}`, repository: repo.fullName, updatedAt: "2026-10-04T12:00:00Z" });
const SCOPE_LOST = () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED, message: "not allowed to perform state.get: the worker referenced a missing, expired, or unknown invocation scope" });
const ISSUES = 300;

async function fixture() {
  const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
  vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("fixture-pem");
  h.seed({ projects: [{ id: "p1", companyId, name: "One" }] as any, projectWorkspaces: [{ id: "w1", companyId, projectId: "p1", repoUrl: repo.url }] as any });
  const remote = new Map<number, GitHubIssue>(Array.from({ length: ISSUES }, (_, at) => [at + 1, issue(at + 1)]));
  const client = new GitHubClient();
  vi.spyOn(client, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false });
  vi.spyOn(client, "issues").mockImplementation(async () => ({ issues: [...remote.values()], nextPage: null, repository: repo.fullName }));
  vi.spyOn(client, "getIssue").mockImplementation(async (_id, _pem, _repo, number) => remote.get(number)!);
  await seedConnection(h, companyId, "12");
  const service = register(h.ctx, client);
  return { h, service };
}

/** The host calls that a sync makes, by kind, from now on. */
function countHostCalls(h: Awaited<ReturnType<typeof fixture>>["h"]) {
  const calls = { stateGet: 0, stateSet: 0, linkSet: 0, issuesGet: 0 };
  const get = h.ctx.state.get.bind(h.ctx.state), set = h.ctx.state.set.bind(h.ctx.state), issuesGet = h.ctx.issues.get.bind(h.ctx.issues);
  vi.spyOn(h.ctx.state, "get").mockImplementation(async key => { calls.stateGet++; return get(key); });
  vi.spyOn(h.ctx.state, "set").mockImplementation(async (key, value) => { calls.stateSet++; if (key.stateKey.startsWith("link:")) calls.linkSet++; return set(key, value); });
  vi.spyOn(h.ctx.issues, "get").mockImplementation(async (...args: Parameters<typeof issuesGet>) => { calls.issuesGet++; return issuesGet(...args); });
  return calls;
}

describe("the cost of a sync run over issues that did not change", () => {
  it("writes nothing for an unchanged issue (today: two link writes per issue per run)", async () => {
    const f = await fixture();
    await f.service.sync(companyId); // imports every issue
    const calls = countHostCalls(f.h);

    await f.service.sync(companyId); // nothing changed on either side

    // Printed so that the cost per issue is visible in the test output.
    expect(calls.linkSet).toBe(0);
  }, 60_000);
});

describe("a sync run whose host calls start to be denied (the invocation scope is gone)", () => {
  it("stops at the first denial instead of calling the host once per remaining issue", async () => {
    const f = await fixture();
    await f.service.sync(companyId); // imports every issue
    let denied = false, afterDenial = 0, writesAfterDenial = 0, linkReads = 0;
    const get = f.h.ctx.state.get.bind(f.h.ctx.state);
    vi.spyOn(f.h.ctx.state, "get").mockImplementation(async key => {
      if (denied) { afterDenial++; throw SCOPE_LOST(); }
      if (key.stateKey.startsWith("link:") && ++linkReads === 20) denied = true; // the scope is lost in the middle of the loop over the issues
      return get(key);
    });
    vi.spyOn(f.h.ctx.state, "set").mockImplementation(async () => { if (denied) { writesAfterDenial++; throw SCOPE_LOST(); } });
    vi.spyOn(f.h.ctx.issues, "get").mockImplementation(async () => { if (denied) { afterDenial++; throw SCOPE_LOST(); } return null; });

    // The run ends with the host's error, once: the caller (the scheduled job) logs it and the next run starts over.
    const outcome = await f.service.sync(companyId).then(() => null, (error: unknown) => error);

    expect(outcome).toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
    expect(afterDenial).toBeLessThanOrEqual(3);
    expect(writesAfterDenial).toBe(0);
  }, 60_000);
});
