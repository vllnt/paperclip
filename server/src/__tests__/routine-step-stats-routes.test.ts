import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueExecutionDecisions,
  issues,
  projects,
  routineRuns,
  runUsageRecords,
} from "@paperclipai/db";
import {
  createRoutineSchema,
  readRoutineStepsRunPayload,
  routineStepStatsSchema,
  type RoutineStep,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import { routineService } from "../services/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine step stats route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE = 60_000;

function step(key: string, after: string[] = []): RoutineStep {
  return { key, title: `Step ${key}`, after };
}

describeEmbeddedPostgres("routine step stats routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-step-stats-routes-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(steps: RoutineStep[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const routine = await svc.create(
      companyId,
      createRoutineSchema.parse({
        title: "Release",
        assigneeAgentId: agentId,
        projectId,
        concurrencyPolicy: "always_enqueue",
        steps,
      }),
      {},
    );
    return { companyId, agentId, routineId: routine.id, svc };
  }

  /** Runs the routine once and returns the step issue id by key. */
  async function runOnce(fx: Awaited<ReturnType<typeof seed>>): Promise<Record<string, string>> {
    const run = await fx.svc.runRoutine(fx.routineId, { source: "manual" });
    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
    return readRoutineStepsRunPayload(stored?.triggerPayload)?.stepIssueIds ?? {};
  }

  async function close(issueId: string, status: "done" | "cancelled", startedAt: Date, closedAt: Date) {
    await db
      .update(issues)
      .set(
        status === "done"
          ? { status, startedAt, completedAt: closedAt }
          : { status, startedAt, cancelledAt: closedAt },
      )
      .where(eq(issues.id, issueId));
  }

  async function usage(fx: Awaited<ReturnType<typeof seed>>, issueId: string, values: { input: number; output: number; costMicros: number | null; durationMs: number }) {
    const now = new Date();
    await db.insert(runUsageRecords).values({
      runId: randomUUID(),
      companyId: fx.companyId,
      agentId: fx.agentId,
      issueId,
      routineId: fx.routineId,
      adapterType: "codex_local",
      runtimeMode: "local",
      invocationSource: "assignment",
      status: "succeeded",
      usageQuality: "measured",
      inputTokens: values.input,
      outputTokens: values.output,
      costMicros: values.costMicros,
      durationMs: values.durationMs,
      runCreatedAt: now,
      finishedAt: now,
      day: now.toISOString().slice(0, 10),
      schemaVersion: 1,
      source: "worker",
    });
  }

  async function decision(fx: Awaited<ReturnType<typeof seed>>, issueId: string, outcome: "approved" | "changes_requested") {
    await db.insert(issueExecutionDecisions).values({
      companyId: fx.companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      outcome,
      body: "Decision",
    });
  }

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { actor });
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardActor = (companyId: string) => ({
    type: "board",
    userId: "board-user",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  });

  it("returns the current steps with zero figures when the routine has no run", async () => {
    const fx = await seed([step("build"), step("review", ["build"])]);

    const res = await request(appFor(boardActor(fx.companyId))).get(`/api/routines/${fx.routineId}/step-stats`);

    expect(res.status).toBe(200);
    const stats = routineStepStatsSchema.parse(res.body);
    expect(stats.window).toEqual({ runs: 50, scannedRuns: 0, since: null });
    expect(stats.routine).toMatchObject({
      runs: 0,
      finishedRuns: 0,
      medianDurationMs: null,
      done: 0,
      cancelled: 0,
      open: 0,
      cancelledRate: null,
      agentRuns: 0,
      inputTokens: null,
      costMicros: null,
      reviewRounds: 0,
      changesRequestedRate: null,
    });
    expect(stats.steps.map((entry) => [entry.key, entry.title, entry.runs])).toEqual([
      ["build", "Step build", 0],
      ["review", "Step review", 0],
    ]);
  });

  it("derives runs, outcomes, durations, usage and reviews from the rows the runs wrote", async () => {
    const fx = await seed([step("build"), step("review", ["build"])]);
    const first = await runOnce(fx);
    const second = await runOnce(fx);
    const t0 = new Date(Date.now() + MINUTE);
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MINUTE);

    await close(first.build!, "done", at(0), at(10));
    await close(first.review!, "done", at(12), at(20));
    await close(second.build!, "cancelled", at(0), at(5));
    await usage(fx, first.build!, { input: 100, output: 10, costMicros: 2_000, durationMs: 9 * MINUTE });
    await usage(fx, first.build!, { input: 50, output: 5, costMicros: null, durationMs: MINUTE });
    await usage(fx, first.review!, { input: 30, output: 3, costMicros: 500, durationMs: 4 * MINUTE });
    await decision(fx, first.review!, "changes_requested");
    await decision(fx, first.review!, "approved");

    const res = await request(appFor(boardActor(fx.companyId))).get(`/api/routines/${fx.routineId}/step-stats`);

    expect(res.status).toBe(200);
    const stats = routineStepStatsSchema.parse(res.body);
    expect(stats.window.scannedRuns).toBe(2);
    expect(stats.window.since).not.toBeNull();
    const firstRun = await db.select().from(issues).where(eq(issues.id, first.build!));
    expect(stats.routine).toEqual({
      runs: 2,
      finishedRuns: 1,
      medianDurationMs: at(20).getTime() - firstRun[0]!.createdAt.getTime(),
      done: 2,
      cancelled: 1,
      open: 1,
      cancelledRate: 1 / 3,
      agentRuns: 3,
      inputTokens: 180,
      cacheReadTokens: null,
      outputTokens: 18,
      costMicros: 2_500,
      agentDurationMs: 14 * MINUTE,
      reviewRounds: 2,
      changesRequested: 1,
      changesRequestedRate: 0.5,
    });
    expect(stats.steps).toEqual([
      {
        key: "build",
        title: "Step build",
        runs: 2,
        medianDurationMs: 10 * MINUTE,
        done: 1,
        cancelled: 1,
        open: 0,
        cancelledRate: 0.5,
        agentRuns: 2,
        inputTokens: 150,
        cacheReadTokens: null,
        outputTokens: 15,
        costMicros: 2_000,
        agentDurationMs: 10 * MINUTE,
        reviewRounds: 0,
        changesRequested: 0,
        changesRequestedRate: null,
      },
      {
        key: "review",
        title: "Step review",
        runs: 2,
        medianDurationMs: 8 * MINUTE,
        done: 1,
        cancelled: 0,
        open: 1,
        cancelledRate: 0,
        agentRuns: 1,
        inputTokens: 30,
        cacheReadTokens: null,
        outputTokens: 3,
        costMicros: 500,
        agentDurationMs: 4 * MINUTE,
        reviewRounds: 2,
        changesRequested: 1,
        changesRequestedRate: 0.5,
      },
    ]);
  });

  it("reads only the latest runs, lists keys that only earlier runs had, and skips runs without steps", async () => {
    const fx = await seed([]);
    await fx.svc.runRoutine(fx.routineId, { source: "manual" });
    await fx.svc.update(fx.routineId, { steps: [step("draft")] }, {});
    await runOnce(fx);
    await fx.svc.update(fx.routineId, { steps: [step("build")] }, {});
    await runOnce(fx);
    const app = appFor(boardActor(fx.companyId));

    const all = routineStepStatsSchema.parse((await request(app).get(`/api/routines/${fx.routineId}/step-stats`)).body);
    expect(all.window.scannedRuns).toBe(3);
    expect(all.routine.runs).toBe(2);
    expect(all.steps.map((entry) => [entry.key, entry.title, entry.runs])).toEqual([
      ["build", "Step build", 1],
      ["draft", null, 1],
    ]);

    const latest = routineStepStatsSchema.parse(
      (await request(app).get(`/api/routines/${fx.routineId}/step-stats?runs=1`)).body,
    );
    expect(latest.window).toMatchObject({ runs: 1, scannedRuns: 1 });
    expect(latest.steps.map((entry) => [entry.key, entry.runs])).toEqual([["build", 1]]);
  });

  it("ignores a recorded step issue of another routine or company", async () => {
    const fx = await seed([step("build")]);
    const other = await seed([step("build")]);
    const otherIds = await runOnce(other);
    const ids = await runOnce(fx);
    const [run] = await db
      .select()
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, fx.routineId), eq(routineRuns.companyId, fx.companyId)));
    const payload = readRoutineStepsRunPayload(run?.triggerPayload);
    await db
      .update(routineRuns)
      .set({
        triggerPayload: {
          ...run!.triggerPayload,
          routineSteps: { ...payload, stepIssueIds: { build: ids.build, stolen: otherIds.build, junk: "not-a-uuid" } },
        },
      })
      .where(eq(routineRuns.id, run!.id));

    const res = await request(appFor(boardActor(fx.companyId))).get(`/api/routines/${fx.routineId}/step-stats`);

    expect(res.status).toBe(200);
    expect(res.body.steps.map((entry: { key: string; runs: number }) => [entry.key, entry.runs])).toEqual([["build", 1]]);
  });

  it("rejects a window out of range or an unknown query key", async () => {
    const fx = await seed([step("build")]);
    const app = appFor(boardActor(fx.companyId));

    for (const query of ["runs=0", "runs=101", "runs=abc", "limit=5"]) {
      const res = await request(app).get(`/api/routines/${fx.routineId}/step-stats?${query}`);
      expect(res.status, query).toBe(400);
    }
    expect((await request(app).get(`/api/routines/${fx.routineId}/step-stats?runs=100`)).status).toBe(200);
  });

  it("answers 404 outside the routine's company and lets a same-company agent read", async () => {
    const fx = await seed([step("build")]);
    const other = await seed([]);

    const outside = await request(appFor(boardActor(other.companyId))).get(`/api/routines/${fx.routineId}/step-stats`);
    expect(outside.status).toBe(404);

    const missing = await request(appFor(boardActor(fx.companyId))).get(`/api/routines/${randomUUID()}/step-stats`);
    expect(missing.status).toBe(404);

    const agent = await request(
      appFor({ type: "agent", agentId: fx.agentId, companyId: fx.companyId, source: "agent_key" }),
    ).get(`/api/routines/${fx.routineId}/step-stats`);
    expect(agent.status).toBe(200);
  });
});
