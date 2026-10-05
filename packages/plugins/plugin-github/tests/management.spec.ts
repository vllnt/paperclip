import { relatedPullsQuery } from "../src/task-links.js";
import { readFileSync } from "node:fs";
import { buildASTSchema, parse, validate, visit, getVariableValues, type OperationDefinitionNode } from "graphql";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { GitHubClient, GitHubError } from "../src/github.js";
import { RepositoryManager } from "../src/management-repository.js";
import { ProjectManager } from "../src/management-projects.js";
import { registerManagement } from "../src/management.js";
import { registerAgentBots } from "../src/agent-bots.js";
import manifest from "../src/manifest.js";

// The upstream snapshot duplicates two unrelated EnterpriseOwnerInfo fields.
// Deduplicate only that type; all queried types, input coercion and operations are validated.
const schema = buildASTSchema(visit(parse(readFileSync(new URL("./fixtures/github-schema.graphql", import.meta.url), "utf8")), {
  ObjectTypeDefinition(node) {
    if (node.name.value !== "EnterpriseOwnerInfo") return;
    const seen = new Set<string>();
    return { ...node, fields: node.fields?.filter(f => { if (seen.has(f.name.value)) return false; seen.add(f.name.value); return true; }) };
  },
}));
const permissions = { metadata: "read", issues: "write", pull_requests: "write", contents: "write", checks: "write", statuses: "read", organization_projects: "write" };
const repo = { id: 22, name: "repo", fullName: "org/repo", url: "https://github.com/org/repo", installationId: 33, owner: "org", private: true, issuesWrite: true, permissions };
const pr = { id: 44, node_id: "PR", number: 7, state: "open", merged: false, head: { sha: "a".repeat(40) }, base: { ref: "main" } };
const issue = { id: 55, node_id: "I", number: 7, title: "Issue", body: "Original\n<!-- paperclip:company:task -->", state: "open" };
const project = { id: "P", number: 1, title: "Roadmap", public: false, closed: false };
const fields = [ { id: "F", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "opt", name: "Todo", color: "GRAY", description: "" }] }, { id: "text", name: "Notes", dataType: "TEXT" }, { id: "number", name: "Size", dataType: "NUMBER" }, { id: "date", name: "Due", dataType: "DATE" }, { id: "iteration", name: "Sprint", dataType: "ITERATION", configuration: { iterations: [{ id: "iter" }], completedIterations: [] } } ];
const item = { id: "ITEM", project: { id: "P" }, content: { id: "DRAFT", __typename: "DraftIssue", title: "Draft" }, fieldValues: { nodes: [] } };
function fixture() {
  const github = new GitHubClient(), tokens = vi.spyOn(github, "scopedToken").mockResolvedValue("token");
  const requests = vi.spyOn(github, "request").mockImplementation(async (path, _token, body, method) => {
    if (path === "/user") return { data: { login: "person" }, next: false } as any;
    if (path.endsWith("/pulls/7") && !method) return { data: pr, next: false } as any;
    if (path.endsWith("/issues/7") && !method) return { data: issue, next: false } as any;
    if (path.endsWith("/comments/9") && !method) return { data: { issue_url: "https://api.github.com/repos/org/repo/issues/7", pull_request_url: "https://api.github.com/repos/org/repo/pulls/7" }, next: false } as any;
    if (path.endsWith("/org/repo")) return { data: { node_id: "R" }, next: false } as any;
    if (path.includes("/check-runs")) return { data: { check_runs: [{ id: 1 }] }, next: true } as any;
    if (path.includes("/status?")) return { data: { statuses: [{ id: 2 }] }, next: false } as any;
    return { data: method ? { ...body as any, merged: true, number: 7 } : [issue, { id: 77, pull_request: {} }], next: true } as any;
  });
  const graph = vi.spyOn(github, "graphql").mockImplementation(async (_token, query, variables = {}) => {
    const ast = parse(query);
    expect(validate(schema, ast).map(e => e.message), query).toEqual([]);
    const op = ast.definitions.find(d => d.kind === "OperationDefinition") as OperationDefinitionNode;
    const coercion = getVariableValues(schema, op.variableDefinitions ?? [], variables);
    expect(coercion.errors?.map(e => e.message) ?? [], JSON.stringify(variables)).toEqual([]);
    if (query.startsWith("mutation")) return { ok: true } as any;
    if (query.includes("projectV2(number")) return { organization: { projectV2: project }, user: { projectV2: project } } as any;
    if (query.includes("projectsV2")) return { organization: { id: "ORG", projectsV2: { nodes: [project], pageInfo: { hasNextPage: false } } }, user: { id: "USER", projectsV2: { nodes: [project], pageInfo: { hasNextPage: false } } }, viewer: {} } as any;
    if (query.includes("fields(first")) return { node: { fields: { nodes: fields, pageInfo: { hasNextPage: false } } } } as any;
    if (query.includes("items(first")) return { node: { items: { nodes: [item], pageInfo: { hasNextPage: false } } } } as any;
    if (query.includes("...on ProjectV2Item")) return { node: item } as any;
    if (query.includes("...on PullRequestReviewThread")) return { node: { pullRequest: { id: "PR" } } } as any;
    return { node: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } as any;
  });
  return { github, tokens, requests, graph, manager: new RepositoryManager(github, { id: "12", pem: "fixture" }, repo), projectManager: new ProjectManager(github, "token", { login: "org", type: "Organization" }, async () => ({ id: "R", contentId: "I" })) };
}
const base = { number: 7, body: "Body", title: "Title", sha: pr.head.sha, confirm: "org/repo#7" };

