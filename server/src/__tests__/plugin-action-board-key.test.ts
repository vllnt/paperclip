import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { boardAuthService, hashBearerToken } from "../services/board-auth.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin action board-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const PLUGIN_KEY = "vllnt.paperclip-github";

const FIXTURE_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-invocation-scope.cjs",
);

const eventBusStub = {
  forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }),
} as never;

async function seed(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `Plugin Co ${nonce}`,
      issuePrefix: `P${nonce.slice(0, 3).toUpperCase()}`,
      defaultResponsibleUserId: "member-user",
    })
    .returning();
  const now = new Date();
  for (const id of ["admin-user", "member-user"]) {
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: id,
      membershipRole: "owner",
      status: "active",
    });
  }
  await db.insert(instanceUserRoles).values({ userId: "admin-user", role: "instance_admin" });
  const [plugin] = await db
    .insert(plugins)
    .values({
      pluginKey: PLUGIN_KEY,
      packageName: "@vllnt/paperclip-github",
      version: "1.0.0",
      manifestJson: { id: PLUGIN_KEY } as never,
      status: "ready",
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: "Builder", role: "general", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
    .returning();
  const boardAuth = boardAuthService(db);
  const adminKey = await boardAuth.createNamedBoardApiKey({ userId: "admin-user", name: "operator automation" });
  const memberKey = await boardAuth.createNamedBoardApiKey({ userId: "member-user", name: "member automation" });
  const agentToken = `pcp_agent_${randomUUID().replace(/-/g, "")}`;
  await db.insert(agentApiKeys).values({
    agentId: agent!.id,
    companyId: company!.id,
    name: "agent key",
    keyHash: hashBearerToken(agentToken),
    responsibleUserId: "member-user",
  });
  return { company: company!, plugin: plugin!, agent: agent!, adminKey, memberKey, agentToken };
}

type AuthOutcome = { actor: Express.Request["actor"] } | { error: unknown };

/**
 * Runs the real `actorMiddleware` against the real database for one bearer
 * token and returns what it produced: the actor, or the error it passed to
 * `next`. It is called directly instead of being mounted on the test app, so
 * the test app registers no authorizing route handler of its own.
 */
async function authenticate(db: Db, path: string, token: string): Promise<AuthOutcome> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const req = {
    method: "POST",
    path,
    originalUrl: path,
    actor: undefined as Express.Request["actor"] | undefined,
    header: (name: string) => headers[name.toLowerCase()],
  };
  return new Promise<AuthOutcome>((resolve) => {
    void actorMiddleware(db, { deploymentMode: "authenticated" })(req as never, {} as never, (error?: unknown) => {
      resolve(error ? { error } : { actor: req.actor as Express.Request["actor"] });
    });
  });
}

/** The real plugin routes, called as the actor (or failing with the error) that `authenticate` produced. */
function createApp(db: Db, call: ReturnType<typeof vi.fn>, auth: AuthOutcome) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if ("error" in auth) {
      next(auth.error);
      return;
    }
    req.actor = auth.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(db, { installPlugin: vi.fn() } as never, undefined, undefined, undefined, {
      workerManager: { call },
    } as never),
  );
  app.use(errorHandler);
  return app;
}

/** POSTs a plugin action authenticated by `token`, through the real middleware and routes. */
async function postAction(
  db: Db,
  call: ReturnType<typeof vi.fn>,
  token: string,
  key: string,
  body: Record<string, unknown>,
) {
  const path = `/api/plugins/${PLUGIN_KEY}/actions/${key}`;
  const app = createApp(db, call, await authenticate(db, path, token));
  return request(app).post(path).set("Authorization", `Bearer ${token}`).send(body);
}

