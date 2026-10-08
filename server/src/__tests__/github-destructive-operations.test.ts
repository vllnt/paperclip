import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import type { GitHubOperation } from "../services/github-write-identity.js";

// The credential store is a sentinel: reaching it would hand the agent a GitHub token.
const credentials = vi.hoisted(() => ({
  resolveManagedGitHubCredential: vi.fn(),
  secretService: vi.fn(() => ({})),
}));
vi.mock("../services/secrets.js", () => ({ secretService: credentials.secretService }));
vi.mock("../services/git-credentials.js", () => ({
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

  it("still hands a credential to ordinary agent writes", async () => {
    const run = await seed();
    for (const operation of [
      { program: "gh", args: ["pr", "create", "--fill"], remote },
      { program: "gh", args: ["pr", "merge", "5", "--admin", "--squash", "--delete-branch", "--match-head-commit", "a".repeat(40)], remote },
      { program: "gh", args: ["issue", "comment", "3", "-b", "done"], remote },
      { program: "gh", args: ["project", "item-edit", "--id", "I", "--project-id", "P", "--field-id", "F", "--text", "x"], remote },
      { program: "gh", args: ["api", "-X", "POST", "repos/acme/site/deployments/9/statuses", "-f", "state=success"], remote: null },
      { program: "git", args: ["push", "origin", "--delete", "feature/done"], remote, pushUrls: [remote], currentBranch: "feature/next" },
      { program: "git", args: ["push", "--force-with-lease", "origin", "feature/next"], remote, pushUrls: [remote], currentBranch: "feature/next", touchesWorkflows: false },
    ] satisfies GitHubOperation[]) {
      expect(await resolveGitHubOperationCredentials(db, run, operation), operation.args.join(" ")).toMatchObject({ status: "available", env: { GH_TOKEN: "test-export-sentinel" } });
    }
  });
});