describe("repository management", () => {
  it.each(["pulls", "issues", "comments", "reviews", "review-comments", "files", "commits", "labels", "milestones", "assignees", "branches"])("paginates %s", async op => {
    const f = fixture(); const result = await f.manager.run(op, { ...base, page: 2 });
    expect(result.nextPage).toBe(3); expect(f.requests.mock.calls.at(-1)?.[0]).toContain("page=2");
    if (op === "issues") expect(result.rows).toEqual([issue]);
    expect(f.tokens.mock.calls.every(c => c[4] === repo.id)).toBe(true);
  });
  const mutations: [string, Record<string, unknown>, string, string][] = [
    ["create-issue", {}, "/issues", "POST"], ["edit-issue", { labels: [], assignees: [], milestone: null }, "/issues/7", "PATCH"],
    ["lock", { reason: "resolved" }, "/issues/7/lock", "PUT"], ["unlock", {}, "/issues/7/lock", "DELETE"], ["subscribe", {}, "/issues/7/subscription", "PUT"], ["unsubscribe", {}, "/issues/7/subscription", "DELETE"],
    ["comment", {}, "/issues/7/comments", "POST"], ["react-comment", { commentId: 9, content: "heart" }, "/issues/comments/9/reactions", "POST"], ["edit-comment", { commentId: 9 }, "/issues/comments/9", "PATCH"], ["delete-comment", { commentId: 9 }, "/issues/comments/9", "DELETE"],
    ["create-pr", { head: "feature", base: "main", draft: true }, "/pulls", "POST"], ["edit-pr", { base: "release", state: "closed" }, "/pulls/7", "PATCH"],
    ["request-reviewers", { reviewers: ["alex"], teams: ["eng"] }, "/pulls/7/requested_reviewers", "POST"], ["remove-reviewers", { reviewers: ["alex"] }, "/pulls/7/requested_reviewers", "DELETE"],
    ["review", { event: "APPROVE" }, "/pulls/7/reviews", "POST"], ["dismiss-review", { reviewId: 8 }, "/pulls/7/reviews/8/dismissals", "PUT"],
    ["inline-comment", { path: "file.ts", line: 5 }, "/pulls/7/comments", "POST"], ["reply-review-comment", { commentId: 9 }, "/pulls/7/comments/9/replies", "POST"],
    ["edit-review-comment", { commentId: 9 }, "/pulls/comments/9", "PATCH"], ["delete-review-comment", { commentId: 9 }, "/pulls/comments/9", "DELETE"],
    ["merge-pr", { method: "squash" }, "/pulls/7/merge", "PUT"], ["update-branch", {}, "/pulls/7/update-branch", "PUT"], ["rerequest-check", { checkRunId: 1 }, "/check-runs/1/rerequest", "POST"],
    ["create-label", { name: "bug", color: "123abc" }, "/labels", "POST"], ["edit-label", { currentName: "old", name: "new", color: "123abc" }, "/labels/old", "PATCH"], ["delete-label", { name: "bug", confirm: "bug" }, "/labels/bug", "DELETE"],
    ["create-milestone", {}, "/milestones", "POST"], ["edit-milestone", { milestone: 2, dueOn: null }, "/milestones/2", "PATCH"], ["delete-milestone", { milestone: 2, confirm: "org/repo/milestone/2" }, "/milestones/2", "DELETE"],
  ];
  it.each(mutations)("sends %s through the correct GitHub contract", async (op, params, path, method) => {
    const f = fixture(); await f.manager.run(op, { ...base, ...params });
    const call = f.requests.mock.calls.at(-1)!; expect(call[0]).toBe(`/repos/org/repo${path}`); expect(call[3]).toBe(method);
    if (op === "merge-pr") expect(call[2]).toEqual({ sha: pr.head.sha, merge_method: "squash" });
    if (op === "review") expect(call[2]).toMatchObject({ commit_id: pr.head.sha, event: "APPROVE" });
    if (op === "edit-issue") expect(call[2]).toMatchObject({ body: "Body\n<!-- paperclip:company:task -->", assignees: [], labels: [], milestone: null });
  });
  it.each(["pin-issue", "unpin-issue"])('validates %s against GitHub\'s real GraphQL schema', async op => {
    const f = fixture(); await f.manager.run(op, { ...base, kind: "issue" });
    expect(f.graph.mock.calls.at(-1)?.[1]).toMatch(/^mutation/);
  });
  it("reads issue pin state through the GraphQL Issue contract", async () => {
    const f = fixture(); f.graph.mockImplementation(async (_token, query, variables = {}) => {
      const ast = parse(query); expect(validate(schema, ast).map(e => e.message), query).toEqual([]);
      if (query.includes("isPinned")) return { node: { isPinned: true } } as any;
      return { node: {} } as any;
    });
    await expect(f.manager.run("pin-status", { ...base, kind: "issue" })).resolves.toEqual({ isPinned: true });
  });
  it.each(["delete-issue", "transfer-issue", "draft-pr", "ready-pr", "enable-auto-merge", "disable-auto-merge", "resolve-thread", "unresolve-thread"])('validates %s against GitHub\'s real GraphQL schema', async op => {
    const f = fixture(); await f.manager.run(op, { ...base, method: "squash", threadId: "THREAD", destinationNodeId: "R2", destinationRepositoryId: 23 });
    expect(f.graph.mock.calls.at(-1)?.[1]).toMatch(/^mutation/);
  });
  it("validates the thread query and exposes partial check permission failures", async () => {
    const f = fixture(); await f.manager.run("threads", base); const checks = await f.manager.run("checks", base);
    expect(checks).toMatchObject({ sha: pr.head.sha, nextPage: 2, warnings: [] });
    const denied = new RepositoryManager(f.github, { id: "12", pem: "fixture" }, { ...repo, permissions: { ...permissions, checks: "" } });
    expect(await denied.run("checks", base)).toMatchObject({ statuses: [{ id: 2 }], warnings: [expect.stringContaining("checks")] });
  });
  it.each(["merge-pr", "review", "inline-comment", "update-branch", "enable-auto-merge"])("rejects %s against a stale reviewed commit", async op => {
    const f = fixture(); await expect(f.manager.run(op, { ...base, sha: "old", event: "APPROVE", method: "merge" })).rejects.toThrow("changed");
    expect(f.requests.mock.calls.every(c => !c[3])).toBe(true);
    expect(f.graph).not.toHaveBeenCalled();
  });
  it("requires confirmation, verifies comment membership, and rejects missing write permission before a mutation", async () => {
    const f = fixture(); await expect(f.manager.run("merge-pr", { ...base, confirm: "wrong" })).rejects.toThrow("Confirm");
    f.requests.mockResolvedValueOnce({ data: { issue_url: "https://api.github.com/repos/other/repo/issues/7" }, next: false });
    await expect(f.manager.run("edit-comment", { ...base, commentId: 9 })).rejects.toThrow("another item");
    await expect(new RepositoryManager(f.github, { id: "12", pem: "x" }, { ...repo, permissions: { issues: "read" } }).run("create-issue", base)).rejects.toThrow("read/write");
    expect(f.requests.mock.calls.every(c => !c[3])).toBe(true);
  });
});

