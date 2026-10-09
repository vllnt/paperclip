import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { logger } from "../middleware/logger.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Deferred wake redelivery test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred wake redelivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE_MS = 60_000;
const SEEDED_WAKE_REASON = "issue_assigned";

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("deferred issue-execution wake redelivery", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-deferred-wake-redelivery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).then((rows) => rows.map((row) => row.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Deferred wake redelivery test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    input: { name: string; maxConcurrentRuns?: number; status?: string },
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: input.maxConcurrentRuns ?? 3 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(
    companyId: string,
    input: {
      assigneeAgentId: string;
      title?: string;
      priority?: string;
      status?: string;
      executionRunId?: string;
      projectId?: string;
    },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: input.title ?? "Review target",
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      assigneeAgentId: input.assigneeAgentId,
      responsibleUserId: "responsible-user",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.executionRunId ? { executionRunId: input.executionRunId, executionLockedAt: new Date() } : {}),
    });
    return issueId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    input: { status: string; errorCode?: string; resultJson?: Record<string, unknown> },
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.status,
      invocationSource: "on_demand",
      errorCode: input.errorCode ?? null,
      resultJson: input.resultJson ?? null,
      finishedAt: input.status === "running" || input.status === "queued" ? null : new Date(),
      contextSnapshot: { issueId, wakeReason: "seeded_run" },
    });
    return runId;
  }

  /** A deferred wake exactly as admission parks it behind an issue's execution lock. */
  async function seedDeferredWake(
    companyId: string,
    agentId: string,
    issueId: string,
    input: {
      ageMs: number;
      reason?: string;
      /** Comment ids a comment-driven wake carries, oldest first. */
      commentIds?: string[];
      actor?: { type: "agent" | "user" | "system"; id: string };
      /** The recovery gate that parked the wake, as admission records it in the payload. */
      executionWait?: { reason: string; message?: string; recoveryActionId?: string };
      idempotencyKey?: string;
    },
  ) {
    const at = new Date(Date.now() - input.ageMs);
    const wakeReason = input.reason ?? SEEDED_WAKE_REASON;
    const commentIds = input.commentIds ?? [];
    const latestCommentId = commentIds.at(-1);
    const actor = input.actor ?? { type: "system" as const, id: "seed" };
    const [wake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        status: "deferred_issue_execution",
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        payload: {
          issueId,
          ...(latestCommentId ? { commentId: latestCommentId } : {}),
          ...(input.executionWait ? { executionWait: input.executionWait } : {}),
          _paperclipWakeContext: {
            issueId,
            taskId: issueId,
            wakeReason,
            ...(latestCommentId
              ? { wakeCommentId: latestCommentId, commentId: latestCommentId, wakeCommentIds: commentIds }
              : {}),
          },
        },
        requestedByActorType: actor.type,
        requestedByActorId: actor.id,
        requestedAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    // Admission inserts these rows with the column default now(), which keeps
    // microseconds; a JavaScript Date does not. Seed the sub-millisecond part so
    // the optimistic claim is tested against real stored precision.
    await db.execute(sql`
      update agent_wakeup_requests
      set requested_at = requested_at + interval '321 microseconds',
          updated_at = updated_at + interval '321 microseconds'
      where id = ${wake!.id}
    `);
    return wake!.id;
  }

  /**
   * Runs the sweep while another transaction holds the issue row lock, then lets
   * that transaction change the world under the lock and commit. The sweep's
   * admission waits on the same lock, so it observes the committed change, as it
   * would if a release drain, an operator or a new run got the lock first. The
   * order is forced by the lock, not by timing.
   */
  async function sweepWhileIssueLockHeld(
    issueId: string,
    changeUnderLock: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
  ) {
    let lockTaken!: () => void;
    const lockTakenPromise = new Promise<void>((resolve) => (lockTaken = resolve));
    let proceed!: () => void;
    const proceedPromise = new Promise<void>((resolve) => (proceed = resolve));
    const lockTx = db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      lockTaken();
      await proceedPromise;
      await changeUnderLock(tx);
    });
    await lockTakenPromise;
    const sweep = heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
    // The sweep is committed to the lock order once a backend waits on a lock.
    expect(
      await waitForCondition(async () => {
        const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`);
        return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0;
      }, 10_000),
    ).toBe(true);
    proceed();
    await lockTx;
    return sweep;
  }

  async function wakeRow(wakeId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
  }

  async function runsForIssue(issueId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
      .orderBy(asc(heartbeatRuns.createdAt));
  }

  /**
   * Runs started for the seeded wake. A successful run that posts no issue
   * comment legitimately gets a `missing_issue_comment` follow-up from the
   * liveness check, so duplicates are counted by the seeded wake reason.
   */
  async function runsForSeededWake(issueId: string, wakeReason: string = SEEDED_WAKE_REASON) {
    return (await runsForIssue(issueId)).filter(
      (run) => (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason === wakeReason,
    );
  }

  it("re-delivers an aged deferred wake on an issue its agent has never run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentId, priority: "critical" });
    const wakeId = await seedDeferredWake(companyId, agentId, issueId, { ageMs: 30 * MINUTE_MS });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const wake = await wakeRow(wakeId);
    expect(wake.status).not.toBe("deferred_issue_execution");
    const runs = await runsForSeededWake(issueId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId, status: "succeeded" });
    expect(wake.runId).toBe(runs[0]!.id);
  });

  it("re-delivers a wake that was deferred behind a run whose lock was cleared without a release", async () => {
    const companyId = await seedCompany();
    const holderAgentId = await seedAgent(companyId, { name: "AuthorAgent", maxConcurrentRuns: 1 });
    const reviewerId = await seedAgent(companyId, { name: "ReviewerAgent", maxConcurrentRuns: 3 });
    const holderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: holderAgentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueId: randomUUID(), wakeReason: "seeded_holder" },
    });
    const issueId = await seedIssue(companyId, { assigneeAgentId: reviewerId, executionRunId: holderRunId });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId, wakeReason: "seeded_holder" } })
      .where(eq(heartbeatRuns.id, holderRunId));
    runningProcesses.set(holderRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    // The reviewer is woken while the author's run still holds the issue.
    const wakeResult = await heartbeat.wakeup(reviewerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      idempotencyKey: `redelivery-lock-cleared:${issueId}`,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(wakeResult).toBeNull();
    const [deferred] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `redelivery-lock-cleared:${issueId}`));
    expect(deferred!.status).toBe("deferred_issue_execution");

    // The holder ends through a path that never calls releaseIssueExecutionAndPromote
    // (reaper-terminalized, restarted, cancelled elsewhere); only the stale-lock
    // sweeper clears the lock, and it does not look at the queue behind it.
    runningProcesses.delete(holderRunId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));
    await db
      .update(agentWakeupRequests)
      .set({ requestedAt: new Date(Date.now() - 10 * MINUTE_MS), updatedAt: new Date(Date.now() - 10 * MINUTE_MS) })
      .where(eq(agentWakeupRequests.id, deferred!.id));
    expect((await heartbeat.sweepStaleIssueLocks()).cleared).toBe(1);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const wake = await wakeRow(deferred!.id);
    expect(wake.status).not.toBe("deferred_issue_execution");
    const reviewerRuns = (await runsForSeededWake(issueId)).filter((run) => run.agentId === reviewerId);
    expect(reviewerRuns).toHaveLength(1);
    expect(reviewerRuns[0]).toMatchObject({ status: "succeeded" });
  });

  it("re-delivers a comment-driven wake from another agent, with and without a finished run to anchor to", async () => {
    const companyId = await seedCompany();
    const reviewerId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
    const authorId = await seedAgent(companyId, { name: "Author", maxConcurrentRuns: 3 });
    const wakeReason = "issue_commented";

    const seedCommentWake = async (title: string, withFinishedRun: boolean) => {
      const issueId = await seedIssue(companyId, { assigneeAgentId: reviewerId, title, priority: "critical" });
      if (withFinishedRun) await seedRun(companyId, reviewerId, issueId, { status: "succeeded" });
      const [comment] = await db
        .insert(issueComments)
        .values({ companyId, issueId, authorAgentId: authorId, body: "The pull request is ready for review." })
        .returning();
      const wakeId = await seedDeferredWake(companyId, reviewerId, issueId, {
        ageMs: 30 * MINUTE_MS,
        reason: wakeReason,
        commentIds: [comment!.id],
        actor: { type: "agent", id: authorId },
      });
      return { issueId, wakeId };
    };
    const anchored = await seedCommentWake("Has a finished run", true);
    const anchorless = await seedCommentWake("Never ran", false);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    for (const { issueId, wakeId } of [anchored, anchorless]) {
      const wake = await wakeRow(wakeId);
      expect(wake.status).not.toBe("deferred_issue_execution");
      const runs = await runsForSeededWake(issueId, wakeReason);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ agentId: reviewerId, status: "succeeded" });
      expect(wake.runId).toBe(runs[0]!.id);
    }
  });

  it("re-delivers a wake deferred behind a workspace-busy retry that never produced a run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "WorkspaceWaiter", maxConcurrentRuns: 3 });
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });
    // The earlier attempt was cancelled with workspace_busy and no retry took the
    // lock; the evidence is what finalizeWorkspaceBusyDeferral records.
    await seedRun(companyId, agentId, issueId, {
      status: "cancelled",
      errorCode: "workspace_busy",
      resultJson: {
        executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        workspaceBusy: { projectWorkspaceId: randomUUID(), holderRunId: randomUUID(), deferralAttempt: 1 },
      },
    });
    const wakeId = await seedDeferredWake(companyId, agentId, issueId, { ageMs: 12 * MINUTE_MS });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await wakeRow(wakeId)).status).not.toBe("deferred_issue_execution");
    const fresh = await runsForSeededWake(issueId);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ agentId, status: "succeeded" });
  });

  it("does not wake a held issue: pause hold, execution blocker, operator Stop, or paused agent", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "HeldAgent", maxConcurrentRuns: 3 });
    const pausedAgentId = await seedAgent(companyId, { name: "PausedAgent", maxConcurrentRuns: 3, status: "paused" });

    const heldRootId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Under pause hold" });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: heldRootId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });
    const heldWakeId = await seedDeferredWake(companyId, agentId, heldRootId, { ageMs: 20 * MINUTE_MS });

    const blockedIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Execution blocker" });
    const stoppedRunId = await seedRun(companyId, agentId, blockedIssueId, { status: "cancelled" });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: blockedIssueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: stoppedRunId,
      evidence: { runId: stoppedRunId },
      nextAction: "Inspect the stopped run before continuing.",
    });
    const blockedWakeId = await seedDeferredWake(companyId, agentId, blockedIssueId, { ageMs: 20 * MINUTE_MS });

    const pausedIssueId = await seedIssue(companyId, { assigneeAgentId: pausedAgentId, title: "Paused assignee" });
    const pausedWakeId = await seedDeferredWake(companyId, pausedAgentId, pausedIssueId, { ageMs: 20 * MINUTE_MS });

    const operatorStopIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Operator Stop" });
    const operatorStopRunId = await seedRun(companyId, agentId, operatorStopIssueId, {
      status: "cancelled",
      errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    const operatorStopWakeId = await seedDeferredWake(companyId, agentId, operatorStopIssueId, { ageMs: 20 * MINUTE_MS });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    for (const wakeId of [heldWakeId, blockedWakeId, pausedWakeId, operatorStopWakeId]) {
      const wake = await wakeRow(wakeId);
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
    }
    expect(await runsForIssue(heldRootId)).toHaveLength(0);
    expect((await runsForIssue(blockedIssueId)).filter((run) => run.id !== stoppedRunId)).toHaveLength(0);
    expect(await runsForIssue(pausedIssueId)).toHaveLength(0);
    expect((await runsForIssue(operatorStopIssueId)).filter((run) => run.id !== operatorStopRunId)).toHaveLength(0);

    // The endpoint says what held each wake. The paused agent's wake is excluded
    // by the query, so only the three issue holds are counted, once each.
    const { sweep } = await heartbeat.getDeferredWakeStats(companyId);
    expect(sweep).toMatchObject({
      examined: 3,
      promoted: 0,
      skippedHeld: 3,
      skippedPauseHold: 1,
      skippedExecutionBlocker: 1,
      skippedOperatorStop: 1,
      skippedBudget: 0,
      failed: 0,
      executionBlockerCauses: { legacy_execution_requires_reconciliation: 1 },
    });
  });

  describe("wakes parked behind an execution-recovery hold", () => {
    /**
     * ANT-3892 as production holds it: a todo task, its assignee with a free
     * slot, no lock and no live run. Its latest run was cancelled before it ever
     * started (`execution_reconciliation_required`), the run before it was
     * orphaned, and the recovery action recorded for that run is resolved with a
     * no-replay verdict, which still holds the task. Six user comments were
     * saved behind the hold, each parked with a recovery wait.
     */
    async function seedRecoveryHeldTask(companyId: string) {
      const agentId = await seedAgent(companyId, { name: "Anthm DX", maxConcurrentRuns: 2 });
      const busyIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Other work" });
      const busyRunId = await seedRun(companyId, agentId, busyIssueId, { status: "running" });
      const issueId = await seedIssue(companyId, {
        assigneeAgentId: agentId,
        title: "Recovery-held task",
        priority: "critical",
      });
      await seedRun(companyId, agentId, issueId, { status: "interrupted", errorCode: "orphaned_running_run" });
      const neverStartedRunId = await seedRun(companyId, agentId, issueId, {
        status: "cancelled",
        errorCode: "execution_reconciliation_required",
        resultJson: {
          stopReason: "execution_reconciliation_required",
          timeoutSource: "stale_queued_run_gate",
          executionWait: { issueId, recoveryActionId: null },
        },
      });
      const [action] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId,
          sourceIssueId: issueId,
          kind: "active_run_watchdog",
          status: "resolved",
          outcome: "blocked",
          resolvedAt: new Date(),
          ownerType: "board",
          cause: "legacy_execution_requires_reconciliation",
          fingerprint: neverStartedRunId,
          evidence: {
            runId: neverStartedRunId,
            attempt: 1,
            automaticRecovery: {
              runId: neverStartedRunId,
              policy: "preserve_without_replay_v1",
              replay: "blocked",
              actionOutcome: "unknown",
            },
          },
          nextAction:
            "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
        })
        .returning();
      const wakeIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const [comment] = await db
          .insert(issueComments)
          .values({ companyId, issueId, authorUserId: "board-user", body: `Please continue (${index + 1}).` })
          .returning();
        wakeIds.push(
          await seedDeferredWake(companyId, agentId, issueId, {
            ageMs: (7 - index) * 30 * MINUTE_MS,
            reason: "issue_commented",
            commentIds: [comment!.id],
            actor: { type: "user", id: "board-user" },
            executionWait: {
              reason: "execution_recovery",
              message: "Waiting for execution recovery. Your message is saved.",
              recoveryActionId: action!.id,
            },
          }),
        );
      }
      return { agentId, issueId, actionId: action!.id, wakeIds, busyRunId, neverStartedRunId };
    }

    const finishBusyRun = (runId: string) =>
      db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

    it("holds a task whose no-replay recovery action awaits an operator, examines only its oldest wake, and says why", async () => {
      const info = vi.spyOn(logger, "info");
      const companyId = await seedCompany();
      const { issueId, actionId, wakeIds, busyRunId, neverStartedRunId } = await seedRecoveryHeldTask(companyId);
      const before = await Promise.all(wakeIds.map((wakeId) => wakeRow(wakeId)));

      // The periodic pass, with the default recheck window.
      const first = await heartbeat.sweepDeferredWakes();
      expect(first).toMatchObject({
        scanned: 1,
        promoted: 0,
        skippedHeld: 1,
        skippedExecutionBlocker: 1,
        skippedPauseHold: 0,
        skippedOperatorStop: 0,
        skippedBudget: 0,
        failed: 0,
        executionBlockerCauses: { legacy_execution_requires_reconciliation: 1 },
      });
      // The next tick finds the head waiting out its window. A younger comment
      // must not step forward in its place and be examined out of order.
      const second = await heartbeat.sweepDeferredWakes();
      expect(second.scanned).toBe(0);

      const after = await Promise.all(wakeIds.map((wakeId) => wakeRow(wakeId)));
      expect(after.every((wake) => wake.status === "deferred_issue_execution" && wake.runId === null)).toBe(true);
      expect(after[0]!.updatedAt.getTime()).toBeGreaterThan(before[0]!.updatedAt.getTime());
      for (const index of [1, 2, 3, 4, 5]) {
        expect(after[index]!.updatedAt.getTime()).toBe(before[index]!.updatedAt.getTime());
      }
      // Nothing started, and the hold itself is untouched.
      expect((await runsForIssue(issueId)).map((run) => run.id)).toContain(neverStartedRunId);
      expect(await runsForSeededWake(issueId, "issue_commented")).toHaveLength(0);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
      expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });

      // A reader sees why, from a different service instance than the scheduler's,
      // as a route builds its own.
      const stats = await heartbeatService(db).getDeferredWakeStats(companyId);
      expect(stats.parked).toEqual({
        closedIssue: 0,
        awaitingRecovery: { execution_recovery: 6 },
        behindIssueLock: 0,
        otherRecovery: 0,
        orphaned: 0,
      });
      expect(stats.sweep).toMatchObject({
        examined: 1,
        promoted: 0,
        skippedHeld: 1,
        skippedExecutionBlocker: 1,
        executionBlockerCauses: { legacy_execution_requires_reconciliation: 1 },
      });
      expect(stats.sweep.lastExaminedAt).toBeInstanceOf(Date);
      expect(stats.deferredTotal).toBe(6);

      // One line for the pass that read a wake, none for the pass that read none.
      const passLines = info.mock.calls.filter(
        ([fields, message]) =>
          message === "deferred wake sweep pass" && (fields as { trigger?: string } | undefined)?.trigger === "periodic",
      );
      expect(passLines).toHaveLength(1);
      expect(passLines[0]![0]).toMatchObject({ trigger: "periodic", scanned: 1, skippedExecutionBlocker: 1 });
      info.mockRestore();
      await finishBusyRun(busyRunId);
    });

    it("delivers the oldest saved comment once an operator has cleared the hold", async () => {
      const companyId = await seedCompany();
      const { issueId, actionId, wakeIds, busyRunId, neverStartedRunId } = await seedRecoveryHeldTask(companyId);

      const held = await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
      expect(held).toMatchObject({ promoted: 0, skippedExecutionBlocker: 1 });
      expect(await runsForSeededWake(issueId, "issue_commented")).toHaveLength(0);

      // The board verifies the unverified outcome and restores the task.
      await db
        .update(issueRecoveryActions)
        .set({
          outcome: "restored",
          evidence: { runId: neverStartedRunId, automaticRecovery: { replay: "allowed" } },
        })
        .where(eq(issueRecoveryActions.id, actionId));

      const released = await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
      await heartbeat.drainActiveRunExecutions();
      expect(released).toMatchObject({ promoted: 1, skippedHeld: 0, failed: 0 });
      expect((await wakeRow(wakeIds[0]!)).status).not.toBe("deferred_issue_execution");
      const started = await runsForSeededWake(issueId, "issue_commented");
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ agentId: expect.any(String), status: "succeeded" });
      await finishBusyRun(busyRunId);
    });
  });

  it("explains why each parked wake is parked, from durable state", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
    const otherAgentId = await seedAgent(otherCompanyId, { name: "Elsewhere", maxConcurrentRuns: 3 });

    const closedIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, status: "done" });
    await seedDeferredWake(companyId, agentId, closedIssueId, { ageMs: 40 * MINUTE_MS });

    for (const reason of ["execution_recovery", "execution_recovery", "remote_cleanup"]) {
      const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });
      await seedDeferredWake(companyId, agentId, issueId, { ageMs: 40 * MINUTE_MS, executionWait: { reason } });
    }

    const lockedIssueId = await seedIssue(companyId, { assigneeAgentId: agentId });
    const holderRunId = await seedRun(companyId, agentId, lockedIssueId, { status: "running" });
    await db.update(issues).set({ executionRunId: holderRunId, executionLockedAt: new Date() }).where(eq(issues.id, lockedIssueId));
    await seedDeferredWake(companyId, agentId, lockedIssueId, { ageMs: 40 * MINUTE_MS });

    const chatIssueId = await seedIssue(companyId, { assigneeAgentId: agentId });
    await seedDeferredWake(companyId, agentId, chatIssueId, { ageMs: 40 * MINUTE_MS, idempotencyKey: `chat-inbound:${randomUUID()}` });

    const orphanedIssueId = await seedIssue(companyId, { assigneeAgentId: agentId });
    await seedDeferredWake(companyId, agentId, orphanedIssueId, { ageMs: 40 * MINUTE_MS });
    const otherIssueId = await seedIssue(otherCompanyId, { assigneeAgentId: otherAgentId });
    await seedDeferredWake(otherCompanyId, otherAgentId, otherIssueId, { ageMs: 40 * MINUTE_MS });

    const { parked, deferredTotal } = await heartbeat.getDeferredWakeStats(companyId);

    expect(parked).toEqual({
      closedIssue: 1,
      awaitingRecovery: { execution_recovery: 2, remote_cleanup: 1 },
      behindIssueLock: 1,
      otherRecovery: 1,
      orphaned: 1,
    });
    expect(deferredTotal).toBe(7);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
  });

  it("starts exactly one run per wake when recovery passes and completion triggers race", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "RacedAgent", maxConcurrentRuns: 5 });
    // One issue the drain can anchor to (a finished run exists), one it cannot.
    const anchoredIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Has a finished run" });
    await seedRun(companyId, agentId, anchoredIssueId, { status: "succeeded" });
    const anchorlessIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Never ran" });
    const anchoredWakeId = await seedDeferredWake(companyId, agentId, anchoredIssueId, { ageMs: 15 * MINUTE_MS });
    const anchorlessWakeId = await seedDeferredWake(companyId, agentId, anchorlessIssueId, { ageMs: 15 * MINUTE_MS });

    const immediate = { agentId, minAgeMs: 0, recheckMs: 0 };
    await Promise.all([
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
      heartbeat.sweepDeferredWakes(immediate),
      heartbeat.sweepDeferredWakes(immediate),
      heartbeat.sweepDeferredWakes(immediate),
    ]);
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    for (const [issueId, wakeId] of [
      [anchoredIssueId, anchoredWakeId],
      [anchorlessIssueId, anchorlessWakeId],
    ] as const) {
      const wake = await wakeRow(wakeId);
      expect(wake.status).not.toBe("deferred_issue_execution");
      const runs = await runsForSeededWake(issueId);
      expect(runs).toHaveLength(1);
      expect(wake.runId).toBe(runs[0]!.id);
    }
  });

  it("leaves a wake alone while a live run still holds its issue, and a wake that has not aged out", async () => {
    const companyId = await seedCompany();
    const holderAgentId = await seedAgent(companyId, { name: "HolderAgent", maxConcurrentRuns: 3 });
    const waitingAgentId = await seedAgent(companyId, { name: "WaitingAgent", maxConcurrentRuns: 3 });

    // A live holder: the lock is taken and the run is running. Its own release
    // will promote the wake; the sweep must not race it.
    const heldIssueId = await seedIssue(companyId, { assigneeAgentId: waitingAgentId, title: "Live holder" });
    const holderRunId = await seedRun(companyId, holderAgentId, heldIssueId, { status: "running" });
    await db
      .update(issues)
      .set({ executionRunId: holderRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, heldIssueId));
    runningProcesses.set(holderRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });
    const behindHolderWakeId = await seedDeferredWake(companyId, waitingAgentId, heldIssueId, { ageMs: 20 * MINUTE_MS });

    // A lock-free wake that was parked seconds ago: the periodic sweep waits it out.
    const youngIssueId = await seedIssue(companyId, { assigneeAgentId: waitingAgentId, title: "Just parked" });
    const youngWakeId = await seedDeferredWake(companyId, waitingAgentId, youngIssueId, { ageMs: 20_000 });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    for (const wakeId of [behindHolderWakeId, youngWakeId]) {
      const wake = await wakeRow(wakeId);
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
    }
    expect(await runsForSeededWake(heldIssueId)).toHaveLength(0);
    expect(await runsForSeededWake(youngIssueId)).toHaveLength(0);

    runningProcesses.delete(holderRunId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
  });

  it("reports how many wakes each agent has parked, how long the oldest has waited, and how many were promoted", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const reviewerId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3, status: "paused" });
    const builderId = await seedAgent(companyId, { name: "Builder", maxConcurrentRuns: 3, status: "paused" });
    await seedAgent(companyId, { name: "Idle", maxConcurrentRuns: 3 });
    const otherAgentId = await seedAgent(otherCompanyId, { name: "Elsewhere", maxConcurrentRuns: 3 });

    for (const ageMs of [38 * MINUTE_MS, 5 * MINUTE_MS]) {
      const issueId = await seedIssue(companyId, { assigneeAgentId: reviewerId });
      await seedDeferredWake(companyId, reviewerId, issueId, { ageMs });
    }
    const builderIssueId = await seedIssue(companyId, { assigneeAgentId: builderId });
    await seedDeferredWake(companyId, builderId, builderIssueId, { ageMs: 90_000 });
    // A promoted wake counts toward the builder's promotions; another company's wake is invisible.
    const promotedIssueId = await seedIssue(companyId, { assigneeAgentId: builderId });
    const promotedWakeId = await seedDeferredWake(companyId, builderId, promotedIssueId, { ageMs: 10 * MINUTE_MS });
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", reason: "issue_execution_promoted" })
      .where(eq(agentWakeupRequests.id, promotedWakeId));
    const otherIssueId = await seedIssue(otherCompanyId, { assigneeAgentId: otherAgentId });
    await seedDeferredWake(otherCompanyId, otherAgentId, otherIssueId, { ageMs: 500 * MINUTE_MS });

    const stats = await heartbeat.getDeferredWakeStats(companyId);

    expect(stats.deferredTotal).toBe(3);
    expect(stats.promotedLast24h).toBe(1);
    expect(stats.agents.map((agent) => agent.agentName)).toEqual(["Builder", "Reviewer"]);
    const reviewer = stats.agents.find((agent) => agent.agentName === "Reviewer")!;
    expect(reviewer).toMatchObject({ agentId: reviewerId, deferredCount: 2, promotedLast24h: 0 });
    expect(reviewer.oldestDeferredAgeSeconds).toBeGreaterThanOrEqual(38 * 60);
    expect(reviewer.oldestDeferredAgeSeconds).toBeLessThan(38 * 60 + 30);
    const builder = stats.agents.find((agent) => agent.agentName === "Builder")!;
    expect(builder).toMatchObject({ agentId: builderId, deferredCount: 1, promotedLast24h: 1 });
    expect(builder.oldestDeferredAgeSeconds).toBeGreaterThanOrEqual(90);
    expect(stats.oldestDeferredAgeSeconds).toBe(reviewer.oldestDeferredAgeSeconds);
    expect(stats.sweep).toMatchObject({ failed: 0 });
  });

  it("holds an aged deferred wake while its agent is at capacity, then promotes by priority and age when a run completes", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "BusyReviewer", maxConcurrentRuns: 1 });
    const busyIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Currently running" });
    const lowIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Low, older", priority: "low" });
    const criticalIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, title: "Critical, newer", priority: "critical" });
    const lowWakeId = await seedDeferredWake(companyId, agentId, lowIssueId, { ageMs: 30 * MINUTE_MS });
    const criticalWakeId = await seedDeferredWake(companyId, agentId, criticalIssueId, { ageMs: 20 * MINUTE_MS });

    let releaseBusyRun!: () => void;
    const busyRunGate = new Promise<void>((resolve) => {
      releaseBusyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await busyRunGate;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Busy run finished.",
        provider: "test",
        model: "test-model",
      };
    });
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: busyIssueId },
      contextSnapshot: { issueId: busyIssueId, wakeReason: "issue_assigned" },
    });
    expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);

    // At capacity: the periodic pass leaves the aged wakes parked.
    await heartbeat.resumeQueuedRuns();
    expect((await wakeRow(lowWakeId)).status).toBe("deferred_issue_execution");
    expect((await wakeRow(criticalWakeId)).status).toBe("deferred_issue_execution");

    // Capacity frees: the agent's wakes drain one per free slot, critical first
    // even though the low-priority wake is older.
    releaseBusyRun();
    expect(
      await waitForCondition(async () => {
        const [low, critical] = await Promise.all([wakeRow(lowWakeId), wakeRow(criticalWakeId)]);
        return low.status !== "deferred_issue_execution" && critical.status !== "deferred_issue_execution";
      }, 15_000),
    ).toBe(true);
    await heartbeat.drainActiveRunExecutions();

    const promoted = await db
      .select({ issueId: sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' in (${lowIssueId}, ${criticalIssueId})`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = ${SEEDED_WAKE_REASON}`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt));
    expect(promoted.map((run) => run.issueId)).toEqual([criticalIssueId, lowIssueId]);
  });

  describe("closed tasks", () => {
    it.each(["done", "cancelled"])(
      "never revives a %s task from an old parked wake, with or without a finished run",
      async (status) => {
        const companyId = await seedCompany();
        const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
        const anchorlessIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, status, title: "Closed, never ran" });
        const anchoredIssueId = await seedIssue(companyId, { assigneeAgentId: agentId, status, title: "Closed, has a run" });
        await seedRun(companyId, agentId, anchoredIssueId, { status: "succeeded" });
        const wakeIds = [
          await seedDeferredWake(companyId, agentId, anchorlessIssueId, { ageMs: 40 * MINUTE_MS }),
          await seedDeferredWake(companyId, agentId, anchoredIssueId, { ageMs: 40 * MINUTE_MS }),
        ];

        await heartbeat.resumeQueuedRuns();
        await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
        await heartbeat.sweepDeferredWakes({ agentId, minAgeMs: 0, recheckMs: 0 });
        await heartbeat.drainActiveRunExecutions();

        for (const wakeId of wakeIds) {
          const wake = await wakeRow(wakeId);
          expect(wake.status).toBe("deferred_issue_execution");
          expect(wake.runId).toBeNull();
        }
        expect(await runsForIssue(anchorlessIssueId)).toHaveLength(0);
        // Only the finished run seeded before the sweep; nothing new was queued.
        expect(await runsForIssue(anchoredIssueId)).toHaveLength(1);
      },
    );

    it("rechecks the task status under the issue lock, after the sweep has already read it as open", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
      const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake(companyId, agentId, issueId, { ageMs: 30 * MINUTE_MS });

      const result = await sweepWhileIssueLockHeld(issueId, async (tx) => {
        await tx.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
      });
      await heartbeat.drainActiveRunExecutions();

      expect(result.failed).toBe(0);
      const wake = await wakeRow(wakeId);
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
      expect(await runsForIssue(issueId)).toHaveLength(0);
    });
  });

  describe("racing the release drain and other writers", () => {
    it("starts no second run when a release drain promotes the wake after the sweep read it", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
      const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake(companyId, agentId, issueId, { ageMs: 30 * MINUTE_MS });
      const drainedRunId = randomUUID();

      const result = await sweepWhileIssueLockHeld(issueId, async (tx) => {
        // What a release drain commits when it promotes the parked wake: the same
        // row becomes the run's wake and a queued run is created, in one commit.
        await tx.insert(heartbeatRuns).values({
          id: drainedRunId,
          companyId,
          agentId,
          status: "queued",
          invocationSource: "automation",
          wakeupRequestId: wakeId,
          contextSnapshot: { issueId, wakeReason: SEEDED_WAKE_REASON },
        });
        await tx
          .update(agentWakeupRequests)
          .set({ status: "queued", reason: "issue_execution_promoted", runId: drainedRunId })
          .where(eq(agentWakeupRequests.id, wakeId));
      });

      expect(result.failed).toBe(0);
      // Exactly one run for the wake, the drain's. The sweep added none.
      const runs = await runsForSeededWake(issueId);
      expect(runs.map((run) => run.id)).toEqual([drainedRunId]);
      // And no receipt is left parked for the issue: no second deferred wake.
      const parked = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
      expect(parked).toEqual([]);
      expect((await wakeRow(wakeId)).runId).toBe(drainedRunId);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
    });

    it("leaves the original wake parked, and adds none, when a live run takes the issue first", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
      const otherAgentId = await seedAgent(companyId, { name: "Author", maxConcurrentRuns: 3 });
      const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake(companyId, agentId, issueId, { ageMs: 30 * MINUTE_MS });
      const liveRunId = randomUUID();

      const result = await sweepWhileIssueLockHeld(issueId, async (tx) => {
        await tx.insert(heartbeatRuns).values({
          id: liveRunId,
          companyId,
          agentId: otherAgentId,
          status: "queued",
          invocationSource: "on_demand",
          contextSnapshot: { issueId, wakeReason: "seeded_live_run" },
        });
      });

      expect(result.failed).toBe(0);
      const wake = await wakeRow(wakeId);
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
      expect(wake.coalescedCount).toBe(0);
      // The live run's own release will promote it. Nothing else was parked or started.
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(receipts.map((receipt) => receipt.id)).toEqual([wakeId]);
      expect((await runsForIssue(issueId)).map((run) => run.id)).toEqual([liveRunId]);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, liveRunId));
    });
  });

  describe("budget hard stops", () => {
    it("leaves a budget-blocked wake parked and untouched, creates no run row, and resumes with the budget", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "Reviewer", maxConcurrentRuns: 3 });
      const projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Over budget",
        pausedAt: new Date(),
        pauseReason: "budget",
      });
      const issueId = await seedIssue(companyId, { assigneeAgentId: agentId, projectId });
      // A finished run exists, so release admission would claim the parked wake.
      await seedRun(companyId, agentId, issueId, { status: "succeeded" });
      const wakeId = await seedDeferredWake(companyId, agentId, issueId, { ageMs: 30 * MINUTE_MS });
      const before = await wakeRow(wakeId);
      const runsBefore = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));

      const blocked = await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
      await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      expect(blocked).toMatchObject({ skippedBudget: 1, promoted: 0, failed: 0 });
      const after = await wakeRow(wakeId);
      expect(after.status).toBe("deferred_issue_execution");
      expect(after.runId).toBeNull();
      expect(after.payload).toEqual(before.payload);
      // No run row was created, so none can be cancelled later at claim time.
      const runsAfter = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runsAfter.map((run) => run.id).sort()).toEqual(runsBefore.map((run) => run.id).sort());
      expect((await heartbeat.getDeferredWakeStats(companyId)).sweep.skippedBudget).toBeGreaterThanOrEqual(1);

      // The budget is raised: the same wake now starts.
      await db.update(projects).set({ pausedAt: null, pauseReason: null }).where(eq(projects.id, projectId));
      const resumed = await heartbeat.sweepDeferredWakes({ minAgeMs: 0, recheckMs: 0 });
      await heartbeat.drainActiveRunExecutions();
      expect(resumed.promoted).toBe(1);
      expect((await runsForSeededWake(issueId)).length).toBe(1);
    });
  });

  describe("tenant isolation of the stats", () => {
    it("reports sweep counters for the requested company only", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const agentA = await seedAgent(companyA, { name: "ReviewerA", maxConcurrentRuns: 3 });
      const agentB = await seedAgent(companyB, { name: "ReviewerB", maxConcurrentRuns: 3 });
      const issueA = await seedIssue(companyA, { assigneeAgentId: agentA });
      // Company B has a wake that the sweep will never read (a closed task).
      const issueB = await seedIssue(companyB, { assigneeAgentId: agentB, status: "done" });
      await seedDeferredWake(companyA, agentA, issueA, { ageMs: 30 * MINUTE_MS });
      await seedDeferredWake(companyB, agentB, issueB, { ageMs: 30 * MINUTE_MS });

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const statsA = await heartbeat.getDeferredWakeStats(companyA);
      const statsB = await heartbeat.getDeferredWakeStats(companyB);
      expect(statsA.sweep).toMatchObject({ examined: 1, promoted: 1, failed: 0 });
      expect(statsA.sweep.lastExaminedAt).toBeInstanceOf(Date);
      expect(statsB.sweep).toMatchObject({ examined: 0, promoted: 0, skippedHeld: 0, skippedBudget: 0, failed: 0, lastExaminedAt: null });
      for (const stats of [statsA, statsB]) {
        // Process-wide fields would leak activity across companies.
        expect(stats.sweep).not.toHaveProperty("passes");
        expect(stats.sweep).not.toHaveProperty("completionPasses");
        expect(stats.sweep).not.toHaveProperty("lastPassAt");
      }
      expect(statsB.agents.map((agent) => agent.agentId)).toEqual([agentB]);
    });
  });

  describe("bounded passes", () => {
    it("re-delivers a backlog over several passes, within each agent's free run slots", async () => {
      const companyId = await seedCompany();
      let releaseRuns!: () => void;
      const runsGate = new Promise<void>((resolve) => (releaseRuns = resolve));
      mockAdapterExecute.mockImplementation(async () => {
        await runsGate;
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "done", provider: "test", model: "test-model" };
      });
      const slotsPerAgent = 3;
      const agentIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        agentIds.push(await seedAgent(companyId, { name: `Backlog${index}`, maxConcurrentRuns: slotsPerAgent }));
      }
      // 3 agents x 4 stranded wakes: 12 orphans, 9 free slots. The pass is capped
      // at 4 (the default cap of 20 is covered by the unit tests of the budget).
      for (const agentId of agentIds) {
        for (let n = 0; n < 4; n += 1) {
          const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });
          await seedDeferredWake(companyId, agentId, issueId, { ageMs: (60 - n) * MINUTE_MS });
        }
      }
      const parked = async () =>
        (await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")))).length;

      const first = await heartbeat.sweepDeferredWakes({ maxPromotions: 4 });
      expect(first).toMatchObject({ scanned: 12, promoted: 4, failed: 0 });
      expect(await parked()).toBe(8);
      const perAgent = await db
        .select({ agentId: heartbeatRuns.agentId, n: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = ${SEEDED_WAKE_REASON}`))
        .groupBy(heartbeatRuns.agentId);
      for (const row of perAgent) expect(row.n).toBeLessThanOrEqual(slotsPerAgent);

      // The next pass continues with what is left, within the slots still free.
      const second = await heartbeat.sweepDeferredWakes({ recheckMs: 0, maxPromotions: 4 });
      expect(second.promoted).toBeLessThanOrEqual(4);
      expect(second.promoted).toBeGreaterThan(0);
      const perAgentAfter = await db
        .select({ agentId: heartbeatRuns.agentId, n: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = ${SEEDED_WAKE_REASON}`))
        .groupBy(heartbeatRuns.agentId);
      for (const row of perAgentAfter) expect(row.n).toBeLessThanOrEqual(slotsPerAgent);

      releaseRuns();
      await heartbeat.drainActiveRunExecutions();
    });
  });

  it("indexes parked wakes with a narrow partial index", async () => {
    const rows = (await db.execute(
      sql`select indexdef from pg_indexes where indexname = 'agent_wakeup_requests_deferred_requested_idx'`,
    )) as unknown as Array<{ indexdef: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/\(requested_at\)/);
    expect(rows[0]!.indexdef).toContain("deferred_issue_execution");
  });
});
