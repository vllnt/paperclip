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
import { and, eq } from "drizzle-orm";
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
