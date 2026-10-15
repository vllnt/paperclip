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
