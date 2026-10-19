import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  plugins,
  pluginState,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { acceptSteeredIdentity, initializeRunIdentity, reserveSteeredIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationAccess } from "../services/github-operation-access.js";
import { registerGitHubWriteIdentityWorkers } from "../services/github-write-identity.js";
import { CallerGaveUp, resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";

// The credential route is asked once for each git or gh command of a run. These tests pin what one run costs the server:
// how often the secret store and the plugin are asked, what is written, and that a short per-run cache never serves what
// changed (the run, its identity, the policy, the trust gate, the grant, the connection, the secret).

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({ value: `test-token-${input.responsibleUserId}` })),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
const support = await getEmbeddedPostgresTestSupport();

const REMOTE = "https://github.com/o/r.git";
const reads = {
  prView: { program: "gh" as const, args: ["pr", "view", "1"], remote: REMOTE },
  runList: { program: "gh" as const, args: ["run", "list"], remote: REMOTE },
  status: { program: "git" as const, args: ["status"], remote: null },
  fetch: { program: "git" as const, args: ["fetch"], remote: REMOTE },
};
const push = { program: "git" as const, args: ["push", "origin", "HEAD"], remote: "git@github.com:o/r.git", currentBranch: "feat", touchesWorkflows: false };

(support.supported ? describe : describe.skip)("the GitHub credential route, per run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-broker-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-read-cache-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); }, 60_000);
  // Two plugins that declare the write identity make the policy ambiguous, so each test starts without one.
  afterEach(async () => { await db.delete(pluginState); await db.delete(plugins); });

  async function seed(user = "A") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Shared", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cache test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.insert(companyMemberships).values(["A", "B"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active", membershipRole: "member" })));
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: user, cause: "instruction" });
    return { companyId, agentId, runId, issueId };
  }
  async function grant(input: Awaited<ReturnType<typeof seed>>, user: string) {
    const applicationId = randomUUID(), connectionId = randomUUID(), secretId = randomUUID(), definitionId = randomUUID(), id = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: input.companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: input.companyId, applicationId, name: connectionId, uid: connectionId, transport: "mcp_remote", status: "active", enabled: true, credentialPolicy: "per_user", config: { sourceTemplateKey: "github" } });
    await db.insert(toolConnectionInstalls).values({ companyId: input.companyId, connectionId, targetType: "agent", targetId: input.agentId });
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: input.companyId, key: definitionId, name: "Test GitHub" });
    await db.insert(companySecrets).values({ id: secretId, companyId: input.companyId, key: secretId, name: `Test token ${secretId}`, scope: "user", ownerUserId: user, userSecretDefinitionId: definitionId });
    await db.insert(connectionGrants).values({
      id, companyId: input.companyId, connectionId, kind: "user", subjectUserId: user, status: "active",
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: { github: { userId: user, login: user, installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: [user] } },
    });
    return { id, connectionId, secretId };
  }
  /** A run with the user's GitHub connection, ready for reads. */
  async function connectedRun(user = "A") {
    const input = await seed(user);
    const connection = await grant(input, user);
    return { input, connection };
  }
  /** The same database, with every statement recorded. */
  function counted() {
    const statements: string[] = [];
    const client = drizzle(db.$client as never, { logger: { logQuery: (query: string) => { statements.push(query); } } }) as unknown as typeof db;
    return { client, statements };
  }
  const writes = (statements: string[]) => statements.filter(sql => /^(update|insert|delete)/i.test(sql));
  const secretReads = () => vault.resolveUserSecretValue.mock.calls.length;

  async function identityPlugin(input: Awaited<ReturnType<typeof seed>>, policy: Record<string, unknown>) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId, pluginKey: `github-${pluginId}`, packageName: "github", version: "1.0.0", status: "ready" as never,
      manifestJson: { id: `github-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "GitHub", description: "", author: "", categories: ["connector"], capabilities: ["ui.action.register"], entrypoints: { worker: "./worker.js" }, projectRepositories: { listAction: "list", writeIdentityAction: "repository-write-identity", signCommitAction: "repository-sign-commit" } } as never,
    });
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: input.companyId, namespace: "identity", stateKey: "write-identity", valueJson: policy });
    const calls: Array<{ key: string; params: Record<string, unknown> }> = [];
    const plugin = { pluginId, calls, answer: (_params: Record<string, unknown>): unknown => ({ identity: "user", missingUserConnection: "fail" }) };
    registerGitHubWriteIdentityWorkers({ call: (async (_id: string, _method: string, request: { key: string; params: Record<string, unknown> }) => { calls.push({ key: request.key, params: request.params }); return plugin.answer(request.params); }) as never });
    return plugin;
  }
  const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };

  describe("calls the route makes for the commands of one run", () => {
    it("reads the secret store once for many reads of the same kind", async () => {
      const { input } = await connectedRun();
      vault.resolveUserSecretValue.mockClear();

      for (let command = 0; command < 20; command++) {
        const result = await resolveGitHubOperationAccess(db, input, reads.runList);
        expect(result).toMatchObject({ status: "available", login: "A" });
        expect(result.env.GH_TOKEN).toBe("test-token-A");
      }

      expect(secretReads()).toBe(1);
    });

    it("reads the secret store once for each kind of read, not once for each command", async () => {
      const { input } = await connectedRun();
      vault.resolveUserSecretValue.mockClear();

      for (let round = 0; round < 10; round++) {
        for (const operation of Object.values(reads)) await resolveGitHubOperationAccess(db, input, operation);
      }

      // `gh run list` and `gh pr view` name a repository; `git fetch` the same one; `git status` none.
      expect(secretReads()).toBeLessThanOrEqual(Object.keys(reads).length);
      expect(secretReads()).toBeGreaterThan(0);
    });

    it("answers a repeated read with a few reads and no write, lock or secret read", async () => {
      const { input } = await connectedRun();
      const { client, statements } = counted();
      await resolveGitHubOperationAccess(client, input, reads.prView);
      statements.length = 0;
      vault.resolveUserSecretValue.mockClear();

      const again = await resolveGitHubOperationAccess(client, input, reads.prView);

      expect(again).toMatchObject({ status: "available", login: "A" });
      expect(writes(statements)).toEqual([]);
      expect(statements.filter(sql => /for no key update|for update/i.test(sql))).toEqual([]);
      expect(secretReads()).toBe(0);
      expect(statements.length).toBeLessThanOrEqual(9);
    });

    it("does not write the run's GitHub summary again when it did not change", async () => {
      const { input } = await connectedRun();
      const { client, statements } = counted();

      // Three kinds of read: each is resolved, and each ends with the same summary.
      for (const operation of [reads.prView, reads.status, reads.fetch]) await resolveGitHubOperationAccess(client, input, operation);

      expect(writes(statements).filter(sql => /run_identity_contexts/.test(sql))).toHaveLength(1);
    });

    it("lets concurrent identical reads share one resolution", async () => {
      const { input } = await connectedRun();
      vault.resolveUserSecretValue.mockClear();

      const answers = await Promise.all(Array.from({ length: 8 }, () => resolveGitHubOperationAccess(db, input, reads.fetch)));

      expect(answers.every(answer => answer.status === "available" && answer.env.GH_TOKEN === "test-token-A")).toBe(true);
      expect(secretReads()).toBe(1);
    });

    it("gives concurrent callers their own copy of the shared answer", async () => {
      const { input } = await connectedRun();

      const [first, second] = await Promise.all([resolveGitHubOperationAccess(db, input, reads.fetch), resolveGitHubOperationAccess(db, input, reads.fetch)]);
      first.env.GH_TOKEN = "changed-by-the-first-caller";

      expect(second.env.GH_TOKEN).toBe("test-token-A");
    });

    it("gives each caller its own copy of the answer", async () => {
      const { input } = await connectedRun();
      const first = await resolveGitHubOperationAccess(db, input, reads.prView);
      first.env.GH_TOKEN = "changed-by-the-caller";

      const second = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(second.env.GH_TOKEN).toBe("test-token-A");
    });
  });

  describe("the resolver, asked directly, and a caller that gave up", () => {
    it.each([["a read", reads.fetch], ["a write", push]])("starts nothing for %s when the caller is already gone", async (_name, operation) => {
      const { input } = await connectedRun();
      vault.resolveUserSecretValue.mockClear();
      const { client, statements } = counted();

      await expect(resolveGitHubOperationCredentials(client, input, operation, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CallerGaveUp);

      expect(statements).toEqual([]);
      expect(secretReads()).toBe(0);
    });

    it("does not read the secret store when the caller leaves while the plugin decides", async () => {
      const { input } = await connectedRun();
      const plugin = await identityPlugin(input, { default: userWrites, allowedRepositories: ["o/r"] });
      const gone = new AbortController();
      // The plugin defers to the run's own identity (so the secret store would be read next), and the caller leaves meanwhile.
      plugin.answer = () => { gone.abort(); return { identity: "user", missingUserConnection: "fail" }; };
      vault.resolveUserSecretValue.mockClear();

      await expect(resolveGitHubOperationCredentials(db, input, push, { signal: gone.signal })).rejects.toBeInstanceOf(CallerGaveUp);

      expect(plugin.calls).toHaveLength(1);
      expect(secretReads()).toBe(0);
    });
  });

  describe("a caller that gave up", () => {
    it("starts no work for a read when the caller is already gone", async () => {
      const { input } = await connectedRun();
      vault.resolveUserSecretValue.mockClear();
      const { client, statements } = counted();
      const gone = AbortSignal.abort();

      await expect(resolveGitHubOperationAccess(client, input, reads.prView, { signal: gone })).rejects.toThrow();

      expect(secretReads()).toBe(0);
      expect(writes(statements)).toEqual([]);
    });

    it("asks the plugin nothing for a write when the caller is already gone", async () => {
      const { input } = await connectedRun();
      const plugin = await identityPlugin(input, { default: userWrites, allowedRepositories: ["o/r"] });

      await expect(resolveGitHubOperationAccess(db, input, push, { signal: AbortSignal.abort() })).rejects.toThrow();

      expect(plugin.calls).toEqual([]);
    });
  });

  describe("what the cache never serves", () => {
    async function filled(operation = reads.prView) {
      const run = await connectedRun();
      await resolveGitHubOperationAccess(db, run.input, operation);
      vault.resolveUserSecretValue.mockClear();
      return run;
    }

    it("a run that has ended", async () => {
      const { input } = await filled();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));

      await expect(resolveGitHubOperationAccess(db, input, reads.prView)).rejects.toThrow(/active run/);
    });

    it("another person's token after the identity of the run changed", async () => {
      const { input } = await filled();
      await grant(input, "B");
      const message = randomUUID();
      await db.insert(issueComments).values({ id: message, companyId: input.companyId, issueId: input.issueId, authorUserId: "B", body: "Next instruction" });
      const context = await reserveSteeredIdentity(db, { ...input, messageId: message });
      await acceptSteeredIdentity(db, context!);

      const result = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(result).toMatchObject({ status: "available", login: "B" });
      expect(result.env.GH_TOKEN).toBe("test-token-B");
    });

    it("an identity that is waiting to be accepted", async () => {
      const { input } = await filled();
      const message = randomUUID();
      await db.insert(issueComments).values({ id: message, companyId: input.companyId, issueId: input.issueId, authorUserId: "B", body: "Next instruction" });
      await reserveSteeredIdentity(db, { ...input, messageId: message });

      // The full path decides: it does not hand out the cached answer while an acceptance is open.
      await expect(resolveGitHubOperationAccess(db, input, reads.prView)).rejects.toThrow(/Message acceptance is being reconciled/);
    });

    it("a revoked grant", async () => {
      const { input, connection } = await filled();
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, connection.id));

      const result = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(result.status).not.toBe("available");
      expect(result.env.GH_TOKEN).toBeUndefined();
    });

    it("a disabled connection", async () => {
      const { input, connection } = await filled();
      await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connection.connectionId));

      const result = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(result.status).not.toBe("available");
      expect(result.env.GH_TOKEN).toBeUndefined();
    });

    it("a deleted secret", async () => {
      const { input, connection } = await filled();
      await db.update(companySecrets).set({ status: "deleted", deletedAt: new Date() }).where(eq(companySecrets.id, connection.secretId));
      vault.resolveUserSecretValue.mockRejectedValueOnce(new Error("Secret not found"));

      const result = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(result.status).not.toBe("available");
      expect(result.env.GH_TOKEN).toBeUndefined();
    });

    it("a rotated secret", async () => {
      const { input, connection } = await filled();
      await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, connection.secretId));
      vault.resolveUserSecretValue.mockClear();

      await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(secretReads()).toBe(1);
    });

    it("an agent or issue that became low trust", async () => {
      const { input } = await filled();
      await db.update(issues).set({ sourceTrust: { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: input.issueId } as never }).where(eq(issues.id, input.issueId));

      const result = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(result).toMatchObject({ status: "unavailable" });
      expect(result.env).toEqual({});
    });

    it("an answer made under another write-identity policy", async () => {
      const run = await connectedRun();
      const plugin = await identityPlugin(run.input, { default: userWrites, allowedRepositories: ["o/r"] });
      const before = await resolveGitHubOperationAccess(db, run.input, reads.prView);
      expect(before).toMatchObject({ status: "available", login: "A" });
      await resolveGitHubOperationAccess(db, run.input, reads.prView);
      vault.resolveUserSecretValue.mockClear();

      // The company switches its GitHub access off (the kill switch).
      await db.update(pluginState).set({ valueJson: { default: userWrites, allowedRepositories: ["o/r"], enabled: false } }).where(eq(pluginState.pluginId, plugin.pluginId));
      const after = await resolveGitHubOperationAccess(db, run.input, reads.prView);

      expect(after.status).toBe("unavailable");
      expect(after.env.GH_TOKEN).toBeUndefined();
    });

    it("another run of the same person, or another company", async () => {
      const first = await connectedRun("A");
      const second = await connectedRun("A");
      vault.resolveUserSecretValue.mockClear();

      await resolveGitHubOperationAccess(db, first.input, reads.prView);
      await resolveGitHubOperationAccess(db, second.input, reads.prView);

      // Each run resolves for itself: the second one did not receive the first one's answer.
      expect(secretReads()).toBe(2);
    });

    it("an answer for another repository", async () => {
      const { input } = await filled();
      vault.resolveUserSecretValue.mockClear();

      const other = await resolveGitHubOperationAccess(db, input, { program: "gh", args: ["pr", "view", "1"], remote: "https://github.com/o/other.git" });

      expect(other.repository).toBe("o/other");
      expect(secretReads()).toBe(1);
    });

    it("a failure to read the secret", async () => {
      const { input } = await connectedRun();
      vault.resolveUserSecretValue.mockRejectedValueOnce(new Error("vault is down"));
      const failed = await resolveGitHubOperationAccess(db, input, reads.prView);
      expect(failed.status).toBe("unavailable");

      const retried = await resolveGitHubOperationAccess(db, input, reads.prView);

      expect(retried).toMatchObject({ status: "available", login: "A" });
    });

    it("a write: each one is decided and audited by itself", async () => {
      const run = await connectedRun();
      const plugin = await identityPlugin(run.input, { default: userWrites, allowedRepositories: ["o/r"] });
      plugin.answer = () => ({ identity: "bot", credential: { token: "app-token", login: "vllnt-agents[bot]", userId: "99" } });

      for (let command = 0; command < 3; command++) await resolveGitHubOperationAccess(db, run.input, push);

      expect(plugin.calls.filter(call => call.key === "repository-write-identity")).toHaveLength(3);
    });
  });
});
