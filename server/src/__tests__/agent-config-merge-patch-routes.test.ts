import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { resolveManagedInstructionsRoot, syncInstructionsBundleConfigFromFilePath } from "../services/agent-instructions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent config merge-patch route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const STORED_SECRET = "plain-secret-value-do-not-leak";

async function seed(db: Db) {
  const [company] = await db
    .insert(companies)
    .values({ name: "Merge Patch Co", issuePrefix: "MRG", defaultResponsibleUserId: "board-user" })
    .returning();
  await db.insert(companyMemberships).values({
    companyId: company!.id,
    principalType: "user",
    principalId: "board-user",
    membershipRole: "owner",
    status: "active",
  });
  // Board users change agent config through an explicit agents:configure grant.
  await db.insert(principalPermissionGrants).values({
    companyId: company!.id,
    principalType: "user",
    principalId: "board-user",
    permissionKey: "agents:configure",
  });
  const [inserted] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Builder",
      role: "general",
      adapterType: "process",
      adapterConfig: {
        command: "echo",
        promptTemplate: "Do the work",
        env: {
          SECRET_TOKEN: { type: "plain", value: STORED_SECRET },
          LOG_LEVEL: { type: "plain", value: "info" },
        },
      },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 900, maxDailyRuns: 10 },
        wakeOnDemand: true,
      },
    })
    .returning();
  // A managed instructions bundle, normalized the way the server stores it.
  const adapterConfig = syncInstructionsBundleConfigFromFilePath(inserted!, {
    ...(inserted!.adapterConfig as Record<string, unknown>),
    instructionsFilePath: path.join(resolveManagedInstructionsRoot(inserted!), "AGENTS.md"),
  });
  const [agent] = await db.update(agents).set({ adapterConfig }).where(eq(agents.id, inserted!.id)).returning();
  return { company: company!, agent: agent! };
}

function boardKeyActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    keyId: "board-key-1",
    source: "board_key",
  };
}

function selfAgentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_key" };
}

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

async function storedAgent(db: Db, id: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row!;
}

