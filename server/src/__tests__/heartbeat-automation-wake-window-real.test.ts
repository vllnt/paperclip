import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // Holds an issue's row lock so a promotion on that issue blocks before its admission check.
  async function holdIssueLock(issueId: string) {
    let unlock: () => void = () => {};
    let signal: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const blocker = db.transaction(async (transaction) => {
      await transaction.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      signal();
      await released;
    });
    await locked;
    return {
      async waitForWaiter() {
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
      },
      async release() {
        unlock();
        await blocker;
      },
    };
  }

  it("rechecks the window under the promotion lock when a fresh wake commits first", async () => {
    const { companyId, agentId, issueIds } = await seed(300, 2);
    const retryId = await insertScheduledRetry(companyId, agentId, issueIds[0]!);
    const lock = await holdIssueLock(issueIds[0]!);
    const pending = heartbeat.promoteDueScheduledRetries();
    try {
      await lock.waitForWaiter();
      await monitorWake(agentId, issueIds[1]!);
    } finally {
      await lock.release();
    }
    const promoted = await pending;

    expect(await monitorRuns(agentId)).toHaveLength(1);
    expect(promoted.runIds).not.toContain(retryId);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(retry?.status).toBe("scheduled_retry");
  });

  it("stamps admission after waiting for locks, not at the start of the sweep", async () => {
    const { companyId, agentId, issueIds } = await seed(1, 2);
    const retryId = await insertScheduledRetry(companyId, agentId, issueIds[0]!);
    const lock = await holdIssueLock(issueIds[0]!);
    const pending = heartbeat.promoteDueScheduledRetries();
    try {
      await lock.waitForWaiter();
      // Longer than the 1-second window: a sweep-start stamp would already be expired.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      await lock.release();
    }
    expect((await pending).runIds).toEqual([retryId]);

    await monitorWake(agentId, issueIds[1]!);
    expect(await monitorRuns(agentId)).toHaveLength(0);
  }, 30_000);

  it("stamps a fresh wake's admission after waiting for the window lock", async () => {
    const { companyId, agentId, issueIds } = await seed(1, 2);
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => (ready = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const blocker = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`automation-wake-window:${companyId}:${agentId}`}, 0))`,
      );
      ready();
      await released;
    });
    await locked;
    const pending = monitorWake(agentId, issueIds[0]!);
    try {
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (!waiting && Date.now() < deadline) {
        const rows = await db.execute(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
          and query like '%pg_advisory_xact_lock%'`);
        waiting = Number(rows[0]?.count ?? 0);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      // Longer than the 1-second window: a transaction-start stamp would already be expired.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      release();
      await blocker;
    }
    await pending;

    await monitorWake(agentId, issueIds[1]!);
    expect(await monitorRuns(agentId)).toHaveLength(1);
  }, 30_000);

  it("reschedules held retries so more than a sweep's skip cap cannot starve another agent", async () => {
    const held = await seed(300, 1);
    await insertRecentAutomationRun(held.companyId, held.agentId, held.issueIds[0]!);
    const heldCount = 520;
    const heldIds: string[] = [];
    await db.insert(heartbeatRuns).values(
      Array.from({ length: heldCount }, (_, index) => {
        const id = randomUUID();
        heldIds.push(id);
        return {
          id,
          companyId: held.companyId,
          agentId: held.agentId,
          invocationSource: "automation" as const,
          triggerDetail: "system",
          status: "scheduled_retry" as const,
          scheduledRetryAt: new Date(Date.now() - 60_000 + index),
          scheduledRetryAttempt: 1,
          scheduledRetryReason: "provider_quota_recovery",
          responsibleUserId: "window-user",
          createdAt: new Date(Date.now() - 600_000),
          contextSnapshot: {
            issueId: held.issueIds[0],
            wakeReason: "provider_quota_recovery",
            retryReason: "provider_quota_recovery",
          },
        };
      }),
    );
    const other = await seed(0, 1);
    const first = await insertScheduledRetry(other.companyId, other.agentId, other.issueIds[0]!, {
      dueAt: new Date(Date.now() - 1000),
    });

    expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([first]);

    // Held rows moved to the end of the window, so they are no longer due and later
    // sweeps reach the other agent's next retry without rescanning them.
    const rescheduled = await db
      .select({ at: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, held.agentId), eq(heartbeatRuns.status, "scheduled_retry")));
    expect(rescheduled).toHaveLength(heldCount);
    expect(rescheduled.every((row) => row.at && row.at.getTime() > Date.now())).toBe(true);

    const second = await insertScheduledRetry(other.companyId, other.agentId, other.issueIds[0]!, {
      dueAt: new Date(Date.now() - 500),
    });
    expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([second]);
  }, 120_000);

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

  // Starts a manual run on `issueId` whose real child process stays alive for `runMs`, so a
  // wake for that issue parks behind it and its release drains the queue.
  async function startManualRun(companyId: string, agentId: string, issueId: string, runMs: number) {
    const marker = join(tmpdir(), `window-child-${randomUUID()}`);
    const command = (script: string) => ({ command: process.execPath, args: ["-e", script], cwd: tmpdir() });
    await db.update(agents).set({
      adapterConfig: command(
        `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => process.exit(0), ${runMs})`,
      ),
    }).where(eq(agents.id, agentId));
    const manual = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_test",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "manual_test" },
      requestedByActorType: "user",
      requestedByActorId: "window-user",
    });
    expect(manual).not.toBeNull();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);
    // The running child keeps its command; later runs finish promptly.
    await db.update(agents).set({ adapterConfig: command("process.exit(0)") }).where(eq(agents.id, agentId));
    return manual!;
  }

  async function runsForIssue(agentId: string, issueId: string) {
    return (await monitorRuns(agentId)).filter((run) => run.contextSnapshot?.issueId === issueId);
  }

  async function deferredReceipts(agentId: string, issueId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
      ));
  }

  // Parks a monitor wake for issue 0 behind its running manual run. Coalesced: the window was
  // open when it arrived and its own deadline has since passed. Unmarked: a receipt carrying no
  // window deadline at all, as an automation wake deferred behind active execution does.
  async function parkMonitorWake(
    kind: "coalesced" | "unmarked",
    fixture: { companyId: string; agentId: string; issueIds: string[] },
  ) {
    const { companyId, agentId, issueIds } = fixture;
    if (kind === "unmarked") {
      const [receipt] = await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_monitor_due",
        status: "deferred_issue_execution",
        payload: {
          issueId: issueIds[0],
          _paperclipWakeContext: { issueId: issueIds[0], wakeReason: "issue_monitor_due" },
        },
      }).returning();
      return receipt!;
    }
    await insertRecentAutomationRun(companyId, agentId, issueIds[1]!);
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 299_000) })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "succeeded")));
    expect(await monitorWake(agentId, issueIds[0]!)).toBeNull();
    const [receipt] = await deferredReceipts(agentId, issueIds[0]!);
    expect(receipt).toBeDefined();
    // Let the receipt's own deadline pass; the renewal that follows outlives it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return receipt!;
  }

  // The parked wake stays behind the manual run while another issue's wake renews the window;
  // the release must then not start it inside the renewed window.
  it.each(["coalesced", "unmarked"] as const)("holds a %s receipt on release while another issue's wake owns the window", async (kind) => {
    const fixture = await seed(300, 2);
    const { companyId, agentId, issueIds } = fixture;
    const manual = await startManualRun(companyId, agentId, issueIds[0]!, 4000);
    const parked = await parkMonitorWake(kind, fixture);
    expect(await monitorWake(agentId, issueIds[1]!)).not.toBeNull();

    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, manual.id));
    expect(finished?.status).toBe("succeeded");
    expect(await runsForIssue(agentId, issueIds[0]!)).toHaveLength(0);
    expect((await deferredReceipts(agentId, issueIds[0]!)).map((row) => row.id)).toEqual([parked.id]);
  }, 60_000);

  it("delivers a receipt held on release once the window ends", async () => {
    const fixture = await seed(300, 2);
    const { companyId, agentId, issueIds } = fixture;
    await startManualRun(companyId, agentId, issueIds[0]!, 2000);
    await parkMonitorWake("coalesced", fixture);
    expect(await monitorWake(agentId, issueIds[1]!)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runsForIssue(agentId, issueIds[0]!)).toHaveLength(0);

    // Age the renewing run past the window, then let the sweep redeliver the held receipt.
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 301_000) })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "succeeded")));
    await heartbeat.sweepDeferredWakes({ agentId, minAgeMs: 0, recheckMs: 0 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await runsForIssue(agentId, issueIds[0]!)).toHaveLength(1);
    expect(await deferredReceipts(agentId, issueIds[0]!)).toHaveLength(0);
  }, 60_000);

  async function insertAgent(companyId: string, name: string, windowSeconds: number) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: "/tmp" },
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, minSecondsBetweenAutomationWakes: windowSeconds },
      },
      permissions: {},
    });
    return agentId;
  }

  async function insertIssue(companyId: string, assigneeAgentId: string, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "in_progress",
      assigneeAgentId,
      responsibleUserId: "window-user",
    });
    return issueId;
  }

  async function parkUnmarkedWake(companyId: string, agentId: string, issueId: string) {
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      status: "deferred_issue_execution",
      payload: { issueId, _paperclipWakeContext: { issueId, wakeReason: "issue_monitor_due" } },
    });
  }

  // A queued manual run that its issue points at; cancelling it enters the real release drain.
  async function queueManualRun(companyId: string, agentId: string, issueId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      responsibleUserId: "window-user",
      contextSnapshot: { issueId, wakeReason: "manual_test" },
    }).returning();
    await db.update(issues).set({ executionRunId: run!.id, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    return run!;
  }

  // Holds the agent's window lock in a separate transaction until the returned function is called.
  async function holdWindowLock(companyId: string, agentId: string) {
    let unlock!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const finished = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`automation-wake-window:${companyId}:${agentId}`}, 0))`,
      );
      locked();
      await hold;
    });
    await acquired;
    return async () => {
      unlock();
      await finished;
    };
  }

  it("releases opposite-order queues of several agents without deadlock, keeping held receipts", async () => {
    const { companyId, agentId: agentA } = await seed(300, 0);
    const agentB = await insertAgent(companyId, "Window agent B", 300);
    const finisher1 = await insertAgent(companyId, "Finisher 1", 0);
    const finisher2 = await insertAgent(companyId, "Finisher 2", 0);
    const issue1 = await insertIssue(companyId, finisher1, "Queue [A, B]");
    const issue2 = await insertIssue(companyId, finisher2, "Queue [B, A]");
    for (const agentId of [agentA, agentB]) await insertRecentAutomationRun(companyId, agentId, issue1);
    const manual1 = await queueManualRun(companyId, finisher1, issue1);
    const manual2 = await queueManualRun(companyId, finisher2, issue2);
    await parkUnmarkedWake(companyId, agentA, issue1);
    await parkUnmarkedWake(companyId, agentB, issue1);
    await parkUnmarkedWake(companyId, agentB, issue2);
    await parkUnmarkedWake(companyId, agentA, issue2);

    // Both windows are busy when the releases start; unlocking A before B reproduces the
    // interleaving in which each drain holds one window and waits for the other.
    const unlockA = await holdWindowLock(companyId, agentA);
    const unlockB = await holdWindowLock(companyId, agentB);
    const releases = Promise.allSettled([
      heartbeat.cancelRun(manual1.id, undefined, { suppressImmediateRecovery: true }),
      heartbeat.cancelRun(manual2.id, undefined, { suppressImmediateRecovery: true }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await unlockA();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await unlockB();
    const results = await releases;

    expect(results.map((result) => (result.status === "rejected" ? String(result.reason) : result.status))).toEqual(["fulfilled", "fulfilled"]);
    const pointers = await db.select({ id: issues.id, executionRunId: issues.executionRunId }).from(issues)
      .where(sql`${issues.id} in (${issue1}, ${issue2})`);
    expect(pointers.map((row) => row.executionRunId)).toEqual([null, null]);
    for (const agentId of [agentA, agentB]) {
      expect(await deferredReceipts(agentId, issue1)).toHaveLength(1);
      expect(await deferredReceipts(agentId, issue2)).toHaveLength(1);
    }
  }, 90_000);

  // A cancelled run's system recovery is an automation wake: inside the window it is not started,
  // its receipt waits, and the sweep delivers it once the window has ended.
  it("holds the immediate recovery of a cancelled run inside the window, then delivers it", async () => {
    const { companyId, agentId, issueIds } = await seed(300, 2);
    await insertRecentAutomationRun(companyId, agentId, issueIds[1]!);
    const manual = await queueManualRun(companyId, agentId, issueIds[0]!);

    await heartbeat.cancelRun(manual.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const recoveries = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter((run) => run.contextSnapshot?.wakeReason === "issue_continuation_needed");
    expect(await recoveries()).toHaveLength(0);
    const [receipt] = await deferredReceipts(agentId, issueIds[0]!);
    expect(receipt).toBeDefined();

    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 301_000) })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "succeeded")));
    await heartbeat.sweepDeferredWakes({ agentId, minAgeMs: 0, recheckMs: 0 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await recoveries()).toHaveLength(1);
    expect(await deferredReceipts(agentId, issueIds[0]!)).toHaveLength(0);
  }, 60_000);
});