describe("Projects v2 management", () => {
  it.each(["list", "detail", "items"])("validates %s queries against GitHub's schema", async op => { await fixture().projectManager.run(op, { projectNumber: 1 }); });
  const mutations: [string, Record<string, unknown>][] = [
    ["create", { title: "New" }], ["edit", { title: "New", public: true, confirm: "Roadmap" }], ["delete", { confirm: "Roadmap" }],
    ["add-item", { repositoryId: 22, number: 7 }], ["add-draft", { title: "Draft", body: "Text" }], ["edit-draft", { title: "Renamed", body: "Text" }], ["convert-draft", { repositoryId: 22 }],
    ["archive-item", {}], ["restore-item", {}], ["remove-item", { confirm: "Draft" }], ["move-item", { afterId: null }], ["move-item", { afterId: "OTHER_ITEM" }],
    ["set-field", { fieldId: "F", value: "opt" }], ["set-field", { fieldId: "text", value: "Some text" }], ["set-field", { fieldId: "number", value: 4 }], ["set-field", { fieldId: "date", value: "2026-10-04" }], ["set-field", { fieldId: "iteration", value: "iter" }], ["clear-field", { fieldId: "F" }],
    ["create-field", { dataType: "TEXT", name: "Notes" }], ["create-field", { dataType: "SINGLE_SELECT", name: "Priority", options: ["Low", "High"] }], ["create-field", { dataType: "ITERATION", name: "Sprint", duration: 14, startDate: "2026-10-04", iterationCount: 3 }],
    ["edit-field", { fieldId: "F", name: "Stage", options: ["Todo", "Done"], confirm: "Status" }], ["delete-field", { fieldId: "F", confirm: "Status" }], ["link-repository", { repositoryId: 22 }], ["unlink-repository", { repositoryId: 22 }],
  ];
  it.each(mutations)("validates %s mutation and inputs against GitHub's schema", async (op, params) => { const f = fixture(); await f.projectManager.run(op, { projectNumber: 1, itemId: "ITEM", ...params }); expect(f.graph.mock.calls.at(-1)?.[1]).toMatch(/^mutation/); });
  it("rejects foreign project items, fields, invalid select values and unconfirmed visibility changes", async () => {
    const f = fixture();
    await expect(f.projectManager.run("set-field", { projectNumber: 1, itemId: "ITEM", fieldId: "F", value: "foreign-option" })).rejects.toThrow("options");
    await expect(f.projectManager.run("clear-field", { projectNumber: 1, itemId: "ITEM", fieldId: "foreign-field" })).rejects.toThrow("belong");
    await expect(f.projectManager.run("edit", { projectNumber: 1, public: true })).rejects.toThrow("Confirm");
    const original = f.graph.getMockImplementation()!;
    f.graph.mockImplementation(async (...args) => args[1].includes("...on ProjectV2Item") ? { node: { ...item, project: { id: "FOREIGN" } } } as any : original(...args));
    await expect(f.projectManager.run("archive-item", { projectNumber: 1, itemId: "ITEM" })).rejects.toThrow("belong");
    expect(f.graph.mock.calls.some(c => c[1].startsWith("mutation"))).toBe(false);
  });
});

