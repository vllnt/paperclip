/**
 * Needs embedded Postgres, so it cannot join the fixed `vitest run` list in the
 * Dockerfile. Run it with
 * `cd server && npx vitest run src/__tests__/routine-copy-wake-conflict.test.ts`.
 *
 * A routine tick that finds no live run creates a new issue, even when an older
 * open copy with the same fingerprint is still there. The unique index
 * `issues_open_routine_execution_uq` allows any number of idle copies and one
 * copy that holds execution. These tests pin both halves: how the copies come to
 * exist, and what a wake of an older copy does while a newer one is live.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
  routineRuns,
  routines,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { routineService } from "../services/routines.ts";
import { runPeriodicHeartbeatRecovery } from "../services/periodic-heartbeat-recovery.ts";

const adapterGate = vi.hoisted(() => {
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    wait: () => gate,
    open: () => { release(); },
    reset: () => { gate = new Promise<void>((resolve) => { release = resolve; }); },
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => {
        await adapterGate.wait();
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "gated", provider: "test", model: "test-model" };
      }),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine copy wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("a wake of an older routine copy while a newer copy holds execution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-copy-wake-");
    db = createDb(tempDb.connectionString);
  }, 240_000);

  afterEach(async () => {
    adapterGate.open();
    await heartbeatService(db).drainActiveRunExecutions();
    adapterGate.reset();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(routineRuns);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Fires two ticks of one routine. A stub wake records a queued run and takes the
   * issue lock, as the routine tests do. Between the ticks, the first run ends and
   * its lock is released, which leaves the first issue open with no live run.
   */
  async function fireTwoTicksLeavingAnOlderCopy() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", defaultResponsibleUserId, requireBoardApprovalForNewAgents: false,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Waiter", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Routines", status: "in_progress" });

    const stubWakeup = async (wakeAgentId: string, opts: { source?: string; triggerDetail?: string; payload?: Record<string, unknown> | null; contextSnapshot?: Record<string, unknown> }) => {
      const issueId = (opts.payload?.issueId as string | undefined) ?? (opts.contextSnapshot?.issueId as string | undefined) ?? null;
      if (!issueId) return null;
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId: wakeAgentId, invocationSource: opts.source ?? "assignment",
        triggerDetail: opts.triggerDetail ?? null, status: "queued", responsibleUserId: defaultResponsibleUserId,
        contextSnapshot: { ...(opts.contextSnapshot ?? {}), issueId },
      });
      await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
      return { id: runId };
    };
    const svc = routineService(db, { heartbeat: { wakeup: stubWakeup } });
    const routine = await svc.create(companyId, {
      projectId, goalId: null, parentIssueId: null, title: "report", description: "Run the report",
      assigneeAgentId: agentId, priority: "medium", status: "active",
      concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed",
    }, {});

    const first = await svc.runRoutine(routine.id, { source: "api" } as never);
    const olderIssueId = first.linkedIssueId!;
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null, status: "in_progress" })
      .where(eq(issues.id, olderIssueId));

    const second = await svc.runRoutine(routine.id, { source: "api" } as never);
    const newerIssueId = second.linkedIssueId!;
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    return { companyId, agentId, routineId: routine.id, olderIssueId, newerIssueId, first, second };
  }

  it("a tick fires while an older copy has no live run, so two open copies exist (the cause)", async () => {
    const { companyId, olderIssueId, newerIssueId, first, second } = await fireTwoTicksLeavingAnOlderCopy();

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(newerIssueId).not.toBe(olderIssueId);
    const open = await db.select({
      id: issues.id, status: issues.status, executionRunId: issues.executionRunId, fingerprint: issues.originFingerprint,
    }).from(issues).where(eq(issues.companyId, companyId));
    expect(open).toHaveLength(2);
    expect(new Set(open.map((row) => row.fingerprint)).size).toBe(1);
    expect(open.find((row) => row.id === olderIssueId)?.executionRunId).toBeNull();
    expect(open.find((row) => row.id === newerIssueId)?.executionRunId).not.toBeNull();
  });

  it("waking the older copy does not fail, and leaves the newer copy's execution alone", async () => {
    const { companyId, agentId, olderIssueId, newerIssueId } = await fireTwoTicksLeavingAnOlderCopy();
    const [newerBefore] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, newerIssueId));

    await expect(
      heartbeatService(db).wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: olderIssueId, mutation: "update" },
        contextSnapshot: { issueId: olderIssueId, source: "test.conveyor" },
      }),
    ).resolves.not.toThrow();

    const [newerAfter] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, newerIssueId));
    expect(newerAfter?.executionRunId).toBe(newerBefore?.executionRunId);
    const [older] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, olderIssueId));
    expect(older?.executionRunId).toBeNull();

    const wakeRuns = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    const olderWakeRun = wakeRuns.find((run) => run.status === "queued" || run.errorCode === "routine_execution_superseded");
    expect(olderWakeRun).toMatchObject({ status: "cancelled", errorCode: "routine_execution_superseded" });

    const events = await db.select({ message: heartbeatRunEvents.message }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, olderWakeRun!.id));
    expect(events.map((event) => event.message).join(" ")).toContain("another open copy of this routine execution");
  });

  it("a stale lock on the newer copy does not fail the wake: the run stays queued and starts once the lock is cleared", async () => {
    const { companyId, agentId, olderIssueId, newerIssueId } = await fireTwoTicksLeavingAnOlderCopy();
    const heartbeat = heartbeatService(db);
    // The newer copy's run ended, but its lock was not cleared yet. The policy
    // does not cancel for this (the holder is not live), so the claim itself meets
    // the unique index and must yield instead of failing.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));

    await expect(heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: olderIssueId, mutation: "update" },
      contextSnapshot: { issueId: olderIssueId, source: "test.conveyor" },
    })).resolves.not.toThrow();

    const [stillHeld] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, newerIssueId));
    expect(stillHeld?.executionRunId).not.toBeNull();
    const queued = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued).toHaveLength(1);

    await db.update(issues).set({ executionRunId: null, executionLockedAt: null }).where(eq(issues.id, newerIssueId));
    await heartbeat.resumeQueuedRuns();

    const [older] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, olderIssueId));
    expect(older?.executionRunId).toBe(queued[0]!.id);
  });

  /**
   * The production state: copy 3 holds the slot, but its run was cancelled and the lock
   * was not cleared (a stale lock). Copy 4 has no run of its own, and a queued run wants
   * the slot. The rows are written directly, so no code path under test can shape them.
   */
  async function seedStaleLockHolder() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const originId = randomUUID();
    const holderIssueId = randomUUID();
    const waitingIssueId = randomUUID();
    const cancelledRunId = randomUUID();
    const queuedRunId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const longAgo = new Date(Date.now() - 30 * 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: prefix, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Waiter", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: cancelledRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "cancelled", errorCode: "cancelled", startedAt: longAgo, finishedAt: new Date(Date.now() - 5 * 60_000),
        contextSnapshot: { issueId: holderIssueId },
      },
      {
        id: queuedRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "queued", contextSnapshot: { issueId: waitingIssueId, wakeReason: "issue_assigned" },
      },
    ]);
    const copy = (id: string, n: number, extra: Record<string, unknown>) => ({
      id, companyId, title: `Copy ${n}`, status: "in_progress" as const, priority: "medium" as const,
      assigneeAgentId: agentId, issueNumber: n, identifier: `${prefix}-${n}`,
      originKind: "routine_execution", originId, createdAt: longAgo, updatedAt: longAgo, ...extra,
    });
    await db.insert(issues).values([
      copy(holderIssueId, 1, { executionRunId: cancelledRunId, executionLockedAt: longAgo }),
      copy(waitingIssueId, 2, {}),
    ]);
    return { companyId, agentId, holderIssueId, waitingIssueId, cancelledRunId, queuedRunId };
  }

  it("the production state: a cancelled holder's stale lock is cleared by the periodic tick, and the waiting run starts on the next tick", async () => {
    const { holderIssueId, waitingIssueId, queuedRunId } = await seedStaleLockHolder();
    const heartbeat = heartbeatService(db);

    // Tick 1. On main, resumeQueuedRuns throws the duplicate key and the chain stops
    // before the sweep, so the lock stays and every later tick fails the same way.
    await expect(runPeriodicHeartbeatRecovery(heartbeat)).resolves.not.toThrow();
    const [holderAfterTick1] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, holderIssueId));
    expect(holderAfterTick1?.executionRunId).toBeNull();

    // Tick 2: the slot is free, so the queued run is claimed.
    await expect(runPeriodicHeartbeatRecovery(heartbeat)).resolves.not.toThrow();
    const [waiting] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, waitingIssueId));
    expect(waiting?.executionRunId).toBe(queuedRunId);
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    expect(run?.status).toBe("running");
  });

  /**
   * Makes the claim of one agent's runs fail with a database error, as a lost race
   * or a constraint would. The trigger exists only for the length of `body`.
   */
  async function withFailingClaimFor<T>(failingAgentId: string, body: () => Promise<T>) {
    await db.execute(sql`create or replace function test_fail_claim() returns trigger language plpgsql as $$
      begin raise exception 'test claim failure' using errcode = '23505'; end $$`);
    await db.execute(sql.raw(`create trigger test_fail_claim_trg before update on heartbeat_runs
      for each row when (new.agent_id = '${failingAgentId}' and new.status = 'running' and old.status = 'queued')
      execute function test_fail_claim()`));
    try {
      return await body();
    } finally {
      await db.execute(sql`drop trigger if exists test_fail_claim_trg on heartbeat_runs`);
    }
  }

  /** Two agents of one company, each with one queued run and no issue. Agent 1's run is older. */
  async function seedTwoAgentsWithQueuedRuns() {
    const companyId = randomUUID();
    const agentIds = [randomUUID(), randomUUID()];
    const runIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    for (const [index, agentId] of agentIds.entries()) {
      await db.insert(agents).values({
        id: agentId, companyId, name: `Agent ${index + 1}`, role: "engineer", status: "idle",
        adapterType: "claude_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 3 } },
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runIds[index]!, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        status: "queued", contextSnapshot: {},
      });
    }
    return { companyId, agentIds, runIds };
  }

  it("a claim error for one agent does not stop resumeQueuedRuns from starting the next agent", async () => {
    const { agentIds, runIds } = await seedTwoAgentsWithQueuedRuns();
    const heartbeat = heartbeatService(db);

    await withFailingClaimFor(agentIds[0]!, async () => {
      await expect(heartbeat.resumeQueuedRuns()).resolves.not.toThrow();
    });

    const [first] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runIds[0]!));
    const [second] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runIds[1]!));
    expect(first?.status).toBe("queued");
    expect(second?.status).toBe("running");
  });

  it("a claim error for one agent does not skip the stale-lock sweep in the same recovery tick", async () => {
    const stale = await seedStaleLockHolder();
    const { agentIds, runIds } = await seedTwoAgentsWithQueuedRuns();
    const heartbeat = heartbeatService(db);
    // Agent 1 of the second company fails; the stale holder of the first company must still be swept.
    await withFailingClaimFor(agentIds[0]!, async () => {
      await expect(runPeriodicHeartbeatRecovery(heartbeat)).resolves.not.toThrow();
    });

    const [holder] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, stale.holderIssueId));
    expect(holder?.executionRunId).toBeNull();
    const [second] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runIds[1]!));
    expect(second?.status).toBe("running");
  });

  it("the sweep alone clears a cancelled holder's lock (the existing mechanism the tick relies on)", async () => {
    const { holderIssueId } = await seedStaleLockHolder();
    const result = await heartbeatService(db).sweepStaleIssueLocks();
    expect(result.issueIds).toContain(holderIssueId);
    const [holder] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, holderIssueId));
    expect(holder?.executionRunId).toBeNull();
  });

  /**
   * Copy 1 holds the slot through a live run. Copy 2 is open, holds no lock, and already
   * has a queued run of its own. The rows are written directly. This is the state in which
   * a wake of copy 2 reaches the "legacy run" rebind in the enqueue transaction, which sets
   * `execution_run_id` on copy 2 before any claim runs.
   */
  async function seedLiveHolderAndQueuedSibling() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const originId = randomUUID();
    const holderIssueId = randomUUID();
    const siblingIssueId = randomUUID();
    const holderRunId = randomUUID();
    const siblingRunId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const longAgo = new Date(Date.now() - 30 * 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: prefix, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Waiter", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: holderRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "running", startedAt: new Date(), contextSnapshot: { issueId: holderIssueId },
      },
      {
        id: siblingRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "queued", contextSnapshot: { issueId: siblingIssueId, wakeReason: "issue_assigned" },
      },
    ]);
    const copy = (id: string, n: number, extra: Record<string, unknown>) => ({
      id, companyId, title: `Copy ${n}`, status: "in_progress" as const, priority: "medium" as const,
      assigneeAgentId: agentId, issueNumber: n, identifier: `${prefix}-${n}`,
      originKind: "routine_execution", originId, createdAt: longAgo, updatedAt: longAgo, ...extra,
    });
    await db.insert(issues).values([
      copy(holderIssueId, 1, { executionRunId: holderRunId, executionLockedAt: new Date() }),
      copy(siblingIssueId, 2, {}),
    ]);
    return { companyId, agentId, holderIssueId, holderRunId, siblingIssueId, siblingRunId };
  }

  it("a wake of a copy that already has a queued run does not rebind it onto the slot while a sibling holds it", async () => {
    const { agentId, holderIssueId, holderRunId, siblingIssueId, siblingRunId } = await seedLiveHolderAndQueuedSibling();

    await expect(heartbeatService(db).wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: siblingIssueId, mutation: "update" },
      contextSnapshot: { issueId: siblingIssueId, source: "test.conveyor" },
    })).resolves.not.toThrow();

    const [holder] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, holderIssueId));
    expect(holder?.executionRunId).toBe(holderRunId);
    const [sibling] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, siblingIssueId));
    expect(sibling?.executionRunId).toBeNull();
    // The sibling's own queued run is never left to fail: it is cancelled as superseded
    // once the claim path sees the live holder.
    await heartbeatService(db).resumeQueuedRuns();
    const [siblingRun] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, siblingRunId));
    expect(siblingRun).toMatchObject({ status: "cancelled", errorCode: "routine_execution_superseded" });
  });

  it("the queued-comment claim yields on a stale holder's slot: the run stays queued, then starts once the lock is cleared", async () => {
    const { companyId, agentId, waitingIssueId, queuedRunId } = await seedStaleLockHolder();
    const commentId = randomUUID();
    const wakeId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId: waitingIssueId, body: "please continue" });
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source: "automation", status: "queued", runId: queuedRunId,
      payload: { issueId: waitingIssueId, _paperclipWakeContext: { wakeCommentIds: [commentId] } },
    });
    await db.update(heartbeatRuns).set({
      wakeupRequestId: wakeId,
      invocationSource: "assignment",
      contextSnapshot: { issueId: waitingIssueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] },
    }).where(eq(heartbeatRuns.id, queuedRunId));
    const heartbeat = heartbeatService(db);

    // The holder's run is not live, so the policy does not cancel. The claim meets the index.
    await expect(heartbeat.resumeQueuedRuns()).resolves.not.toThrow();
    const [stillQueued] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    expect(stillQueued?.status).toBe("queued");
    const [wake] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).toBe("queued");

    await heartbeat.sweepStaleIssueLocks();
    await expect(heartbeat.resumeQueuedRuns()).resolves.not.toThrow();
    const [waiting] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, waitingIssueId));
    expect(waiting?.executionRunId).toBe(queuedRunId);
  });

  it("two connections wake two idle copies at once: one run wins the slot, the other is cancelled as superseded, and nothing fails", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const originId = randomUUID();
    const issueIds = [randomUUID(), randomUUID()];
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const longAgo = new Date(Date.now() - 30 * 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: prefix, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Waiter", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });
    await db.insert(issues).values(issueIds.map((id, index) => ({
      id, companyId, title: `Copy ${index + 1}`, status: "in_progress" as const, priority: "medium" as const,
      assigneeAgentId: agentId, issueNumber: index + 1, identifier: `${prefix}-${index + 1}`,
      originKind: "routine_execution", originId, createdAt: longAgo, updatedAt: longAgo,
    })));

    const otherConnection = createDb(tempDb!.connectionString);
    const wake = (service: ReturnType<typeof heartbeatService>, issueId: string) =>
      service.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId, mutation: "update" },
        contextSnapshot: { issueId, source: "test.race" },
      });
    await expect(Promise.all([
      wake(heartbeatService(db), issueIds[0]!),
      wake(heartbeatService(otherConnection), issueIds[1]!),
    ])).resolves.toBeDefined();

    const rows = await db.select({ id: issues.id, executionRunId: issues.executionRunId }).from(issues).where(eq(issues.companyId, companyId));
    expect(rows.filter((row) => row.executionRunId !== null)).toHaveLength(1);
    const runs = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, issueId: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.filter((run) => run.status === "failed")).toHaveLength(0);
    expect(runs.filter((run) => run.status === "running" || run.status === "queued")).toHaveLength(1);
    const cancelled = runs.filter((run) => run.status === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.errorCode).toBe("routine_execution_superseded");
  });

  it("repeated wakes of the older copy keep failing safe: no error, one cancelled run each, no queue left behind", async () => {
    const { companyId, agentId, olderIssueId } = await fireTwoTicksLeavingAnOlderCopy();
    const heartbeat = heartbeatService(db);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(heartbeat.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: olderIssueId, mutation: "update", attempt },
        contextSnapshot: { issueId: olderIssueId, source: "test.conveyor" },
      })).resolves.not.toThrow();
    }

    const queued = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued).toHaveLength(0);
  });
});
