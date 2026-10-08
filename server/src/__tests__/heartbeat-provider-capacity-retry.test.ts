import { randomUUID } from "node:crypto";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
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
import { buildIssueAssignmentIdempotencyKey } from "../services/issue-assignment-wakeup.js";
import {
  computeProviderQuotaRetrySchedule,
  heartbeatService,
} from "../services/heartbeat.ts";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping provider capacity retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
const MINUTE_MS = 60_000;

type ScriptedOutcome =
  | { kind: "capacity"; usefulComment?: boolean; outputTokens?: number }
  | { kind: "transient" }
  | { kind: "success" };

describe("computeProviderQuotaRetrySchedule", () => {
  const policy = { maxAttempts: 8, windowMs: 120 * MINUTE_MS, maxDailyUncountedRuns: 48 };
  const now = new Date("2026-10-08T12:00:00.000Z");

  it("backs off exponentially from one minute and caps each delay at thirty minutes", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      computeProviderQuotaRetrySchedule({ attempt, now, chainStartedAt: now, policy, random: () => 0.5 })?.baseDelayMs);
    expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30].map((minutes) => minutes * MINUTE_MS));
  });

  it("jitters each delay by at most twenty percent", () => {
    const low = computeProviderQuotaRetrySchedule({ attempt: 3, now, chainStartedAt: now, policy, random: () => 0 });
    const high = computeProviderQuotaRetrySchedule({ attempt: 3, now, chainStartedAt: now, policy, random: () => 1 });
    expect(low).toMatchObject({ phase: "backoff", baseDelayMs: 4 * MINUTE_MS, delayMs: 3.2 * MINUTE_MS });
    expect(high).toMatchObject({ phase: "backoff", baseDelayMs: 4 * MINUTE_MS, delayMs: 4.8 * MINUTE_MS });
  });

  it("drops to the hourly recovery cadence after the window or the attempt budget", () => {
    const pastWindow = computeProviderQuotaRetrySchedule({
      attempt: 2, now, chainStartedAt: new Date(now.getTime() - 119 * MINUTE_MS), policy, random: () => 0.5,
    });
    expect(pastWindow).toMatchObject({ phase: "slow", baseDelayMs: 60 * MINUTE_MS });
    expect(pastWindow?.dueAt.toISOString()).toBe(new Date(now.getTime() + 60 * MINUTE_MS).toISOString());
    const pastAttempts = computeProviderQuotaRetrySchedule({ attempt: 9, now, chainStartedAt: now, policy, random: () => 0.5 });
    expect(pastAttempts).toMatchObject({ phase: "slow", baseDelayMs: 60 * MINUTE_MS });
  });
});