const actor = { companyId: "c1", actor: { type: "user" as const, userId: "u1", companyId: "c1", agentId: null, runId: null } };
function hostFixture() {
  const f = fixture(), h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "key" } } });
  const credentials = vi.fn().mockResolvedValue({ id: "12", pem: "fixture" });
  const catalog = vi.spyOn(f.github, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, repositories: [repo], installations: [{ id: 33, login: "org", accountType: "Organization", suspended: false, permissions }], warnings: [], truncated: false });
  registerManagement(h.ctx, f.github, credentials, vi.fn().mockResolvedValue(null));
  registerAgentBots(h.ctx);
  const action = (params: Record<string, unknown>, scope = actor) => h.performAction("manage-repository", { repositoryId: 22, requestId: "request-1234", ...params }, scope);
  return { ...f, h, credentials, catalog, action };
}
describe("company boundaries and durable management requests", () => {
  it("denies agents and forged company context before credentials, and denies unknown repositories", async () => {
    const f = hostFixture();
    await expect(f.h.performAction("manage-repository", { op: "issues", companyId: "c2", repositoryId: 22 }, { actor: actor.actor })).rejects.toThrow();
    await expect(f.action({ op: "issues" }, { ...actor, actor: { ...actor.actor, type: "agent" as any } })).rejects.toThrow();
    expect(f.credentials).not.toHaveBeenCalled();
    await expect(f.action({ op: "issues", repositoryId: 99 })).rejects.toThrow("accessible");
    expect(f.requests).not.toHaveBeenCalled();
  });
  it("serializes duplicate creates, retains a receipt and writes a body-free activity record", async () => {
    const f = hostFixture(), params = { op: "create-issue", title: "One", body: "Private content" };
    await Promise.all([f.action(params), f.action(params)]); await f.action(params);
    expect(f.requests.mock.calls.filter(c => c[3] === "POST")).toHaveLength(1);
    expect(JSON.stringify(f.h.logs)).not.toContain("Private content");
    expect(f.h.getState({ scopeKind: "company", scopeId: "c1", namespace: "management", stateKey: "request:request-1234" })).toMatchObject({ status: "done" });
    await expect(f.action({ ...params, title: "Changed" })).rejects.toThrow("different values");
  });
  it("does not replay an uncertain POST, but permits retry after definitive permission denial", async () => {
    const f = hostFixture(); f.requests.mockRejectedValueOnce(new Error("Response lost"));
    await expect(f.action({ op: "create-issue", title: "One" })).rejects.toThrow("unconfirmed");
    await expect(f.action({ op: "create-issue", title: "One" })).rejects.toThrow("unconfirmed");
    expect(f.requests).toHaveBeenCalledTimes(1);
    f.requests.mockRejectedValueOnce(new GitHubError(403));
    await expect(f.action({ op: "create-issue", title: "Two", requestId: "request-5678" })).rejects.toThrow("denied");
    await f.action({ op: "create-issue", title: "Two", requestId: "request-5678" });
    expect(f.requests).toHaveBeenCalledTimes(3);
  });
  it("does not poison a receipt when local validation rejects before any remote mutation", async () => {
    const f = hostFixture(); f.catalog.mockResolvedValueOnce({ ...(await f.github.catalog("12", "pem")), repositories: [{ ...repo, permissions: { issues: "read" } }] });
    await expect(f.action({ op: "create-issue", title: "One" })).rejects.toThrow("read/write");
    await f.action({ op: "create-issue", title: "One" }); expect(f.requests).toHaveBeenCalledTimes(1);
  });
  it("binds organization Projects to the current company App installation", async () => {
    const f = hostFixture();
    await expect(f.h.performAction("manage-project", { op: "list", owner: "other" }, actor)).rejects.toThrow("connected");
    expect(f.graph).not.toHaveBeenCalled();
    await f.h.performAction("manage-project", { op: "list", owner: "org" }, actor);
    expect(f.tokens).toHaveBeenCalledWith("12", "fixture", 33, expect.objectContaining({ organization_projects: "read" }));
  });
  it("accepts no arbitrary node ID or provider path from the browser", async () => {
    const f = hostFixture();
    await expect(f.action({ op: "raw-request", path: "/user" })).rejects.toThrow("Unknown");
    await expect(f.action({ op: "transfer-issue", destinationNodeId: "FOREIGN", number: 7, confirm: "org/repo#7" })).rejects.toThrow("destination");
    await expect(f.action({ op: "transfer-issue", destinationRepositoryId: "22", number: 7, confirm: "org/repo#7" })).rejects.toThrow("valid destination repository");
    expect(f.graph).not.toHaveBeenCalled();
  });
});

