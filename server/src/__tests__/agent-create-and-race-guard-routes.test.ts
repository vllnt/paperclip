import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent create and race guard route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_key" };
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

const LARGE_ADAPTER_CONFIG = { model: "large-model", cwd: "/tmp/agent-guard" };

describeEmbeddedPostgres("agent-authored creates and the PATCH stale-snapshot race", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-create-race-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`truncate table companies, agents cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(input: { requireBoardApprovalForNewAgents?: boolean } = {}) {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Create guard ${randomUUID()}`,
        issuePrefix: `CG${randomUUID().slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: input.requireBoardApprovalForNewAgents ?? false,
      })
      .returning();
    return company!.id;
  }

  /** Seeds an active agent that may create agents (`canCreateAgents`). */
  async function seedAgent(companyId: string, input: { adapterConfig?: Record<string, unknown> } = {}) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Creator ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: input.adapterConfig ?? LARGE_ADAPTER_CONFIG,
        runtimeConfig: {},
        budgetMonthlyCents: 1_000,
        permissions: { canCreateAgents: true },
      })
      .returning();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    return agent!.id;
  }

  async function grantConfigure(companyId: string, agentId: string) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "agents:configure",
      scope: null,
      grantedByUserId: null,
    });
  }

  async function agentCount(companyId: string) {
    return (await db.select().from(agents).where(eq(agents.companyId, companyId))).length;
  }

  async function childPermissions(companyId: string, creatorId: string | null) {
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    return rows.find((row) => row.id !== creatorId)!.permissions;
  }

  async function deniedForCompany(companyId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, companyId), eq(activityLog.action, "agent.self_config_update_denied")));
  }

  async function deniedForAgent(agentId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.self_config_update_denied")));
  }

  async function readAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  }

  const PROTECTED_CREATES = [
    {
      label: "heartbeat caps",
      body: { runtimeConfig: { heartbeat: { maxDailyRuns: 100_000, maxConcurrentRuns: 50 } } },
      fields: ["runtimeConfig.heartbeat.maxConcurrentRuns", "runtimeConfig.heartbeat.maxDailyRuns"],
    },
    {
      label: "model and effort",
      body: { adapterConfig: { model: "huge-model", effort: "max" } },
      fields: ["adapterConfig.effort", "adapterConfig.model"],
    },
    { label: "budget", body: { budgetMonthlyCents: 9_999_999 }, fields: ["budgetMonthlyCents"] },
    {
      label: "a permission bypass flag",
      body: { adapterConfig: { dangerouslySkipPermissions: true } },
      fields: ["adapterConfig.dangerouslySkipPermissions"],
    },
    {
      label: "the canCreateAgents permission",
      body: { permissions: { canCreateAgents: true } },
      fields: ["permissions.canCreateAgents"],
    },
    { label: "the ceo role", body: { role: "ceo" }, fields: ["role"] },
  ];

  describe.each([
    { surface: "agent_create", path: (companyId: string) => `/api/companies/${companyId}/agents` },
    { surface: "agent_hire", path: (companyId: string) => `/api/companies/${companyId}/agent-hires` },
  ])("$surface", ({ surface, path }) => {
    it.each(PROTECTED_CREATES)("denies an agent supplying $label, creates nothing, and logs it", async ({ body, fields }) => {
      const companyId = await seedCompany();
      const creatorId = await seedAgent(companyId);

      const res = await request(createApp(db, agentActor(companyId, creatorId)))
        .post(path(companyId))
        .send({ name: "Child", adapterType: "process", ...body });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change", fields });
      expect(await agentCount(companyId)).toBe(1);
      expect((await deniedForCompany(companyId))[0]).toMatchObject({
        companyId,
        actorType: "agent",
        actorId: creatorId,
        agentId: creatorId,
        entityType: "company",
        details: { surface, fields, reason: "deny_no_grant" },
      });
    });

    it("still lets an agent create an agent with no protected settings", async () => {
      const companyId = await seedCompany();
      const creatorId = await seedAgent(companyId);

      const res = await request(createApp(db, agentActor(companyId, creatorId)))
        .post(path(companyId))
        .send({
          name: "Child",
          role: "engineer",
          title: "Builder",
          adapterType: "process",
          adapterConfig: { cwd: "/tmp/child" },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await agentCount(companyId)).toBe(2);
      expect(await deniedForCompany(companyId)).toHaveLength(0);
      expect(await childPermissions(companyId, creatorId)).toMatchObject({ canCreateAgents: false });
    });

    it("keeps today's behaviour for an agent holding company-wide agents:configure", async () => {
      const companyId = await seedCompany();
      const creatorId = await seedAgent(companyId);
      await grantConfigure(companyId, creatorId);

      const res = await request(createApp(db, agentActor(companyId, creatorId)))
        .post(path(companyId))
        .send({
          name: "Child",
          adapterType: "process",
          adapterConfig: { model: "huge-model" },
          runtimeConfig: { heartbeat: { maxDailyRuns: 100_000 } },
          budgetMonthlyCents: 9_999_999,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await deniedForCompany(companyId)).toHaveLength(0);
    });

    it("keeps a board caller unchanged", async () => {
      const companyId = await seedCompany();

      const res = await request(createApp(db, boardActor(companyId)))
        .post(path(companyId))
        .send({
          name: "Child",
          adapterType: "process",
          adapterConfig: { model: "huge-model" },
          budgetMonthlyCents: 9_999_999,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await deniedForCompany(companyId)).toHaveLength(0);
      expect(await childPermissions(companyId, null)).toMatchObject({ canCreateAgents: true });
    });
  });

  it("does not check a hire that waits for board approval, since the board sees the exact payload", async () => {
    const companyId = await seedCompany({ requireBoardApprovalForNewAgents: true });
    const creatorId = await seedAgent(companyId);

    const res = await request(createApp(db, agentActor(companyId, creatorId)))
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({ name: "Child", adapterType: "process", adapterConfig: { model: "huge-model" }, budgetMonthlyCents: 9_999_999 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body.agent ?? res.body).status).toBe("pending_approval");
    expect(await deniedForCompany(companyId)).toHaveLength(0);
  });

  /**
   * Holds a board update to the agent row open in a transaction, sends the
   * agent's request (which has already read the old row by the time it needs
   * the row lock), waits until that request is blocked on the lock, then commits
   * the board update so the request resumes against the new committed row.
   */
  async function withConcurrentBoardUpdate(
    agentId: string,
    boardUpdate: Partial<typeof agents.$inferInsert>,
    send: () => PromiseLike<request.Response>,
  ) {
    let boardUpdateHeld!: () => void;
    const held = new Promise<void>((resolve) => { boardUpdateHeld = resolve; });
    let commitBoardUpdate!: () => void;
    const commit = new Promise<void>((resolve) => { commitBoardUpdate = resolve; });
    const boardTransaction = db.transaction(async (tx) => {
      await tx.update(agents).set(boardUpdate).where(eq(agents.id, agentId));
      boardUpdateHeld();
      await commit;
    });
    await held;
    const pending = Promise.resolve(send());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`);
      const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ n: number }>;
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    commitBoardUpdate();
    await boardTransaction;
    return pending;
  }

  it("refuses an agent's safe-looking PATCH that would put back a value the board just lowered", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const res = await withConcurrentBoardUpdate(
      agentId,
      { adapterConfig: { model: "small-model", cwd: LARGE_ADAPTER_CONFIG.cwd } },
      () => request(createApp(db, agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { search: true } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "agent_config_changed_concurrently",
      fields: ["adapterConfig.model"],
    });
    expect((await readAgent(agentId)).adapterConfig).toEqual({ model: "small-model", cwd: LARGE_ADAPTER_CONFIG.cwd });
    expect((await deniedForAgent(agentId))[0]).toMatchObject({ details: { surface: "patch_conflict" } });
  });

  it("lets the same agent PATCH succeed when no protected value changed concurrently", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const res = await withConcurrentBoardUpdate(
      agentId,
      { title: "Edited by the board" },
      () => request(createApp(db, agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { search: true } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readAgent(agentId)).toMatchObject({
      title: "Edited by the board",
      adapterConfig: { ...LARGE_ADAPTER_CONFIG, search: true },
    });
    expect(await deniedForAgent(agentId)).toHaveLength(0);
  });

  it("keeps today's behaviour in that race for an agent holding agents:configure", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await grantConfigure(companyId, agentId);

    const res = await withConcurrentBoardUpdate(
      agentId,
      { adapterConfig: { model: "small-model", cwd: LARGE_ADAPTER_CONFIG.cwd } },
      () => request(createApp(db, agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { search: true } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await deniedForAgent(agentId)).toHaveLength(0);
  });

  it("refuses an agent's rollback that would restore a value the board just lowered", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({ title: "First edit" })
      .expect(200);
    const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));

    const res = await withConcurrentBoardUpdate(
      agentId,
      { adapterConfig: { model: "small-model", cwd: LARGE_ADAPTER_CONFIG.cwd } },
      () => request(createApp(db, agentActor(companyId, agentId)))
        .post(`/api/agents/${agentId}/config-revisions/${revision!.id}/rollback`)
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "agent_config_changed_concurrently", fields: ["adapterConfig.model"] });
    expect((await readAgent(agentId)).adapterConfig).toEqual({ model: "small-model", cwd: LARGE_ADAPTER_CONFIG.cwd });
  });
});
