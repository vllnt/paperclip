import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, plugins, pluginState, projects } from "@paperclipai/db";
import { GITHUB_WRITE_IDENTITY_STATE, parseGitHubWriteIdentityPolicy } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { registerGitHubWriteIdentityWorkers } from "../services/github-write-identity.js";

// The broker runs for real on real rows; only the credential store behind it and the GitHub plugin worker are doubles.
// The plugin double records what the broker asks it, which is the point: the launcher's workflow paths must reach the plugin.
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

(support.supported ? describe : describe.skip)("a push's workflow paths reach the GitHub plugin through the broker", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const asked: Array<Record<string, any>> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-workflow-push-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    registerGitHubWriteIdentityWorkers(null);
    await database?.cleanup();
  }, 60_000);
  beforeEach(() => {
    vi.clearAllMocks();
    asked.length = 0;
    registerGitHubWriteIdentityWorkers({
      call: async (_plugin: string, _method: string, input: any) => { asked.push(input.params); return { identity: "user", unavailable: "stopped here, after the plugin was asked" }; },
    } as any);
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Site" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Keep the PR current" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId, projectId } });
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "accepted-author", issueId, cause: "instruction" });
    // The company writes as its App user, through an installed GitHub plugin that declares the write identity action.
    const [plugin] = await db.insert(plugins).values({
      pluginKey: `github-${companyId}`, packageName: "@vllnt/paperclip-github", version: "0.0.0", status: "ready",
      manifestJson: { projectRepositories: { writeIdentityAction: "repository-write-identity" } } as any,
    }).returning();
    const permissions = { contents: "write", metadata: "read", pull_requests: "write" };
    await db.insert(pluginState).values({
      pluginId: plugin!.id, scopeKind: "company", scopeId: companyId, ...GITHUB_WRITE_IDENTITY_STATE,
      valueJson: parseGitHubWriteIdentityPolicy({
        default: { commit: "user", push: "user", pullRequest: "user", comment: "user" }, userSource: "app", allowedRepositories: ["acme/site"],
        installationRepositories: ["acme/site"], userLogin: "agent-owner", installationPermissions: permissions,
      }),
    });
    return { companyId, agentId, runId };
  }

  const origin = "https://github.com/Acme/Site.git";
  const tip = "a".repeat(40), parent = "b".repeat(40), side = "c".repeat(40), oid = "d".repeat(40);
  const report = {
    workflowFiles: [{ path: ".github/workflows/ci.yml", mode: "100644", oid }],
    workflowCommits: [{ sha: tip, parents: [parent, side], changes: [{ path: ".github/workflows/ci.yml", mode: "100644", oid }, { path: ".github/workflows/old.yml", mode: null, oid: null }] }],
    workflowEntries: [parent, side],
  };
  const push = (extra: Record<string, unknown> = {}) => ({
    program: "git" as const, args: ["push", "origin", "feature/x"], remote: origin, pushUrls: [origin], currentBranch: "feature/x",
    refs: { "feature/x": "refs/heads/feature/x" }, shas: [tip], touchesWorkflows: true, ...report, ...extra,
  });

  it("asks the plugin with the one branch, the commit, its workflow files and where its history joins, and with none of it when the launcher reported none", async () => {
    const run = await seed();
    const refused = await resolveGitHubOperationCredentials(db, run, push());
    expect(refused).toMatchObject({ status: "unavailable" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      companyId: run.companyId, repository: "acme/site", access: "write", action: "push", privileged: ["editWorkflows"],
      workflowPush: { branch: "feature/x", tip, files: report.workflowFiles, commits: report.workflowCommits, entries: report.workflowEntries },
    });
    await resolveGitHubOperationCredentials(db, run, push({ workflowFiles: undefined }));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ privileged: ["editWorkflows"] });
    expect(asked[1]).not.toHaveProperty("workflowPush");
  });

  it("never asks the plugin about a push that is refused whatever the toggles, a release tag with workflow changes included", async () => {
    const run = await seed();
    const tag = await resolveGitHubOperationCredentials(db, run, push({ args: ["push", "origin", "refs/tags/engine@1.0.0"], refs: {} }));
    expect(tag).toMatchObject({ status: "unavailable" });
    // The plugin double records every question, so nothing here means the broker refused before asking.
    expect(asked).toHaveLength(0);
  });
});
