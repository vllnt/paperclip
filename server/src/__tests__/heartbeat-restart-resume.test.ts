import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, shouldResetTaskSessionForWake } from "../services/heartbeat.ts";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { orderQueuedRunsForClaim, selectAgentQueuedRuns } from "../services/queued-run-claim-order.js";

// Literal on purpose: the test states the contract, not the constant's name.
const RESUME = "planned_restart_resume";
const TRANSIENT = "transient_failure";
const DEAD_PID = 999_999_999;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres restart resume tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RunRow = typeof heartbeatRuns.$inferSelect;

describeEmbeddedPostgres("heartbeat restart resume", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-restart-resume-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(environmentLeases);
        await db.delete(issueRecoveryActions);
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Resume Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** One run that is `running` and holds the execution lock of its issue. */
  async function seedRunningRun(
    agent: { companyId: string; agentId: string },
    input: {
      issuePriority?: string;
      scheduledRetryAttempt?: number;
      scheduledRetryReason?: string;
      contextSnapshot?: Record<string, unknown>;
      processPid?: number | null;
      controllerBootId?: string;
      leaseValidForMs?: number;
    } = {},
  ) {
    const { companyId, agentId } = agent;
    const runId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned", ...(input.contextSnapshot ?? {}) },
      processPid: input.processPid ?? null,
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      ...(input.controllerBootId
        ? {
            controllerBootId: input.controllerBootId,
            controllerLeaseExpiresAt: new Date(Date.now() + (input.leaseValidForMs ?? 60_000)),
          }
        : {}),
      nextEventSeq: 2,
      startedAt,
      updatedAt: startedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: { adapterType: "claude_local" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work cut short by a restart",
      status: "in_progress",
      priority: input.issuePriority ?? "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { ...agent, runId, issueId };
  }

  /** An SSH lease of the run. `stopped` models a stop that an earlier call recorded. */
  async function seedSshLease(input: { companyId: string; runId: string; issueId: string; stopped?: boolean }) {
    const now = new Date();
    await db.insert(environmentLeases).values({
      id: randomUUID(),
      companyId: input.companyId,
      environmentId: null,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "ssh",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "ssh",
        ...(input.stopped
          ? { remoteProcessStop: { outcome: "stopped", matched: 1, killed: 1, survived: 0, at: now.toISOString() } }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  async function successorOf(runId: string): Promise<RunRow> {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function runEventMessages(runId: string): Promise<string[]> {
    const rows = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "lifecycle")));
    return rows.map((row) => row.message ?? "");
  }

  function failureRetries(run: RunRow): unknown {
    return (run.contextSnapshot as { executionRetryAccounting?: { failureRetries?: unknown } } | null)
      ?.executionRetryAccounting?.failureRetries;
  }

  describe("shutdown drain", () => {
    it("queues a resume that is due now, on the same session, and spends no failure retry", async () => {
      const seeded = await seedRunningRun(await seedAgent(), {
        scheduledRetryAttempt: 1,
        scheduledRetryReason: TRANSIENT,
        // A copied fresh-session choice must not survive into the resume.
        contextSnapshot: { forceFreshSession: true },
      });
      const heartbeat = heartbeatService(db);
      const now = new Date();

      const drain = await heartbeat.drainRunningRunsForShutdown("SIGTERM", now);

      expect(drain.interruptedRunIds).toEqual([seeded.runId]);
      const retry = await successorOf(seeded.runId);
      expect(drain.retryRunIds).toEqual([retry.id]);
      expect(retry).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryReason: RESUME,
        scheduledRetryAttempt: 1,
      });
      // No delay.
      expect(retry.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      // Resumes the interrupted run's session and is not reset as a fresh start.
      expect(retry.contextSnapshot).toMatchObject({
        wakeReason: RESUME,
        retryReason: RESUME,
        resumeFromRunId: seeded.runId,
        resumeSessionDisplayId: "session-after",
        forceFreshSession: false,
      });
      expect(shouldResetTaskSessionForWake(retry.contextSnapshot)).toBe(false);
      // The one failure retry already spent stays at one: the restart is free.
      expect(failureRetries(retry)).toBe(1);
    });

    it("leaves the full ordinary retry budget to a real failure after the resume", async () => {
      const seeded = await seedRunningRun(await seedAgent(), {
        scheduledRetryAttempt: 1,
        scheduledRetryReason: TRANSIENT,
      });
      const heartbeat = heartbeatService(db);
      await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date());
      const resume = await successorOf(seeded.runId);
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, resume.id));

      const next = await heartbeat.scheduleBoundedRetry(resume.id, { now: new Date() });

      // One failure retry was spent before the restart; the second is still free.
      expect(next).toMatchObject({ outcome: "scheduled" });
      expect(await successorOf(resume.id)).toMatchObject({
        scheduledRetryReason: TRANSIENT,
        scheduledRetryAttempt: 2,
      });
    });

    it("uses the ordinary bounded retry once three resumes followed each other", async () => {
      const seeded = await seedRunningRun(await seedAgent(), {
        scheduledRetryAttempt: 3,
        scheduledRetryReason: RESUME,
        contextSnapshot: { failureRetriesBeforePlannedRestart: 0 },
      });
      const now = new Date();

      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", now);

      const retry = await successorOf(seeded.runId);
      expect(retry).toMatchObject({ scheduledRetryReason: TRANSIENT, scheduledRetryAttempt: 1 });
      expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());
    });

    it("resumes when the stored evidence shows the remote processes stopped", async () => {
      const seeded = await seedRunningRun(await seedAgent());
      await seedSshLease({ ...seeded, stopped: true });

      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date());

      expect(await successorOf(seeded.runId)).toMatchObject({ scheduledRetryReason: RESUME });
    });

    it("falls back to the ordinary retry and records why when the remote stop is unproven", async () => {
      const seeded = await seedRunningRun(await seedAgent());
      // No stop is recorded and the environment is gone: nothing can prove it.
      await seedSshLease(seeded);
      const now = new Date();

      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", now);

      const retry = await successorOf(seeded.runId);
      expect(retry).toMatchObject({ scheduledRetryReason: TRANSIENT, scheduledRetryAttempt: 1 });
      expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());
      expect(retry.contextSnapshot).not.toHaveProperty("resumeFromRunId");
      expect(await runEventMessages(seeded.runId)).toContainEqual(
        expect.stringContaining("Restart resume skipped"),
      );
    });
  });

  describe("claim order", () => {
    it("claims the resume of an interrupted run before older and more urgent queued runs", async () => {
      const agent = await seedAgent();
      const interrupted = await seedRunningRun(agent, { issuePriority: "low" });
      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date());
      const resume = await successorOf(interrupted.runId);
      // The scheduled retry becomes due and queued; only the status changes.
      await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, resume.id));

      const urgentIssueId = randomUUID();
      const urgentRunId = randomUUID();
      await db.insert(issues).values({
        id: urgentIssueId,
        companyId: agent.companyId,
        title: "Urgent work that has waited longer",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agent.agentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(heartbeatRuns).values({
        id: urgentRunId,
        companyId: agent.companyId,
        agentId: agent.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: urgentIssueId },
        createdAt: new Date(Date.now() - 5 * 60_000),
      });

      const queued = await selectAgentQueuedRuns(db, { ...agent, cutoff: null });
      const priorities = new Map([
        [interrupted.issueId, "low"],
        [urgentIssueId, "critical"],
      ]);
      const ordered = orderQueuedRunsForClaim(
        queued,
        (run) => {
          const issueId = (run.contextSnapshot as { issueId?: string } | null)?.issueId;
          return issueId
            ? { priority: priorities.get(issueId), inProgress: false, dependencyReady: true }
            : null;
        },
        new Date(),
      );

      expect(ordered.map((run) => run.id)).toEqual([resume.id, urgentRunId]);
    });
  });

  describe("startup reap of runs owned by another boot", () => {
    it("reaps a run of another boot at once, but only when asked to, and queues a resume", async () => {
      const seeded = await seedRunningRun(await seedAgent(), {
        processPid: DEAD_PID,
        controllerBootId: randomUUID(),
        leaseValidForMs: 60_000,
      });
      const heartbeat = heartbeatService(db);

      // Without the startup flag the live lease still protects the run.
      expect(await heartbeat.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
      expect((await heartbeat.getRun(seeded.runId))?.status).toBe("running");

      const result = await heartbeat.reapOrphanedRuns({ reapDeadBootRuns: true });

      expect(result).toEqual({ reaped: 1, runIds: [seeded.runId] });
      expect(await heartbeat.getRun(seeded.runId)).toMatchObject({ status: "failed", errorCode: "process_lost" });
      const retry = await successorOf(seeded.runId);
      expect(retry).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryReason: RESUME,
        scheduledRetryAttempt: 1,
      });
      expect(retry.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(retry.contextSnapshot).toMatchObject({
        wakeReason: RESUME,
        resumeFromRunId: seeded.runId,
        resumeSessionDisplayId: "session-after",
      });
      expect(failureRetries(retry)).toBe(0);
    });

    it("does not reap a run that this boot owns", async () => {
      const seeded = await seedRunningRun(await seedAgent(), {
        processPid: DEAD_PID,
        controllerBootId: legacyControllerBootId,
      });
      const heartbeat = heartbeatService(db);

      expect(await heartbeat.reapOrphanedRuns({ reapDeadBootRuns: true })).toEqual({ reaped: 0, runIds: [] });
      expect((await heartbeat.getRun(seeded.runId))?.status).toBe("running");
    });

    it("leaves a run running while its local child process is still alive", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.add(child);
      expect(child.pid).toBeGreaterThan(0);
      const seeded = await seedRunningRun(await seedAgent(), {
        processPid: child.pid ?? null,
        controllerBootId: randomUUID(),
      });
      const heartbeat = heartbeatService(db);

      expect(await heartbeat.reapOrphanedRuns({ reapDeadBootRuns: true })).toEqual({ reaped: 0, runIds: [] });
      expect((await heartbeat.getRun(seeded.runId))?.status).toBe("running");
    });

    it("falls back to the ordinary retry and records why when the remote stop is unproven", async () => {
      const seeded = await seedRunningRun(await seedAgent(), {
        processPid: DEAD_PID,
        controllerBootId: randomUUID(),
      });
      await seedSshLease(seeded);
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.reapOrphanedRuns({ reapDeadBootRuns: true });

      expect(result.reaped).toBe(1);
      expect(await successorOf(seeded.runId)).toMatchObject({
        scheduledRetryReason: TRANSIENT,
        scheduledRetryAttempt: 1,
      });
      expect(await runEventMessages(seeded.runId)).toContainEqual(
        expect.stringContaining("Restart resume skipped"),
      );
    });
  });
});