describeEmbeddedPostgres("plugin actions called with a board API key", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-action-board-key-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(boardApiKeys);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(instanceUserRoles);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reaches the plugin as the key's board user, with instance admin and the authorized company", async () => {
    const { company, adminKey } = await seed(db);
    const call = vi.fn().mockResolvedValue({ ok: true });

    const res = await postAction(db, call, adminKey.token, "write-identity.get", {
      companyId: company.id,
      params: { companyId: "spoofed" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(call).toHaveBeenCalledWith(expect.any(String), "performAction", {
      key: "write-identity.get",
      params: { companyId: company.id },
      actorContext: {
        type: "user",
        userId: "admin-user",
        agentId: null,
        runId: null,
        companyId: company.id,
        isInstanceAdmin: true,
        keyId: adminKey.id,
        source: "board_key",
      },
      renderEnvironment: null,
    });
  });

  it("omits instance admin for a key whose user is not an instance admin", async () => {
    const { company, memberKey } = await seed(db);
    const call = vi.fn().mockResolvedValue({ ok: true });

    const res = await postAction(db, call, memberKey.token, "repositories.list", { companyId: company.id, params: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(call.mock.calls[0]?.[2]?.actorContext).toEqual({
      type: "user",
      userId: "member-user",
      agentId: null,
      runId: null,
      companyId: company.id,
      keyId: memberKey.id,
      source: "board_key",
    });
  });

  it("requires instance admin for a call without a company", async () => {
    const { memberKey } = await seed(db);
    const call = vi.fn();

    const res = await postAction(db, call, memberKey.token, "sync.trigger", { params: {} });

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards an agent key as an agent actor, which board-only plugin actions refuse", async () => {
    const { company, agent, agentToken } = await seed(db);
    const call = vi.fn().mockResolvedValue({ ok: true });

    const res = await postAction(db, call, agentToken, "write-identity.get", { companyId: company.id, params: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(call.mock.calls[0]?.[2]?.actorContext).toMatchObject({ type: "agent", agentId: agent.id, userId: null });
  });

  it("names the credential that called, with its kind and no key material, in every actor context", async () => {
    const { company, adminKey, memberKey, agentToken } = await seed(db);
    const call = vi.fn().mockResolvedValue({ ok: true });

    await postAction(db, call, adminKey.token, "write-identity.get", { companyId: company.id, params: {} });
    await postAction(db, call, memberKey.token, "write-identity.get", { companyId: company.id, params: {} });
    await postAction(db, call, agentToken, "write-identity.get", { companyId: company.id, params: {} });

    const contexts = call.mock.calls.map((args) => args[2]?.actorContext);
    expect(contexts.map((context) => context?.source)).toEqual(["board_key", "board_key", "agent_key"]);
    expect(contexts[0]?.keyId).toBe(adminKey.id);
    expect(contexts[1]?.keyId).toBe(memberKey.id);
    expect(contexts[2]?.keyId).toEqual(expect.any(String));
    expect(new Set(contexts.map((context) => context?.keyId)).size).toBe(3);
    const serialized = JSON.stringify(contexts);
    for (const secret of [adminKey.token, memberKey.token, agentToken]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(hashBearerToken(secret));
    }
  });

  /**
   * Starts a real plugin worker handle on the fixture worker, with the real host
   * services behind it, and returns a `call` that the plugin routes use. The fixture
   * serves each action by making one `activity.log` call to the host, as a plugin
   * does when it records what it changed.
   */
  async function startAuditedWorker(pluginRow: { id: string }) {
    const services = buildHostServices(db, pluginRow.id, PLUGIN_KEY, eventBusStub);
    const handle = createPluginWorkerHandle(pluginRow.id, {
      entrypointPath: FIXTURE_WORKER,
      manifest: {
        id: PLUGIN_KEY,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Audit fixture",
        description: "Audit fixture",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["activity.log.write"],
        entrypoints: { worker: "dist/worker.js" },
      },
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: createHostClientHandlers({
        pluginId: PLUGIN_KEY,
        capabilities: ["activity.log.write"],
        services,
      }),
    });
    await handle.start();
    const call = vi.fn((_pluginId: string, method: string, params: unknown) => handle.call(method, params as never));
    return { call, stop: () => handle.stop().catch(() => undefined), dispose: () => services.dispose() };
  }

  it("records which key ran a plugin action in the plugin's activity row, without key material", async () => {
    const { company, plugin, agent, adminKey, memberKey, agentToken } = await seed(db);
    const worker = await startAuditedWorker(plugin);
    const message = "GitHub write identity updated";
    const body = (extra: Record<string, unknown> = {}) => ({
      companyId: company.id,
      params: {
        mode: "echo",
        hostMethod: "activity.log",
        requestedCompanyId: company.id,
        message,
        metadata: { enabled: true, ...extra },
      },
    });

    try {
      for (const [token, extra] of [
        [adminKey.token, { initiatingKeyId: "forged-key", initiatingSource: "forged-source" }],
        [memberKey.token, {}],
        [agentToken, {}],
      ] as const) {
        const res = await postAction(db, worker.call, token, "write-identity.set", body(extra));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
    } finally {
      await worker.stop();
      worker.dispose();
    }

    const rows = await db.select().from(activityLog).where(eq(activityLog.action, message));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.actorType).toBe("plugin");
      expect(row.actorId).toBe(plugin.id);
    }
    const detailsOf = (userId: string | null, agentId: string | null) =>
      rows
        .map((row) => row.details as Record<string, unknown>)
        .find((details) => details.initiatingUserId === userId && details.initiatingAgentId === agentId);

    expect(detailsOf("admin-user", null)).toMatchObject({
      initiatingActorType: "user",
      initiatingActorId: "admin-user",
      initiatingKeyId: adminKey.id,
      initiatingSource: "board_key",
      enabled: true,
    });
    expect(detailsOf("member-user", null)).toMatchObject({
      initiatingKeyId: memberKey.id,
      initiatingSource: "board_key",
    });
    expect(detailsOf(null, agent.id)).toMatchObject({
      initiatingActorType: "agent",
      initiatingSource: "agent_key",
    });
    const keyIds = rows.map((row) => (row.details as Record<string, unknown>).initiatingKeyId);
    expect(new Set(keyIds).size).toBe(3);
    expect(keyIds).not.toContain("forged-key");
    const serialized = JSON.stringify(rows);
    for (const secret of [adminKey.token, memberKey.token, agentToken]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(hashBearerToken(secret));
    }
  }, 60_000);

  it("rejects a revoked board key", async () => {
    const { company, adminKey } = await seed(db);
    await boardAuthService(db).revokeBoardApiKey(adminKey.id);
    const call = vi.fn();

    const res = await postAction(db, call, adminKey.token, "write-identity.get", { companyId: company.id, params: {} });

    expect(res.status).toBe(401);
    expect(call).not.toHaveBeenCalled();
  });
});