it("handles successful empty DELETE/PUT responses and sanitizes GraphQL errors", async () => {
  const client = new GitHubClient(vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "private-token", type: "FORBIDDEN" }] }), { status: 200 })));
  expect(await client.request("/test", "token", undefined, "DELETE")).toEqual({ data: undefined, next: false });
  await expect(client.graphql("token", "query{viewer{login}}" )).rejects.toThrow("denied");
});

describe("provider people options", () => {
  it("returns GitHub people and only channel-backed Paperclip bots", async () => {
    const f = hostFixture();
    const original = f.requests.getMockImplementation()!;
    f.requests.mockImplementation(async (...args) => {
      if (args[0].endsWith("/assignees?per_page=50&page=1")) return { data: [{ login: "alice", name: "Alice", avatar_url: "https://github.com/alice.png" }, { login: "bad login" }], next: false } as any;
      return original(...args);
    });
    const withoutChannel: any = await f.h.performAction("github-people-options", { repositoryId: 22 }, actor);
    expect(withoutChannel.assignees).toEqual([expect.objectContaining({ login: "alice" })]);
    expect(withoutChannel.reviewers).toEqual(withoutChannel.assignees);
    expect(withoutChannel.bots).toEqual([]);
    vi.spyOn(f.h.ctx.chat, "listEndpoints").mockResolvedValue({ chatConnectorsEnabled: true, endpoints: [{ id: "ep-a1", companyId: "c1", connectionId: "conn", provider: "github", status: "active", assignedAgentId: "a1", botUsername: "review-bot", capabilities: {} }] });
    f.h.seed({ agents: [{ id: "a1", companyId: "c1", name: "Review bot", status: "idle" }] as any });
    const withChannel: any = await f.h.performAction("github-people-options", { repositoryId: 22 }, actor);
    expect(withChannel.bots).toEqual([expect.objectContaining({ id: "a1", agentId: "a1", login: "review-bot", source: "paperclip-native-github" })]);
    expect(withChannel.people.map((person: any) => person.login)).toEqual(["alice", "review-bot"]);
  });

  it("rejects malformed human handles before reviewer mutation", async () => {
    const f = hostFixture();
    await expect(f.h.performAction("manage-agent-reviewers", { repositoryId: 22, number: 7, op: "request", reviewers: ["bad login"], requestId: "review-1234" }, actor)).rejects.toThrow("valid GitHub reviewer logins");
    expect(f.requests.mock.calls.some(call => call[3] === "POST")).toBe(false);
  });
});

