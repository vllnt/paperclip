/**
 * A routine whose assignee the wake refuses: a paused agent (assignable but not
 * invokable) or an agent over its budget hard-stop. The dispatch used to commit
 * the routine issue, let the wake fail, then delete the issue. A recovery sweep
 * that read the issue in between then failed its recovery-action insert with an
 * FK violation. Uses the real heartbeat wake and the real stranded-issue sweep.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/** Holds the next invokability check until released: lets a test stop a sweep between its read and its write. */
const invokabilityGate = vi.hoisted(() => ({
  armed: null as null | { entered: () => void; release: Promise<void> },
}));

vi.mock("../services/agent-invokability.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-invokability.ts")>(
    "../services/agent-invokability.ts",
  );
  return {
    ...actual,
    evaluateAgentInvokabilityFromDb: async (...args: Parameters<typeof actual.evaluateAgentInvokabilityFromDb>) => {
      const result = await actual.evaluateAgentInvokabilityFromDb(...args);
      const gate = invokabilityGate.armed;
      if (gate) {
        invokabilityGate.armed = null;
        gate.entered();
        await gate.release;
      }
      return result;
    },
  };
});

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
}));

import { heartbeatService } from "../services/heartbeat.ts";
import { routineService } from "../services/routines.ts";

const NOT_INVOKABLE = "Agent is not invokable in its current state";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine dispatch to an assignee that cannot be invoked", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-non-invokable-");
    db = createDb(tempDb.connectionString);
  }, 240_000);

  afterEach(async () => {
    invokabilityGate.armed = null;
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(agentStatus: "paused" | "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: agentStatus,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Routines", status: "in_progress" });

    const heartbeat = heartbeatService(db);
    const wakeAttempts: string[] = [];
    let beforeWake: (() => Promise<void>) | null = null;
    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeAgentId, opts) => {
          wakeAttempts.push(String(opts.payload?.issueId ?? ""));
          if (beforeWake) await beforeWake();
          return heartbeat.wakeup(wakeAgentId, opts);
        },
      },
    });
    const routine = await svc.create(companyId, {
      projectId,
      goalId: null,
      parentIssueId: null,
      title: "nightly report",
      description: "Run the report",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }, {});
    return {
      companyId,
      agentId,
      heartbeat,
      routine,
      svc,
      wakeAttempts,
      setBeforeWake: (hook: () => Promise<void>) => { beforeWake = hook; },
    };
  }

  /** Fires one scheduled dispatch and checks it failed with `reason`, created no issue, and was audited as usual. */
  async function expectScheduledDispatchFailsWithoutIssue(
    { companyId, routine, svc, wakeAttempts }: Awaited<ReturnType<typeof seed>>,
    reason: string,
  ) {
    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    await db.update(routineTriggers)
      .set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));

    await svc.tickScheduledTriggers(new Date());

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      source: "schedule",
      status: "failed",
      failureReason: reason,
      linkedIssueId: null,
    });
    expect(runs[0]?.completedAt).not.toBeNull();

    // No issue was created at all: no wake was attempted and no identifier was spent.
    expect(wakeAttempts).toEqual([]);
    const [company] = await db.select({ issueCounter: companies.issueCounter }).from(companies)
      .where(eq(companies.id, companyId));
    expect(company?.issueCounter).toBe(0);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).toEqual([]);

    // Same audit row as any failed scheduled dispatch.
    const audit = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "routine_run"),
    ));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "routine.run_triggered",
      actorType: "system",
      actorId: "routine-scheduler",
      entityId: runs[0]!.id,
      details: expect.objectContaining({ routineId: routine.id, source: "schedule", status: "failed" }),
    });
  }

  it("creates no issue and records the failed dispatch when the assignee is paused", async () => {
    await expectScheduledDispatchFailsWithoutIssue(await seed("paused"), NOT_INVOKABLE);
  });

  it("creates no issue and records the failed dispatch when the assignee is over its budget hard-stop", async () => {
    const fixture = await seed("idle");
    await db.insert(budgetPolicies).values({
      companyId: fixture.companyId,
      scopeType: "agent",
      scopeId: fixture.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    await expectScheduledDispatchFailsWithoutIssue(fixture, "Agent cannot start because its budget hard-stop is still exceeded.");
  });

  // The wake skips its budget and invokability checks, and keeps the issue, for an inactive
  // company or while scheduling is suppressed. The dispatch must keep that outcome.
  it.each([
    ["the company is paused", "idle"],
    ["the company is paused and the assignee is paused", "paused"],
    ["scheduling is suppressed and the assignee is paused", "paused"],
  ] as const)("keeps the created issue, as the wake does, when %s", async (situation, agentStatus) => {
    const { companyId, routine, svc, wakeAttempts } = await seed(agentStatus);
    const suppressed = situation.startsWith("scheduling");
    if (suppressed) process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    else await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));

    let run: Awaited<ReturnType<typeof svc.runRoutine>>;
    try {
      run = await svc.runRoutine(routine.id, { source: "manual" });
    } finally {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    }

    expect(run).toMatchObject({ status: "issue_created", failureReason: null });
    expect(wakeAttempts).toHaveLength(1);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId)))
      .toEqual([{ id: run.linkedIssueId }]);
  });

  it("a failed wake leaves no orphan issue and no FK error in a recovery sweep that read the issue", async () => {
    const { companyId, agentId, heartbeat, routine, svc, wakeAttempts, setBeforeWake } = await seed("idle");
    let sweep: Promise<Awaited<ReturnType<typeof heartbeat.reconcileStrandedAssignedIssues>>> | null = null;
    let sweepReadTheIssue = false;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });

    // The agent is paused while the dispatch runs, and a recovery sweep reads the
    // new issue before the wake fails and the dispatch removes it again.
    setBeforeWake(async () => {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      const entered = new Promise<void>((resolve) => {
        invokabilityGate.armed = { entered: resolve, release: released };
      });
      sweep = heartbeat.reconcileStrandedAssignedIssues();
      await Promise.race([entered.then(() => { sweepReadTheIssue = true; }), sweep]);
    });

    let run: Awaited<ReturnType<typeof svc.runRoutine>>;
    try {
      run = await svc.runRoutine(routine.id, { source: "manual" });
    } finally {
      release();
    }
    const result = await sweep!;

    expect(run).toMatchObject({ status: "failed", failureReason: NOT_INVOKABLE, linkedIssueId: null });
    expect(wakeAttempts).toHaveLength(1);
    expect(sweepReadTheIssue).toBe(true);
    // The sweep reached its recovery-action insert after the issue was gone: it skips, it does not fail.
    expect(result.failed).toBe(0);
    expect(result.escalated).toBe(0);

    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).toEqual([]);
    expect(
      await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(inArray(issueRecoveryActions.sourceIssueId, wakeAttempts)),
    ).toEqual([]);
  });
});
