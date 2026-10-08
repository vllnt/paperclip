import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companyMemberships,
  costEvents,
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
    `Skipping agent self-config guard route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const STORED_RUNTIME_CONFIG = {
  heartbeat: { enabled: true, intervalSec: 3600, maxConcurrentRuns: 1, maxDailyRuns: 5 },
};
const STORED_ADAPTER_CONFIG = { model: "small-model", effort: "low", cwd: "/tmp/agent-self-config" };

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

async function seedAgent(
  db: Db,
  input: { role?: string; status?: string; permissions?: Record<string, unknown> } = {},
) {
  const [company] = await db
    .insert(companies)
    .values({
      name: `Self config ${randomUUID()}`,
      issuePrefix: `SC${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: `Worker ${randomUUID().slice(0, 8)}`,
      role: input.role ?? "engineer",
      status: input.status ?? "idle",
      adapterType: "process",
      adapterConfig: STORED_ADAPTER_CONFIG,
      runtimeConfig: STORED_RUNTIME_CONFIG,
      budgetMonthlyCents: 1_000,
      permissions: input.permissions ?? {},
    })
    .returning();
  await db.insert(companyMemberships).values({
    companyId: company!.id,
    principalType: "agent",
    principalId: agent!.id,
    status: "active",
    membershipRole: "member",
  });
  await db.insert(costEvents).values({
    companyId: company!.id,
    agentId: agent!.id,
    provider: "test",
    model: "small-model",
    costCents: 700,
    occurredAt: new Date(),
  });
  return { companyId: company!.id, agentId: agent!.id };
}