describe("native PR review tasks", () => {
  function setup() {
    const f = hostFixture(); f.h.seed({ projects: [{ id: "p1", companyId: "c1", name: "API" }] as any, projectWorkspaces: [{ id: "w1", projectId: "p1", companyId: "c1", repoUrl: repo.url }] as any, agents: [{ id: "a1", companyId: "c1", name: "Reviewer A", status: "idle" }, { id: "a2", companyId: "c1", name: "Reviewer B", status: "idle" }, { id: "foreign", companyId: "c2", name: "Other", status: "idle" }] as any });
    vi.spyOn(f.h.ctx.chat, "listEndpoints").mockImplementation(async ({ companyId, agentId }) => ({ chatConnectorsEnabled: true, endpoints: agentId && companyId === "c1" ? [{ id: `ep-${agentId}`, companyId, connectionId: `conn-${agentId}`, provider: "github", status: "active", assignedAgentId: agentId, botUsername: agentId === "a1" ? "review-bot" : `${agentId}-bot`, capabilities: {} }] : [] }));
    return f;
  }
  it("creates one Todo review task per PR commit and only wakes when explicitly requested", async () => {
    const f = setup(), wake = vi.spyOn(f.h.ctx.issues, "requestWakeup").mockResolvedValue({} as any);
    await f.h.performAction("save-agent-bot", { agentId: "a1", login: "review-bot", identity: "github-app" }, actor);
    const params = { repositoryId: 22, number: 7, projectId: "p1", agentId: "a1", reviewerAgentIds: ["a1"], sha: pr.head.sha };
    const first: any = await f.h.performAction("review-pr-task", params, actor);
    const second: any = await f.h.performAction("review-pr-task", params, actor);
    expect(first.id).toBe(second.id); expect(wake).not.toHaveBeenCalled();
    expect(await f.h.ctx.issues.list({ companyId: "c1" })).toMatchObject([{ status: "todo", assigneeAgentId: "a1", originKind: "plugin:vllnt.paperclip-github:pull", description: expect.stringContaining("review-bot") }]);
    expect(await f.h.ctx.state.get({ scopeKind: "company", scopeId: "c1", namespace: "sync", stateKey: "review:" + first.id })).toMatchObject({ reviewerAgents: [{ agentId: "a1", login: "review-bot", identity: "github-app" }] });
    await f.h.performAction("review-pr-task", { ...params, wake: true }, actor);
    expect(wake).toHaveBeenCalledWith(first.id, "c1", expect.objectContaining({ idempotencyKey: `github-review:22:7:${pr.head.sha}` }));
  });
  it("creates one idempotent Paperclip review task per selected reviewer", async () => {
    const f = setup(), wake = vi.spyOn(f.h.ctx.issues, "requestWakeup").mockResolvedValue({} as any);
    await f.h.performAction("save-agent-bot", { agentId: "a1", login: "review-a" }, actor);
    await f.h.performAction("save-agent-bot", { agentId: "a2", login: "review-b" }, actor);
    const params = { repositoryId: 22, number: 7, projectId: "p1", agentIds: ["a1", "a2"], reviewerAgentIds: ["a1", "a2"], sha: pr.head.sha, wake: true };
    const first: any = await f.h.performAction("review-pr-task", params, actor);
    const second: any = await f.h.performAction("review-pr-task", params, actor);
    expect(first.tasks).toHaveLength(2);
    expect(first.tasks.map((task: any) => task.assigneeAgentId)).toEqual(["a1", "a2"]);
    expect(second.tasks.map((task: any) => task.id)).toEqual(first.tasks.map((task: any) => task.id));
    expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(2);
    expect(wake).toHaveBeenCalledTimes(4);
  });

  it("rejects an unlinked project, foreign agent and stale PR commit", async () => {
    const f = setup(), params = { repositoryId: 22, number: 7, projectId: "p1", sha: pr.head.sha };
    await expect(f.h.performAction("review-pr-task", { ...params, projectId: "other" }, actor)).rejects.toThrow("linked");
    await expect(f.h.performAction("review-pr-task", { ...params, agentId: "foreign" }, actor)).rejects.toThrow("company");
    await expect(f.h.performAction("review-pr-task", { ...params, sha: "old" }, actor)).rejects.toThrow("changed");
    expect(await f.h.ctx.issues.list({ companyId: "c1" })).toHaveLength(0);
  });
});

it("does not classify partial GraphQL mutation success as a safe-to-retry denial", async () => {
  const client = new GitHubClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { createProjectV2: null }, errors: [{ type: "FORBIDDEN", message: "secret" }] }), { status: 200 })));
  const error = await client.graphql("token", "mutation{createProjectV2(input:{ownerId:\"O\",title:\"P\"}){clientMutationId}}").catch(e => e);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(GitHubError); expect((error as Error).message).not.toContain("secret");
});

it("validates batched closing PR discovery against GitHub’s schema", () => {
  expect(validate(schema, parse(relatedPullsQuery([1, 2, 9000]))).map(e => e.message)).toEqual([]);
  expect(() => relatedPullsQuery([NaN])).toThrow();
});
