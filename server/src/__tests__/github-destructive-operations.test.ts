import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import type { GitHubOperation } from "../services/github-write-identity.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";

// The credential store is a sentinel: reaching it would hand the agent a GitHub token.
const credentials = vi.hoisted(() => ({
  resolveManagedGitHubCredential: vi.fn(),
  secretService: vi.fn(() => ({})),
}));
vi.mock("../services/secrets.js", () => ({ secretService: credentials.secretService }));
vi.mock("../services/git-credentials.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  resolveManagedGitHubCredential: credentials.resolveManagedGitHubCredential,
  buildGitAuthInvocation: () => ({ env: { GH_TOKEN: "test-export-sentinel" } }),
}));

const support = await getEmbeddedPostgresTestSupport();
const remote = "https://github.com/acme/site.git";

// An agent run of a company without a write identity policy: only an always-on refusal stops it.
(support.supported ? describe : describe.skip)("destructive GitHub operations through the managed broker", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-destructive-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.clearAllMocks();
    credentials.resolveManagedGitHubCredential.mockResolvedValue({
      configured: true,
      credential: { identitySource: "personal", githubIdentity: { login: "accepted-author" } },
    });
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Site" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Ship it" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId, projectId } });
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "accepted-author", issueId, cause: "instruction" });
    return { companyId, agentId, runId };
  }

  const activity = async (companyId: string) => db.select().from(activityLog).where(eq(activityLog.companyId, companyId));

  it.each<[string, GitHubOperation, string]>([
    ["gh repo archive", { program: "gh", args: ["repo", "archive", "--yes"], remote }, "(gh repo archive)"],
    ["a repository settings PATCH", { program: "gh", args: ["api", "repos/acme/site", "-F", "archived=true", "-X", "PATCH"], remote: null }, "(PATCH repos/{owner}/{repo})"],
    ["a webhook DELETE", { program: "gh", args: ["api", "--method", "DELETE", "repos/acme/site/hooks/7"], remote: null }, "(DELETE repos/{owner}/{repo}/hooks)"],
    ["an inactive deployment status", { program: "gh", args: ["api", "repos/acme/site/deployments/9/statuses", "-f", "state=inactive"], remote: null }, "statuses with state inactive)"],
    ["GraphQL deleteRef", { program: "gh", args: ["api", "graphql", "-f", 'query=mutation{deleteRef(input:{refId:"F"}){clientMutationId}}'], remote }, "(graphql deleteRef"],
    ["git push --delete main", { program: "git", args: ["push", "origin", "--delete", "main"], remote, pushUrls: [remote], currentBranch: "feature" }, "(git push deleting refs/heads/main)"],
    ["git push +HEAD:main", { program: "git", args: ["push", "origin", "+HEAD:main"], remote, pushUrls: [remote], currentBranch: "feature", touchesWorkflows: false }, "(git push force-pushing refs/heads/main)"],
  ])("refuses %s for an agent run: no token, an activity record with the route and the agent", async (_name, operation, route) => {
    const run = await seed();
    const result = await resolveGitHubOperationCredentials(db, run, operation);
    expect(result).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
    expect(String((result as { reason?: unknown }).reason)).toMatch(/^Denied: agents never /);
    expect(credentials.resolveManagedGitHubCredential).not.toHaveBeenCalled();
    expect(await activity(run.companyId)).toEqual([expect.objectContaining({
      action: "github.write_identity_resolved", actorType: "agent", actorId: run.agentId, agentId: run.agentId, runId: run.runId,
      details: expect.objectContaining({ status: "unavailable", reason: expect.stringContaining(route) }),
    })]);
  });

  /**
   * GitHub as the broker reads it: every repository's default branch is develop, `protected` has classic protection,
   * `locked` a ruleset that forbids deleting it, every other branch nothing. `down` makes GitHub unreachable.
   */
  function fakeGitHub(mode: "up" | "down" = "up") {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
      if (mode === "down") throw new TypeError("fetch failed");
      const path = url.replace(/^https:\/\/api\.github\.com\/repos\/acme\/[^/]+/, "");
      const body = path === "" ? { default_branch: "develop" }
        : path.startsWith("/branches/") ? { protected: path === "/branches/protected" }
        : path.startsWith("/rules/branches/locked?") ? [{ type: "deletion" }]
        : path.startsWith("/rules/branches/") ? [] : null;
      return new Response(JSON.stringify(body), { status: body === null ? 404 : 200 });
    }));
    return requests;
  }

  /** Asks the real route, with the run's GitHub capability, as the managed launcher does. */
  async function ask(run: Awaited<ReturnType<typeof seed>>, operation: GitHubOperation) {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "github-destructive-operations-secret");
    const capability = createRuntimeToolsToken({ agentId: run.agentId, companyId: run.companyId, runId: run.runId, responsibleUserId: "accepted-author", scope: "github_credentials" });
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    const response = await request(app).post("/runtime-tools/github/credentials").set("x-paperclip-github-capability", capability!.token).send({ operation });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as { status: string; reason?: string; failClosed?: boolean; env?: Record<string, string> };
  }

  const repositoryRemote = () => `https://github.com/acme/site-${randomUUID().slice(0, 8)}.git`;
  const denials = async (companyId: string) => (await activity(companyId)).filter(row => (row.details as { status?: unknown } | null)?.status === "unavailable");

  it("still hands a credential to ordinary agent writes, and to feature branches GitHub does not protect", async () => {
    const run = await seed();
    const origin = repositoryRemote();
    const github = fakeGitHub();
    for (const operation of [
      { program: "gh", args: ["pr", "create", "--fill"], remote: origin },
      { program: "gh", args: ["pr", "merge", "5", "--admin", "--squash", "--delete-branch", "--match-head-commit", "a".repeat(40)], remote: origin },
      { program: "gh", args: ["issue", "comment", "3", "-b", "done"], remote: origin },
      { program: "gh", args: ["project", "item-edit", "--id", "I", "--project-id", "P", "--field-id", "F", "--text", "x"], remote: origin },
      { program: "gh", args: ["api", "-X", "POST", "repos/acme/site/deployments/9/statuses", "-f", "state=success"], remote: null },
      { program: "gh", args: ["co", "12"], remote: origin },
      { program: "gh", args: ["label", "create", "bug"], remote: origin },
      { program: "git", args: ["push", "origin", "--delete", "feature/done"], remote: origin, pushUrls: [origin], currentBranch: "feature/next" },
      { program: "git", args: ["push", "--force-with-lease", "origin", "feature/next"], remote: origin, pushUrls: [origin], currentBranch: "feature/next", touchesWorkflows: false },
    ] satisfies GitHubOperation[]) {
      expect(await ask(run, operation), operation.args.join(" ")).toMatchObject({ status: "available", env: { GH_TOKEN: "test-export-sentinel" } });
    }
    // GitHub was only read, with GETs, and only for the branches the pushes rewrite.
    expect(github.length).toBeGreaterThan(0);
    expect(github.every(entry => entry.method === "GET" && entry.authorization === "Bearer test-export-sentinel")).toBe(true);
    expect(github.map(entry => entry.url).filter(url => url.includes("/branches/")).map(url => decodeURIComponent(url.split("/branches/")[1]!.split("?")[0]!)).sort())
      .toEqual(["feature/done", "feature/done", "feature/next", "feature/next"]);
    expect(await denials(run.companyId)).toEqual([]);
  });

  it.each<[string, (origin: string) => GitHubOperation, RegExp]>([
    // Review M1: a gh alias or extension runs any command, so no name gh itself does not know gets a token.
    ["an alias (gh wipe)", origin => ({ program: "gh", args: ["wipe"], remote: origin }), /does not know the gh command wipe/],
    ["creating an alias", origin => ({ program: "gh", args: ["alias", "set", "wipe", "repo archive --yes"], remote: origin }), /does not create gh aliases/],
    ["an extension", origin => ({ program: "gh", args: ["extension", "exec", "wipe"], remote: origin }), /does not run gh extensions/],
    // Review M2: protected branches are the ones GitHub reports, not only main and master.
    ["force-pushing a protected branch", origin => ({ program: "git", args: ["push", "--force", "origin", "protected"], remote: origin, pushUrls: [origin], currentBranch: "feature", touchesWorkflows: false }),
      /\(protected is a protected branch of acme\/site-/],
    ["deleting a branch a ruleset protects", origin => ({ program: "git", args: ["push", "origin", "--delete", "locked"], remote: origin, pushUrls: [origin], currentBranch: "feature" }),
      /\(locked is a protected branch of acme\/site-/],
    ["force-updating the default branch through the API", origin => ({ program: "gh", args: ["api", "-X", "PATCH", `repos/${origin.slice(19, -4)}/git/refs/heads/develop`, "-f", `sha=${"b".repeat(40)}`, "-f", "force=true"], remote: null }),
      /\(develop is the default branch of acme\/site-/],
    ["gh repo sync --force on the default branch", origin => ({ program: "gh", args: ["repo", "sync", "--force", "--branch", "develop"], remote: origin }),
      /\(develop is the default branch of acme\/site-/],
  ])("refuses %s through the route: no token, an activity record with the reason", async (_name, operation, reason) => {
    const run = await seed();
    const github = fakeGitHub();
    const result = await ask(run, operation(repositoryRemote()));
    expect(result).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
    expect(result.reason).toMatch(reason);
    expect(result.reason).toMatch(/^Denied: /);
    expect(github.every(entry => entry.method === "GET")).toBe(true);
    expect(await denials(run.companyId)).toEqual([expect.objectContaining({
      action: "github.write_identity_resolved", actorType: "agent", actorId: run.agentId, agentId: run.agentId, runId: run.runId,
      details: expect.objectContaining({ reason: expect.stringMatching(reason) }),
    })]);
  });

  it("fails closed when GitHub cannot be read, and when a caller skips the protected-branch read", async () => {
    const run = await seed();
    const origin = repositoryRemote();
    const github = fakeGitHub("down");
    const push = (branch: string): GitHubOperation => ({ program: "git", args: ["push", "--force-with-lease", "origin", branch], remote: origin, pushUrls: [origin], currentBranch: branch, touchesWorkflows: false });
    const unreachable = await ask(run, push("feature/a"));
    expect(unreachable).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
    expect(unreachable.reason).toMatch(/^Denied: Paperclip could not read from GitHub whether feature\/a is the default or a protected branch/);
    expect(github.length).toBeGreaterThan(0);
    // The credential resolver on its own never learned about this branch: it refuses too.
    const direct = await resolveGitHubOperationCredentials(db, run, push("feature/b"));
    expect(direct).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
    expect(String((direct as { reason?: unknown }).reason)).toMatch(/could not read from GitHub whether feature\/b/);
  });
});