describeEmbeddedPostgres("PATCH /api/agents/:id with mergeConfig", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-config-merge-patch-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("changes one runtimeConfig key with a board API key and keeps the rest", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, runtimeConfig: { heartbeat: { maxDailyRuns: 64 } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await storedAgent(db, agent.id);
    expect(stored.runtimeConfig).toEqual({
      heartbeat: { enabled: true, intervalSec: 900, maxDailyRuns: 64 },
      wakeOnDemand: true,
    });
    expect(stored.adapterConfig).toEqual(agent.adapterConfig);
    expect(res.body.runtimeConfig.heartbeat.maxDailyRuns).toBe(64);
  });

  it("changes adapterConfig keys without resending or exposing secrets", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({
        mergeConfig: true,
        // Only the changed env key is sent; SECRET_TOKEN is neither resent nor lost.
        adapterConfig: { promptTemplate: "Do the work carefully", env: { LOG_LEVEL: { type: "plain", value: "debug" } } },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await storedAgent(db, agent.id);
    expect(stored.adapterConfig).toMatchObject({
      command: "echo",
      promptTemplate: "Do the work carefully",
      instructionsBundleMode: "managed",
      instructionsEntryFile: "AGENTS.md",
      env: {
        SECRET_TOKEN: { type: "plain", value: STORED_SECRET },
        LOG_LEVEL: { type: "plain", value: "debug" },
      },
    });
    expect(stored.runtimeConfig).toEqual(agent.runtimeConfig);
    expect(JSON.stringify(res.body)).not.toContain(STORED_SECRET);
    expect(res.body.adapterConfig.env.SECRET_TOKEN).toEqual({ type: "plain", value: REDACTED_EVENT_VALUE });
  });

  it("restores a redacted env value read back from GET instead of persisting the placeholder", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, adapterConfig: { env: { SECRET_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE } } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedAgent(db, agent.id)).adapterConfig).toEqual(agent.adapterConfig);
  });

  it("removes keys set to null and replaces env bindings whole", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({
        mergeConfig: true,
        adapterConfig: { env: { LOG_LEVEL: null, NEW_FLAG: { type: "plain", value: "1" } } },
        runtimeConfig: { heartbeat: { intervalSec: null }, wakeOnDemand: null },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await storedAgent(db, agent.id);
    expect(stored.runtimeConfig).toEqual({ heartbeat: { enabled: true, maxDailyRuns: 10 } });
    expect((stored.adapterConfig as { env: Record<string, unknown> }).env).toEqual({
      SECRET_TOKEN: { type: "plain", value: STORED_SECRET },
      NEW_FLAG: { type: "plain", value: "1" },
    });
  });

  it("records a config revision and an activity entry naming only the changed keys", async () => {
    const { company, agent } = await seed(db);
    await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, runtimeConfig: { heartbeat: { maxDailyRuns: 32 } } })
      .expect(200);

    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.changedKeys).toEqual(["runtimeConfig"]);
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.action, "agent.updated"));
    expect(entry!.details).toMatchObject({
      changedTopLevelKeys: ["runtimeConfig"],
      changedRuntimeConfigKeys: ["heartbeat"],
      mergeConfig: true,
    });
    expect(JSON.stringify(entry!.details)).not.toContain(STORED_SECRET);
  });

  it("rejects a merged config that fails validation and persists nothing", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, runtimeConfig: { debug: { verbose: true } } });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect((await storedAgent(db, agent.id)).runtimeConfig).toEqual(agent.runtimeConfig);
  });

  it("refuses to drop runtimeConfig.aiConnection through a merge patch", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, runtimeConfig: { aiConnection: null } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("aiConnection");
  });

  it("allows the stored adapterType alongside a merge patch", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, adapterType: "process", adapterConfig: { promptTemplate: "Same adapter" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedAgent(db, agent.id)).adapterConfig).toMatchObject({ promptTemplate: "Same adapter" });
  });

  it("fails with 409 instead of overwriting a config that changed after the merge base was read", async () => {
    const { agent } = await seed(db);
    const svc = agentService(db);
    const stale = { adapterConfig: agent.adapterConfig, runtimeConfig: { heartbeat: { maxDailyRuns: 1 } } };

    await expect(
      svc.update(agent.id, { runtimeConfig: { heartbeat: { maxDailyRuns: 2 } } }, { expectedConfig: stale }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await storedAgent(db, agent.id)).runtimeConfig).toEqual(agent.runtimeConfig);

    const current = await svc.getById(agent.id);
    await expect(
      svc.update(
        agent.id,
        { runtimeConfig: { ...agent.runtimeConfig, wakeOnDemand: false } },
        { expectedConfig: { adapterConfig: current!.adapterConfig, runtimeConfig: current!.runtimeConfig } },
      ),
    ).resolves.toMatchObject({ runtimeConfig: { wakeOnDemand: false } });
  });

  it("rejects mergeConfig combined with replaceAdapterConfig or an adapter type change", async () => {
    const { company, agent } = await seed(db);
    const app = createApp(db, boardKeyActor(company.id));
    for (const body of [
      { mergeConfig: true, replaceAdapterConfig: true, adapterConfig: { command: "true" } },
      { mergeConfig: true, adapterType: "http", adapterConfig: { url: "https://example.test" } },
    ]) {
      const res = await request(app).patch(`/api/agents/${agent.id}`).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain("mergeConfig cannot be combined");
    }
    expect((await storedAgent(db, agent.id)).adapterConfig).toEqual(agent.adapterConfig);
  });

  it("rejects a non-object merge patch", async () => {
    const { company, agent } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, runtimeConfig: ["not", "an", "object"] });
    expect(res.status).toBe(400);
    expect((await storedAgent(db, agent.id)).runtimeConfig).toEqual(agent.runtimeConfig);
  });

  it("replaces workspaceStrategy whole, so an agent can't keep an admin-set host command under a new strategy", async () => {
    const { company, agent } = await seed(db);
    await db
      .update(agents)
      .set({
        adapterConfig: {
          ...(agent.adapterConfig as Record<string, unknown>),
          workspaceStrategy: { type: "git_worktree", baseRef: "main", provisionCommand: "make setup" },
        },
      })
      .where(eq(agents.id, agent.id));

    const res = await request(createApp(db, selfAgentActor(company.id, agent.id)))
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, adapterConfig: { workspaceStrategy: { type: "git_worktree", baseRef: "dev" } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedAgent(db, agent.id)).adapterConfig).toMatchObject({
      workspaceStrategy: { type: "git_worktree", baseRef: "dev" },
    });
    expect(JSON.stringify((await storedAgent(db, agent.id)).adapterConfig)).not.toContain("make setup");
  });

  it("checks an agent's own merge patch against the keys it sends, not the stored config", async () => {
    const { company, agent } = await seed(db);
    const app = createApp(db, selfAgentActor(company.id, agent.id));

    // The stored config has instructions keys; patching another key must not trip the instructions guard.
    const allowed = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, adapterConfig: { promptTemplate: "Self-edited" } });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    // Removing an instructions key through a merge patch is still an instructions change.
    const denied = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ mergeConfig: true, adapterConfig: { instructionsBundleMode: null } });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect((await storedAgent(db, agent.id)).adapterConfig).toMatchObject({ instructionsBundleMode: "managed" });
  });
});
