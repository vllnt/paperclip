import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  documents,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueComments,
  issues,
  plugins,
  pluginState,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createFakeGitHubPullRequestApi } from "./helpers/fake-github-pull-request.js";
import { initializeRunIdentity, reserveSteeredIdentity, acceptSteeredIdentity } from "../services/run-identity.js";
import { createGitRemoteAuthProvider } from "../services/git-credentials.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { registerGitHubWriteIdentityWorkers } from "../services/github-write-identity.js";
import { resolveGitHubIssueReadToken } from "../services/github-read-credentials.js";
import { createGitHubExternalObjectProvider } from "../services/github-external-object-provider.js";
import {
  PULL_REQUEST_FINGERPRINT_CONTEXT_KEY,
  computeIssuePullRequestFingerprint,
  evaluatePullRequestWakeGate,
} from "../services/pull-request-wake-gate.js";

const vault = vi.hoisted(() => {
  const state = {
    /** Company secrets by name, as the legacy `GITHUB_TOKEN` lookup finds them. */
    namedSecretIds: new Map<string, string>(),
    /** What a company secret (dedicated or by name) resolves to; unknown ids resolve to a dedicated token. */
    tokensBySecretId: new Map<string, string>(),
  };
  return {
    state,
    getByName: vi.fn(async (_company: string, name: string) => {
      const id = state.namedSecretIds.get(name);
      return id ? { id } : null;
    }),
    resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({
      value: `test-token-${input.responsibleUserId}`,
    })),
    resolveSecretValue: vi.fn(async (_company: string, secretId: string) =>
      state.tokensBySecretId.get(secretId) ?? "test-dedicated-token"),
  };
});
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

const support = await getEmbeddedPostgresTestSupport();
const PULL_REQUEST = { owner: "acme", repo: "app", number: 7 };
const REPOSITORY = "acme/app";