describeEmbeddedPostgres("provider capacity retries", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let script: ScriptedOutcome[] = [];
  const executedRunIds: string[] = [];

  async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    executedRunIds.push(ctx.runId);
    const outcome = script.shift() ?? { kind: "success" };
    if (outcome.kind === "success") {
      return { exitCode: 0, signal: null, timedOut: false, provider: "openai", model: "gpt-test", summary: "Done." };
    }
    if (outcome.kind === "transient") {
      return {
        exitCode: 1, signal: null, timedOut: false, provider: "openai", model: "gpt-test",
        errorMessage: "We're currently experiencing high demand.",
        errorCode: "codex_transient_upstream", errorFamily: "transient_upstream",
        // An adapter cannot exempt its own runs from the cap.
        resultJson: {
          stderr: "We're currently experiencing high demand.", errorFamily: "transient_upstream",
          providerQuotaBeforeUsefulAction: true,
        },
      };
    }
    if (outcome.usefulComment) {
      const issueId = String(ctx.context.issueId);
      const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
      await db.insert(issueComments).values({
        companyId: issue!.companyId, issueId, authorAgentId: ctx.agent.id, authorType: "agent",
        createdByRunId: ctx.runId, body: "Progress: drafted the delivery plan.",
      });
    }
    return {
      exitCode: 1, signal: null, timedOut: false, provider: "openai", model: "gpt-test",
      errorMessage: CAPACITY_MESSAGE, errorCode: "provider_quota", errorFamily: "provider_quota",
      ...(outcome.outputTokens ? { usage: { inputTokens: 900, outputTokens: outcome.outputTokens } } : {}),
      resultJson: { stdout: "", stderr: CAPACITY_MESSAGE, errorFamily: "provider_quota" },
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-capacity-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date(0).toISOString(),
      }),
    });
  }, 20_000);

  beforeEach(async () => {
    // maxDailyRuns uses the UTC day. Keep each test inside one day.
    const msToUtcMidnight = 86_400_000 - (Date.now() % 86_400_000);
    if (msToUtcMidnight < 30_000) await new Promise((resolve) => setTimeout(resolve, msToUtcMidnight + 1_000));
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.restoreAllMocks();
    script = [];
    executedRunIds.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "heartbeat_run_events", "issue_comments", "issues",
        "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "environment_leases",
        "agents", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter("codex_local");
    await tempDb?.cleanup();
  });

  async function seed(heartbeatConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Capacity", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Codex", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, ...heartbeatConfig } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Deliver the report", status: "todo", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId,
      issueNumber: 1, identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  async function assign(agentId: string, issueId: string) {
    const [issue] = await db.select({ statusVersion: issues.statusVersion }).from(issues).where(eq(issues.id, issueId));
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      idempotencyKey: buildIssueAssignmentIdempotencyKey({
        issueId, assigneeAgentId: agentId, assignmentGeneration: issue!.statusVersion,
      }),
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return run;
  }

  async function companyRuns(companyId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(asc(heartbeatRuns.createdAt));
  }

  async function pendingRetry(companyId: string) {
    return db.select().from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        eq(heartbeatRuns.scheduledRetryReason, "transient_failure"),
      ))
      .then((rows) => rows[0] ?? null);
  }

  /** Promote the pending retry at its due time and run it to completion. */
  async function runPendingRetry(companyId: string) {
    const retry = await pendingRetry(companyId);
    if (!retry?.scheduledRetryAt) throw new Error("expected a scheduled retry");
    const promotion = await heartbeat.promoteDueScheduledRetries(retry.scheduledRetryAt);
    expect(promotion.runIds).toContain(retry.id);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return heartbeat.getRun(retry.id);
  }

  async function scheduledRetryEvent(runId: string) {
    return db.select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), sql`${heartbeatRunEvents.payload} ->> 'retryRunId' is not null`))
      .then((rows) => rows[0] ?? null);
  }

  it("retries a capacity failure with growing jittered backoff until the provider recovers", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { companyId, agentId, issueId } = await seed();
    script = [{ kind: "capacity" }, { kind: "capacity" }, { kind: "capacity" }, { kind: "success" }];

    await assign(agentId, issueId);
    const delays: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = (await companyRuns(companyId)).filter((run) => run.status === "failed").at(-1)!;
      expect(failed).toMatchObject({ errorCode: "provider_quota" });
      expect(failed.resultJson).toMatchObject({ providerQuotaBeforeUsefulAction: true });
      delays.push((await scheduledRetryEvent(failed.id))?.payload?.delayMs);
      const retried = await runPendingRetry(companyId);
      expect(retried?.status).toBe(attempt < 3 ? "failed" : "succeeded");
    }

    // 1, 2 and 4 minutes: past the old fixed budget of two 30-second retries.
    expect(delays).toEqual([1 * MINUTE_MS, 2 * MINUTE_MS, 4 * MINUTE_MS]);
    const chain = (await companyRuns(companyId)).slice(0, 4);
    expect(chain.map((run) => run.status)).toEqual(["failed", "failed", "failed", "succeeded"]);
    expect(executedRunIds.slice(0, 4)).toEqual(chain.map((run) => run.id));
    expect(await pendingRetry(companyId)).toBeNull();
    // The retry chain never re-enters the assignment path guarded by
    // agent_wakeup_requests_issue_assignment_idempotency_uq.
    const assignmentReceipts = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), like(agentWakeupRequests.idempotencyKey, "issue-assignment:%")));
    expect(assignmentReceipts).toHaveLength(1);
  });

  it("does not charge capacity failures before any useful action to maxDailyRuns", async () => {
    const { companyId, agentId, issueId } = await seed({ maxDailyRuns: 1 });
    script = [{ kind: "capacity" }, { kind: "capacity" }, { kind: "success" }];

    await assign(agentId, issueId);
    expect((await runPendingRetry(companyId))?.status).toBe("failed");
    expect((await runPendingRetry(companyId))?.status).toBe("succeeded");

    // The one successful run still spends the whole cap.
    const blocked = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual_check",
      payload: {}, requestedByActorType: "system",
    });
    expect(blocked).toBeNull();
    const [skipped] = await db.select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "skipped")));
    expect(skipped).toMatchObject({ reason: "heartbeat.daily_run_limit" });
  });

  it("bounds a permanent outage: past the daily allowance failures count toward the cap again", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { companyId, agentId, issueId } = await seed({
      maxDailyRuns: 1,
      providerQuotaRetry: { maxDailyUncountedRuns: 2 },
    });
    script = Array.from({ length: 10 }, () => ({ kind: "capacity" as const }));

    await assign(agentId, issueId);
    expect((await runPendingRetry(companyId))?.status).toBe("failed");
    expect((await runPendingRetry(companyId))?.status).toBe("failed");

    // The third failure passes the allowance of two: the alarm fires once and
    // the failure counts, so the cap cancels the next retry before the adapter.
    const alarms = await db.select({ entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "heartbeat.provider_quota_cap_exemption_exhausted")));
    expect(alarms).toEqual([{ entityId: agentId, details: expect.objectContaining({ limit: 2, observed: 3 }) }]);
    expect(await runPendingRetry(companyId)).toMatchObject({
      status: "cancelled", errorCode: "heartbeat.daily_run_limit",
    });
    expect(executedRunIds).toHaveLength(3);
    expect(await pendingRetry(companyId)).toBeNull();
  });

  it("lets the hourly quota monitor re-dispatch a chain the default budget would have abandoned", async () => {
    const { companyId, agentId, issueId } = await seed();
    const sourceRunId = randomUUID();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "failed", errorCode: "provider_quota", error: CAPACITY_MESSAGE,
      startedAt: new Date(), finishedAt: new Date(),
      scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure",
      resultJson: {
        errorFamily: "provider_quota", providerQuotaBeforeUsefulAction: true,
        conversationContinuation: "continue_conversation_v1",
      },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "transient_failure_retry" },
    });

    // The reconciler arms the hourly provider-quota monitor for the issue.
    await heartbeat.reconcileStrandedAssignedIssues();
    const [armed] = await db.select({ monitorNextCheckAt: issues.monitorNextCheckAt }).from(issues).where(eq(issues.id, issueId));
    expect(armed?.monitorNextCheckAt).toBeTruthy();

    await heartbeat.tickTimers(new Date(armed!.monitorNextCheckAt!.getTime() + 1_000));
    // Two retries are spent; the default budget would return retry_exhausted.
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(successor).toMatchObject({
      status: "scheduled_retry", scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 3,
    });
  });

  it("keeps probing at the slower recovery cadence after the backoff window", async () => {
    const { companyId, agentId, issueId } = await seed();
    const chainStartedAt = new Date(Date.now() - 3 * 60 * MINUTE_MS);
    const failedRunId = randomUUID();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: failedRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "failed", errorCode: "provider_quota", error: CAPACITY_MESSAGE,
      startedAt: new Date(chainStartedAt.getTime() + 30 * MINUTE_MS), finishedAt: new Date(),
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      resultJson: {
        errorFamily: "provider_quota", providerQuotaBeforeUsefulAction: true,
        conversationContinuation: "continue_conversation_v1",
      },
      contextSnapshot: {
        issueId, taskId: issueId, wakeReason: "transient_failure_retry",
        providerQuotaRetryStartedAt: chainStartedAt.toISOString(),
      },
    });

    const now = new Date();
    const scheduled = await heartbeat.scheduleBoundedRetry(failedRunId, { now, random: () => 0.5 });
    expect(scheduled).toMatchObject({ outcome: "scheduled", attempt: 2 });
    if (scheduled.outcome !== "scheduled") return;
    // Attempt 2 is inside the attempt budget, but the two-hour window that
    // started with the first failure has passed.
    expect(scheduled.dueAt.getTime() - now.getTime()).toBe(60 * MINUTE_MS);
    expect(scheduled.run.contextSnapshot).toMatchObject({
      providerQuotaRetryStartedAt: chainStartedAt.toISOString(),
    });
  });

  it("leaves non-capacity failures on the existing retry budget and run cap", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { companyId, agentId, issueId } = await seed({ maxDailyRuns: 3 });
    script = [{ kind: "transient" }, { kind: "transient" }, { kind: "transient" }];

    await assign(agentId, issueId);
    expect((await runPendingRetry(companyId))?.status).toBe("failed");
    expect((await runPendingRetry(companyId))?.status).toBe("failed");
    const failed = (await companyRuns(companyId)).filter((run) => run.status === "failed");
    expect(failed).toHaveLength(3);
    for (const run of failed) expect(run.resultJson).not.toHaveProperty("providerQuotaBeforeUsefulAction");
    expect((await scheduledRetryEvent(failed[0]!.id))?.payload).toMatchObject({ delayMs: 30_000, baseDelayMs: 30_000 });
    expect((await scheduledRetryEvent(failed[1]!.id))?.payload).toMatchObject({ delayMs: 30_000, baseDelayMs: 30_000 });
    // The two-attempt budget is spent and all three failures count toward the cap.
    expect(await pendingRetry(companyId)).toBeNull();
    expect(await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual_check", payload: {}, requestedByActorType: "system",
    })).toBeNull();
  });

  it.each([
    ["an issue comment", { usefulComment: true }],
    ["model output tokens", { outputTokens: 120 }],
  ] as const)("treats a capacity failure after %s as an ordinary failed run", async (_label, useful) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { companyId, agentId, issueId } = await seed({ maxDailyRuns: 2 });
    script = [{ kind: "capacity", ...useful }, { kind: "capacity", ...useful }, { kind: "success" }];

    await assign(agentId, issueId);
    const [first] = await companyRuns(companyId);
    expect(first).toMatchObject({ status: "failed", errorCode: "provider_quota" });
    expect(first!.resultJson).not.toHaveProperty("providerQuotaBeforeUsefulAction");
    expect((await scheduledRetryEvent(first!.id))?.payload).toMatchObject({ delayMs: 30_000 });
    expect((await runPendingRetry(companyId))?.status).toBe("failed");
    expect(await runPendingRetry(companyId)).toMatchObject({
      status: "cancelled", errorCode: "heartbeat.daily_run_limit",
    });
  });

  it("restores the default budget and cap when providerQuotaRetry is disabled", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { companyId, agentId, issueId } = await seed({ maxDailyRuns: 1, providerQuotaRetry: { enabled: false } });
    script = [{ kind: "capacity" }, { kind: "success" }];

    await assign(agentId, issueId);
    const [first] = await companyRuns(companyId);
    expect((await scheduledRetryEvent(first!.id))?.payload).toMatchObject({ delayMs: 30_000 });
    expect(await runPendingRetry(companyId)).toMatchObject({
      status: "cancelled", errorCode: "heartbeat.daily_run_limit",
    });
  });
});
