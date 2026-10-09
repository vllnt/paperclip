import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat run list/stats route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const HOUR = 60 * 60 * 1000;

function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function seed(db: Db, name = "Runs Co", prefix = "RUN") {
  const [company] = await db
    .insert(companies)
    .values({ name, issuePrefix: prefix, defaultResponsibleUserId: "board-user" })
    .returning();
  await db.insert(companyMemberships).values({
    companyId: company!.id,
    principalType: "user",
    principalId: "board-user",
    membershipRole: "owner",
    status: "active",
  });
  const [capped, uncapped] = await db
    .insert(agents)
    .values([
      {
        companyId: company!.id,
        name: "Capped",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, maxDailyRuns: 3 } },
      },
      {
        companyId: company!.id,
        name: "Uncapped",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
    ])
    .returning();

  // Runs today stay inside the current UTC day even when the suite runs just after midnight.
  const dayStart = startOfUtcDay();
  const today = (minutes: number) => new Date(dayStart.getTime() + minutes * 60 * 1000);
  const longAgo = new Date(Date.now() - 72 * HOUR);
  const run = (
    agentId: string,
    status: string,
    at: Date,
    errorCode: string | null = null,
  ): typeof heartbeatRuns.$inferInsert => ({
    companyId: company!.id,
    agentId,
    status,
    errorCode,
    createdAt: at,
    startedAt: status === "queued" ? null : at,
    contextSnapshot: {},
  });
  await db.insert(heartbeatRuns).values([
    run(capped!.id, "succeeded", today(1)),
    run(capped!.id, "failed", today(2), "adapter_failed"),
    run(capped!.id, "timed_out", today(3), "timeout"),
    run(capped!.id, "queued", today(4)),
    run(capped!.id, "failed", longAgo, "adapter_failed"),
    run(uncapped!.id, "cancelled", today(5), "heartbeat.daily_run_limit"),
    run(uncapped!.id, "succeeded", today(6)),
  ]);
  return { company: company!, capped: capped!, uncapped: uncapped!, dayStart, longAgo };
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

describeEmbeddedPostgres("heartbeat run list filters and stats", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-list-stats-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("filters runs by status, error code, agent and creation time", async () => {
    const { company, capped, dayStart } = await seed(db);
    const app = createApp(db, boardKeyActor(company.id));
    const list = async (query: string) => {
      const res = await request(app).get(`/api/companies/${company.id}/heartbeat-runs?${query}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as Array<{ status: string; errorCode: string | null; agentId: string }>;
    };

    expect((await list("status=failed,timed_out")).map((row) => row.status).sort()).toEqual([
      "failed",
      "failed",
      "timed_out",
    ]);
    expect((await list("errorCode=adapter_failed")).every((row) => row.errorCode === "adapter_failed")).toBe(true);
    expect(await list("errorCode=adapter_failed")).toHaveLength(2);
    expect(await list(`status=failed&since=${encodeURIComponent(dayStart.toISOString())}`)).toHaveLength(1);
    expect(await list(`agentId=${capped.id}&until=${encodeURIComponent(dayStart.toISOString())}`)).toHaveLength(1);
    expect(await list("")).toHaveLength(7);
  });

  it("rejects unknown statuses, malformed times and malformed agent IDs with 400", async () => {
    const { company } = await seed(db);
    const app = createApp(db, boardKeyActor(company.id));
    for (const query of ["status=exploded", "since=yesterday", "agentId=not-a-uuid"]) {
      const res = await request(app).get(`/api/companies/${company.id}/heartbeat-runs?${query}`);
      expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it("reports run counts, top error codes and runs today against each agent's cap", async () => {
    const { company, capped, uncapped } = await seed(db);
    const since = new Date(Date.now() - 96 * HOUR).toISOString();
    const res = await request(createApp(db, boardKeyActor(company.id))).get(
      `/api/companies/${company.id}/heartbeat-runs/stats?since=${encodeURIComponent(since)}`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totals).toMatchObject({ runs: 7, terminal: 6, succeeded: 2, unsuccessful: 4 });
    expect(res.body.totals.byStatus).toMatchObject({ failed: 2, timed_out: 1, cancelled: 1, queued: 1, succeeded: 2 });
    expect(res.body.topErrorCodes[0]).toEqual({ errorCode: "adapter_failed", count: 2 });

    const byId = new Map(res.body.agents.map((agent: { agentId: string }) => [agent.agentId, agent]));
    // Today: succeeded, failed, timed_out started; the queued run doesn't count, as in the cap check.
    expect(byId.get(capped.id)).toMatchObject({
      name: "Capped",
      runs: 5,
      runsToday: 3,
      maxDailyRuns: 3,
      remainingToday: 0,
      capReached: true,
    });
    expect(byId.get(uncapped.id)).toMatchObject({ runsToday: 2, maxDailyRuns: null, remainingToday: null, capReached: false });
  });

  it("defaults the stats window to the last 24 hours and narrows to one agent", async () => {
    const { company, capped } = await seed(db);
    const res = await request(createApp(db, boardKeyActor(company.id))).get(
      `/api/companies/${company.id}/heartbeat-runs/stats?agentId=${capped.id}`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual([capped.id]);
    // The 72-hour-old failure is outside the default window.
    expect(res.body.totals).toMatchObject({ runs: 4, unsuccessful: 2 });
  });

  it("rejects an inverted or oversized stats window", async () => {
    const { company } = await seed(db);
    const app = createApp(db, boardKeyActor(company.id));
    const now = Date.now();
    const iso = (offsetMs: number) => encodeURIComponent(new Date(now + offsetMs).toISOString());
    expect((await request(app).get(`/api/companies/${company.id}/heartbeat-runs/stats?since=${iso(0)}&until=${iso(-HOUR)}`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${company.id}/heartbeat-runs/stats?since=${iso(-91 * 24 * HOUR)}`)).status).toBe(400);
  });

  it("keeps stats inside the caller's company", async () => {
    const { company } = await seed(db);
    const other = await seed(db, "Other Co", "OTH");
    const res = await request(createApp(db, boardKeyActor(other.company.id))).get(
      `/api/companies/${company.id}/heartbeat-runs/stats`,
    );
    expect(res.status).toBe(403);
  });
});