(support.supported ? describe : describe.skip)("GitHub read credential for an issue (no run yet)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-read-credentials-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterEach(async () => {
    registerGitHubWriteIdentityWorkers(null);
    // More than one installed plugin that declares a write identity makes the policy ambiguous.
    await db.delete(plugins);
    vault.state.namedSecretIds.clear();
    vault.state.tokensBySecretId.clear();
    vault.getByName.mockClear();
    vault.resolveSecretValue.mockClear();
    vault.resolveUserSecretValue.mockClear();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  type Seed = Awaited<ReturnType<typeof seed>>;

  /**
   * A company with one agent and one issue. The agent's last run on the issue finished: the next run
   * does not exist yet. `responsibleUserId` is who that run acted for, `cause` why.
   */
  async function seed(input: { responsibleUserId?: string; cause?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local",
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Wait on a pull request", assigneeAgentId: agentId });
    await db.insert(companyMemberships).values(
      ["A", "B"].map((principalId) => ({
        companyId, principalType: "user", principalId, status: "active", membershipRole: "member",
      })),
    );
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId },
    });
    await initializeRunIdentity(db, {
      companyId, runId, responsibleUserId: input.responsibleUserId ?? "A", cause: input.cause ?? "instruction",
    });
    return { companyId, agentId, issueId, runId };
  }

  /** A GitHub authorization (personal for `user`, or dedicated to the agent) installed for the agent. */
  async function grant(seeded: Seed, user: string, dedicated = false) {
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    const definitionId = randomUUID();
    const id = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: seeded.companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId: seeded.companyId, applicationId, name: connectionId, uid: connectionId,
      transport: "mcp_remote", status: "active", enabled: true,
      credentialPolicy: dedicated ? "per_agent" : "per_user", config: { sourceTemplateKey: "github" },
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: seeded.companyId, connectionId, targetType: "agent", targetId: seeded.agentId,
    });
    if (!dedicated) {
      await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: seeded.companyId, key: definitionId, name: "Test GitHub" });
    }
    await db.insert(companySecrets).values({
      id: secretId, companyId: seeded.companyId, key: secretId, name: `Test token ${secretId}`,
      scope: dedicated ? "company" : "user", ownerUserId: dedicated ? null : user,
      userSecretDefinitionId: dedicated ? null : definitionId,
    });
    await db.insert(connectionGrants).values({
      id, companyId: seeded.companyId, connectionId, kind: dedicated ? "agent" : "user",
      subjectUserId: dedicated ? null : user, subjectAgentId: dedicated ? seeded.agentId : null, status: "active",
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: {
        github: {
          userId: user, login: user, installationCount: 1, repositoryCount: 1,
          repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: [user],
        },
      },
    });
    return { id, connectionId, secretId };
  }

  /** The issue now continues under `user`: a message of theirs steered the running run. */
  async function continueAs(seeded: Seed, user: string) {
    const messageId = randomUUID();
    await db.insert(issueComments).values({
      id: messageId, companyId: seeded.companyId, issueId: seeded.issueId, authorUserId: user, body: "Next instruction",
    });
    const context = await reserveSteeredIdentity(db, { ...seeded, messageId });
    await acceptSteeredIdentity(db, context!);
  }

  async function identityPlugin(seeded: Seed, policy: Record<string, unknown>) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId, pluginKey: `github-${pluginId}`, packageName: "github", version: "1.0.0", status: "ready" as never,
      manifestJson: {
        id: `github-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "GitHub", description: "", author: "",
        categories: ["connector"], capabilities: ["ui.action.register"], entrypoints: { worker: "./worker.js" },
        projectRepositories: { listAction: "list", writeIdentityAction: "repository-write-identity", signCommitAction: "repository-sign-commit" },
      } as never,
    });
    await db.insert(pluginState).values({
      pluginId, scopeKind: "company", scopeId: seeded.companyId, namespace: "identity", stateKey: "write-identity", valueJson: policy,
    });
    const calls: Array<{ key: string; params: Record<string, unknown> }> = [];
    const plugin = {
      pluginId, calls,
      answer: (_key: string, _params: Record<string, unknown>): unknown => ({ identity: "user", missingUserConnection: "fail" }),
    };
    registerGitHubWriteIdentityWorkers({
      call: (async (_id: string, _method: string, request: { key: string; params: Record<string, unknown> }) => {
        calls.push({ key: request.key, params: request.params });
        return plugin.answer(request.key, request.params);
      }) as never,
    });
    return plugin;
  }

  const read = (seeded: Seed, repository = REPOSITORY) =>
    resolveGitHubIssueReadToken(db, { companyId: seeded.companyId, agentId: seeded.agentId, issueId: seeded.issueId, repository });

  describe("the lookup", () => {
    it("finds the personal authorization of the user the issue continues under, where the lookup without that user finds none", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");

      // The old lookup: no responsible user, so no personal authorization can be chosen.
      const withoutUser = createGitRemoteAuthProvider(
        db, seeded.companyId, { issueId: seeded.issueId, agentId: seeded.agentId }, { env: {} },
      );
      await expect(withoutUser(`https://github.com/${REPOSITORY}.git`)).rejects.toThrow("No managed GitHub identity is available");

      expect(await read(seeded)).toBe("test-token-A");
    });

    it("answers as the runtime-tools route answers the same agent's run for a read", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");

      const route = await resolveGitHubOperationCredentials(
        db, seeded, { program: "gh", args: ["api", `repos/${REPOSITORY}/pulls/7`], remote: null },
      );

      expect(route).toMatchObject({ status: "available", login: "A" });
      expect(await read(seeded)).toBe(route.env.GH_TOKEN);
    });

    it("follows the issue when it moves to another user's instruction", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      await grant(seeded, "B");

      expect(await read(seeded)).toBe("test-token-A");
      await continueAs(seeded, "B");
      expect(await read(seeded)).toBe("test-token-B");
      expect(
        (await resolveGitHubOperationCredentials(db, seeded, { program: "gh", args: ["api", `repos/${REPOSITORY}`], remote: null })).env.GH_TOKEN,
      ).toBe("test-token-B");
    });

    it("prefers the agent's dedicated authorization, as the route does", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const dedicated = await grant(seeded, "bot", true);
      vault.state.tokensBySecretId.set(dedicated.secretId, "test-dedicated-bot-token");

      expect(await read(seeded)).toBe("test-dedicated-bot-token");
    });

    it("does not act for a company-default identity or a standing delegation, as the route does not", async () => {
      const seeded = await seed({ responsibleUserId: "A", cause: "company_default" });
      const personal = await grant(seeded, "A");
      await db.insert(connectionGrantDelegations).values({
        companyId: seeded.companyId, grantId: personal.id, agentId: seeded.agentId, createdByUserId: "A",
      });

      const route = await resolveGitHubOperationCredentials(
        db, seeded, { program: "gh", args: ["api", `repos/${REPOSITORY}`], remote: null },
      );
      expect(route.status).not.toBe("available");
      await expect(read(seeded)).rejects.toThrow("No managed GitHub identity is available");
    });

    it("uses a GITHUB_TOKEN company secret when the agent has no managed connection, never the server's own token", async () => {
      const seeded = await seed();
      vi.stubEnv("GITHUB_TOKEN", "server-env-token");
      vi.stubEnv("GH_TOKEN", "server-env-token");
      expect(await read(seeded)).toBeNull();

      const secretId = randomUUID();
      vault.state.namedSecretIds.set("GITHUB_TOKEN", secretId);
      vault.state.tokensBySecretId.set(secretId, "test-company-secret-token");
      expect(await read(seeded)).toBe("test-company-secret-token");
    });

    it("gives no token when there is no credential at all", async () => {
      const seeded = await seed();

      expect(await read(seeded)).toBeNull();
    });

    it("gives a company's agent no token for another company's issue, and uses no other company's authorization", async () => {
      const mine = await seed({ responsibleUserId: "A" });
      const other = await seed({ responsibleUserId: "A" });
      await grant(other, "A");

      // Another company's issue with this company's agent, and the reverse.
      expect(await resolveGitHubIssueReadToken(db, { ...mine, issueId: other.issueId, repository: REPOSITORY })).toBeNull();
      expect(await resolveGitHubIssueReadToken(db, { ...other, agentId: mine.agentId, repository: REPOSITORY })).toBeNull();
      // The company without an authorization finds none in the other one.
      expect(await read(mine)).toBeNull();
      expect(await read(other)).toBe("test-token-A");
    });

    it("gives no token for a low-trust issue, as the route gives none to its run", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      await db.update(issues).set({
        sourceTrust: { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: seeded.issueId },
      }).where(eq(issues.id, seeded.issueId));

      expect(await read(seeded)).toBeNull();
    });

    it.each([
      "acme",
      "acme/app/extra",
      "acme/app@evil.example",
      "acme/ap p",
      "",
    ])("gives no token for the malformed repository %j", async (repository) => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");

      expect(await read(seeded, repository)).toBeNull();
    });
  });

  describe("the company's GitHub write-identity policy", () => {
    const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };

    it("keeps the run's identity and never asks the plugin when the policy is for the run's user", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const plugin = await identityPlugin(seeded, { default: userWrites });

      expect(await read(seeded)).toBe("test-token-A");
      expect(plugin.calls).toEqual([]);
    });

    it("withholds the token while the kill switch is on", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const plugin = await identityPlugin(seeded, { default: userWrites, enabled: false });

      const route = await resolveGitHubOperationCredentials(
        db, seeded, { program: "gh", args: ["api", `repos/${REPOSITORY}`], remote: null },
      );
      expect(route.status).toBe("unavailable");
      expect(await read(seeded)).toBeNull();
      expect(plugin.calls).toEqual([]);
    });

    it("lets the plugin answer for an App-user company, and never uses the run's own identity", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const plugin = await identityPlugin(seeded, {
        default: userWrites, userSource: "app", allowedRepositories: [REPOSITORY], userLogin: "agent-owner",
        installationPermissions: { contents: "write", metadata: "read" },
      });
      plugin.answer = () => ({ identity: "bot", credential: { token: "app-read-token", login: "factory[bot]", userId: "99" } });

      expect(await read(seeded)).toBe("app-read-token");
      expect(plugin.calls).toEqual([{
        key: "repository-write-identity",
        params: {
          companyId: seeded.companyId, repository: REPOSITORY, access: "read", action: null, privileged: [],
          wiki: false, pullRequest: null, expectedHeadSha: null,
        },
      }]);

      // A plugin that refuses, fails or has no token leaves the lookup without one; it does not fall back to user A.
      plugin.answer = () => ({ identity: "bot", unavailable: "Repository not allowed" });
      expect(await read(seeded)).toBeNull();
      plugin.answer = () => { throw new Error("secret-provider-error ghp_leaked"); };
      expect(await read(seeded)).toBeNull();
      plugin.answer = () => ({ identity: "user", credential: { token: null, login: "agent-owner", userId: "5" } });
      expect(await read(seeded)).toBeNull();
    });
  });

  describe("the pull request wake gate with the real lookup", () => {
    /** The gate's fixture: a finished monitor check that started from the pull request as `github` serves it now. */
    async function seedGate(seeded: Seed, github: ReturnType<typeof createFakeGitHubPullRequestApi>) {
      const computed = await computeIssuePullRequestFingerprint(
        db, { ...seeded, pullRequest: PULL_REQUEST }, { fetch: github.fetch, resolveToken: async () => "fixture-token" },
      );
      if (!computed.ok) throw new Error(`fixture fingerprint failed: ${computed.reason}`);
      const startedAt = new Date(Date.now() - 11 * 60_000);
      await db.update(heartbeatRuns).set({
        status: "succeeded",
        startedAt,
        finishedAt: new Date(Date.now() - 10 * 60_000),
        contextSnapshot: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          wakeReason: "issue_monitor_due",
          [PULL_REQUEST_FINGERPRINT_CONTEXT_KEY]: {
            version: computed.fingerprint.version,
            digest: computed.fingerprint.digest,
            computedAt: new Date(startedAt.getTime() - 1_000).toISOString(),
          },
        },
      }).where(eq(heartbeatRuns.id, seeded.runId));
      github.requests.length = 0;
    }

    const evaluate = (seeded: Seed, github: ReturnType<typeof createFakeGitHubPullRequestApi>) =>
      evaluatePullRequestWakeGate(db, { ...seeded, pullRequest: PULL_REQUEST }, { fetch: github.fetch });

    it("skips a wake for an unchanged pull request, and sends the user's token to GitHub", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);
      await seedGate(seeded, github);

      const decision = await evaluate(seeded, github);

      expect(decision).toMatchObject({ outcome: "skip", baselineRunId: seeded.runId });
      expect(github.requests.length).toBeGreaterThan(0);
      for (const request of github.requests) expect(request.authorization).toBe("Bearer test-token-A");
    });

    it("wakes the agent for a changed pull request, with the new fingerprint to store", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);
      await seedGate(seeded, github);
      github.state.headSha = "2222222222222222222222222222222222222222";

      const decision = await evaluate(seeded, github);

      expect(decision).toMatchObject({
        outcome: "wake",
        reason: "pull_request_changed",
        fingerprint: { digest: expect.stringMatching(/^sha256:/) },
      });
    });

    it("keeps the token out of every stored row", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);
      await seedGate(seeded, github);
      github.state.headSha = "3333333333333333333333333333333333333333";

      const decision = await evaluate(seeded, github);
      await evaluate(seeded, github);

      expect(github.requests.map((request) => request.authorization)).toContain("Bearer test-token-A");
      const stored = JSON.stringify({
        decision,
        runs: await db.select().from(heartbeatRuns),
        identities: await db.select().from(runIdentityContexts),
        activity: await db.select().from(activityLog),
        issues: await db.select().from(issues),
      });
      expect(stored).not.toContain("test-token-");
    });

    it("still fails open without calling GitHub when there is no credential", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);
      await seedGate(seeded, github);

      expect(await evaluate(seeded, github)).toMatchObject({ outcome: "wake", reason: "github_credentials_missing", fingerprint: null });
      expect(github.requests).toHaveLength(0);
    });

    it("still fails open when the managed identity cannot be used", async () => {
      const seeded = await seed({ responsibleUserId: "A", cause: "company_default" });
      await grant(seeded, "A");
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);
      await seedGate(seeded, github);

      expect(await evaluate(seeded, github)).toMatchObject({ outcome: "wake", reason: "github_credentials_unavailable", fingerprint: null });
      expect(github.requests).toHaveLength(0);
    });
  });

  describe("the issue's GitHub panel", () => {
    async function seedObject(seeded: Seed) {
      const [object] = await db.insert(externalObjects).values({
        companyId: seeded.companyId, providerKey: "github", objectType: "pull_request", externalId: "acme/app#pull/7",
      }).returning();
      await db.insert(externalObjectMentions).values({
        companyId: seeded.companyId, sourceIssueId: seeded.issueId, sourceKind: "description", objectId: object!.id,
        providerKey: "github", objectType: "pull_request",
      });
      return object!;
    }

    function resolver(github: ReturnType<typeof createFakeGitHubPullRequestApi>) {
      const found = createGitHubExternalObjectProvider(db, {
        fetch: (url, init) => github.fetch(url, init),
      }).resolvers.find((candidate) => candidate.objectType === "pull_request");
      if (!found) throw new Error("no pull request resolver");
      return found;
    }

    it("shows the pull request with the credential of the issue that mentions it, where it showed `Requires auth`", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      await grant(seeded, "A");
      const object = await seedObject(seeded);
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

      const result = await resolver(github).resolve({ companyId: seeded.companyId, object });

      expect(result).toMatchObject({ ok: true, snapshot: { statusKey: "open" } });
      expect(github.requests.length).toBeGreaterThan(0);
      for (const request of github.requests) expect(request.authorization).toBe("Bearer test-token-A");
    });

    it("keeps the company-secret lookup for an object no assigned issue mentions", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      const object = await seedObject(seeded);
      await db.delete(externalObjectMentions).where(eq(externalObjectMentions.objectId, object.id));
      const secretId = randomUUID();
      vault.state.namedSecretIds.set("GITHUB_TOKEN", secretId);
      vault.state.tokensBySecretId.set(secretId, "test-company-secret-token");
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

      const result = await resolver(github).resolve({ companyId: seeded.companyId, object });

      expect(result).toMatchObject({ ok: true });
      for (const request of github.requests) expect(request.authorization).toBe("Bearer test-company-secret-token");
    });

    it("asks for authorization when no credential exists, and when the issue's identity cannot be used", async () => {
      const seeded = await seed({ responsibleUserId: "A" });
      const object = await seedObject(seeded);
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

      expect(await resolver(github).resolve({ companyId: seeded.companyId, object })).toMatchObject({
        ok: false, liveness: "auth_required", errorCode: "github_token_missing",
      });

      await grant(seeded, "B");
      expect(await resolver(github).resolve({ companyId: seeded.companyId, object })).toMatchObject({
        ok: false, liveness: "auth_required", errorCode: "github_token_unavailable",
      });
      expect(github.requests).toHaveLength(0);
    });

    it("does not use another company's issue to read a pull request", async () => {
      const mine = await seed({ responsibleUserId: "A" });
      const other = await seed({ responsibleUserId: "A" });
      await grant(other, "A");
      const object = await seedObject(other);
      const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

      // The object belongs to the other company, but is resolved for this one: its mentions are not this company's.
      const result = await resolver(github).resolve({ companyId: mine.companyId, object });

      expect(result).toMatchObject({ ok: false, errorCode: "github_token_missing" });
      expect(github.requests).toHaveLength(0);
    });

    describe("a mention in low-trust text", () => {
      /** The object is mentioned by a comment or document of the issue with this trust, and by nothing else. */
      async function mentionedBy(seeded: Seed, kind: "comment" | "document", disposition: "quarantined" | "promoted") {
        const [object] = await db.insert(externalObjects).values({
          companyId: seeded.companyId, providerKey: "github", objectType: "pull_request", externalId: "acme/app#pull/7",
        }).returning();
        const sourceTrust = { preset: LOW_TRUST_REVIEW_PRESET, disposition, sourceIssueId: seeded.issueId };
        const sourceRecordId = randomUUID();
        if (kind === "comment") {
          await db.insert(issueComments).values({
            id: sourceRecordId, companyId: seeded.companyId, issueId: seeded.issueId, body: "https://github.com/acme/app/pull/7", sourceTrust,
          });
        } else {
          await db.insert(documents).values({
            id: sourceRecordId, companyId: seeded.companyId, latestBody: "https://github.com/acme/app/pull/7", sourceTrust,
          });
        }
        await db.insert(externalObjectMentions).values({
          companyId: seeded.companyId, sourceIssueId: seeded.issueId, sourceKind: kind, sourceRecordId, objectId: object!.id,
          providerKey: "github", objectType: "pull_request",
        });
        return object!;
      }

      /** A second agent and issue of the seeded company; its latest run acted for `responsibleUserId`. */
      async function seedSibling(seeded: Seed, responsibleUserId: string): Promise<Seed> {
        const agentId = randomUUID();
        const issueId = randomUUID();
        const runId = randomUUID();
        await db.insert(agents).values({
          id: agentId, companyId: seeded.companyId, name: "Sibling", role: "engineer", adapterType: "codex_local",
        });
        await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: "Sibling", assigneeAgentId: agentId });
        await db.insert(heartbeatRuns).values({
          id: runId, companyId: seeded.companyId, agentId, status: "running", contextSnapshot: { issueId },
        });
        await initializeRunIdentity(db, { companyId: seeded.companyId, runId, responsibleUserId, cause: "instruction" });
        return { companyId: seeded.companyId, agentId, issueId, runId };
      }

      it.each(["comment", "document"] as const)(
        "gives an object that only a quarantined %s mentions no token, not even the company secret",
        async (kind) => {
          const seeded = await seed({ responsibleUserId: "A" });
          await grant(seeded, "A");
          const secretId = randomUUID();
          vault.state.namedSecretIds.set("GITHUB_TOKEN", secretId);
          vault.state.tokensBySecretId.set(secretId, "test-company-secret-token");
          const object = await mentionedBy(seeded, kind, "quarantined");
          const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

          const result = await resolver(github).resolve({ companyId: seeded.companyId, object });

          expect(result).toMatchObject({ ok: false, liveness: "auth_required", errorCode: "github_token_missing" });
          expect(github.requests).toHaveLength(0);
        },
      );

      it.each(["comment", "document"] as const)(
        "reads with the grant of a %s that was promoted, where the same text quarantined gets none",
        async (kind) => {
          const seeded = await seed({ responsibleUserId: "A" });
          await grant(seeded, "A");
          const object = await mentionedBy(seeded, kind, "promoted");
          const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

          const result = await resolver(github).resolve({ companyId: seeded.companyId, object });

          expect(result).toMatchObject({ ok: true });
          for (const request of github.requests) expect(request.authorization).toBe("Bearer test-token-A");
        },
      );

      it("does not let a quarantined comment of a newer issue choose the grant over an issue whose description mentions it", async () => {
        const quarantined = await seed({ responsibleUserId: "A" });
        await grant(quarantined, "A");
        const trusted = await seedSibling(quarantined, "B");
        await grant(trusted, "B");
        const object = await mentionedBy(quarantined, "comment", "quarantined");
        await db.insert(externalObjectMentions).values({
          companyId: trusted.companyId, sourceIssueId: trusted.issueId, sourceKind: "description", objectId: object.id,
          providerKey: "github", objectType: "pull_request",
        });
        // The quarantined issue is the newest one, so it would be tried first if its mention counted.
        await db.update(issues).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(issues.id, quarantined.issueId));
        const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

        const result = await resolver(github).resolve({ companyId: trusted.companyId, object });

        expect(result).toMatchObject({ ok: true });
        expect(github.requests.length).toBeGreaterThan(0);
        for (const request of github.requests) expect(request.authorization).toBe("Bearer test-token-B");
      });

      it("keeps an issue whose description mentions the object when one of its own comments does so in quarantine", async () => {
        const seeded = await seed({ responsibleUserId: "A" });
        await grant(seeded, "A");
        const object = await mentionedBy(seeded, "comment", "quarantined");
        await db.insert(externalObjectMentions).values({
          companyId: seeded.companyId, sourceIssueId: seeded.issueId, sourceKind: "description", objectId: object.id,
          providerKey: "github", objectType: "pull_request",
        });
        const github = createFakeGitHubPullRequestApi(PULL_REQUEST);

        const result = await resolver(github).resolve({ companyId: seeded.companyId, object });

        expect(result).toMatchObject({ ok: true });
        for (const request of github.requests) expect(request.authorization).toBe("Bearer test-token-A");
      });
    });
  });
});
