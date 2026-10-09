import { randomUUID } from "node:crypto";
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
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { boardAuthService, hashBearerToken } from "../services/board-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin action board-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const PLUGIN_KEY = "vllnt.paperclip-github";

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

  it("rejects a revoked board key", async () => {
    const { company, adminKey } = await seed(db);
    await boardAuthService(db).revokeBoardApiKey(adminKey.id);
    const call = vi.fn();

    const res = await postAction(db, call, adminKey.token, "write-identity.get", { companyId: company.id, params: {} });

    expect(res.status).toBe(401);
    expect(call).not.toHaveBeenCalled();
  });
});
