import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Real embedded Postgres and a real process adapter; no internal service is mocked.
describe("automation wake window on the real queue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-automation-wake-window-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 90_000);

  afterEach(async () => {
    await db.update(issues).set({ status: "done" });
    // Held retries stay scheduled; do not let them fill a later test's sweep.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.status, "scheduled_retry"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seed(windowSeconds: number, issueCount: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Window fixture",
      issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "window-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Process fixture",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: "/tmp" },
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, minSecondsBetweenAutomationWakes: windowSeconds },
      },
      permissions: {},
    });
    const issueIds: string[] = [];
    for (let index = 0; index < issueCount; index += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Window issue ${index}`,
        status: "in_progress",
        assigneeAgentId: agentId,
        responsibleUserId: "window-user",
      });
    }
    return { companyId, agentId, issueIds };
  }

  async function insertRecentAutomationRun(companyId: string, agentId: string, issueId: string) {
    const createdAt = new Date(Date.now() - 100);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      responsibleUserId: "window-user",
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
      contextSnapshot: { issueId, wakeReason: "issue_monitor_due" },
    });
  }

  function monitorWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_monitor_due" },
      requestedByActorType: "system",
      requestedByActorId: "window-test",
    });
  }

  async function monitorRuns(agentId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((run) => run.contextSnapshot?.wakeReason === "issue_monitor_due");
  }

  it("admits one run when wakes for different issues arrive together", async () => {
    const { agentId, issueIds } = await seed(300, 2);
    // Hold every heartbeat_runs insert until both admissions have passed their window check.
    let releaseLock: () => void = () => {};
    let signalLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = db.transaction(async (transaction) => {
      await transaction.execute(sql`lock table heartbeat_runs in share mode`);
      signalLocked();
      await released;
    });
    await locked;
    const pending = issueIds.map((issueId) => monitorWake(agentId, issueId));
    // Without serialization both reach the insert; with it, one waits on the agent lock.
    await new Promise((resolve) => setTimeout(resolve, 750));
    releaseLock();
    await blocker;
    await Promise.all(pending);

    expect(await monitorRuns(agentId)).toHaveLength(1);
    const parked = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(parked).toHaveLength(1);
  });

  it("holds a due scheduled retry while the agent window is open, then promotes it", async () => {
    const { companyId, agentId, issueIds } = await seed(300, 2);
    await insertRecentAutomationRun(companyId, agentId, issueIds[0]!);
    const now = new Date();
    const wakeupRequestId = randomUUID();
    const scheduledRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "provider_quota_recovery",
      status: "queued",
      payload: { issueId: issueIds[1], retryReason: "provider_quota_recovery" },
    });
    await db.insert(heartbeatRuns).values({
      id: scheduledRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt: now,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "provider_quota_recovery",
      responsibleUserId: "window-user",
      contextSnapshot: { issueId: issueIds[1], wakeReason: "provider_quota_recovery", retryReason: "provider_quota_recovery" },
    });
    await db.update(agentWakeupRequests).set({ runId: scheduledRunId }).where(eq(agentWakeupRequests.id, wakeupRequestId));

    const held = await heartbeat.promoteDueScheduledRetries(new Date(now.getTime() + 1000));
    expect(held.promoted).toBe(0);
    const [stillScheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scheduledRunId));
    expect(stillScheduled?.status).toBe("scheduled_retry");

    // Past the window the same retry is promoted: nothing is dropped.
    const released = await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 301_000));
    expect(released.runIds).toContain(scheduledRunId);
  });

  async function insertScheduledRetry(
    companyId: string,
    agentId: string,
    issueId: string,
    options: { dueAt?: Date; createdAt?: Date } = {},
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "provider_quota_recovery",
      status: "queued",
      payload: { issueId, retryReason: "provider_quota_recovery" },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt: options.dueAt ?? new Date(Date.now() - 1000),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "provider_quota_recovery",
      responsibleUserId: "window-user",
      createdAt: options.createdAt ?? new Date(Date.now() - 600_000),
      contextSnapshot: { issueId, wakeReason: "provider_quota_recovery", retryReason: "provider_quota_recovery" },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  it("treats promotion as the admission time for an aged retry", async () => {
    const { companyId, agentId, issueIds } = await seed(300, 3);
    const first = await insertScheduledRetry(companyId, agentId, issueIds[0]!);
    const second = await insertScheduledRetry(companyId, agentId, issueIds[1]!);

    const promotion = await heartbeat.promoteDueScheduledRetries();
    expect(promotion.runIds).toHaveLength(1);
    expect([first, second]).toContain(promotion.runIds[0]);

    // The promoted retry opened a window, so an immediate fresh wake is coalesced.
    await monitorWake(agentId, issueIds[2]!);
    expect(await monitorRuns(agentId)).toHaveLength(0);
  });

  it("rechecks the window under the promotion lock when a fresh wake commits first", async () => {
    const { companyId, agentId, issueIds } = await seed(300, 2);
    const retryId = await insertScheduledRetry(companyId, agentId, issueIds[0]!);
    let unlock: () => void = () => {};
    let signal: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    // Hold the retry's issue lock so the promotion blocks before its admission check.
    const blocker = db.transaction(async (transaction) => {
      await transaction.select({ id: issues.id }).from(issues).where(eq(issues.id, issueIds[0]!)).for("update");
      signal();
      await released;
    });
    await locked;
    const pending = heartbeat.promoteDueScheduledRetries();
    try {
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline && waiting === 0) {
        const result = await db.execute(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
          and query like '%from "issues"%' and query like '%for update%'`);
        waiting = Number(result[0]?.count ?? 0);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      await monitorWake(agentId, issueIds[1]!);
    } finally {
      unlock();
      await blocker;
    }
    const promoted = await pending;

    expect(await monitorRuns(agentId)).toHaveLength(1);
    expect(promoted.runIds).not.toContain(retryId);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(retry?.status).toBe("scheduled_retry");
  });

  it("does not let held retries starve an eligible retry of another agent", async () => {
    const held = await seed(300, 1);
    await insertRecentAutomationRun(held.companyId, held.agentId, held.issueIds[0]!);
    for (let index = 0; index < 52; index += 1) {
      await insertScheduledRetry(held.companyId, held.agentId, held.issueIds[0]!, {
        dueAt: new Date(Date.now() - 60_000 + index),
      });
    }
    const other = await seed(0, 1);
    const eligible = await insertScheduledRetry(other.companyId, other.agentId, other.issueIds[0]!, {
      dueAt: new Date(Date.now() - 1000),
    });

    const promotion = await heartbeat.promoteDueScheduledRetries();
    expect(promotion.runIds).toEqual([eligible]);
  }, 90_000);

  it("promotes a due scheduled retry immediately when no window is configured", async () => {
    const { companyId, agentId, issueIds } = await seed(0, 2);
    await insertRecentAutomationRun(companyId, agentId, issueIds[0]!);
    const now = new Date();
    const wakeupRequestId = randomUUID();
    const scheduledRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "provider_quota_recovery",
      status: "queued",
      payload: { issueId: issueIds[1], retryReason: "provider_quota_recovery" },
    });
    await db.insert(heartbeatRuns).values({
      id: scheduledRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt: now,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "provider_quota_recovery",
      responsibleUserId: "window-user",
      contextSnapshot: { issueId: issueIds[1], wakeReason: "provider_quota_recovery", retryReason: "provider_quota_recovery" },
    });
    await db.update(agentWakeupRequests).set({ runId: scheduledRunId }).where(eq(agentWakeupRequests.id, wakeupRequestId));

    const result = await heartbeat.promoteDueScheduledRetries(new Date(now.getTime() + 1000));
    expect(result.runIds).toContain(scheduledRunId);
  });
});
