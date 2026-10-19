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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { builtInAgentService } from "../services/built-in-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping merge-patch self-config guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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
    source: "board_key",
    keyId: "board-key-1",
  };
}

async function seedAgent(db: Db, input: { role?: string; companyId?: string; adapterConfig?: Record<string, unknown> } = {}) {
  const companyId =
    input.companyId ??
    (
      await db
        .insert(companies)
        .values({
          name: `Merge guard ${randomUUID()}`,
          issuePrefix: `MG${randomUUID().slice(0, 6).toUpperCase()}`,
        })
        .returning()
    )[0]!.id;
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      name: `Worker ${randomUUID().slice(0, 8)}`,
      role: input.role ?? "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: input.adapterConfig ?? STORED_ADAPTER_CONFIG,
      runtimeConfig: STORED_RUNTIME_CONFIG,
      budgetMonthlyCents: 1_000,
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
  return { companyId, agentId: agent!.id };
}

/** Seeds the root CEO and gets its company-wide agents:configure grant from the code that applies it by default. */
async function seedRootCeoWithCompanyWideGrant(db: Db) {
  const { companyId, agentId } = await seedAgent(db, { role: "ceo" });
  await builtInAgentService(db).ensureCompanyDefaultAgentGrants(companyId);
  const [grant] = await db
    .select()
    .from(principalPermissionGrants)
    .where(and(eq(principalPermissionGrants.principalId, agentId), eq(principalPermissionGrants.permissionKey, "agents:configure")));
  expect(grant, "the default grant exists and is company-wide").toMatchObject({ scope: null });
  return { companyId, agentId };
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

/** Merge-patch bodies that change a protected value. A merge patch names only the delta, so the guard must read the merged result. */
const PROTECTED_MERGE_EDITS = [
  {
    label: "run cap",
    body: { mergeConfig: true, runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 } } },
    field: "runtimeConfig.heartbeat.maxConcurrentRuns",
  },
  {
    label: "run cap, removed with null",
    body: { mergeConfig: true, runtimeConfig: { heartbeat: { maxDailyRuns: null } } },
    field: "runtimeConfig.heartbeat.maxDailyRuns",
  },
  {
    label: "adapterConfig.model",
    body: { mergeConfig: true, adapterConfig: { model: "large-model" } },
    field: "adapterConfig.model",
  },
  {
    label: "adapterConfig.model, removed with null",
    body: { mergeConfig: true, adapterConfig: { model: null } },
    field: "adapterConfig.model",
  },
  {
    label: "adapterConfig.env.CODEX_HOME",
    body: { mergeConfig: true, adapterConfig: { env: { CODEX_HOME: { type: "plain", value: "/tmp/other-codex-home" } } } },
    field: "adapterConfig.env.CODEX_HOME",
  },
  {
    label: "budgetMonthlyCents",
    body: { mergeConfig: true, budgetMonthlyCents: 1_000_000 },
    field: "budgetMonthlyCents",
  },
];

