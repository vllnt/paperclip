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
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

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
    input: { assigneeAgentId: string; title?: string; priority?: string; status?: string; executionRunId?: string },
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
        payload: {
          issueId,
          ...(latestCommentId ? { commentId: latestCommentId } : {}),
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

  it("does not wake a held issue: pause hold, execution blocker, or paused agent", async () => {
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

    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    for (const wakeId of [heldWakeId, blockedWakeId, pausedWakeId]) {
      const wake = await wakeRow(wakeId);
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
    }
    expect(await runsForIssue(heldRootId)).toHaveLength(0);
    expect((await runsForIssue(blockedIssueId)).filter((run) => run.id !== stoppedRunId)).toHaveLength(0);
    expect(await runsForIssue(pausedIssueId)).toHaveLength(0);
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
});
