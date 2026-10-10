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
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

type AdapterResult = Record<string, unknown>;

const MINUTE_MS = 60_000;

// What claude_local returns when the turn succeeded but a background task it
// started kept the process alive and Paperclip stopped it (ssh exit 255).
function backgroundStopResult(): AdapterResult {
  return {
    exitCode: 255,
    signal: null,
    timedOut: false,
    errorMessage:
      "Claude finished its turn successfully, but a background task it started was still running, so Paperclip stopped the process (exit code 255).",
    errorCode: "unmanaged_background_task_stopped",
    summary: "Opened the PR and started watching CI.",
    provider: "test",
    model: "test-model",
    resultJson: {
      result: "Opened the PR and started watching CI.",
      unmanagedBackgroundTask: {
        kind: "terminal_result_cleanup",
        stopped: true,
        stopReason: "unmanaged_background_task_stopped",
        reason: "unmanaged background task stopped; no durable live path",
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      },
    },
  };
}

type AdapterContext = { runId: string; agent: { id: string; companyId: string } };

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterContext): Promise<Record<string, unknown>> => ({})),
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
    `Skipping embedded Postgres background task re-check tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat background task re-check", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-background-recheck-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    mockAdapterExecute.mockReset();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) {
      await heartbeat.cancelRun(run.id, "Background re-check fixture teardown", { suppressImmediateRecovery: true });
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueRecoveryActions);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { runtimeConfig?: Record<string, unknown> } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [id, name] of [[agentId, "Coder"], [otherAgentId, "Other"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
          ...(input.runtimeConfig ?? {}),
        },
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the fix and wait for CI",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, otherAgentId, issueId };
  }

  async function seedFlaggedRun(input: { companyId: string; agentId: string; issueId: string; minutesAgo: number }) {
    const at = new Date(Date.now() - input.minutesAgo * MINUTE_MS);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: at,
      startedAt: at,
      finishedAt: new Date(at.getTime() + 1_000),
      resultJson: { backgroundTaskStopped: true, stopReason: "unmanaged_background_task_stopped" },
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_monitor_due" },
    });
  }

  // A real agent leaves a progress comment on its issue during the turn, which
  // satisfies the issue comment policy (otherwise a missing-comment retry runs).
  function agentTurn(issueId: string, result: () => AdapterResult, during?: () => Promise<void>) {
    return async (ctx: AdapterContext) => {
      await db.insert(issueComments).values({
        companyId: ctx.agent.companyId,
        issueId,
        authorAgentId: ctx.agent.id,
        createdByRunId: ctx.runId,
        body: "Opened the PR; CI is running.",
      });
      await during?.();
      return result();
    };
  }

  async function runOnce(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then((rows) => rows[0]!);
  }

  async function loadIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function countRuns(agentId: string) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function pendingWakes(agentId: string) {
    return db
      .select({ id: agentWakeupRequests.id, reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        sql`${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution', 'claimed')`,
      ));
  }

  async function stopActivity(issueId: string) {
    return db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.run_background_task_stopped")))
      .then((rows) => rows[0]?.details as Record<string, unknown> | undefined);
  }

  it("records a successful turn stopped for a background task as succeeded and schedules a re-check", async () => {
    const { agentId, issueId } = await seed();
    mockAdapterExecute.mockImplementation(agentTurn(issueId, backgroundStopResult));

    const startedAt = Date.now();
    const run = await runOnce(agentId, issueId);

    expect(run.status).toBe("succeeded");
    expect(run.errorCode).toBeNull();
    expect(run.error).toBeNull();
    expect(run.exitCode).toBe(255);
    expect(run.resultJson).toMatchObject({
      backgroundTaskStopped: true,
      stopReason: "unmanaged_background_task_stopped",
    });

    const issue = await loadIssue(issueId);
    // The issue keeps its working status; the wait is a scheduled re-check.
    expect(issue.status).toBe("in_progress");
    expect(issue.assigneeAgentId).toBe(agentId);
    expect(issue.monitorNextCheckAt).not.toBeNull();
    const delayMs = issue.monitorNextCheckAt!.getTime() - startedAt;
    expect(delayMs).toBeGreaterThanOrEqual(5 * MINUTE_MS - 1_000);
    expect(delayMs).toBeLessThan(6 * MINUTE_MS);
    expect(issue.monitorNotes).toContain("re-check after background task stop");
    expect((issue.executionPolicy as Record<string, any>)?.monitor).toMatchObject({
      serviceName: "Background task re-check",
      externalRef: run.id,
    });

    // Not re-run immediately: one run, no follow-up wake, the agent is not in error.
    expect(await countRuns(agentId)).toBe(1);
    expect(await pendingWakes(agentId)).toEqual([]);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect(agent.status).toBe("idle");
    expect(await stopActivity(issueId)).toMatchObject({
      runId: run.id,
      exitCode: 255,
      recheck: { scheduled: true, attempt: 1 },
    });
  });

  it("does not re-run the agent to force a missing comment while the re-check wait is pending", async () => {
    const { agentId, issueId } = await seed();
    // This turn posts no issue comment.
    mockAdapterExecute.mockImplementation(async () => backgroundStopResult());

    const run = await runOnce(agentId, issueId);

    expect(run.status).toBe("succeeded");
    expect((await loadIssue(issueId)).monitorNextCheckAt).not.toBeNull();
    expect(await countRuns(agentId)).toBe(1);
    expect(await pendingWakes(agentId)).toEqual([]);
  });

  it("leaves the waiting issue alone when the stranded-issue reconciler runs", async () => {
    const { agentId, issueId } = await seed();
    mockAdapterExecute.mockImplementation(agentTurn(issueId, backgroundStopResult));
    await runOnce(agentId, issueId);
    const before = await loadIssue(issueId);

    await heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const after = await loadIssue(issueId);
    expect(after.status).toBe("in_progress");
    expect(after.monitorNextCheckAt?.toISOString()).toBe(before.monitorNextCheckAt?.toISOString());
    expect(await countRuns(agentId)).toBe(1);
    expect(await pendingWakes(agentId)).toEqual([]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);
  });

  it("backs off to 20 minutes on the third consecutive stop and stops scheduling after the cap", async () => {
    const { companyId, agentId, issueId } = await seed();
    await seedFlaggedRun({ companyId, agentId, issueId, minutesAgo: 30 });
    await seedFlaggedRun({ companyId, agentId, issueId, minutesAgo: 20 });
    mockAdapterExecute.mockImplementation(agentTurn(issueId, backgroundStopResult));

    const startedAt = Date.now();
    await runOnce(agentId, issueId);
    const third = await loadIssue(issueId);
    const delayMs = third.monitorNextCheckAt!.getTime() - startedAt;
    expect(delayMs).toBeGreaterThanOrEqual(20 * MINUTE_MS - 1_000);
    expect(delayMs).toBeLessThan(21 * MINUTE_MS);

    // Fourth consecutive stop: the cap (3) is reached, so no new wait.
    await db.update(issues).set({ monitorNextCheckAt: null, executionPolicy: null }).where(eq(issues.id, issueId));
    await runOnce(agentId, issueId);
    const fourth = await loadIssue(issueId);
    expect(fourth.monitorNextCheckAt).toBeNull();
    const activities = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.run_background_task_stopped")));
    expect(activities.map((row) => (row.details as Record<string, any>).recheck)).toContainEqual({
      scheduled: false,
      reason: "max_attempts_exhausted",
    });
  });

  it("honours a configured backoff", async () => {
    const { agentId, issueId } = await seed({
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, backgroundTaskRecheck: { delaysSec: [120] } } },
    });
    mockAdapterExecute.mockImplementation(agentTurn(issueId, backgroundStopResult));
    const startedAt = Date.now();
    await runOnce(agentId, issueId);
    const delayMs = (await loadIssue(issueId)).monitorNextCheckAt!.getTime() - startedAt;
    expect(delayMs).toBeGreaterThanOrEqual(2 * MINUTE_MS - 1_000);
    expect(delayMs).toBeLessThan(3 * MINUTE_MS);
  });

  it.each([
    ["blocked", { status: "blocked" }],
    ["done", { status: "done" }],
    ["reassigned", "reassign"],
  ] as const)("does not schedule a re-check when the issue became %s during the run", async (_label, change) => {
    const { agentId, otherAgentId, issueId } = await seed();
    mockAdapterExecute.mockImplementation(agentTurn(issueId, backgroundStopResult, async () => {
      await db
        .update(issues)
        .set(change === "reassign" ? { assigneeAgentId: otherAgentId } : change)
        .where(eq(issues.id, issueId));
    }));

    const run = await runOnce(agentId, issueId);
    expect(run.status).toBe("succeeded");
    const issue = await loadIssue(issueId);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect((await stopActivity(issueId))?.recheck).toMatchObject({ scheduled: false });
  });

  it("keeps a wait the agent scheduled itself", async () => {
    const { agentId, issueId } = await seed();
    const agentWaitAt = new Date(Date.now() + 45 * MINUTE_MS);
    mockAdapterExecute.mockImplementation(agentTurn(issueId, backgroundStopResult, async () => {
      await db
        .update(issues)
        .set({
          monitorNextCheckAt: agentWaitAt,
          monitorNotes: "CI on PR #4320",
          executionPolicy: {
            mode: "normal",
            commentRequired: true,
            stages: [],
            monitor: { nextCheckAt: agentWaitAt.toISOString(), notes: "CI on PR #4320", scheduledBy: "assignee" },
          },
        })
        .where(eq(issues.id, issueId));
    }));

    await runOnce(agentId, issueId);
    const issue = await loadIssue(issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe(agentWaitAt.toISOString());
    expect(issue.monitorNotes).toBe("CI on PR #4320");
    expect((await stopActivity(issueId))?.recheck).toEqual({ scheduled: false, reason: "wait_already_scheduled" });
  });

  it("keeps today's failed classification for a real failure", async () => {
    const { agentId, issueId } = await seed();
    mockAdapterExecute.mockImplementation(agentTurn(issueId, () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude exited with code 1",
      errorCode: "adapter_failed",
      provider: "test",
      model: "test-model",
    })));

    const run = await runOnce(agentId, issueId);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("adapter_failed");
    expect((run.resultJson as Record<string, unknown> | null)?.backgroundTaskStopped).toBeUndefined();
    expect((await loadIssue(issueId)).monitorNextCheckAt).toBeNull();
    expect(await stopActivity(issueId)).toBeUndefined();
  });
});
