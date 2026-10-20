import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Worked on the assigned issue.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry");
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TICK_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RUN_CAP = 5;
const ISSUE_COUNT = 5;

function utcDayStart(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

describeEmbeddedPostgres("liveness dispatch for an agent at its daily run cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-liveness-daily-cap-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 120_000);

  afterEach(async () => {
    vi.useRealTimers();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]));
    await db.update(issues).set({ status: "done", executionRunId: null, checkoutRunId: null });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCappedAgent(dayStart: Date) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Capped company",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Capped worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxDailyRuns: DAILY_RUN_CAP } },
      permissions: {},
    });
    // The day's allowance is spent by runs that carried no issue, so every
    // assigned todo below still has no run and stays in the liveness lane.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: DAILY_RUN_CAP }, (_, index) => ({
        companyId,
        agentId,
        invocationSource: "timer" as const,
        triggerDetail: "system" as const,
        status: "succeeded" as const,
        startedAt: new Date(dayStart.getTime() + (index + 1) * 1000),
        finishedAt: new Date(dayStart.getTime() + (index + 2) * 1000),
        contextSnapshot: {},
      })),
    );
    const issueIds: string[] = [];
    for (let number = 1; number <= ISSUE_COUNT; number += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Assigned work ${number}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        responsibleUserId: "responsible-user",
        issueNumber: number,
        identifier: `${issuePrefix}-${number}`,
      });
    }
    return { companyId, agentId, issueIds };
  }

  /**
   * Wakes skipped at the daily run cap, all of them or only the liveness
   * dispatcher's. A finished run's own follow-up wakes (for example a
   * disposition repair) belong to other lanes.
   */
  async function countCapSkips(agentId: string, onlyLivenessDispatch = false) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "skipped"),
        eq(agentWakeupRequests.reason, "heartbeat.daily_run_limit"),
        onlyLivenessDispatch
          ? sql`${agentWakeupRequests.payload} ->> 'mutation' = 'assigned_todo_liveness_dispatch'`
          : undefined,
      ));
    return Number(row?.count ?? 0);
  }

  const countLivenessCapSkips = (agentId: string) => countCapSkips(agentId, true);

  function capHoldEntries(agentId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.agentId, agentId),
        eq(activityLog.action, "heartbeat.daily_cap_dispatch_held"),
      ));
  }

  it("holds dispatch with one record per cap window and resumes after the reset", async () => {
    // Simulated days end before the real clock: run leases are timed by the
    // database clock, and a simulated time ahead of it would expire them.
    const dayStart = new Date(utcDayStart(new Date()).getTime() - 2 * DAY_MS);
    const nextDayStart = new Date(dayStart.getTime() + DAY_MS);
    const ticksInDay = DAY_MS / TICK_MS;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dayStart);
    const { companyId, agentId, issueIds } = await seedCappedAgent(dayStart);
    const heartbeat = heartbeatService(db);

    // A simulated day of liveness ticks, one every 30 seconds.
    let dispatched = 0;
    let deferred = 0;
    for (let tick = 1; tick < ticksInDay; tick += 1) {
      vi.setSystemTime(new Date(dayStart.getTime() + tick * TICK_MS));
      const result = await heartbeat.reconcileStrandedAssignedIssues();
      dispatched += result.assignmentDispatched;
      deferred += result.assignmentDispatchDeferred;
    }
    const simulated = `${ticksInDay - 1} ticks over ${ISSUE_COUNT} issues`;
    expect(dispatched, `dispatches in ${simulated}`).toBe(0);
    expect(await countCapSkips(agentId), `wakes skipped at the cap in ${simulated}`).toBe(0);
    expect(deferred).toBe((ticksInDay - 1) * ISSUE_COUNT);
    const holdsInDay = await capHoldEntries(agentId);
    expect(holdsInDay, `cap hold records in ${simulated}`).toHaveLength(1);
    expect(holdsInDay[0]).toMatchObject({
      companyId,
      entityType: "agent",
      entityId: agentId,
      details: expect.objectContaining({
        reason: "heartbeat.daily_run_limit",
        observed: DAILY_RUN_CAP,
        limit: DAILY_RUN_CAP,
        windowStart: dayStart.toISOString(),
        resetsAt: nextDayStart.toISOString(),
      }),
    });
    // A restarted process has no in-memory record of the hold; the stored entry
    // still keeps the window at one.
    const restarted = heartbeatService(db);
    expect((await restarted.reconcileStrandedAssignedIssues()).assignmentDispatchDeferred).toBe(ISSUE_COUNT);
    expect(await capHoldEntries(agentId)).toHaveLength(1);
    const stillAssigned = await db.select().from(issues).where(inArray(issues.id, issueIds));
    expect(stillAssigned.every((issue) => issue.status === "todo" && issue.assigneeAgentId === agentId)).toBe(true);

    // The first tick of the next window dispatches every held issue, and the
    // new window has no hold record while the agent is under its cap.
    vi.setSystemTime(nextDayStart);
    const afterReset = await heartbeat.reconcileStrandedAssignedIssues();
    expect(afterReset.assignmentDispatched).toBe(ISSUE_COUNT);
    expect(afterReset.assignmentDispatchDeferred).toBe(0);
    expect(new Set(afterReset.issueIds)).toEqual(new Set(issueIds));
    await heartbeat.drainActiveRunExecutions();
    expect(await countLivenessCapSkips(agentId)).toBe(0);
    expect(await capHoldEntries(agentId)).toHaveLength(1);

    // Those runs spend the new window's cap; new work is held again, with one
    // new record for the new window only.
    await db.update(issues).set({ status: "done" }).where(inArray(issues.id, issueIds));
    const [prefixRow] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies)
      .where(eq(companies.id, companyId));
    await db.insert(issues).values({
      companyId,
      title: "Assigned work after the reset",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      responsibleUserId: "responsible-user",
      issueNumber: ISSUE_COUNT + 1,
      identifier: `${prefixRow!.issuePrefix}-${ISSUE_COUNT + 1}`,
    });
    for (let tick = 1; tick <= 3; tick += 1) {
      vi.setSystemTime(new Date(nextDayStart.getTime() + tick * TICK_MS));
      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.assignmentDispatched).toBe(0);
      expect(result.assignmentDispatchDeferred).toBe(1);
    }
    expect(await countLivenessCapSkips(agentId)).toBe(0);
    const holds = await capHoldEntries(agentId);
    expect(holds.map((entry) => (entry.details as Record<string, unknown>).windowStart).sort()).toEqual([
      dayStart.toISOString(),
      nextDayStart.toISOString(),
    ]);
  }, 600_000);

  it("holds dispatch with no receipt and no cap record when wakeOnDemand is off", async () => {
    const { agentId, issueIds } = await seedCappedAgent(utcDayStart(new Date()));
    await db.update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } })
      .where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.assignmentDispatched).toBe(0);
      expect(result.assignmentDispatchDeferred).toBe(issueIds.length);
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toEqual([]);
    expect(await capHoldEntries(agentId)).toEqual([]);
  });
});
