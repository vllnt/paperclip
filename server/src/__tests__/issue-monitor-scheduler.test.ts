import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { scheduleIssueWaitMonitor } from "../services/issue-waits.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused" | "terminated";
    wakeOnDemand?: boolean;
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: input?.wakeOnDemand ?? true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("keeps a paused agent's due monitor and fires it once after the agent resumes", async () => {
    const { issueId, agentId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);

    const whilePaused = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(whilePaused.skipped ?? 0).toBe(0);
    const pausedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(pausedIssue.status).toBe("in_progress");
    expect(pausedIssue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:30:00.000Z");
    expect(parseIssueExecutionState(pausedIssue.executionState)?.monitor).toMatchObject({ status: "scheduled" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toEqual([]);

    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    const afterResume = await heartbeat.tickTimers(new Date("2026-04-11T12:40:00.000Z"));
    expect(afterResume.enqueued).toBe(1);
    await heartbeat.tickTimers(new Date("2026-04-11T12:41:00.000Z"));

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.map((wake) => wake.reason)).toEqual(["issue_monitor_due"]);
    const resumedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(resumedIssue.monitorNextCheckAt).toBeNull();
    expect(resumedIssue.monitorAttemptCount).toBe(1);
  });

  it("keeps the monitor and retries when the wake queue drops the wake", async () => {
    const { issueId, agentId } = await seedFixture({ wakeOnDemand: false });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.status).toBe("in_progress");
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:36:00.000Z");
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt).toBeNull();
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor?.nextCheckAt).toBe("2026-04-11T12:36:00.000Z");
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      nextCheckAt: "2026-04-11T12:36:00.000Z",
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.map((row) => row.action)).toContain("issue.monitor_wake_skipped");
    expect(activity.map((row) => row.action)).not.toContain("issue.monitor_triggered");

    // Wake on demand comes back: the next due check wakes the agent once.
    await db.update(agents).set({
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).where(eq(agents.id, agentId));
    await heartbeat.tickTimers(new Date("2026-04-11T12:37:00.000Z"));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.filter((wake) => wake.status !== "skipped").map((wake) => wake.reason)).toEqual(["issue_monitor_due"]);
    const fired = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(fired.monitorNextCheckAt).toBeNull();
    expect(fired.monitorAttemptCount).toBe(2);
  });

  it.each(["pending_approval"] as const)(
    "keeps the wait and backs off when the agent is %s and the wake is refused with a 409",
    async (agentStatus) => {
      const { issueId, agentId } = await seedFixture();
      await db.update(agents).set({ status: agentStatus }).where(eq(agents.id, agentId));
      const heartbeat = heartbeatService(db);

      await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
      const first = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(first.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:36:00.000Z");
      expect(first.monitorAttemptCount).toBe(1);
      expect(parseIssueExecutionState(first.executionState)?.monitor).toMatchObject({ status: "scheduled", attemptCount: 1 });

      // The second refusal backs off further (10 minutes) and counts again.
      await heartbeat.tickTimers(new Date("2026-04-11T12:37:00.000Z"));
      const second = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(second.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:47:00.000Z");
      expect(second.monitorAttemptCount).toBe(2);
      const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).map((row) => row.action);
      expect(actions).toContain("issue.monitor_wake_skipped");
      expect(actions).not.toContain("issue.monitor_skipped");
    },
  );

  it("stops retrying a dropped wake after the attempt cap and hands the issue to owner recovery", async () => {
    const { issueId } = await seedFixture({ wakeOnDemand: false, monitorAttemptCount: 49 });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });
  });

  it("does not treat a wake queued behind a live run as dropped", async () => {
    const { issueId, agentId, companyId } = await seedFixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));

    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null }).where(eq(issues.id, issueId));
  });

  it("bounds a chain of waits: the monitor attempt count carries over and the cap refuses another wait", async () => {
    const { issueId } = await seedFixture({ monitor: { nextCheckAt: "2026-04-11T12:30:00.000Z" }, monitorAttemptCount: 49 });
    const heartbeat = heartbeatService(db);
    const waitIssue = () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    const wait = async (at: Date) => scheduleIssueWaitMonitor(db, issueService(db), {
      issue: await waitIssue(),
      nextCheckAt: at,
      notes: "Waiting: CI",
      serviceName: "Issue wait",
      externalRef: null,
      activity: { actorType: "system", actorId: "test", agentId: null, runId: null, source: "test" },
    });

    // 49 wakes are used, so one more wait is allowed and it carries the cap.
    await db.update(issues).set({ monitorNextCheckAt: null, executionPolicy: null }).where(eq(issues.id, issueId));
    await wait(new Date("2026-04-11T12:30:00.000Z"));
    expect(normalizeIssueExecutionPolicy((await waitIssue()).executionPolicy ?? null)?.monitor?.maxAttempts).toBe(50);
    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect((await waitIssue()).monitorAttemptCount).toBe(50);

    // The 51st wake is refused: the agent cannot chain waits without end.
    await expect(wait(new Date("2026-04-11T12:40:00.000Z"))).rejects.toMatchObject({
      status: 422,
      message: "Monitor bounds are already exhausted",
    });
    expect((await waitIssue()).monitorNextCheckAt).toBeNull();
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "terminated" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
});
