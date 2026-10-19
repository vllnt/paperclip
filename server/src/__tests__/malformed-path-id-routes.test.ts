import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { goalRoutes } from "../routes/goals.js";
import { routineRoutes } from "../routes/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping malformed path id route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const SAFE_BODY = { error: "Invalid identifier or value in request" };

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", routineRoutes(db));
  app.use("/api", goalRoutes(db));
  app.use(errorHandler);
  return app;
}

const boardActor: Express.Request["actor"] = {
  type: "board",
  source: "local_implicit",
  userId: "board-user",
  isInstanceAdmin: true,
};

// Postgres rejects a non-UUID value bound to a uuid column with SQLSTATE 22P02.
// The real routes pass the raw path segment straight to the query, so these
// tests exercise the driver error end to end rather than a mocked service.
describeEmbeddedPostgres("malformed ids in request paths", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-malformed-path-id-");
    db = createDb(tempDb.connectionString);
    // Embedded Postgres cold-starts slowly on a loaded machine.
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 400 with a safe message for PATCH /api/routines/not-a-uuid", async () => {
    const res = await request(createApp(db, boardActor))
      .patch("/api/routines/not-a-uuid")
      .send({ title: "Renamed" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual(SAFE_BODY);
  });

  it("returns 400 with a safe message for GET /api/goals/not-a-uuid", async () => {
    const res = await request(createApp(db, boardActor)).get("/api/goals/not-a-uuid");

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual(SAFE_BODY);
  });

  it("does not echo the driver message, SQL, or the submitted value", async () => {
    const res = await request(createApp(db, boardActor)).get("/api/goals/zz-canary-value");

    expect(res.status).toBe(400);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("zz-canary-value");
    expect(text).not.toMatch(/uuid|select|goals|syntax/i);
  });

  it("gives an agent from any company the same 400 as the board", async () => {
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: null,
      source: "agent_key",
    };
    const res = await request(createApp(db, agentActor)).get("/api/goals/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body).toEqual(SAFE_BODY);
  });

  it("returns the same 400 for a malformed id in a query value", async () => {
    // Not a path parameter: the routine list filter forwards `projectId`
    // unvalidated to a uuid column, so the same Postgres error applies.
    const res = await request(createApp(db, boardActor))
      .get(`/api/companies/${randomUUID()}/routines`)
      .query({ projectId: "not-a-uuid" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual(SAFE_BODY);
  });

  it("still returns 404 for a well-formed id that does not exist", async () => {
    const app = createApp(db, boardActor);

    const routine = await request(app).patch(`/api/routines/${randomUUID()}`).send({ title: "Renamed" });
    expect(routine.status, JSON.stringify(routine.body)).toBe(404);
    expect(routine.body).toEqual({ error: "Routine not found" });

    const goal = await request(app).get(`/api/goals/${randomUUID()}`);
    expect(goal.status, JSON.stringify(goal.body)).toBe(404);
    expect(goal.body).toEqual({ error: "Goal not found" });
  });
});
