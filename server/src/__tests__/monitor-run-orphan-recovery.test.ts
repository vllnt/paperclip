/**
 * Needs embedded Postgres, so it cannot join the fixed `vitest run` list in the
 * Dockerfile (that list runs inside the production image build). Run it with
 * `cd server && npx vitest run src/__tests__/monitor-run-orphan-recovery.test.ts`.
 *
 * A legacy run that a restart orphaned may have had side effects, so recovery
 * holds the issue behind one board-owned reconciliation action and replays
 * nothing. These tests pin that hold: it must stay one stable action while the
 * condition holds, and it must end once when the condition really clears.
 */
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
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
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.ts";

/** A re-queued run blocks here, so it stays the one live run until teardown. */
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
    `Skipping embedded Postgres monitor-run orphan recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** A pid this large never maps to a live process, so the run reads as lost. */
const DEAD_PID = 2_000_000_000;
const PASSES = 10;

describeEmbeddedPostgres("a run lost to a restart is held once and stays held", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-monitor-orphan-");
    db = createDb(tempDb.connectionString);
  }, 240_000);

  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    adapterGate.open();
    await heartbeat.drainActiveRunExecutions();
    adapterGate.reset();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds an in_progress issue whose last run is "running" with a dead process
   * and no live handle, as after a deploy restart. `wakeReason` is the wake that
   * started the run. A monitor wake has already consumed the one-shot monitor
   * (`monitorNextCheckAt` is null), as the dispatcher does when it fires.
   * `claudeLocal` records the adapter the server claimed for the run, which is
   * what production runs carry.
   */
  async function seedLostRun(input: {
    wakeReason: string;
    agentStatus?: "idle" | "paused";
    lostBeforeProviderWork?: boolean;
    claudeLocal?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const startedAt = new Date(Date.now() - 20 * 60_000);
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Waiter", role: "engineer", status: input.agentStatus ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "running", startedAt, updatedAt: startedAt, processPid: DEAD_PID,
      ...(input.claudeLocal ? { runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } } : {}),
      ...(input.lostBeforeProviderWork
        ? { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }
        : {}),
      contextSnapshot: { issueId, wakeReason: input.wakeReason },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Watch external deploy", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1`,
      monitorNextCheckAt: null, monitorAttemptCount: 3, monitorLastTriggeredAt: startedAt,
      monitorNotes: "Check deploy", monitorScheduledBy: "assignee",
      checkoutRunId: runId, executionRunId: runId, executionLockedAt: startedAt,
      createdAt: startedAt, updatedAt: startedAt,
    });
    return { companyId, agentId, issueId, runId };
  }

  /**
   * One periodic recovery pass, in the server's order. The stale-lock sweep
   * runs first, as it did for the production runs (they ended as
   * `orphaned_running_run`, not `process_lost`).
   */
  async function periodicPass() {
    const heartbeat = heartbeatService(db);
    await heartbeat.sweepStaleIssueLocks();
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60_000 });
    await heartbeat.reconcileStrandedAssignedIssues();
    await settleUnrecoverableExecutions(db);
  }

  async function loadActions(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  async function otherRuns(issueId: string, lostRunId: string) {
    return db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`, ne(heartbeatRuns.id, lostRunId)));
  }

  async function activityCount(issueId: string, action: string) {
    const rows = await db.select({ id: activityLog.id }).from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
    return rows.length;
  }

  it.each(["issue_monitor_due", "issue_assigned"])(
    `keeps exactly one active board action across ${PASSES} repeated passes for a %s run lost to a restart`,
    async (wakeReason) => {
      const { issueId, runId } = await seedLostRun({ wakeReason, claudeLocal: true });

      for (let pass = 0; pass < PASSES; pass += 1) await periodicPass();

      const actions = await loadActions(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        status: "active",
        ownerType: "board",
        kind: "active_run_watchdog",
        cause: "legacy_execution_requires_reconciliation",
      });
      expect(await activityCount(issueId, "issue.execution_recovery_settled")).toBe(0);
      expect(await otherRuns(issueId, runId)).toHaveLength(0);
    },
  );

  it("ends the hold once, and does not recreate it, when the board resolves it", async () => {
    const { issueId, runId } = await seedLostRun({ wakeReason: "issue_monitor_due", claudeLocal: true });
    await periodicPass();
    const [held] = await loadActions(issueId);
    expect(held?.status).toBe("active");

    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "restored", resolvedAt: new Date(),
      evidence: { ...held!.evidence, executionReconciliation: { runId } },
    }).where(eq(issueRecoveryActions.id, held!.id));
    for (let pass = 0; pass < PASSES; pass += 1) await periodicPass();

    const actions = await loadActions(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "resolved", outcome: "restored" });
  });

  it("ends the hold once, and does not recreate it, when the issue is done", async () => {
    const { issueId } = await seedLostRun({ wakeReason: "issue_monitor_due", claudeLocal: true });
    await periodicPass();
    expect((await loadActions(issueId))[0]?.status).toBe("active");

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
    for (let pass = 0; pass < PASSES; pass += 1) await periodicPass();

    const actions = await loadActions(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "resolved", outcome: "restored", resolutionNote: "source_terminal" });
  });

  it("does not wake a paused agent, and still holds the issue once", async () => {
    const { issueId, runId } = await seedLostRun({
      wakeReason: "issue_monitor_due", agentStatus: "paused", claudeLocal: true,
    });

    for (let pass = 0; pass < PASSES; pass += 1) await periodicPass();

    expect(await otherRuns(issueId, runId)).toHaveLength(0);
    expect((await loadActions(issueId)).filter((action) => action.status === "active")).toHaveLength(1);
  });

  it.each(["issue_assigned", "issue_monitor_due"])(
    "still re-queues exactly one run for a %s run lost before provider work started (retry unchanged)",
    async (wakeReason) => {
      const { issueId, runId } = await seedLostRun({ wakeReason, lostBeforeProviderWork: true });

      await periodicPass();

      expect(await otherRuns(issueId, runId)).toHaveLength(1);
      expect(await loadActions(issueId)).toHaveLength(0);
    },
  );
});
