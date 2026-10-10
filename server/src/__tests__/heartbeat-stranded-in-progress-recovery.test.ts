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
    await waitFor(async () => {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      return active.length === 0 ? true : null;
    }, 3_000);
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
    const settled = await waitFor(async () => {
      const current = await heartbeat.getRun(run!.id);
      return current && current.status !== "queued" && current.status !== "running" ? current : null;
    });
    expect(settled?.status).toBe("succeeded");
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

  it("leaves the issue in_progress with no issue-bound run after an issue-less run checks it out and finishes", async () => {
    const fixture = await seedAssignedTodo("evidence");
    const runId = await strandThroughIssueLessRun(fixture);

    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    // The finished run still holds the locks until a sweep releases them; no run names the issue.
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: fixture.agentId, executionRunId: runId, checkoutRunId: runId });
    expect(await issueBoundRuns(fixture.issueId)).toHaveLength(0);
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
    const ended = await waitFor(async () => {
      const current = await heartbeat.getRun(dispatched!.id);
      return current && current.status !== "queued" && current.status !== "running" ? current : null;
    });
    expect(ended?.status).toBe("failed");
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