describeEmbeddedPostgres("merge-patch PATCH keeps the agent self-config guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-patch-self-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("an agent changing itself", () => {
    it.each(PROTECTED_MERGE_EDITS)("is denied for $label, and the attempt is logged", async ({ body, field }) => {
      const { companyId, agentId } = await seedAgent(db);
      const before = await readAgent(db, agentId);

      const res = await request(createApp(db, agentActor(companyId, agentId))).patch(`/api/agents/${agentId}`).send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change" });
      expect(res.body.details.fields).toContain(field);
      const after = await readAgent(db, agentId);
      expect(after).toMatchObject({
        adapterConfig: before.adapterConfig,
        runtimeConfig: before.runtimeConfig,
        budgetMonthlyCents: before.budgetMonthlyCents,
      });
      expect(await deniedActivity(db, agentId)).toHaveLength(1);
    });

    it.each(PROTECTED_MERGE_EDITS)(
      "is denied for $label even with the company-wide agents:configure grant",
      async ({ body, field }) => {
        const { companyId, agentId } = await seedRootCeoWithCompanyWideGrant(db);
        const before = await readAgent(db, agentId);

        const res = await request(createApp(db, agentActor(companyId, agentId))).patch(`/api/agents/${agentId}`).send(body);

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change", reason: "deny_scope" });
        expect(res.body.details.fields).toContain(field);
        const after = await readAgent(db, agentId);
        expect(after).toMatchObject({
          adapterConfig: before.adapterConfig,
          runtimeConfig: before.runtimeConfig,
          budgetMonthlyCents: before.budgetMonthlyCents,
        });
      },
    );

    it("cannot send permissions through a merge patch: the body is rejected and nothing changes", async () => {
      const { companyId, agentId } = await seedRootCeoWithCompanyWideGrant(db);
      const before = await readAgent(db, agentId);

      const res = await request(createApp(db, agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ mergeConfig: true, permissions: { canCreateAgents: true } });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect((await readAgent(db, agentId)).permissions).toEqual(before.permissions);
    });

    it("can still merge-patch its own non-protected config, including removing a key", async () => {
      const { companyId, agentId } = await seedAgent(db, { adapterConfig: { ...STORED_ADAPTER_CONFIG, search: true } });

      const res = await request(createApp(db, agentActor(companyId, agentId)))
        .patch(`/api/agents/${agentId}`)
        .send({ mergeConfig: true, adapterConfig: { search: null } });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await readAgent(db, agentId)).adapterConfig).toEqual(STORED_ADAPTER_CONFIG);
      expect(await deniedActivity(db, agentId)).toHaveLength(0);
    });
  });

  it("lets an agent with the company-wide agents:configure grant merge-patch a peer's protected config", async () => {
    const { companyId, agentId } = await seedRootCeoWithCompanyWideGrant(db);
    const { agentId: peerId } = await seedAgent(db, {
      companyId,
      adapterConfig: { ...STORED_ADAPTER_CONFIG, promptTemplate: "peer prompt" },
    });

    const res = await request(createApp(db, agentActor(companyId, agentId)))
      .patch(`/api/agents/${peerId}`)
      .send({
        mergeConfig: true,
        adapterConfig: { model: "large-model" },
        runtimeConfig: { heartbeat: { maxDailyRuns: 50 } },
        budgetMonthlyCents: 5_000,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const peer = await readAgent(db, peerId);
    expect(peer.adapterConfig).toEqual({ ...STORED_ADAPTER_CONFIG, promptTemplate: "peer prompt", model: "large-model" });
    expect(peer.runtimeConfig).toEqual({ heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxDailyRuns: 50 } });
    expect(peer.budgetMonthlyCents).toBe(5_000);
    expect(await deniedActivity(db, peerId)).toHaveLength(0);
  });

  it("lets the board merge-patch an agent's protected config", async () => {
    const { companyId, agentId } = await seedRootCeoWithCompanyWideGrant(db);

    const res = await request(createApp(db, boardActor(companyId)))
      .patch(`/api/agents/${agentId}`)
      .send({
        mergeConfig: true,
        adapterConfig: { model: "large-model" },
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } },
        budgetMonthlyCents: 5_000,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readAgent(db, agentId);
    expect(after.adapterConfig).toEqual({ ...STORED_ADAPTER_CONFIG, model: "large-model" });
    expect(after.runtimeConfig).toEqual({ heartbeat: { ...STORED_RUNTIME_CONFIG.heartbeat, maxConcurrentRuns: 3 } });
    expect(after.budgetMonthlyCents).toBe(5_000);
  });

  describe("a merge patch that an agent sends for itself while the board changes the agent", () => {
    /**
     * Holds a board update to the agent row open in a transaction, sends the agent's request (which
     * has already read the old row by the time it needs the row lock), waits until that request is
     * blocked on the lock, then commits the board update so the request resumes on the new row.
     */
    async function withConcurrentBoardUpdate(
      agentId: string,
      boardUpdate: Partial<typeof agents.$inferInsert>,
      send: () => PromiseLike<request.Response>,
    ) {
      let boardUpdateHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        boardUpdateHeld = resolve;
      });
      let commitBoardUpdate!: () => void;
      const commit = new Promise<void>((resolve) => {
        commitBoardUpdate = resolve;
      });
      const boardTransaction = db.transaction(async (tx) => {
        await tx.update(agents).set(boardUpdate).where(eq(agents.id, agentId));
        boardUpdateHeld();
        await commit;
      });
      await held;
      const pending = Promise.resolve(send());
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%"agents"%'`);
        if (Array.from(waiting).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      commitBoardUpdate();
      await boardTransaction;
      return pending;
    }

    it("is refused when it would put back a budget that the board just lowered, and the lowered budget stays", async () => {
      const { companyId, agentId } = await seedAgent(db);

      const res = await withConcurrentBoardUpdate(agentId, { budgetMonthlyCents: 100 }, () =>
        request(createApp(db, agentActor(companyId, agentId)))
          .patch(`/api/agents/${agentId}`)
          .send({ mergeConfig: true, adapterConfig: { search: true }, budgetMonthlyCents: 1_000 }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ code: "agent_config_changed_concurrently", fields: ["budgetMonthlyCents"] });
      const after = await readAgent(db, agentId);
      expect(after.budgetMonthlyCents).toBe(100);
      expect(after.adapterConfig).toEqual(STORED_ADAPTER_CONFIG);
    });

    it("succeeds when the board changed a field that is not protected", async () => {
      const { companyId, agentId } = await seedAgent(db);

      const res = await withConcurrentBoardUpdate(agentId, { title: "Edited by the board" }, () =>
        request(createApp(db, agentActor(companyId, agentId)))
          .patch(`/api/agents/${agentId}`)
          .send({ mergeConfig: true, adapterConfig: { search: true }, budgetMonthlyCents: 1_000 }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await readAgent(db, agentId)).toMatchObject({
        title: "Edited by the board",
        adapterConfig: { ...STORED_ADAPTER_CONFIG, search: true },
        budgetMonthlyCents: 1_000,
      });
    });
  });
});
