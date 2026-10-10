import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { buildIssueAssignmentIdempotencyKey } from "../services/issue-assignment-wakeup.js";
import { CONVERSATION_CONTINUATION_POLICY } from "../services/conversation-continuation.js";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported && process.platform === "linux"
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping recycled process group tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE_MS = 60_000;

/**
 * After a deploy restart a new process can get the pid of a finished run. Every
 * adapter spawns its run as its own process group, so that new process also
 * leads a group with the old group id. A detached `sleep` is such a process; the
 * run row records its pid and group with an older start time, as a run from
 * before the restart would.
 */
function startRecycledProcessGroup(): ChildProcess {
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

describeEmbeddedPostgres("a finished run whose process group id was recycled", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  /** Separate pools, so a test can hold a transaction open while the sweep runs. */
  let otherDbs: Array<ReturnType<typeof createDb>> = [];
  const children: ChildProcess[] = [];
  const executed: Array<{ runId: string; context: Record<string, unknown> }> = [];

  async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    executed.push({ runId: ctx.runId, context: ctx.context as Record<string, unknown> });
    return { exitCode: 0, signal: null, timedOut: false, provider: "openai", model: "gpt-test", summary: "Done." };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recycled-process-group-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    otherDbs = [createDb(tempDb.connectionString), createDb(tempDb.connectionString)];
    registerServerAdapter({
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date(0).toISOString(),
      }),
    });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const child of children.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    executed.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "heartbeat_run_events", "issue_comments", "issue_recovery_actions",
        "issues", "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "environment_leases",
        "agents", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter("codex_local");
    for (const other of otherDbs) await other.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  /**
   * An issue whose last run was lost in a restart. By default its recorded
   * process group id now belongs to a new, unrelated process (`recycled`).
   * `live` records that process's real start time, as for a provider that is
   * really still running; `none` records no process at all.
   */
  async function seed(input: {
    issueStatus?: "todo" | "in_progress" | "cancelled" | "done";
    scheduledRetry?: boolean;
    process?: "recycled" | "live" | "none";
  } = {}) {
    const processIdentity = input.process ?? "recycled";
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const lostRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Restart", issuePrefix, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "CodexCoder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    const child = startRecycledProcessGroup();
    children.push(child);
    const pid = child.pid!;
    const { readProcessStartedAt } = await import("../services/hot-restart.js");
    const realStartedAt = new Date((await readProcessStartedAt(pid))!);
    await db.insert(heartbeatRuns).values({
      id: lostRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "failed", errorCode: "process_lost", error: "Process lost -- server may have restarted",
      startedAt: new Date(Date.now() - 10 * MINUTE_MS), finishedAt: new Date(Date.now() - 5 * MINUTE_MS),
      ...(processIdentity === "none" ? {} : {
        processPid: pid, processGroupId: pid,
        processStartedAt: processIdentity === "live" ? realStartedAt : new Date(Date.now() - 60 * MINUTE_MS),
      }),
      resultJson: { conversationContinuation: CONVERSATION_CONTINUATION_POLICY },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    let retryRunId: string | null = null;
    if (input.scheduledRetry) {
      retryRunId = randomUUID();
      const scheduledRetryAt = new Date(Date.now() + 30 * MINUTE_MS);
      const [retryWake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "bounded_transient_heartbeat_retry", status: "queued",
        payload: { issueId, retryOfRunId: lostRunId, scheduledRetryAt: scheduledRetryAt.toISOString() },
      }).returning();
      await db.insert(heartbeatRuns).values({
        id: retryRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        status: "scheduled_retry", retryOfRunId: lostRunId, scheduledRetryAt, wakeupRequestId: retryWake!.id,
        scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
        contextSnapshot: {
          issueId, taskId: issueId, wakeReason: "transient_failure_retry", retryOfRunId: lostRunId,
          scheduledRetryAt: scheduledRetryAt.toISOString(), scheduledRetryAttempt: 1, retryReason: "transient_failure",
        },
      });
      await db.update(agentWakeupRequests).set({ runId: retryRunId }).where(eq(agentWakeupRequests.id, retryWake!.id));
    }
    await db.insert(issues).values({
      id: issueId, companyId, title: "Deliver the report", status: input.issueStatus ?? "in_progress",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "board-user",
      issueNumber: 1, identifier: `${issuePrefix}-1`,
      ...(retryRunId
        ? { executionRunId: retryRunId, executionAgentNameKey: "codexcoder", executionLockedAt: new Date() }
        : {}),
    });
    return { companyId, agentId, issueId, lostRunId, retryRunId };
  }

  async function wakeForAssignment(agentId: string, issueId: string) {
    const [issue] = await db.select({ statusVersion: issues.statusVersion }).from(issues).where(eq(issues.id, issueId));
    await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      idempotencyKey: buildIssueAssignmentIdempotencyKey({
        issueId, assigneeAgentId: agentId, assignmentGeneration: issue!.statusVersion,
      }),
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  /**
   * A wake that admission already parked behind the false owner, as on the
   * instance: `executionWait` names no recovery action, and the sweep's claim has
   * kept moving `updated_at` while `created_at` stays at the parking time.
   */
  async function parkWake(input: {
    kind: "comment" | "assignment";
    companyId: string; agentId: string; issueId: string; parkedMinutesAgo: number;
    /** Defaults to the parking time; the sweep ages a wake by `requested_at`. */
    requestedMinutesAgo?: number;
  }) {
    const parkedAt = new Date(Date.now() - input.parkedMinutesAgo * MINUTE_MS);
    const requestedAt = new Date(Date.now() - (input.requestedMinutesAgo ?? input.parkedMinutesAgo) * MINUTE_MS);
    const executionWait = {
      recoveryActionId: null, reason: "execution_recovery",
      message: "Waiting for execution recovery. Your message is saved.",
    };
    let commentId: string | null = null;
    if (input.kind === "comment") {
      const [comment] = await db.insert(issueComments).values({
        companyId: input.companyId, issueId: input.issueId, authorUserId: "board-user", body: "Please continue.",
      }).returning();
      commentId = comment!.id;
    }
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: input.companyId, agentId: input.agentId,
      ...(input.kind === "comment"
        ? { source: "automation", triggerDetail: "system", reason: "issue_commented",
          requestedByActorType: "user", requestedByActorId: "board-user" }
        : { source: "assignment", triggerDetail: "system", reason: "issue_assigned", requestedByActorType: "system" }),
      status: "deferred_issue_execution",
      requestedAt, createdAt: parkedAt, updatedAt: new Date(Date.now() - MINUTE_MS),
      payload: {
        issueId: input.issueId,
        ...(commentId ? { commentId } : {}),
        _paperclipWakeContext: {
          issueId: input.issueId, taskId: input.issueId,
          wakeReason: input.kind === "comment" ? "issue_commented" : "issue_assigned",
          ...(commentId ? { wakeCommentId: commentId } : {}),
        },
        executionWait,
      },
    }).returning();
    return { wakeId: wake!.id, commentId };
  }

  /** Waits until `count` backends wait on a lock. */
  async function waitForLockWaiters(count: number) {
    await vi.waitFor(async () => {
      const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`);
      expect(Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0)).toBeGreaterThanOrEqual(count);
    }, { timeout: 10_000, interval: 50 });
  }

  /**
   * Recovery's insert protocol on another connection: lock the issue row FOR
   * SHARE, insert a scheduled retry for the issue, then hold the transaction
   * open until `release` is called.
   */
  function insertRetryLikeRecovery(other: ReturnType<typeof createDb>, input: {
    companyId: string; agentId: string; issueId: string;
  }) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inserted!: (runId: string) => void;
    const insertedRun = new Promise<string>((resolve) => (inserted = resolve));
    const done = other.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, input.issueId)).for("share");
      const [run] = await tx.insert(heartbeatRuns).values({
        companyId: input.companyId, agentId: input.agentId, invocationSource: "automation", triggerDetail: "system",
        status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 60 * MINUTE_MS),
        scheduledRetryAttempt: 1, scheduledRetryReason: "issue_disposition_repair",
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      }).returning();
      inserted(run!.id);
      await released;
      return run!.id;
    });
    return { insertedRun, release, done };
  }

  async function heldNotes(companyId: string) {
    return db.select({ entityId: activityLog.entityId, details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "heartbeat.deferred_wake_held")));
  }

  /**
   * Runs that delivered a wake, except `excluding`. The stub adapter succeeds
   * without a comment or a disposition, so a success is followed by issue
   * disposition repair and missing-comment follow-up runs; those are left out.
   */
  async function issueRuns(companyId: string, excluding: Array<string | null>) {
    const rows = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId)).orderBy(asc(heartbeatRuns.createdAt));
    return rows.filter((run) =>
      !excluding.includes(run.id) &&
      (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason !== "issue_disposition_repair" &&
      (run.retryOfRunId === null || excluding.includes(run.retryOfRunId)));
  }

  async function parkedWakes(companyId: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
  }

  /** Waits for the route's fire-and-forget wake, then runs every queued run to the end. */
  async function settle(companyId: string, excluding: Array<string | null>) {
    await vi.waitFor(async () => {
      const started = (await issueRuns(companyId, excluding)).length;
      const parked = (await parkedWakes(companyId)).length;
      expect(started + parked).toBeGreaterThan(0);
    }, { timeout: 20_000, interval: 100 });
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  it("lets a board comment that cancels the scheduled retry start one run that carries it", async () => {
    const { companyId, issueId, lostRunId, retryRunId } = await seed({ scheduledRetry: true });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "I added the missing detail; please continue." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await settle(companyId, [lostRunId, retryRunId]);

    expect((await heartbeat.getRun(retryRunId!))?.status).toBe("cancelled");
    const started = await issueRuns(companyId, [lostRunId, retryRunId]);
    expect(started).toHaveLength(1);
    expect(started[0]!.contextSnapshot).toMatchObject({ wakeCommentId: res.body.id });
    expect(executed[0]?.runId).toBe(started[0]!.id);
    expect(await parkedWakes(companyId)).toEqual([]);
  });

  it("keeps the scheduled retry for an agent comment, which does not cancel it, and runs it once", async () => {
    const { companyId, agentId, issueId, lostRunId, retryRunId } = await seed({ scheduledRetry: true });

    // The assignee posts with its own earlier run of this issue.
    const res = await request(createApp(agentActor(companyId, agentId, lostRunId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Progress note from the assignee." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await heartbeat.getRun(retryRunId!))?.status).toBe("scheduled_retry");

    const retry = await heartbeat.getRun(retryRunId!);
    await heartbeat.promoteDueScheduledRetries(new Date(retry!.scheduledRetryAt!.getTime() + 1_000));
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect((await heartbeat.getRun(retryRunId!))?.status).toBe("succeeded");
    expect(executed[0]?.runId).toBe(retryRunId);
    expect(await parkedWakes(companyId)).toEqual([]);
  });

  it("lets an assignment wake run after a restart lost the previous run", async () => {
    const { companyId, agentId, issueId, lostRunId } = await seed({ issueStatus: "todo" });

    await wakeForAssignment(agentId, issueId);

    const started = await issueRuns(companyId, [lostRunId]);
    expect(started.map((run) => run.status)).toContain("succeeded");
    expect(await parkedWakes(companyId)).toEqual([]);
  });

  // A board comment is an explicit continuation and may pass a recovery action
  // by design, so the guard uses a system wake, which never can.
  it.each(["none", "recycled"] as const)("keeps a parked assignment wake behind a real recovery action (process: %s)", async (process) => {
    const { companyId, agentId, issueId, lostRunId } = await seed({ issueStatus: "todo", process });
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: "uncertain_provider_action", status: "active", fingerprint: randomUUID(),
      evidence: { runId: lostRunId }, nextAction: "Inspect the lost run before continuing.",
    });
    const { wakeId } = await parkWake({ kind: "assignment", companyId, agentId, issueId, parkedMinutesAgo: 30 });

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(executed).toEqual([]);
    expect(await issueRuns(companyId, [lostRunId])).toEqual([]);
    expect((await parkedWakes(companyId)).map((wake) => wake.id)).toEqual([wakeId]);
    // Held for 30 minutes: one entry, naming the recovery action that holds it.
    expect(await heldNotes(companyId)).toEqual([{
      entityId: issueId,
      details: expect.objectContaining({ wakeId, reason: "execution_blocker", recoveryActionId: expect.any(String) }),
    }]);
  });

  it.each(["comment", "assignment"] as const)("releases a %s wake that was parked before the fix once the sweep re-checks it", async (kind) => {
    const { companyId, agentId, issueId, lostRunId } = await seed({ issueStatus: "todo" });
    const { commentId } = await parkWake({ kind, companyId, agentId, issueId, parkedMinutesAgo: 269 });

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const started = await issueRuns(companyId, [lostRunId]);
    expect(started).toHaveLength(1);
    if (commentId) expect(started[0]!.contextSnapshot).toMatchObject({ wakeCommentId: commentId });
    expect(await parkedWakes(companyId)).toEqual([]);
  });

  it.each(["cancelled", "done"] as const)("finalizes a wake parked on a %s issue", async (issueStatus) => {
    const { companyId, agentId, issueId, lostRunId } = await seed({ issueStatus });
    const { wakeId } = await parkWake({ kind: "comment", companyId, agentId, issueId, parkedMinutesAgo: 53 * 60 });

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });

    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(after).toMatchObject({ status: "cancelled" });
    expect(after!.finishedAt).not.toBeNull();
    expect(after!.error).toContain(issueStatus);
    expect(await issueRuns(companyId, [lostRunId])).toEqual([]);
  });

  it("keeps a wake parked on a done issue while a run still holds the issue, for that run's release", async () => {
    const { companyId, agentId, issueId } = await seed({ issueStatus: "done", process: "none" });
    const holderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: holderRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId, taskId: issueId },
    });
    await db.update(issues).set({ executionRunId: holderRunId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    const { wakeId } = await parkWake({ kind: "comment", companyId, agentId, issueId, parkedMinutesAgo: 30 });

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });

    expect((await parkedWakes(companyId)).map((wake) => wake.id)).toEqual([wakeId]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
  });

  it("holds a wake behind a provider process that is really still running, and records why once", async () => {
    const { companyId, agentId, issueId, lostRunId } = await seed({ issueStatus: "todo", process: "live" });
    const { wakeId } = await parkWake({ kind: "assignment", companyId, agentId, issueId, parkedMinutesAgo: 30 });
    const [before] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });

    expect(await issueRuns(companyId, [lostRunId])).toEqual([]);
    expect(await parkedWakes(companyId)).toHaveLength(1);
    expect(await heldNotes(companyId)).toEqual([{
      entityId: issueId,
      details: expect.objectContaining({
        wakeId, reason: "execution_blocker", cause: "execution_owner_active", runId: lostRunId, recoveryActionId: null,
      }),
    }]);
    // The sweep's claim moves updated_at on every pass; requested_at, which ages
    // the wake, is never rewritten.
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(after!.requestedAt.getTime()).toBe(before!.requestedAt.getTime());
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("records one held entry for a wake that waits on a full agent", async () => {
    const { companyId, agentId, issueId } = await seed({ issueStatus: "todo", process: "none" });
    // The agent's one run slot is taken by a run on another task.
    await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() },
    });
    const { wakeId } = await parkWake({ kind: "assignment", companyId, agentId, issueId, parkedMinutesAgo: 15 });

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });

    expect((await parkedWakes(companyId)).map((wake) => wake.id)).toEqual([wakeId]);
    expect(await heldNotes(companyId)).toEqual([{
      entityId: issueId, details: expect.objectContaining({ wakeId, reason: "no_free_run_slot" }),
    }]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
  });

  // The sweep ages a wake by requested_at. For the wakes it reads (not durable
  // chat input), requested_at is the insert time and is never rewritten; these
  // cases pin which column decides when the two differ.
  it.each([
    ["an old parking time but a fresh request", { parkedMinutesAgo: 240, requestedMinutesAgo: 0.5 }, false],
    ["a fresh parking time but an old request", { parkedMinutesAgo: 0.5, requestedMinutesAgo: 240 }, true],
  ] as const)("ages a parked wake by requested_at: %s", async (_label, ages, aged) => {
    const open = await seed({ issueStatus: "todo", process: "none" });
    const openWake = await parkWake({ kind: "assignment", ...open, ...ages });
    const closed = await seed({ issueStatus: "cancelled", process: "none" });
    const closedWake = await parkWake({ kind: "assignment", ...closed, ...ages });

    await heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const [openAfter] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, openWake.wakeId));
    const [closedAfter] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, closedWake.wakeId));
    expect(openAfter!.status === "deferred_issue_execution").toBe(!aged);
    expect(closedAfter!.status).toBe(aged ? "cancelled" : "deferred_issue_execution");
  });

  it("does not finalize a closed issue's wake while a retry inserted under the issue lock is still committing", async () => {
    const { companyId, agentId, issueId } = await seed({ issueStatus: "cancelled", process: "none" });
    const { wakeId } = await parkWake({ kind: "comment", companyId, agentId, issueId, parkedMinutesAgo: 30 });

    // Recovery inserts a retry first and has not committed yet.
    const recovery = insertRetryLikeRecovery(otherDbs[0]!, { companyId, agentId, issueId });
    const retryRunId = await recovery.insertedRun;
    const sweep = heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    // The finalizer waits on the issue row lock (a finalizer that does not lock
    // would already have cancelled the wake).
    await waitForLockWaiters(1).catch(() => undefined);
    recovery.release();
    await recovery.done;
    await sweep;

    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake!.status).toBe("deferred_issue_execution");
    expect(await heartbeat.getRun(retryRunId)).toMatchObject({ status: "scheduled_retry" });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retryRunId));
  });

  it("lets a retry inserted while the finalizer holds the issue lock go through after it", async () => {
    const { companyId, agentId, issueId } = await seed({ issueStatus: "cancelled", process: "none" });
    const { wakeId } = await parkWake({ kind: "comment", companyId, agentId, issueId, parkedMinutesAgo: 30 });

    // Hold the issue row so the finalizer queues on it first, then queue
    // recovery's share lock behind the finalizer.
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => (releaseHolder = resolve));
    let holderLocked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (holderLocked = resolve));
    const holder = otherDbs[0]!.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      holderLocked();
      await holderReleased;
    });
    await lockTaken;
    const sweep = heartbeat.sweepDeferredWakes({ recheckMs: 0 });
    await waitForLockWaiters(1);
    const recovery = insertRetryLikeRecovery(otherDbs[1]!, { companyId, agentId, issueId });
    await waitForLockWaiters(2);
    releaseHolder();
    await holder;
    await sweep;
    const retryRunId = await recovery.insertedRun;
    recovery.release();
    await recovery.done;

    // The finalizer saw no run and finalized the wake; the retry then committed.
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake!.status).toBe("cancelled");
    expect(await heartbeat.getRun(retryRunId)).toMatchObject({ status: "scheduled_retry" });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retryRunId));
  });
});
