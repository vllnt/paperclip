import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  heartbeatRunEvents,
  issueRecoveryActions,
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

import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.ts";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import {
  conversationRecoveryActionPredicate,
  needsConversationContinuationRepair,
} from "../services/conversation-continuation.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SUCCESS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Worked on the assigned issue.",
  provider: "test",
  model: "test-model",
};

async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

describeEmbeddedPostgres("stranded in_progress issue recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const releases: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-in-progress-");
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
    for (const release of releases.splice(0)) release();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => SUCCESS);
    // Every run this test started, finalization included, ends before cleanup.
    await heartbeatService(db).drainActiveRunExecutions();
    // Work this test queued must not run into the next test.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]));
    // Later sweeps must not see this test's issues.
    await db.update(issues).set({ status: "done", executionRunId: null, checkoutRunId: null });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignedTodo(label: string, options: { maxConcurrentRuns?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Stranded ${label}`,
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Worker ${label}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: options.maxConcurrentRuns ? { heartbeat: { maxConcurrentRuns: options.maxConcurrentRuns } } : {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Assigned work ${label}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  function issueBoundRuns(issueId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`);
  }

  /**
   * The real path to the stranded state: a manual invoke (no issue in its
   * context) whose agent checks the issue out mid-run, then the run finishes
   * and the wake queue releases the issue's run locks.
   */
  async function strandThroughIssueLessRun(fixture: { agentId: string; issueId: string }) {
    const heartbeat = heartbeatService(db);
    mockAdapterExecute.mockImplementationOnce(async (input?: unknown) => {
      const { runId } = input as { runId: string };
      await issueService(db).checkout(fixture.issueId, fixture.agentId, ["todo"], runId);
      return SUCCESS;
    });
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: { triggeredBy: "board", actorId: "responsible-user" },
    });
    expect(run).not.toBeNull();
    expect(run!.contextSnapshot).not.toHaveProperty("issueId");
    // Wait for the whole run, finalization included: it releases the issue's locks after the status flips.
    await heartbeat.drainActiveRunExecutions();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
    return run!.id;
  }

  /** Holds the next adapter execution open until the test releases it. */
  function holdNextExecution(outcome: typeof SUCCESS = SUCCESS) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    mockAdapterExecute.mockImplementationOnce(async () => {
      await gate;
      return outcome;
    });
    return release;
  }

  /** The database after a restart: an issue-bound assignment run still marked running, its process gone. */
  async function seedRestartOrphanedAssignment(label: string, adapterType = "codex_local") {
    const fixture = await seedAssignedTodo(label);
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId: fixture.companyId, agentId: fixture.agentId, source: "assignment",
      triggerDetail: "system", reason: "issue_assigned", payload: { issueId: fixture.issueId },
      status: "claimed", runId, claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: fixture.companyId, agentId: fixture.agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "running", wakeupRequestId,
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" },
      processPid: 2147483646, processGroupId: null, nextEventSeq: 2, startedAt: now,
      updatedAt: new Date(now.getTime() - 10 * 60_000),
    });
    await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.agentId, runId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType } });
    await db.update(issues).set({ status: "in_progress", checkoutRunId: runId, executionRunId: runId, startedAt: now })
      .where(eq(issues.id, fixture.issueId));
    return { ...fixture, runId };
  }

  /** An issue-bound run that already ended, locks released (the production shapes after a restart). */
  async function seedEndedIssueRun(label: string, run: { status: string; errorCode: string | null; resultJson?: Record<string, unknown>; invocationSource?: string; requestedByActorType?: "user" | "system" }) {
    const fixture = await seedAssignedTodo(label);
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const finishedAt = new Date(Date.now() - 20 * 60_000);
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId: fixture.companyId, agentId: fixture.agentId,
      source: run.invocationSource ?? "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: fixture.issueId }, status: "failed", runId, claimedAt: finishedAt,
      requestedByActorType: run.requestedByActorType ?? "system", requestedByActorId: run.requestedByActorType === "user" ? "responsible-user" : null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: fixture.companyId, agentId: fixture.agentId, invocationSource: run.invocationSource ?? "assignment",
      triggerDetail: "system", status: run.status, wakeupRequestId, errorCode: run.errorCode, resultJson: run.resultJson ?? null,
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" },
      nextEventSeq: 2, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
    });
    await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.agentId, runId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: "codex_local" } });
    await db.update(issues).set({ status: "in_progress", startedAt: new Date(finishedAt.getTime() - 60_000) }).where(eq(issues.id, fixture.issueId));
    return { ...fixture, runId };
  }

  it.each([
    ["process_lost", { status: "failed", errorCode: "process_lost" }],
    ["execution_reconciliation_required", { status: "cancelled", errorCode: "execution_reconciliation_required" }],
    ["cancelled and acknowledged", { status: "cancelled", errorCode: null, resultJson: { executionCancellation: { state: "acknowledged" } } }],
  ] as const)("retries a conversation run that ended %s instead of looping hold and fold", async (label, run) => {
    const fixture = await seedEndedIssueRun(label, run);
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    const [repaired] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(repaired!.resultJson).toMatchObject({ conversationContinuation: "continue_conversation_v1" });
    // The bounded retry waits its delay, so no run executes during this test.
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId)))
      .toEqual([{ status: "scheduled_retry" }]);
    await settleUnrecoverableExecutions(db);
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId))).toHaveLength(1);
  });

  it("folds a hold only on a run the stranded sweep repairs or never holds, for every ending and adapter evidence", async () => {
    const fixture = await seedAssignedTodo("fold-matrix");
    const evidence: Record<string, { claimed: unknown; events: Array<string | null> }> = {
      claimedConversation: { claimed: "codex_local", events: [] },
      claimedProcessInvokedConversation: { claimed: "process", events: ["codex_local"] },
      claimedEmpty: { claimed: "", events: ["codex_local"] },
      claimedNotAString: { claimed: 7, events: ["codex_local"] },
      latestInvocationProcess: { claimed: null, events: ["codex_local", "process"] },
      latestInvocationConversation: { claimed: null, events: ["process", "codex_local"] },
      latestInvocationUntyped: { claimed: null, events: ["codex_local", null] },
      none: { claimed: null, events: [] },
    };
    const endings: Array<{ status: string; errorCode: string | null; acknowledged: boolean }> = [];
    for (const status of ["failed", "timed_out", "interrupted", "cancelled", "succeeded"]) {
      for (const errorCode of [null, "process_lost", "server_shutdown_interrupted", "execution_reconciliation_required", "adapter_failed"]) {
        for (const acknowledged of [false, true]) endings.push({ status, errorCode, acknowledged });
      }
    }
    const foldEndings = endings.filter(({ status, errorCode, acknowledged }) =>
      (status === "interrupted" && errorCode === null && !acknowledged) ||
      (status === "failed" && errorCode === "process_lost" && !acknowledged) ||
      (status === "cancelled" && errorCode === null && acknowledged));
    // Every ending with every evidence shape and marker on legacy runs; the
    // native runtime and the unsafe-archive guard on the endings the fold takes.
    const shapes: Array<{ runtimeMode: string; unsafeArchive: boolean; marker: boolean; ending: (typeof endings)[number]; shape: string }> = [];
    for (const [shape] of Object.entries(evidence)) {
      for (const marker of [false, true]) {
        for (const ending of endings) shapes.push({ runtimeMode: "legacy", unsafeArchive: false, marker, ending, shape });
        for (const ending of foldEndings) {
          shapes.push({ runtimeMode: "native", unsafeArchive: false, marker, ending, shape });
          shapes.push({ runtimeMode: "legacy", unsafeArchive: true, marker, ending, shape });
        }
      }
    }
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
    const eventRows: Array<typeof heartbeatRunEvents.$inferInsert> = [];
    const actionRows: Array<typeof issueRecoveryActions.$inferInsert> = [];
    const labels = new Map<string, string>();
    for (const { runtimeMode, unsafeArchive, marker, ending, shape } of shapes) {
      const runId = randomUUID();
      const { claimed, events } = evidence[shape]!;
      runRows.push({
        id: runId, companyId: fixture.companyId, agentId: fixture.agentId, invocationSource: "assignment",
        status: ending.status, errorCode: ending.errorCode, runtimeMode, contextSnapshot: { issueId: fixture.issueId },
        resultJson: {
          ...(ending.acknowledged ? { executionCancellation: { state: "acknowledged" } } : {}),
          ...(marker ? { conversationContinuation: "continue_conversation_v1" } : {}),
          ...(unsafeArchive ? { workspaceRestoreFailure: "restore_unsafe_archive" } : {}),
        },
        runnerProfileJson: claimed === null ? null : { adapterDispatch: { adapterType: claimed } },
        nextEventSeq: events.length + 1,
      });
      events.forEach((adapterType, index) => eventRows.push({ companyId: fixture.companyId, agentId: fixture.agentId, runId,
        seq: index + 1, eventType: "adapter.invoke", payload: adapterType === null ? {} : { adapterType } }));
      actionRows.push({
        companyId: fixture.companyId, sourceIssueId: fixture.issueId, kind: "active_run_watchdog", status: "resolved",
        ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${runId}`,
        evidence: { runId }, nextAction: "Reconcile the run.",
      });
      labels.set(runId, `${runtimeMode}${unsafeArchive ? " unsafe-archive" : ""}${marker ? " marked" : ""} ` +
        `${ending.status} ${ending.errorCode} acknowledged=${ending.acknowledged} ${shape}`);
    }
    await db.insert(heartbeatRuns).values(runRows);
    await db.insert(heartbeatRunEvents).values(eventRows);
    await db.insert(issueRecoveryActions).values(actionRows);

    const folded = new Set((await db.select({ runId: sql<string>`${issueRecoveryActions.evidence}->>'runId'` })
      .from(issueRecoveryActions).where(conversationRecoveryActionPredicate())).map((row) => row.runId));
    const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, [...labels.keys()]));
    const loops: string[] = [];
    const overreach: string[] = [];
    for (const run of runs) {
      const repaired = await needsConversationContinuationRepair(db, run);
      // A hold the sweep opens and the settle sweep folds, on a run the sweep never repairs, loops forever.
      if (folded.has(run.id) && legacyExecutionNeedsReconciliation(run) && !repaired) loops.push(labels.get(run.id)!);
      // A repair on a run whose hold the settle sweep keeps would bypass that hold.
      if (repaired && !folded.has(run.id)) overreach.push(labels.get(run.id)!);
    }
    expect(runs).toHaveLength(shapes.length);
    expect(loops).toEqual([]);
    expect(overreach).toEqual([]);
    expect(folded.size).toBeGreaterThan(0);
  });

  it("holds and blocks a run whose latest adapter invocation was not a conversation adapter", async () => {
    const fixture = await seedEndedIssueRun("mixed-evidence", { status: "failed", errorCode: "process_lost" });
    await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId,
      seq: 2, eventType: "adapter.invoke", payload: { adapterType: "process" } });
    await db.update(heartbeatRuns).set({ nextEventSeq: 3 }).where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    await settleUnrecoverableExecutions(db);
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId))).toHaveLength(0);
  });

  it("keeps a cancelled adapter_failed run on hold and blocks the issue", async () => {
    const fixture = await seedEndedIssueRun("cancel-adapter", { status: "cancelled", errorCode: "adapter_failed" });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    await settleUnrecoverableExecutions(db);
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId))).toHaveLength(0);
  });

  it("continues an issue whose last run succeeded without moving it", async () => {
    const fixture = await seedEndedIssueRun("succeeded", { status: "succeeded", errorCode: null, invocationSource: "on_demand", requestedByActorType: "user" });
    holdNextExecution();

    const sweep = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(sweep.issueIds).toContain(fixture.issueId);
    const next = await waitFor(async () => {
      const rows = (await issueBoundRuns(fixture.issueId)).filter((row) => row.id !== fixture.runId);
      return rows.length > 0 ? rows : null;
    });
    expect(next).toHaveLength(1);
  });

  it("leaves the issue in_progress with no lock and no issue-bound run after an issue-less run checks it out and finishes", async () => {
    const fixture = await seedAssignedTodo("evidence");
    await strandThroughIssueLessRun(fixture);

    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    // The run's finalization released the issue's locks; no run names the issue.
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: fixture.agentId, executionRunId: null, checkoutRunId: null });
    expect(await issueBoundRuns(fixture.issueId)).toHaveLength(0);
  });

  it("wakes an issue whose locks still point at the finished issue-less run that checked it out", async () => {
    const fixture = await seedUnevidencedInProgress("lock-held");
    const runId = randomUUID();
    // The run ended before the issue's recorded start, so only the lock links them.
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: fixture.companyId, agentId: fixture.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "succeeded", contextSnapshot: { triggeredBy: "board" },
      startedAt: new Date(Date.now() - 3 * 60 * 60_000), finishedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, fixture.issueId));
    holdNextExecution();

    const sweep = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(sweep.issueIds).toContain(fixture.issueId);
    expect(await issueBoundRuns(fixture.issueId)).toHaveLength(1);
  });

  it("wakes that stranded issue once per sweep window", async () => {
    const fixture = await seedAssignedTodo("wake");
    await strandThroughIssueLessRun(fixture);
    holdNextExecution();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileStrandedAssignedIssues();
    expect(first.issueIds).toContain(fixture.issueId);
    const queued = await waitFor(async () => {
      const rows = await issueBoundRuns(fixture.issueId);
      return rows.length > 0 ? rows : null;
    });
    expect(queued).toHaveLength(1);
    expect(queued![0]).toMatchObject({ agentId: fixture.agentId });

    // The recovery run is still live, so the next sweep leaves the issue alone.
    const second = await heartbeat.reconcileStrandedAssignedIssues();
    expect(second.issueIds).not.toContain(fixture.issueId);
    expect(await issueBoundRuns(fixture.issueId)).toHaveLength(1);
  });

  /** in_progress with no lock and no issue-bound run. */
  async function seedUnevidencedInProgress(label: string, options: { maxConcurrentRuns?: number } = {}) {
    const fixture = await seedAssignedTodo(label, options);
    await db.update(issues).set({ status: "in_progress", startedAt: new Date() }).where(eq(issues.id, fixture.issueId));
    return fixture;
  }

  /** A finished run with no issue in its context, live while the agent checked issues out. */
  async function seedIssueLessRunAround(fixture: { companyId: string; agentId: string }, at: Date) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: fixture.companyId, agentId: fixture.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "succeeded", contextSnapshot: { triggeredBy: "board" },
      startedAt: new Date(at.getTime() - 60_000), finishedAt: new Date(at.getTime() + 60_000),
    });
  }

  it("dispatches no more stranded issues per sweep than the agent has free run slots", async () => {
    const first = await seedUnevidencedInProgress("slots", { maxConcurrentRuns: 1 });
    const secondIssueId = randomUUID();
    const [prefixRow] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, first.companyId));
    await db.insert(issues).values({
      id: secondIssueId, companyId: first.companyId, title: "Second assigned work", status: "in_progress",
      priority: "medium", assigneeAgentId: first.agentId, assigneeUserId: null, responsibleUserId: "responsible-user",
      issueNumber: 2, identifier: `${prefixRow!.prefix}-2`, startedAt: new Date(),
    });
    await seedIssueLessRunAround(first, new Date());
    holdNextExecution();
    const heartbeat = heartbeatService(db);

    const sweep = await heartbeat.reconcileStrandedAssignedIssues();
    expect(sweep.dispatchDeferredForCapacity).toBe(1);
    const dispatched = [first.issueId, secondIssueId].filter((id) => sweep.issueIds.includes(id));
    expect(dispatched).toHaveLength(1);
    const [waiting] = [first.issueId, secondIssueId].filter((id) => !sweep.issueIds.includes(id));
    expect(await issueBoundRuns(waiting!)).toHaveLength(0);

    // The dispatched run holds the agent's only slot, so the next sweep waits again.
    const [dispatchedIssue] = [first.issueId, secondIssueId].filter((id) => sweep.issueIds.includes(id));
    await waitFor(async () => {
      const [run] = await issueBoundRuns(dispatchedIssue!);
      return run?.status === "running" ? run : null;
    });
    const next = await heartbeat.reconcileStrandedAssignedIssues();
    expect(next.issueIds).not.toContain(waiting);
    expect(next.dispatchDeferredForCapacity).toBe(1);
  });

  it("gives a failed dispatch's run slot to the next stranded issue in the same sweep", async () => {
    const first = await seedUnevidencedInProgress("slot-release");
    const secondIssueId = randomUUID();
    const [prefixRow] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, first.companyId));
    await db.insert(issues).values({
      id: secondIssueId, companyId: first.companyId, title: "Second assigned work", status: "in_progress",
      priority: "medium", assigneeAgentId: first.agentId, assigneeUserId: null, responsibleUserId: "responsible-user",
      issueNumber: 2, identifier: `${prefixRow!.prefix}-2`, startedAt: new Date(),
    });
    await seedIssueLessRunAround(first, new Date());
    holdNextExecution();
    const heartbeat = heartbeatService(db);
    let calls = 0;
    const enqueueWakeup = vi.fn(async (agentId: string, options: Parameters<typeof heartbeat.wakeup>[1]) => {
      calls += 1;
      if (calls === 1) throw new Error("wake store briefly unavailable");
      return heartbeat.wakeup(agentId, options);
    });

    // One free slot: the dispatch that failed must not keep it.
    const result = await recoveryService(db, { enqueueWakeup, getAgentFreeRunSlots: async () => 1 }).reconcileStrandedAssignedIssues();

    expect(result.failed).toBe(1);
    expect(result.dispatchDeferredForCapacity).toBe(0);
    const [failedIssueId, dispatchedIssueId] = enqueueWakeup.mock.calls
      .map(([, options]) => (options?.payload as { issueId?: string }).issueId);
    expect([failedIssueId, dispatchedIssueId].sort()).toEqual([first.issueId, secondIssueId].sort());
    expect(result.issueIds).toContain(dispatchedIssueId);
    expect(await issueBoundRuns(dispatchedIssueId!)).toHaveLength(1);
    expect(await issueBoundRuns(failedIssueId!)).toHaveLength(0);
  });

  it("re-dispatches a conversation agent's run orphaned by a restart, within the retry limit", async () => {
    const fixture = await seedRestartOrphanedAssignment("orphan");
    const heartbeat = heartbeatService(db);
    holdNextExecution();

    const swept = await heartbeat.sweepStaleIssueLocks();
    expect(swept.terminalizedRunIds).toContain(fixture.runId);
    const [orphaned] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(orphaned).toMatchObject({ status: "interrupted", errorCode: "orphaned_running_run" });
    expect(orphaned!.resultJson).toMatchObject({ conversationContinuation: "continue_conversation_v1" });

    const first = await heartbeat.reconcileStrandedAssignedIssues();
    expect(first.issueIds).toContain(fixture.issueId);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId));
    expect(successors).toHaveLength(1);
    expect(successors[0]!.contextSnapshot).toMatchObject({ issueId: fixture.issueId });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toEqual([]);

    const second = await heartbeat.reconcileStrandedAssignedIssues();
    expect(second.issueIds).not.toContain(fixture.issueId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId))).toHaveLength(1);
  });

  it("keeps the reconciliation hold for a non-conversation adapter orphaned by a restart and blocks the issue", async () => {
    const fixture = await seedRestartOrphanedAssignment("process-orphan", "process");
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepStaleIssueLocks();
    const [orphaned] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(orphaned?.resultJson ?? {}).not.toHaveProperty("conversationContinuation");

    await heartbeat.reconcileStrandedAssignedIssues();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
    expect(hold).toMatchObject({ kind: "active_run_watchdog", ownerType: "board", status: "active", cause: "legacy_execution_requires_reconciliation" });
    await settleUnrecoverableExecutions(db);
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId))).toHaveLength(0);
  });

  it("recovers the dispatched run in turn when it fails", async () => {
    const fixture = await seedAssignedTodo("dispatch-fails");
    await strandThroughIssueLessRun(fixture);
    const release = holdNextExecution({ ...SUCCESS, exitCode: 1, errorMessage: "provider crashed", summary: "" });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    const [dispatched] = await issueBoundRuns(fixture.issueId);
    expect(dispatched).toBeTruthy();
    release();
    // Wait for the whole run, finalization included, so the sweep sees its final state.
    await heartbeat.drainActiveRunExecutions();
    expect((await heartbeat.getRun(dispatched!.id))?.status).toBe("failed");
    // Past the continuation backoff, the next sweep retries (or escalates) instead of skipping.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(heartbeatRuns.id, dispatched!.id));
    holdNextExecution();

    await heartbeat.reconcileStrandedAssignedIssues();
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, dispatched!.id));
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, fixture.issueId));
    expect(successors.length > 0 || issue?.status === "blocked").toBe(true);
  });

  it("wakes an issue whose locks are already released when an issue-less run covered its checkout", async () => {
    const fixture = await seedUnevidencedInProgress("covered");
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await seedIssueLessRunAround(fixture, issue!.startedAt!);
    holdNextExecution();

    const sweep = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(sweep.issueIds).toContain(fixture.issueId);
    expect(await issueBoundRuns(fixture.issueId)).toHaveLength(1);
  });

  it("leaves in_progress work that no run ever checked out alone", async () => {
    const fixture = await seedUnevidencedInProgress("seeded");

    const sweep = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(sweep.issueIds).not.toContain(fixture.issueId);
    expect(await issueBoundRuns(fixture.issueId)).toHaveLength(0);
  });

  it("repairs a run the orphan writer ended before it recorded conversation continuation", async () => {
    const fixture = await seedRestartOrphanedAssignment("old-orphan");
    // The row as an older server wrote it: orphaned, no marker, locks released.
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "orphaned_running_run", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.runId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, fixture.issueId));
    holdNextExecution();

    await heartbeatService(db).reconcileStrandedAssignedIssues();
    const [repaired] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(repaired!.resultJson).toMatchObject({ conversationContinuation: "continue_conversation_v1" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId))).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toEqual([]);
  });

  it("keeps sweeping the other issues when one issue throws", async () => {
    const broken = await seedAssignedTodo("broken");
    const healthy = await seedAssignedTodo("healthy");
    const heartbeat = heartbeatService(db);
    holdNextExecution();
    const enqueueWakeup = vi.fn(async (agentId: string, options: Parameters<typeof heartbeat.wakeup>[1]) => {
      if ((options?.payload as { issueId?: string } | undefined)?.issueId === broken.issueId) {
        throw new Error("wake store unavailable for this issue");
      }
      return heartbeat.wakeup(agentId, options);
    });
    const logged = vi.spyOn(logger, "error");

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(healthy.issueId);
    expect(result.issueIds).not.toContain(broken.issueId);
    expect(result.failed).toBe(1);
    expect(enqueueWakeup.mock.calls.map(([, options]) => (options?.payload as { issueId?: string }).issueId))
      .toEqual(expect.arrayContaining([broken.issueId, healthy.issueId]));
    expect(await waitFor(async () => {
      const rows = await issueBoundRuns(healthy.issueId);
      return rows.length > 0 ? rows : null;
    })).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: broken.issueId, err: expect.any(Error) }),
      expect.stringContaining("stranded issue"),
    );
  });
});
