import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentHarnessCooldowns,
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
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent fallback route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_key" };
}

describeEmbeddedPostgres("agent fallbacks routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-fallbacks-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { fallbacks?: unknown[] } = {}) {
    const [company] = await db
      .insert(companies)
      .values({ name: `Fallbacks ${randomUUID()}`, issuePrefix: `FB${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    const companyId = company!.id;
    const openAiKey = await secretService(db).create(companyId, {
      name: `openai-${randomUUID().slice(0, 6)}`,
      provider: "local_encrypted",
      value: "sk-test-openai-key-value",
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Implementer ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-opus-5-5", cwd: "/tmp/agent-fallbacks" },
        runtimeConfig: { heartbeat: { enabled: false } },
        fallbacks: input.fallbacks ?? [],
        permissions: {},
      })
      .returning();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    return { companyId, agentId: agent!.id, openAiKeyId: openAiKey.id };
  }

  function codexFallback(secretId: string) {
    return {
      adapterType: "codex_local",
      model: "gpt-5.5",
      effort: "high",
      env: {
        OPENAI_API_KEY: { type: "secret_ref", secretId, version: "latest" },
        CODEX_HOME: "/srv/paperclip/codex-home",
      },
    };
  }

  async function readAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  }

  it("stores an ordered fallback chain with secret references, applies harness defaults, and records a revision", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({ fallbacks: [codexFallback(openAiKeyId), { adapterType: "grok_local", model: "grok-4.7" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAgent(agentId);
    expect(stored.fallbacks).toMatchObject([
      {
        adapterType: "codex_local",
        model: "gpt-5.5",
        effort: "high",
        adapterConfig: { dangerouslyBypassApprovalsAndSandbox: true },
        env: {
          OPENAI_API_KEY: { type: "secret_ref", secretId: openAiKeyId },
          CODEX_HOME: { type: "plain", value: "/srv/paperclip/codex-home" },
        },
      },
      { adapterType: "grok_local", model: "grok-4.7" },
    ]);
    const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    expect(revision.changedKeys).toContain("fallbacks");
  });

  it.each([
    ["an Anthropic model on Codex", { adapterType: "codex_local", model: "claude-opus-5-5" }, "Anthropic models never run through codex_local"],
    ["an Anthropic alias on Codex", { adapterType: "codex_local", model: "sonnet" }, "Anthropic models never run through codex_local"],
    ["an Anthropic model on Grok", { adapterType: "grok_local", model: "claude-sonnet-5" }, "Anthropic models never run through grok_local"],
    ["an Anthropic model smuggled through extraArgs", { adapterType: "codex_local", model: "gpt-5.5", adapterConfig: { extraArgs: ["-c", "model=claude-opus-5-5"] } }, "Anthropic models never run through codex_local"],
    ["an OpenAI model on Claude", { adapterType: "claude_local", model: "gpt-5.5" }, "claude_local runs only anthropic models"],
    ["an OpenAI model on Grok", { adapterType: "grok_local", model: "gpt-5.5" }, "grok_local runs only xai models"],
  ])("rejects %s at config time", async (_label, fallback, message) => {
    const { companyId, agentId } = await seed();
    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({ fallbacks: [fallback] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(message);
    expect((await readAgent(agentId)).fallbacks).toEqual([]);
  });

  it("rejects an Anthropic model as a primary on Codex", async () => {
    const { companyId, agentId } = await seed();
    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterType: "codex_local", adapterConfig: { model: "claude-opus-5-5" } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { code: "harness_model_incompatible" } });
  });

  it("refuses plaintext credentials in fallback env", async () => {
    const { companyId, agentId } = await seed();
    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({ fallbacks: [{ adapterType: "codex_local", model: "gpt-5.5", env: { OPENAI_API_KEY: "sk-live-plaintext" } }] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("OPENAI_API_KEY");
    expect((await readAgent(agentId)).fallbacks).toEqual([]);
  });

  it("never returns plaintext fallback env values in API reads, and keeps them on a redacted echo", async () => {
    const { companyId, agentId, openAiKeyId } = await seed({
      fallbacks: [{
        adapterType: "codex_local",
        model: "gpt-5.5",
        env: {
          OPENAI_API_KEY: { type: "secret_ref", secretId: randomUUID() },
          CODEX_HOME: { type: "plain", value: "/srv/private/codex-home" },
        },
      }],
    });
    await db.update(agents).set({
      fallbacks: [{ ...codexFallback(openAiKeyId), env: { ...codexFallback(openAiKeyId).env, CODEX_HOME: { type: "plain", value: "/srv/private/codex-home" } } }],
    }).where(eq(agents.id, agentId));
    const app = createApp(db, boardActor(companyId));
    for (const path of [`/api/agents/${agentId}`, `/api/agents/${agentId}/configuration`, `/api/companies/${companyId}/agents`]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("/srv/private/codex-home");
    }
    const detail = await request(app).get(`/api/agents/${agentId}`);
    expect(detail.body.fallbacks[0].env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: openAiKeyId });

    const echo = await request(app).patch(`/api/agents/${agentId}`).send({ fallbacks: detail.body.fallbacks });
    expect(echo.status, JSON.stringify(echo.body)).toBe(200);
    expect((await readAgent(agentId)).fallbacks).toMatchObject([
      { env: { CODEX_HOME: { type: "plain", value: "/srv/private/codex-home" } } },
    ]);
  });

  it("refuses an agent changing its own fallbacks or quota backoff, and logs the attempt", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    const app = createApp(db, agentActor(companyId, agentId));
    const fallbacks = await request(app).patch(`/api/agents/${agentId}`).send({ fallbacks: [codexFallback(openAiKeyId)] });
    expect(fallbacks.status).toBe(403);
    expect(fallbacks.body).toMatchObject({ details: { code: "agent_self_protected_config_change", fields: ["fallbacks"] } });
    const backoff = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { heartbeat: { enabled: false, quotaBackoffMaxMinutes: 5 } } });
    expect(backoff.status).toBe(403);
    expect(backoff.body.details.fields).toEqual(["runtimeConfig.heartbeat.quotaBackoffMaxMinutes"]);
    expect((await readAgent(agentId)).fallbacks).toEqual([]);
    const denials = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "agent.self_config_update_denied"),
    ));
    expect(denials.map((row) => (row.details as { fields: string[] }).fields)).toEqual([
      ["fallbacks"],
      ["runtimeConfig.heartbeat.quotaBackoffMaxMinutes"],
    ]);
  });

  it("lets an agent with agents:configure for itself, or a board user, change its fallbacks", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "agents:configure",
      scope: { agentIds: [agentId] },
      grantedByUserId: null,
    });
    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${agentId}`)
      .send({ fallbacks: [codexFallback(openAiKeyId)] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("lets an agent resubmit its own unchanged fallbacks", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    await request(createApp(db, boardActor(companyId))).patch(`/api/agents/${agentId}`).send({ fallbacks: [codexFallback(openAiKeyId)] });
    const app = createApp(db, agentActor(companyId, agentId));
    const current = await request(app).get(`/api/agents/${agentId}`);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ fallbacks: current.body.fallbacks, metadata: { note: "x" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("refuses an agent rolling itself back to a revision with different fallbacks", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    const board = createApp(db, boardActor(companyId));
    await request(board).patch(`/api/agents/${agentId}`).send({ fallbacks: [codexFallback(openAiKeyId)] });
    await request(board).patch(`/api/agents/${agentId}`).send({ fallbacks: [] });
    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    const withFallbacks = revisions.find((revision) =>
      Array.isArray((revision.afterConfig as { fallbacks?: unknown[] }).fallbacks)
      && ((revision.afterConfig as { fallbacks: unknown[] }).fallbacks.length > 0))!;
    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .post(`/api/agents/${agentId}/config-revisions/${withFallbacks.id}/rollback`);
    expect(res.status).toBe(403);
    expect(res.body.details.fields).toEqual(["fallbacks"]);
    const boardRollback = await request(board).post(`/api/agents/${agentId}/config-revisions/${withFallbacks.id}/rollback`);
    expect(boardRollback.status, JSON.stringify(boardRollback.body)).toBe(200);
    expect((await readAgent(agentId)).fallbacks).toHaveLength(1);
  });

  it("reports the live fallback state on the agent", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    await request(createApp(db, boardActor(companyId))).patch(`/api/agents/${agentId}`).send({ fallbacks: [codexFallback(openAiKeyId)] });
    const until = new Date(Date.now() + 90 * 60_000);
    await db.insert(agentHarnessCooldowns).values({
      companyId, agentId, targetKey: "claude_local:claude-opus-5-5", adapterType: "claude_local",
      model: "claude-opus-5-5", reason: "provider_usage_limit", cooldownUntil: until,
    });
    const res = await request(createApp(db, boardActor(companyId))).get(`/api/agents/${agentId}`);
    expect(res.body.harnessFallback).toEqual({
      active: true,
      adapterType: "codex_local",
      model: "gpt-5.5",
      reason: "provider_usage_limit",
      primaryCooldownUntil: until.toISOString(),
      heldUntil: null,
    });
  });

  it("refuses fallbacks on a harness outside the fallback matrix", async () => {
    const { companyId, agentId, openAiKeyId } = await seed();
    await db.update(agents).set({ adapterType: "process", adapterConfig: { command: "echo" } }).where(eq(agents.id, agentId));
    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({ fallbacks: [codexFallback(openAiKeyId)] });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Fallbacks are supported only for");
  });
});
