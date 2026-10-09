import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  environments,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
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

function createAccessApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
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
  input: {
    role?: string;
    status?: string;
    permissions?: Record<string, unknown>;
    adapterConfig?: Record<string, unknown>;
    defaultEnvironmentId?: string | null;
  } = {},
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
      adapterConfig: input.adapterConfig ?? STORED_ADAPTER_CONFIG,
      runtimeConfig: STORED_RUNTIME_CONFIG,
      defaultEnvironmentId: input.defaultEnvironmentId ?? null,
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

async function seedLocalEnvironment(db: Db) {
  const [environment] = await db
    .insert(environments)
    .values({ name: `Local ${randomUUID()}`, driver: "local" })
    .returning();
  return environment!.id;
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

async function findRevision(db: Db, agentId: string, matches: (afterConfig: Record<string, unknown>) => boolean) {
  const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
  const revision = revisions.find((row) => matches(row.afterConfig));
  if (!revision) throw new Error("revision not found");
  return revision;
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
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(agents);
    await db.delete(environments);
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
      label: "runtimeConfig.sessionCompaction",
      body: {
        runtimeConfig: { ...STORED_RUNTIME_CONFIG, sessionCompaction: { maxRawInputTokens: 10_000_000 } },
      },
      fields: ["runtimeConfig.sessionCompaction.maxRawInputTokens"],
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
      fields: ["adapterType", "adapterConfig.effort", "adapterConfig.model"],
    },
    {
      label: "adapterConfig.env",
      body: { adapterConfig: { env: { CODEX_HOME: { type: "plain", value: "/tmp/other-codex-home" } } } },
      fields: ["adapterConfig.env.CODEX_HOME"],
    },
    { label: "adapterConfig.cwd", body: { adapterConfig: { cwd: "/" } }, fields: ["adapterConfig.cwd"] },
    { label: "adapterConfig.command", body: { adapterConfig: { command: "/tmp/wrapper" } }, fields: ["adapterConfig.command"] },
    {
      label: "adapterConfig.agentCommand",
      body: { adapterConfig: { agentCommand: "/tmp/acp-wrapper" } },
      fields: ["adapterConfig.agentCommand"],
    },
    {
      label: "adapterConfig.dangerouslySkipPermissions",
      body: { adapterConfig: { dangerouslySkipPermissions: true } },
      fields: ["adapterConfig.dangerouslySkipPermissions"],
    },
    {
      label: "adapterConfig.permissionMode",
      body: { adapterConfig: { permissionMode: "bypassPermissions" } },
      fields: ["adapterConfig.permissionMode"],
    },
    {
      label: "adapterConfig.filesystemSandboxCommand",
      body: { adapterConfig: { filesystemSandboxCommand: "/tmp/not-bwrap" } },
      fields: ["adapterConfig.filesystemSandboxCommand"],
    },
    {
      label: "adapterConfig.acpxPermissionMode",
      body: { adapterConfig: { acpxPermissionMode: "approve-all" } },
      fields: ["adapterConfig.acpxPermissionMode"],
    },
    {
      label: "adapterConfig.maxEstimatedSessionCostUsd",
      body: { adapterConfig: { maxEstimatedSessionCostUsd: 1_000 } },
      fields: ["adapterConfig.maxEstimatedSessionCostUsd"],
    },
    {
      label: "adapterConfig.networkScope",
      body: { adapterConfig: { networkScope: "allow" } },
      fields: ["adapterConfig.networkScope"],
    },
    {
      label: "a future dangerously* adapter flag",
      body: { adapterConfig: { dangerouslyEnableFutureEscapeHatch: true } },
      fields: ["adapterConfig.dangerouslyEnableFutureEscapeHatch"],
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
    expect(res.body.error).toContain(
      "Agents cannot change their own run limits, budget, model, environment, sandbox, role, or permissions",
    );
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

  it("denies an agent changing its own default environment", async () => {
    const environmentId = await seedLocalEnvironment(db);
    const { companyId, agentId } = await seedAgent(db, { defaultEnvironmentId: environmentId });

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ defaultEnvironmentId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual(["defaultEnvironmentId"]);
    expect((await readAgent(db, agentId)).defaultEnvironmentId).toBe(environmentId);
    expect((await deniedActivity(db, agentId))[0]?.details).toMatchObject({ fields: ["defaultEnvironmentId"] });
  });

  it("denies an edit that would make the server turn on a default bypass flag", async () => {
    const { companyId, agentId } = await seedAgent(db);
    await db
      .update(agents)
      .set({ adapterType: "codex_local", adapterConfig: { model: "gpt-5", cwd: "/tmp/agent-self-config" } })
      .where(eq(agents.id, agentId));

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { search: true } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual(["adapterConfig.dangerouslyBypassApprovalsAndSandbox"]);
    expect((await readAgent(db, agentId)).adapterConfig).toEqual({ model: "gpt-5", cwd: "/tmp/agent-self-config" });
  });

  it("still lets an agent echo back its own redacted env unchanged", async () => {
    const storedAdapterConfig = { ...STORED_ADAPTER_CONFIG, env: { LOG_LEVEL: { type: "plain", value: "debug" } } };
    const { companyId, agentId } = await seedAgent(db, { adapterConfig: storedAdapterConfig });
    const app = createApp(db, agentActor(companyId, agentId));

    const detail = await request(app).get(`/api/agents/${agentId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.adapterConfig.env.LOG_LEVEL.value).not.toBe("debug");

    const res = await request(app).patch(`/api/agents/${agentId}`).send({ adapterConfig: detail.body.adapterConfig });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAgent(db, agentId)).adapterConfig).toEqual(storedAdapterConfig);
    expect(await deniedActivity(db, agentId)).toHaveLength(0);
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
    const higherCapRevision = await findRevision(
      db,
      agentId,
      (afterConfig) => isDeepStrictEqual(
        afterConfig.runtimeConfig,
        { heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 50 } },
      ),
    );

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .post(`/api/agents/${agentId}/config-revisions/${higherCapRevision.id}/rollback`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual(["runtimeConfig.heartbeat.maxDailyRuns"]);
    expect((await readAgent(db, agentId)).runtimeConfig).toMatchObject({ heartbeat: { maxDailyRuns: 2 } });
    const denied = await deniedActivity(db, agentId);
    expect(denied[0]?.details).toMatchObject({ surface: "config_rollback" });
  });

  it("denies an agent rolling its own config back to a revision with another environment", async () => {
    const environmentId = await seedLocalEnvironment(db);
    const { companyId, agentId } = await seedAgent(db);
    const board = createApp(db, boardActor(companyId));
    await request(board).patch(`/api/agents/${agentId}`).send({ defaultEnvironmentId: environmentId }).expect(200);
    await request(board).patch(`/api/agents/${agentId}`).send({ defaultEnvironmentId: null }).expect(200);
    const environmentRevision = await findRevision(
      db,
      agentId,
      (afterConfig) => afterConfig.defaultEnvironmentId === environmentId,
    );

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .post(`/api/agents/${agentId}/config-revisions/${environmentRevision.id}/rollback`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.fields).toEqual(["defaultEnvironmentId"]);
    expect((await readAgent(db, agentId)).defaultEnvironmentId).toBeNull();
  });

  it("denies an agent rolling back any change to its own config, but allows a no-op rollback", async () => {
    const { companyId, agentId } = await seedAgent(db);
    const board = createApp(db, boardActor(companyId));
    await request(board).patch(`/api/agents/${agentId}`).send({ title: "Old title" }).expect(200);
    await request(board).patch(`/api/agents/${agentId}`).send({ title: "Current title" }).expect(200);
    const oldTitleRevision = await findRevision(db, agentId, (afterConfig) => afterConfig.title === "Old title");
    const currentTitleRevision = await findRevision(db, agentId, (afterConfig) => afterConfig.title === "Current title");
    const app = createApp(db, agentActor(companyId, agentId));

    const changing = await request(app)
      .post(`/api/agents/${agentId}/config-revisions/${oldTitleRevision.id}/rollback`)
      .send({});
    expect(changing.status, JSON.stringify(changing.body)).toBe(403);
    expect(changing.body.details.fields).toEqual(["title"]);
    expect((await readAgent(db, agentId)).title).toBe("Current title");

    const noOp = await request(app)
      .post(`/api/agents/${agentId}/config-revisions/${currentTitleRevision.id}/rollback`)
      .send({});
    expect(noOp.status, JSON.stringify(noOp.body)).toBe(200);
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

    const scopedAssignGrant = { agentIds: [peerId] };
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "tasks:assign",
      scope: scopedAssignGrant,
      grantedByUserId: null,
    });
    const unchanged = await request(app).patch(`/api/agents/${agentId}/permissions`).send(storedPermissions);
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    const assignGrants = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.principalId, agentId), eq(principalPermissionGrants.permissionKey, "tasks:assign")));
    expect(assignGrants.map((grant) => grant.scope)).toEqual([scopedAssignGrant]);

    const peer = await request(app).patch(`/api/agents/${peerId}/permissions`).send(body);
    expect(peer.status, JSON.stringify(peer.body)).toBe(200);
  });

  it("still lets an agent change its own non-protected fields", async () => {
    const { companyId, agentId } = await seedAgent(db);

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { search: true } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAgent(db, agentId)).adapterConfig).toEqual({ ...STORED_ADAPTER_CONFIG, search: true });
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

  it("keeps today's behaviour for a granted agent changing its own env and environment", async () => {
    const environmentId = await seedLocalEnvironment(db);
    const { companyId, agentId } = await seedAgent(db);
    await grantAgentConfigure(db, companyId, agentId, { agentIds: [agentId] });

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: { env: { LOG_LEVEL: { type: "plain", value: "info" } } },
        defaultEnvironmentId: environmentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readAgent(db, agentId);
    expect(after.defaultEnvironmentId).toBe(environmentId);
    expect(after.adapterConfig).toMatchObject({ env: { LOG_LEVEL: { type: "plain", value: "info" } } });
    expect(await deniedActivity(db, agentId)).toHaveLength(0);
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

  describe("OpenClaw invite replay on an approved agent", () => {
    const gatewayUrl = "wss://gateway.example.test/";

    async function seedApprovedOpenClawJoin(status: "approved" | "pending_approval" = "approved") {
      const token = `pcp_invite_${randomUUID()}`;
      const gatewayToken = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
      const joinDefaults = {
        url: gatewayUrl,
        headers: { "x-openclaw-token": gatewayToken },
        timeoutSec: 600,
        disableDeviceAuth: true,
      };
      const [company] = await db
        .insert(companies)
        .values({ name: `Replay ${randomUUID()}`, issuePrefix: `RP${randomUUID().slice(0, 6).toUpperCase()}` })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({
          companyId: company!.id,
          name: `Gateway ${randomUUID().slice(0, 8)}`,
          role: "engineer",
          adapterType: "openclaw_gateway",
          adapterConfig: joinDefaults,
          runtimeConfig: {},
          permissions: {},
        })
        .returning();
      const [invite] = await db
        .insert(invites)
        .values({
          companyId: company!.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          allowedJoinTypes: "agent",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          acceptedAt: new Date(),
        })
        .returning();
      const [joinRequest] = await db
        .insert(joinRequests)
        .values({
          inviteId: invite!.id,
          companyId: company!.id,
          requestType: "agent",
          status,
          requestIp: "127.0.0.1",
          agentName: agent!.name,
          adapterType: "openclaw_gateway",
          agentDefaultsPayload: joinDefaults,
          createdAgentId: status === "approved" ? agent!.id : null,
        })
        .returning();
      return { token, companyId: company!.id, agent: agent!, joinRequestId: joinRequest!.id, joinDefaults };
    }

    function replayBody(agentName: string, agentDefaultsPayload: Record<string, unknown>) {
      return { requestType: "agent", agentName, adapterType: "openclaw_gateway", agentDefaultsPayload };
    }

    it("denies a replay that would change the agent's protected fields, before any write", async () => {
      const fixture = await seedApprovedOpenClawJoin();

      const res = await request(createAccessApp(db, { type: "none", source: "none" }))
        .post(`/api/invites/${fixture.token}/accept`)
        .send(replayBody(fixture.agent.name, { timeoutSec: 86_400 }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({
        code: "agent_self_protected_config_change",
        fields: ["adapterConfig.timeoutSec"],
      });
      expect((await readAgent(db, fixture.agent.id)).adapterConfig).toEqual(fixture.joinDefaults);
      const [joinRequest] = await db.select().from(joinRequests).where(eq(joinRequests.id, fixture.joinRequestId));
      expect(joinRequest!.agentDefaultsPayload).toEqual(fixture.joinDefaults);
      expect((await deniedActivity(db, fixture.agent.id))[0]).toMatchObject({
        actorType: "user",
        actorId: "invite-anon",
        details: {
          surface: "join_replay",
          fields: ["adapterConfig.timeoutSec"],
          joinRequestId: fixture.joinRequestId,
        },
      });
    });

    it("still lets a replay refresh the gateway token", async () => {
      const fixture = await seedApprovedOpenClawJoin();
      const nextGatewayToken = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");

      const res = await request(createAccessApp(db, { type: "none", source: "none" }))
        .post(`/api/invites/${fixture.token}/accept`)
        .send(replayBody(fixture.agent.name, { headers: { "x-openclaw-token": nextGatewayToken } }));

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await readAgent(db, fixture.agent.id)).adapterConfig).toMatchObject({
        url: gatewayUrl,
        timeoutSec: 600,
        headers: { "x-openclaw-token": nextGatewayToken },
      });
      expect(await deniedActivity(db, fixture.agent.id)).toHaveLength(0);
    });

    it.each([
      {
        label: "a signed-in user with no grant for the agent",
        actor: (): Express.Request["actor"] => ({
          type: "board",
          userId: "stranger-user",
          companyIds: [],
          memberships: [],
          isInstanceAdmin: false,
          source: "session",
        }),
        actorType: "user",
        actorId: "stranger-user",
      },
      {
        label: "the agent itself without a grant",
        actor: (companyId?: string, agentId?: string): Express.Request["actor"] =>
          agentActor(companyId ?? "", agentId ?? ""),
        actorType: "agent",
        actorId: null,
      },
    ])("denies a protected replay change from $label", async ({ actor, actorType, actorId }) => {
      const fixture = await seedApprovedOpenClawJoin();
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "agent",
        principalId: fixture.agent.id,
        status: "active",
        membershipRole: "member",
      });

      const res = await request(createAccessApp(db, actor(fixture.companyId, fixture.agent.id)))
        .post(`/api/invites/${fixture.token}/accept`)
        .send(replayBody(fixture.agent.name, { url: "wss://other-gateway.example.test/", scopes: ["operator.admin"] }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details.fields).toEqual(["adapterConfig.scopes", "adapterConfig.url"]);
      expect((await readAgent(db, fixture.agent.id)).adapterConfig).toEqual(fixture.joinDefaults);
      expect((await deniedActivity(db, fixture.agent.id))[0]).toMatchObject({
        actorType,
        actorId: actorId ?? fixture.agent.id,
        details: { surface: "join_replay" },
      });
    });

    it("still lets a pending join request replay", async () => {
      const fixture = await seedApprovedOpenClawJoin("pending_approval");

      const res = await request(createAccessApp(db, { type: "none", source: "none" }))
        .post(`/api/invites/${fixture.token}/accept`)
        .send(replayBody(fixture.agent.name, { timeoutSec: 86_400 }));

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await readAgent(db, fixture.agent.id)).adapterConfig).toEqual(fixture.joinDefaults);
      expect(await deniedActivity(db, fixture.agent.id)).toHaveLength(0);
    });

    it("keeps today's behaviour for a board actor replay", async () => {
      const fixture = await seedApprovedOpenClawJoin();

      const res = await request(createAccessApp(db, boardActor(fixture.companyId)))
        .post(`/api/invites/${fixture.token}/accept`)
        .send(replayBody(fixture.agent.name, { timeoutSec: 86_400 }));

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await readAgent(db, fixture.agent.id)).adapterConfig).toMatchObject({ timeoutSec: 86_400 });
    });
  });

  describe("agent join request approval", () => {
    async function seedPendingAgentJoin(agentDefaultsPayload: Record<string, unknown>) {
      const { companyId } = await seedAgent(db, { role: "ceo" });
      const approverId = await seedPeer(db, companyId);
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: approverId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: approverId,
        permissionKey: "joins:approve",
        scope: null,
        grantedByUserId: null,
      });
      const [invite] = await db
        .insert(invites)
        .values({
          companyId,
          tokenHash: createHash("sha256").update(`pcp_invite_${randomUUID()}`).digest("hex"),
          allowedJoinTypes: "agent",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          acceptedAt: new Date(),
        })
        .returning();
      const [joinRequest] = await db
        .insert(joinRequests)
        .values({
          inviteId: invite!.id,
          companyId,
          requestType: "agent",
          status: "pending_approval",
          requestIp: "127.0.0.1",
          agentName: "Joiner",
          adapterType: "claude_local",
          agentDefaultsPayload,
        })
        .returning();
      return { companyId, approverId, joinRequestId: joinRequest!.id };
    }

    async function companyAgentCount(companyId: string) {
      return (await db.select().from(agents).where(eq(agents.companyId, companyId))).length;
    }

    const PROTECTED_PAYLOAD = { model: "large-model", dangerouslySkipPermissions: true };

    it("denies an agent approver creating an agent with the requester's protected settings, before any write", async () => {
      const { companyId, approverId, joinRequestId } = await seedPendingAgentJoin(PROTECTED_PAYLOAD);

      const res = await request(createAccessApp(db, agentActor(companyId, approverId)))
        .post(`/api/companies/${companyId}/join-requests/${joinRequestId}/approve`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({
        code: "agent_self_protected_config_change",
        fields: ["adapterConfig.dangerouslySkipPermissions", "adapterConfig.model"],
      });
      expect(await companyAgentCount(companyId)).toBe(2);
      const [joinRequest] = await db.select().from(joinRequests).where(eq(joinRequests.id, joinRequestId));
      expect(joinRequest!.status).toBe("pending_approval");
      expect((await deniedActivity(db, companyId))[0]).toMatchObject({
        companyId,
        actorType: "agent",
        actorId: approverId,
        entityType: "company",
        details: { surface: "join_approval", joinRequestId },
      });
    });

    it("still lets an agent approver approve a request with no protected settings", async () => {
      const { companyId, approverId, joinRequestId } = await seedPendingAgentJoin({ cwd: "/tmp/joiner" });

      const res = await request(createAccessApp(db, agentActor(companyId, approverId)))
        .post(`/api/companies/${companyId}/join-requests/${joinRequestId}/approve`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await companyAgentCount(companyId)).toBe(3);
      expect(await deniedActivity(db, companyId)).toHaveLength(0);
    });

    it("still lets an agent approver holding agents:configure approve protected settings", async () => {
      const { companyId, approverId, joinRequestId } = await seedPendingAgentJoin(PROTECTED_PAYLOAD);
      await grantAgentConfigure(db, companyId, approverId, null);

      const res = await request(createAccessApp(db, agentActor(companyId, approverId)))
        .post(`/api/companies/${companyId}/join-requests/${joinRequestId}/approve`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await companyAgentCount(companyId)).toBe(3);
    });

    it("keeps a board approver unchanged", async () => {
      const { companyId, joinRequestId } = await seedPendingAgentJoin(PROTECTED_PAYLOAD);

      const res = await request(createAccessApp(db, boardActor(companyId)))
        .post(`/api/companies/${companyId}/join-requests/${joinRequestId}/approve`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await companyAgentCount(companyId)).toBe(3);
    });
  });
});
