import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
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
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.ts";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";

const SUCCESS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Wake loop guard test run.",
  provider: "test",
  model: "test-model",
};

type MockRunContext = { runId: string; agent: { id: string; companyId: string }; context: Record<string, unknown> };
const mockAdapterExecute = vi.hoisted(() => vi.fn(async (_ctx: MockRunContext) => ({ ...SUCCESS })));

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
    `Skipping embedded Postgres wake loop guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("issue wake loop guard", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-loop-guard-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  /** A real agent leaves an issue comment; without one the comment policy queues a follow-up run. */
  async function postRunComment(ctx: MockRunContext) {
    const issueId = typeof ctx.context.issueId === "string" ? ctx.context.issueId : null;
    if (!issueId) return;
    await db.insert(issueComments).values({
      companyId: ctx.agent.companyId,
      issueId,
      authorAgentId: ctx.agent.id,
      createdByRunId: ctx.runId,
      body: "Run summary.",
    });
  }

  async function defaultRun(ctx: MockRunContext) {
    await postRunComment(ctx);
    return { ...SUCCESS };
  }

  beforeEach(() => {
    mockAdapterExecute.mockImplementation(defaultRun);
  });

  async function waitForIdle() {
    return waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    });
  }

  afterEach(async () => {
    await waitForIdle();
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    await Promise.all(runIds.map(({ id }) => heartbeat.waitForRunExecutionDrain(id)));
    mockAdapterExecute.mockReset();
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
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
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
      name: "Anthm",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: name === "Jarvis" ? "ceo" : "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(companyId: string, input: { assigneeAgentId: string | null; status?: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Loop guard issue",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  /**
   * Blocks the issue through the issue service, as `PATCH /issues/:id` does.
   * That stamps a new blocked cycle and clears the lock columns, even while
   * the agent's own run is still executing the issue.
   */
  async function blockIssueAsRoute(issueId: string, ownerAgentId: string) {
    const blocked = await issueService(db).update(issueId, {
      status: "blocked",
      unblockDescriptor: { owner: { agentId: ownerAgentId }, action: "Confirm the blocker is done" },
    });
    expect(blocked).toMatchObject({ status: "blocked", executionRunId: null, checkoutRunId: null });
    return blocked!.blockedTransitionAt!;
  }

  /** What `PATCH /issues/:id` emits when an agent blocks an issue on an already-done blocker. */
  function selfReblockWakes(input: {
    agentId: string;
    issueId: string;
    blockerId: string;
    blockedTransitionAt: Date;
  }) {
    return [
      {
        source: "automation" as const,
        triggerDetail: "system" as const,
        reason: "issue_blockers_resolved",
        payload: {
          issueId: input.issueId,
          resolvedBlockerIssueId: input.blockerId,
          blockerIssueIds: [input.blockerId],
          mutation: "blocked_dependency_restored",
        },
        // The ready-state key embeds the block time, so it changes every cycle.
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: input.issueId,
          blockerIssueIds: [input.blockerId],
          blockedTransitionAt: input.blockedTransitionAt,
        }),
        requestedByActorType: "agent" as const,
        requestedByActorId: input.agentId,
        contextSnapshot: {
          issueId: input.issueId,
          taskId: input.issueId,
          wakeReason: "issue_blockers_resolved",
          source: "issue.blockers_restored",
        },
      },
      {
        source: "automation" as const,
        triggerDetail: "system" as const,
        reason: "issue_unblock_requested",
        idempotencyKey: `issue-unblock:${input.issueId}:${input.blockedTransitionAt.toISOString()}`,
        payload: { issueId: input.issueId, action: "Confirm the blocker is done" },
        contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: input.issueId, taskId: input.issueId },
        causedBy: { actorType: "agent" as const, actorId: input.agentId },
      },
    ];
  }

  async function seedSelfReblockRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    createdAt: Date;
  }) {
    for (let index = 0; index < input.count; index += 1) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "automation",
        contextSnapshot: { issueId: input.issueId, wakeReason: "issue_unblock_requested" },
        startedAt: input.createdAt,
        finishedAt: input.createdAt,
        createdAt: input.createdAt,
      }).returning();
      await db.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_unblock_requested",
        payload: {
          issueId: input.issueId,
          _paperclipSelfReblockWake: {
            agentId: input.agentId,
            reason: "issue_unblock_requested",
            causeActorType: "agent",
            causeActorId: input.agentId,
          },
        },
        status: "completed",
        runId: run!.id,
        requestedAt: input.createdAt,
        finishedAt: input.createdAt,
      });
    }
  }

  it("stops the ANT-3260 loop: an owner's own re-block never wakes it again", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId, "Jarvis");
    const blockerId = await seedIssue(companyId, { assigneeAgentId: null, status: "done" });
    const issueId = await seedIssue(companyId, { assigneeAgentId: ceoId, status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });

    // Each run re-blocks its own issue on the done blocker, exactly as the
    // ANT-3260 CEO did, which makes the route wake the same agent again.
    // The bound only keeps a regression from looping forever.
    let cycle = 0;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      cycle += 1;
      if (cycle <= 5) {
        // The run records its disposition: blocked on the done blocker, with
        // itself as the unblock owner ...
        const blockedTransitionAt = await blockIssueAsRoute(issueId, ceoId);
        // ... and the route then emits the same two wakes for the same agent.
        for (const wake of selfReblockWakes({ agentId: ceoId, issueId, blockerId, blockedTransitionAt })) {
          await heartbeat.wakeup(ceoId, wake);
        }
      }
      return defaultRun(ctx);
    });

    const firstRun = await heartbeat.wakeup(ceoId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: { issueId, source: "issue.update" },
    });
    expect(firstRun).not.toBeNull();
    await waitForCondition(async () => cycle >= 1);
    expect(await waitForIdle()).toBe(true);
    await heartbeat.waitForRunExecutionDrain(firstRun!.id);
    // The periodic paths must not restart the agent either: the resolved
    // dependency backstop (every tick) sees a blocked issue whose blockers
    // are all done, and the resume sweep re-drives deferred queues.
    for (let tick = 0; tick < 3; tick += 1) {
      await heartbeat.reconcileResolvedDependencyWakes();
      await heartbeat.resumeQueuedRuns();
    }
    // Give a regressed promotion time to start a second run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await waitForIdle()).toBe(true);

    expect(cycle).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ceoId));
    expect(runs).toHaveLength(1);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ceoId));
    const suppressed = wakes.filter((wake) => wake.reason === "issue_self_reblock_wake_suppressed");
    expect(suppressed).toHaveLength(2);
    expect(suppressed.every((wake) => wake.status === "skipped")).toBe(true);
    // Nothing self-caused is left waiting to promote.
    expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toEqual([]);

    const activity = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.wake_suppressed_self")));
    expect(activity).toHaveLength(2);
    expect(activity.map((row) => (row.details as { reason: string }).reason).sort()).toEqual([
      "issue_blockers_resolved",
      "issue_unblock_requested",
    ]);
  });

  /** A self-wake parked behind the agent's own run, as a deferred receipt. */
  function deferredSelfWake(input: { id: string; companyId: string; agentId: string; issueId: string }) {
    return {
      id: input.id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId: input.issueId,
        action: "Confirm the blocker is done",
        _paperclipSelfReblockWake: {
          agentId: input.agentId,
          reason: "issue_unblock_requested",
          causeActorType: "agent",
          causeActorId: input.agentId,
        },
        _paperclipWakeContext: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_unblock_requested" },
      },
      status: "deferred_issue_execution",
      requestedAt: new Date(Date.now() - 60_000),
    };
  }

  function boardWake() {
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      requestedByActorType: "user" as const,
      requestedByActorId: "board-user",
    };
  }

  it("keeps a parked self-wake suppressed when it is promoted after its owner's run releases", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId, "Jarvis");
    const blockerId = await seedIssue(companyId, { assigneeAgentId: null, status: "done" });
    const issueId = await seedIssue(companyId, { assigneeAgentId: ceoId });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const parkedWakeId = randomUUID();

    let cycle = 0;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      cycle += 1;
      if (cycle === 1) {
        // The run re-blocks its issue on the done blocker while an older
        // self-wake for it sits in the deferred queue.
        await blockIssueAsRoute(issueId, ceoId);
        await db.insert(agentWakeupRequests).values(deferredSelfWake({ id: parkedWakeId, companyId, agentId: ceoId, issueId }));
      }
      return defaultRun(ctx);
    });

    const firstRun = await heartbeat.wakeup(ceoId, {
      ...boardWake(),
      payload: { issueId, mutation: "update" },
      contextSnapshot: { issueId, source: "issue.update" },
    });
    expect(firstRun).not.toBeNull();
    await waitForCondition(async () => cycle >= 1);
    expect(await waitForIdle()).toBe(true);
    await heartbeat.waitForRunExecutionDrain(firstRun!.id);

    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parkedWakeId));
    expect(parked).toMatchObject({ status: "cancelled", runId: null, reason: "issue_self_reblock_wake_suppressed" });
    expect(parked!.error).toContain("Self-caused re-block wake suppressed");
    const suppression = await db
      .select({ details: activityLog.details, runId: activityLog.runId })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.wake_suppressed_self")));
    expect(suppression).toEqual([
      expect.objectContaining({
        runId: firstRun!.id,
        details: expect.objectContaining({ phase: "promotion", wakeupRequestId: parkedWakeId }),
      }),
    ]);

    // Deferred -> cancelled at promotion: the issue is still blocked on a done
    // blocker, but this blocked cycle was the agent's own decision, so the
    // dependency backstop must not restart it either.
    for (let tick = 0; tick < 3; tick += 1) {
      await heartbeat.reconcileResolvedDependencyWakes();
      await heartbeat.resumeQueuedRuns();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await waitForIdle()).toBe(true);
    expect(cycle).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ceoId))).toHaveLength(1);
  });

  it("still promotes a board-caused wake queued next to a suppressed self-wake", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId, "Jarvis");
    const issueId = await seedIssue(companyId, { assigneeAgentId: ceoId });
    const parkedWakeId = randomUUID();
    const boardWakeId = randomUUID();

    let cycle = 0;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      cycle += 1;
      if (cycle === 1) {
        await blockIssueAsRoute(issueId, ceoId);
        await db.insert(agentWakeupRequests).values([
          deferredSelfWake({ id: parkedWakeId, companyId, agentId: ceoId, issueId }),
          {
            id: boardWakeId,
            companyId,
            agentId: ceoId,
            source: "automation",
            triggerDetail: "system",
            reason: "issue_execution_deferred",
            payload: {
              issueId,
              mutation: "blocked_dependency_restored",
              _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_blockers_resolved" },
            },
            status: "deferred_issue_execution",
            requestedByActorType: "user",
            requestedByActorId: "board-user",
            requestedAt: new Date(Date.now() - 30_000),
          },
        ]);
      } else {
        // The board's unblock lets the agent finish the work.
        await issueService(db).update(issueId, { status: "done" });
      }
      return defaultRun(ctx);
    });

    const firstRun = await heartbeat.wakeup(ceoId, {
      ...boardWake(),
      payload: { issueId, mutation: "update" },
      contextSnapshot: { issueId, source: "issue.update" },
    });
    expect(firstRun).not.toBeNull();
    await waitForCondition(async () => cycle >= 2);
    expect(await waitForIdle()).toBe(true);

    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parkedWakeId));
    expect(parked).toMatchObject({ status: "cancelled", runId: null });
    const [board] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, boardWakeId));
    expect(board!.runId).not.toBeNull();
    expect(cycle).toBe(2);
  });

  it("lets the backstop wake the agent when a blocker resolves after its own suppressed unblock request", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Jarvis");
    const blockerId = await seedIssue(companyId, { assigneeAgentId: null, status: "todo" });
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentId });

    let cycle = 0;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      cycle += 1;
      if (cycle === 1) {
        // The run blocks its issue on a still-pending blocker and names itself
        // the unblock owner; that self wake is suppressed.
        await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
        const blockedTransitionAt = await blockIssueAsRoute(issueId, agentId);
        const [, unblockWake] = selfReblockWakes({ agentId, issueId, blockerId, blockedTransitionAt });
        await heartbeat.wakeup(agentId, unblockWake!);
      }
      return defaultRun(ctx);
    });

    const firstRun = await heartbeat.wakeup(agentId, {
      ...boardWake(),
      payload: { issueId, mutation: "update" },
      contextSnapshot: { issueId, source: "issue.update" },
    });
    expect(firstRun).not.toBeNull();
    await waitForCondition(async () => cycle >= 1);
    expect(await waitForIdle()).toBe(true);
    await heartbeat.waitForRunExecutionDrain(firstRun!.id);
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_self_reblock_wake_suppressed")),
    ).toHaveLength(1);

    // Someone else completes the blocker later and its route wake is lost.
    // That resolution is news: the backstop must deliver it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await issueService(db).update(blockerId, { status: "done" });
    const result = await heartbeat.reconcileResolvedDependencyWakes();
    expect(result).toMatchObject({ healed: 1, selfReblockSkipped: 0 });
    await waitForCondition(async () => cycle >= 2);
    expect(await waitForIdle()).toBe(true);
    expect(cycle).toBe(2);
  });

  it("still wakes for a board or other-agent unblock after three self attempts, and parks the fourth self attempt", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent(companyId, "Assignee");
    const unblockOwnerId = await seedAgent(companyId, "UnblockOwner");
    const issueId = await seedIssue(companyId, { assigneeAgentId: ownerId, status: "blocked" });
    await seedSelfReblockRuns({ companyId, agentId: unblockOwnerId, issueId, count: 3, createdAt: new Date() });

    // The fourth self-caused unblock request in the window is held back, not dropped.
    const [, selfUnblock] = selfReblockWakes({ agentId: unblockOwnerId, issueId, blockerId: randomUUID(), blockedTransitionAt: new Date() });
    await expect(heartbeat.wakeup(unblockOwnerId, selfUnblock!)).resolves.toBeNull();
    const parked = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, unblockOwnerId), eq(agentWakeupRequests.reason, "issue_wake_rate_limited")));
    expect(parked).toEqual([
      expect.objectContaining({
        status: "deferred_issue_execution",
        runId: null,
        payload: expect.objectContaining({
          issueId,
          _paperclipSelfReblockWakeParked: expect.objectContaining({ limit: 3, windowMs: 600_000 }),
          _paperclipWakeContext: expect.objectContaining({ wakeReason: "issue_unblock_requested" }),
        }),
      }),
    ]);
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "skipped")),
    ).toEqual([]);

    // The board unblocks the same agent on the same issue: never limited.
    const boardRun = await heartbeat.wakeup(unblockOwnerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issueId}:board`,
      payload: { issueId, action: "Board asked for the unblock" },
      contextSnapshot: { wakeReason: "issue_unblock_requested", issueId, taskId: issueId },
      causedBy: { actorType: "user", actorId: "board-user" },
    });
    expect(boardRun).toMatchObject({ agentId: unblockOwnerId, status: expect.stringMatching(/queued|running|succeeded/) });
    await waitForIdle();

    // Another agent completing a real blocker is never limited either.
    const otherAgentRun = await heartbeat.wakeup(unblockOwnerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId, resolvedBlockerIssueId: randomUUID(), mutation: "blocker_done" },
      idempotencyKey: `issue_blockers_resolved:${issueId}:other`,
      requestedByActorType: "agent",
      requestedByActorId: ownerId,
      contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved", source: "issue.blockers_resolved" },
    });
    expect(otherAgentRun).not.toBeNull();
    await waitForIdle();

    // Those runs released the issue, but the parked self wake keeps its place
    // until its window ends: it was neither promoted nor cancelled.
    const [stillParked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked[0]!.id));
    expect(stillParked).toMatchObject({ status: "deferred_issue_execution", runId: null });

    const limited = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.wake_rate_limited"));
    expect(limited).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ outcome: "deferred", reason: "issue_unblock_requested" }) }),
    ]);
  });

  it("admits a parked self-reblock wake once its window passes, through the resume sweep", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent(companyId, "Assignee");
    const unblockOwnerId = await seedAgent(companyId, "UnblockOwner");
    const issueId = await seedIssue(companyId, { assigneeAgentId: ownerId, status: "blocked" });
    await seedSelfReblockRuns({ companyId, agentId: unblockOwnerId, issueId, count: 3, createdAt: new Date() });

    const [, selfUnblock] = selfReblockWakes({ agentId: unblockOwnerId, issueId, blockerId: randomUUID(), blockedTransitionAt: new Date() });
    await expect(heartbeat.wakeup(unblockOwnerId, selfUnblock!)).resolves.toBeNull();
    const [parked] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "issue_wake_rate_limited"));
    expect(parked).toBeDefined();

    const expireHold = () =>
      db
        .update(agentWakeupRequests)
        .set({
          payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{_paperclipSelfReblockWakeParked,notBefore}', to_jsonb(${new Date(Date.now() - 1_000).toISOString()}::text))`,
        })
        .where(eq(agentWakeupRequests.id, parked!.id));
    const readParked = async () => {
      const [current] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked!.id));
      return current!;
    };

    // Inside the window the sweep leaves it parked.
    await heartbeat.resumeQueuedRuns();
    expect(await readParked()).toMatchObject({ status: "deferred_issue_execution", runId: null });

    // The hold expired but the three runs are still inside the window: the
    // release drain re-parks it for another window instead of promoting it.
    await expireHold();
    await heartbeat.resumeQueuedRuns();
    const reparked = await readParked();
    expect(reparked).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const notBefore = new Date(
      (reparked.payload as { _paperclipSelfReblockWakeParked: { notBefore: string } })._paperclipSelfReblockWakeParked.notBefore,
    );
    expect(notBefore.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);

    // Eleven minutes later: the earlier runs left the window and the hold expired.
    const past = new Date(Date.now() - 11 * 60 * 1000);
    await db.update(heartbeatRuns).set({ createdAt: past }).where(eq(heartbeatRuns.agentId, unblockOwnerId));
    await expireHold();

    await heartbeat.resumeQueuedRuns();
    const promoted = await waitForCondition(async () => {
      const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked!.id));
      return Boolean(row?.runId);
    });
    expect(promoted).toBe(true);
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked!.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row!.runId!));
    expect(run).toMatchObject({
      agentId: unblockOwnerId,
      wakeupRequestId: parked!.id,
      contextSnapshot: expect.objectContaining({ issueId, wakeReason: "issue_unblock_requested" }),
    });
    await waitForIdle();
  });

  it("still wakes an agent that assigns itself a blocked-ready issue from a run elsewhere", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "SelfAssigner");
    const blockerId = await seedIssue(companyId, { assigneeAgentId: null, status: "done" });
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentId, status: "blocked" });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const blockedTransitionAt = new Date();
    await db.update(issues).set({ blockedTransitionAt }).where(eq(issues.id, issueId));

    // Self-caused (the agent assigned itself), but no run of it holds this
    // issue, so the wake is news and must run.
    const [dependencyWake] = selfReblockWakes({ agentId, issueId, blockerId, blockedTransitionAt });
    const run = await heartbeat.wakeup(agentId, dependencyWake!);
    expect(run).toMatchObject({ agentId, contextSnapshot: expect.objectContaining({ issueId }) });
    await waitForIdle();
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "skipped")),
    ).toEqual([]);
  });

  it("gives A -> B -> A distinct assignment wakes and admits no duplicate after a crash before acknowledgement", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "ReviewerA");
    const agentB = await seedAgent(companyId, "ReviewerB");
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentA, status: "todo" });

    async function assign(assigneeAgentId: string, crashAfterCommit: boolean) {
      const [current] = await db
        .update(issues)
        .set({ assigneeAgentId, statusVersion: sql`${issues.statusVersion} + 1` })
        .where(eq(issues.id, issueId))
        .returning();
      let attempts = 0;
      const result = await queueIssueAssignmentWakeup({
        heartbeat: {
          wakeup: async (agentId, opts) => {
            attempts += 1;
            const run = await heartbeat.wakeup(agentId, opts);
            // The wake committed, but the connection dropped before the
            // caller saw the acknowledgement.
            if (crashAfterCommit && attempts === 1) {
              throw new Error("Failed query", {
                cause: Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" }),
              });
            }
            return run;
          },
        },
        issue: { id: issueId, assigneeAgentId, status: current!.status },
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "issue.update",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        assignmentGeneration: current!.statusVersion,
        rethrowOnError: true,
      });
      await waitForIdle();
      return { result, attempts, key: `issue-assignment:${issueId}:${assigneeAgentId}:${current!.statusVersion}` };
    }

    const first = await assign(agentA, true);
    expect(first.attempts).toBe(2);
    const second = await assign(agentB, false);
    const third = await assign(agentA, false);

    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.idempotencyKey} like 'issue-assignment:%'`);
    expect(new Set(receipts.map((receipt) => receipt.idempotencyKey))).toEqual(
      new Set([first.key, second.key, third.key]),
    );
    // The retry after the lost acknowledgement replayed the one committed receipt.
    const firstReceipts = receipts.filter((receipt) => receipt.idempotencyKey === first.key);
    expect(firstReceipts).toHaveLength(1);
    expect(firstReceipts[0]!.runId).not.toBeNull();
    expect((first.result as { id: string } | null)?.id).toBe(firstReceipts[0]!.runId);
    const firstRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, firstReceipts[0]!.id));
    expect(firstRuns).toHaveLength(1);

    // The database itself refuses a second live receipt for the same generation.
    await expect(
      db.insert(agentWakeupRequests).values({
        companyId,
        agentId: agentA,
        source: "assignment",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        idempotencyKey: first.key,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23505" }),
    });
    // A skipped or cancelled receipt never blocks a later delivery attempt.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentA,
      source: "assignment",
      reason: "issue_assigned",
      payload: { issueId },
      status: "skipped",
      idempotencyKey: first.key,
    });
  });
});
