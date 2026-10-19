import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping company run tier route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes(db));
  app.use(errorHandler);
  return app;
}

const boardActor = (companyIds: string[]): Express.Request["actor"] => ({
  type: "board",
  userId: "board-user",
  companyIds,
  memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "owner" as const, status: "active" as const })),
  isInstanceAdmin: false,
  source: "session",
});

const TIERS = {
  tiers: {
    fast: { adapterType: "codex_local", model: "grok-4.7", effort: "low" },
    standard: { adapterType: "claude_local", model: "claude-sonnet-5-5" },
  },
  agentAllowlist: ["fast"],
};

describeEmbeddedPostgres("company run tier routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-run-tiers-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await instanceSettingsService(db).updateGeneral({ companyRunTiers: {} });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db.insert(companies).values({
      name: `Tiers ${randomUUID()}`, issuePrefix: `TR${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!.id;
  }

  it("lets a board user set, read and clear a company's tiers, logging before and after", async () => {
    const companyId = await seedCompany();
    const app = createApp(db, boardActor([companyId]));

    expect((await request(app).get(`/api/companies/${companyId}/run-tiers`)).body).toEqual({ tiers: {}, agentAllowlist: [] });
    const put = await request(app).put(`/api/companies/${companyId}/run-tiers`).send(TIERS);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await request(app).get(`/api/companies/${companyId}/run-tiers`)).body).toEqual(TIERS);
    await request(app).put(`/api/companies/${companyId}/run-tiers`).send({ tiers: {}, agentAllowlist: [] });

    const logged = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.run_tiers_updated")));
    expect(logged.map((row) => row.details)).toMatchObject([{ before: null, after: TIERS }, { before: TIERS, after: { tiers: {}, agentAllowlist: [] } }]);
  });

  it("keeps each company's tiers apart", async () => {
    const first = await seedCompany();
    const second = await seedCompany();
    const app = createApp(db, boardActor([first, second]));
    await request(app).put(`/api/companies/${first}/run-tiers`).send(TIERS);
    await request(app).put(`/api/companies/${second}/run-tiers`).send({ tiers: { quick: { adapterType: "grok_local", model: "grok-4.7" } }, agentAllowlist: ["quick"] });
    expect((await request(app).get(`/api/companies/${first}/run-tiers`)).body).toEqual(TIERS);
    expect((await request(app).get(`/api/companies/${second}/run-tiers`)).body.tiers).toHaveProperty("quick");
  });

  it("rejects an Anthropic model on Codex, the reserved tier and an unknown allowlist entry with 400", async () => {
    const companyId = await seedCompany();
    const app = createApp(db, boardActor([companyId]));
    for (const body of [
      { tiers: { fast: { adapterType: "codex_local", model: "claude-sonnet-5-5" } }, agentAllowlist: [] },
      { tiers: { deep: { adapterType: "codex_local", model: "gpt-5.5" } }, agentAllowlist: [] },
      { tiers: TIERS.tiers, agentAllowlist: ["turbo"] },
    ]) {
      const res = await request(app).put(`/api/companies/${companyId}/run-tiers`).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
    expect((await request(app).get(`/api/companies/${companyId}/run-tiers`)).body).toEqual({ tiers: {}, agentAllowlist: [] });
  });

  it("lets an agent read its company's tiers but never change them, and hides other companies", async () => {
    const companyId = await seedCompany();
    const otherCompany = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId, name: "Manager", role: "ceo", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    await request(createApp(db, boardActor([companyId, otherCompany]))).put(`/api/companies/${companyId}/run-tiers`).send(TIERS);

    const asAgent = createApp(db, { type: "agent", agentId: agent!.id, companyId, source: "agent_key" });
    expect((await request(asAgent).get(`/api/companies/${companyId}/run-tiers`)).body).toEqual(TIERS);
    expect((await request(asAgent).put(`/api/companies/${companyId}/run-tiers`).send({ tiers: {}, agentAllowlist: [] })).status).toBe(403);
    expect((await request(asAgent).get(`/api/companies/${otherCompany}/run-tiers`)).status).toBe(403);
    expect((await request(createApp(db, boardActor([companyId]))).get(`/api/companies/${companyId}/run-tiers`)).body).toEqual(TIERS);
  });
});