async function seedPeer(db: Db, companyId: string) {
  const [peer] = await db
    .insert(agents)
    .values({
      companyId,
      name: `Peer ${randomUUID().slice(0, 8)}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning();
  return peer!.id;
}

async function grantAgentConfigure(db: Db, companyId: string, agentId: string, scope: Record<string, unknown> | null) {
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey: "agents:configure",
    scope,
    grantedByUserId: null,
  });
}

async function readAgent(db: Db, agentId: string) {
  return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
}

async function deniedActivity(db: Db, agentId: string) {
  return db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.self_config_update_denied")));
}

describeEmbeddedPostgres("agent self-config guard routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-self-config-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each([
    {
      label: "runtimeConfig.heartbeat.maxDailyRuns",
      body: { runtimeConfig: { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 500 } } },
      fields: ["runtimeConfig.heartbeat.maxDailyRuns"],
    },
    {
      label: "runtimeConfig.heartbeat.maxConcurrentRuns",
      body: { runtimeConfig: { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxConcurrentRuns: 20 } } },
      fields: ["runtimeConfig.heartbeat.maxConcurrentRuns"],
    },
    {
      label: "runtimeConfig.aiConnection",
      body: {
        runtimeConfig: {
          ...STORED_RUNTIME_CONFIG,
          aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        },
      },
      fields: ["runtimeConfig.aiConnection"],
    },
    { label: "adapterConfig.model", body: { adapterConfig: { model: "large-model" } }, fields: ["adapterConfig.model"] },
    { label: "adapterConfig.effort", body: { adapterConfig: { effort: "max" } }, fields: ["adapterConfig.effort"] },
    {
      label: "adapterConfig.extraArgs",
      body: { adapterConfig: { extraArgs: ["--model", "large-model"] } },
      fields: ["adapterConfig.extraArgs"],
    },
    {
      label: "adapterType",
      body: { adapterType: "claude_local" },
      fields: ["adapterType", "adapterConfig.model", "adapterConfig.effort"],
    },
    { label: "budgetMonthlyCents", body: { budgetMonthlyCents: 1_000_000 }, fields: ["budgetMonthlyCents"] },
    { label: "spentMonthlyCents", body: { spentMonthlyCents: 0 }, fields: ["spentMonthlyCents"] },
    { label: "role (mixed with another field)", body: { role: "ceo", metadata: { note: "promoted" } }, fields: ["role"] },
  ])("denies an agent changing its own $label and logs the attempt", async ({ body, fields }) => {
    const { companyId, agentId } = await seedAgent(db);
    const before = await readAgent(db, agentId);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Agents cannot change their own run limits, budget, model, role, or permissions");
    expect(res.body.error).toContain(fields[0]);
    expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change", fields });

    const after = await readAgent(db, agentId);
    expect(after).toMatchObject({
      adapterType: before.adapterType,
      adapterConfig: before.adapterConfig,
      runtimeConfig: before.runtimeConfig,
      budgetMonthlyCents: before.budgetMonthlyCents,
      spentMonthlyCents: before.spentMonthlyCents,
      role: before.role,
      metadata: before.metadata,
    });

    const denied = await deniedActivity(db, agentId);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      entityType: "agent",
      details: { surface: "patch", fields, reason: "deny_no_grant" },
    });
  });

  it("denies a paused agent un-pausing itself through PATCH", async () => {
    const { companyId, agentId } = await seedAgent(db, { status: "paused" });

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ status: "idle" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual(["status"]);
    expect((await readAgent(db, agentId)).status).toBe("paused");
  });

  it("denies an agent dropping its own heartbeat caps by replacing runtimeConfig", async () => {
    const { companyId, agentId } = await seedAgent(db);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual([
      "runtimeConfig.heartbeat.enabled",
      "runtimeConfig.heartbeat.intervalSec",
      "runtimeConfig.heartbeat.maxConcurrentRuns",
      "runtimeConfig.heartbeat.maxDailyRuns",
    ]);
    expect((await readAgent(db, agentId)).runtimeConfig).toEqual(STORED_RUNTIME_CONFIG);
  });

  it("denies an agent rolling its own config back to a revision with higher caps", async () => {
    const { companyId, agentId } = await seedAgent(db);
    const board = createApp(db, boardActor(companyId));
    await request(board)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 50 } } })
      .expect(200);
    await request(board)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 2 } } })
      .expect(200);
    const [higherCapRevision] = await db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId))
      .orderBy(agentConfigRevisions.createdAt)
      .limit(1);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .post(`/api/agents/${agentId}/config-revisions/${higherCapRevision!.id}/rollback`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual(["runtimeConfig.heartbeat.maxDailyRuns"]);
    expect((await readAgent(db, agentId)).runtimeConfig).toMatchObject({ heartbeat: { maxDailyRuns: 2 } });
    const denied = await deniedActivity(db, agentId);
    expect(denied[0]?.details).toMatchObject({ surface: "config_rollback" });
  });

  it("denies a CEO agent changing its own permissions but not a peer's or an unchanged resubmit", async () => {
    const storedPermissions = { canCreateAgents: false, canCreateSkills: true, canAssignTasks: true };
    const { companyId, agentId } = await seedAgent(db, { role: "ceo", permissions: storedPermissions });
    const peerId = await seedPeer(db, companyId);
    const app = createApp(db, agentActor(companyId, agentId));
    const body = { canCreateAgents: true, canAssignTasks: true };

    const self = await request(app).patch(`/api/agents/${agentId}/permissions`).send(body);

    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(self.body.details.fields).toEqual(["permissions.canCreateAgents"]);
    expect((await readAgent(db, agentId)).permissions).toEqual(storedPermissions);
    const denied = await deniedActivity(db, agentId);
    expect(denied[0]?.details).toMatchObject({ surface: "permissions" });

    const unchanged = await request(app).patch(`/api/agents/${agentId}/permissions`).send(storedPermissions);
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);

    const peer = await request(app).patch(`/api/agents/${peerId}/permissions`).send(body);
    expect(peer.status, JSON.stringify(peer.body)).toBe(200);
  });

  it("still lets an agent change its own non-protected fields", async () => {
    const { companyId, agentId } = await seedAgent(db);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { cwd: "/tmp/agent-self-config-next" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAgent(db, agentId)).adapterConfig).toEqual({
      ...STORED_ADAPTER_CONFIG,
      cwd: "/tmp/agent-self-config-next",
    });
    expect(await deniedActivity(db, agentId)).toHaveLength(0);
  });

  it("still lets an agent resubmit its own protected fields unchanged", async () => {
    const { companyId, agentId } = await seedAgent(db);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: STORED_ADAPTER_CONFIG,
        runtimeConfig: STORED_RUNTIME_CONFIG,
        budgetMonthlyCents: 1_000,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await deniedActivity(db, agentId)).toHaveLength(0);
  });

  it("lets a board actor change the agent's caps, model, and budget", async () => {
    const { companyId, agentId } = await seedAgent(db);

    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: { model: "large-model", effort: "high" },
        runtimeConfig: { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 50, maxConcurrentRuns: 3 } },
        budgetMonthlyCents: 5_000,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readAgent(db, agentId);
    expect(after.adapterConfig).toMatchObject({ model: "large-model", effort: "high" });
    expect(after.runtimeConfig).toMatchObject({ heartbeat: { maxDailyRuns: 50, maxConcurrentRuns: 3 } });
    expect(after.budgetMonthlyCents).toBe(5_000);
  });

  it.each([
    { label: "company-wide", scope: null },
    { label: "scoped to itself", scope: "self" },
  ])("keeps today's behaviour for an agent holding a $label agents:configure grant", async ({ scope }) => {
    const { companyId, agentId } = await seedAgent(db);
    await grantAgentConfigure(db, companyId, agentId, scope === "self" ? { agentIds: [agentId] } : null);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: { model: "large-model" },
        runtimeConfig: { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 50 } },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readAgent(db, agentId);
    expect(after.adapterConfig).toMatchObject({ model: "large-model" });
    expect(after.runtimeConfig).toMatchObject({ heartbeat: { maxDailyRuns: 50 } });
    expect(await deniedActivity(db, agentId)).toHaveLength(0);
  });
});
