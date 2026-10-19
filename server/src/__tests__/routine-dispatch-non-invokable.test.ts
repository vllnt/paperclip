/**
 * A routine whose assignee cannot be invoked (a paused agent is assignable but
 * not invokable). The dispatch used to commit the routine issue, let the wake
 * fail with "Agent is not invokable", then delete the issue. A recovery sweep
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
  companies,
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

  it("creates no issue and records the failed dispatch when the assignee is paused", async () => {
    const { companyId, routine, svc, wakeAttempts } = await seed("paused");
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
      failureReason: NOT_INVOKABLE,
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
