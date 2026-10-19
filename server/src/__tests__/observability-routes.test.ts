import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  runUsageRecords,
} from "@paperclipai/db";
import {
  RUN_USAGE_RECORD_SCHEMA_VERSION,
  observabilityFailuresResponseSchema,
  observabilityUsageResponseSchema,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { observabilityRoutes } from "../routes/observability.js";
import { runUsageRecordService } from "../services/run-usage-records.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Actor = Express.Request["actor"];

describeEmbeddedPostgres.sequential("observability routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-observability-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(runUsageRecords);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(runs: number): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: `board-${companyId}`,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const finished = new Date(Date.now() - 60 * 60_000);
    for (let index = 0; index < runs; index += 1) {
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "succeeded",
        createdAt: new Date(finished.getTime() - 60_000),
        startedAt: new Date(finished.getTime() - 50_000),
        finishedAt: finished,
        usageJson: { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 },
      });
    }
    await runUsageRecordService(db).runPass({ companyId });
    return { companyId, agentId };
  }

  function appFor(actor: Actor) {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", observabilityRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardOf(companyId: string, claimedCompanyIds: string[] = [companyId]): Actor {
    return {
      type: "board",
      userId: `board-${companyId}`,
      companyIds: claimedCompanyIds,
      source: "session",
      memberships: claimedCompanyIds.map((id) => ({ companyId: id, status: "active", membershipRole: "owner" })),
    };
  }

  it("returns this company's collector health to a board member", async () => {
    const mine = await seedCompany(2);
    await seedCompany(5);

    const response = await request(appFor(boardOf(mine.companyId))).get(`/api/companies/${mine.companyId}/observability/health`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      schemaVersion: RUN_USAGE_RECORD_SCHEMA_VERSION,
      terminalRuns24h: 2,
      derivedRuns24h: 2,
      pendingRuns: 0,
      oldestPendingAt: null,
    });
  });

  it("lets an agent of the same company read it", async () => {
    const mine = await seedCompany(1);

    const response = await request(appFor({ type: "agent", agentId: mine.agentId, companyId: mine.companyId, source: "agent_key" }))
      .get(`/api/companies/${mine.companyId}/observability/health`);

    expect(response.status).toBe(200);
    expect(response.body.derivedRuns24h).toBe(1);
  });

  it("refuses an agent of another company", async () => {
    const mine = await seedCompany(1);
    const other = await seedCompany(1);

    const response = await request(appFor({ type: "agent", agentId: other.agentId, companyId: other.companyId, source: "agent_key" }))
      .get(`/api/companies/${mine.companyId}/observability/health`);

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("terminalRuns24h");
  });

  it("refuses a board user who is not a member of the company", async () => {
    const mine = await seedCompany(1);
    const other = await seedCompany(1);

    const response = await request(appFor(boardOf(other.companyId))).get(`/api/companies/${mine.companyId}/observability/health`);

    expect(response.status).toBe(403);
  });

  it("refuses a board session whose membership is not active, even if it claims the company", async () => {
    const mine = await seedCompany(1);
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, mine.companyId));

    const response = await request(appFor(boardOf(mine.companyId))).get(`/api/companies/${mine.companyId}/observability/health`);

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("terminalRuns24h");
  });

  it("refuses an unauthenticated caller", async () => {
    const mine = await seedCompany(1);

    const response = await request(appFor({ type: "none", source: "none" })).get(`/api/companies/${mine.companyId}/observability/health`);

    expect(response.status).toBe(401);
  });

  describe.each(["usage", "failures"])("GET %s", (report) => {
    const pathFor = (companyId: string) => `/api/companies/${companyId}/observability/${report}`;

    it("refuses an agent of another company and a board user who is not a member", async () => {
      const mine = await seedCompany(1);
      const other = await seedCompany(1);

      const asAgent = await request(appFor({ type: "agent", agentId: other.agentId, companyId: other.companyId, source: "agent_key" }))
        .get(pathFor(mine.companyId));
      const asBoard = await request(appFor(boardOf(other.companyId))).get(pathFor(mine.companyId));

      expect(asAgent.status).toBe(403);
      expect(asBoard.status).toBe(403);
      expect(JSON.stringify(asAgent.body) + JSON.stringify(asBoard.body)).not.toContain("totals");
    });

    it("refuses an unauthenticated caller", async () => {
      const mine = await seedCompany(1);

      const response = await request(appFor({ type: "none", source: "none" })).get(pathFor(mine.companyId));

      expect(response.status).toBe(401);
    });

    it("lets an agent of the same company read it", async () => {
      const mine = await seedCompany(1);

      const response = await request(appFor({ type: "agent", agentId: mine.agentId, companyId: mine.companyId, source: "agent_key" }))
        .get(pathFor(mine.companyId));

      expect(response.status).toBe(200);
    });

    it("rejects an unknown query key, a bad group, a bad date and a bad window with 400", async () => {
      const mine = await seedCompany(1);
      const app = appFor(boardOf(mine.companyId));

      expect((await request(app).get(`${pathFor(mine.companyId)}?agentID=x`)).status).toBe(400);
      expect((await request(app).get(`${pathFor(mine.companyId)}?groupBy=nonsense`)).status).toBe(400);
      expect((await request(app).get(`${pathFor(mine.companyId)}?since=yesterday`)).status).toBe(400);
      expect((await request(app).get(`${pathFor(mine.companyId)}?since=2026-10-05&until=2026-10-01`)).status).toBe(400);
    });
  });

  it("returns a usage report that matches the shared response schema and counts only this company", async () => {
    const mine = await seedCompany(2);
    await seedCompany(5);

    const response = await request(appFor(boardOf(mine.companyId)))
      .get(`/api/companies/${mine.companyId}/observability/usage?groupBy=agent`);

    expect(response.status).toBe(200);
    const parsed = observabilityUsageResponseSchema.parse(response.body);
    expect(parsed.rows.map((row) => [row.key, row.label, row.runs])).toEqual([[mine.agentId, "Agent", 2]]);
    expect(parsed.totals.runs).toBe(2);
  });

  it("returns a failures report with the count of all runs in the window", async () => {
    const mine = await seedCompany(2);

    const response = await request(appFor(boardOf(mine.companyId)))
      .get(`/api/companies/${mine.companyId}/observability/failures?groupBy=agent`);

    expect(response.status).toBe(200);
    const parsed = observabilityFailuresResponseSchema.parse(response.body);
    expect(parsed.rows).toEqual([]);
    expect(parsed.totals).toMatchObject({ runs: 0, allRuns: 2 });
  });
});
