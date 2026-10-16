import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type { RoutineNoopSkipSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveRoutineNoopSkip, ROUTINE_RUN_UNCHANGED_SKIP_REASON } from "../services/routine-noop-skip.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("resolveRoutineNoopSkip", () => {
  const on: RoutineNoopSkipSettings = { skipUnchanged: true };
  const off: RoutineNoopSkipSettings = { skipUnchanged: false };

  it("is off when nothing is set", () => {
    expect(resolveRoutineNoopSkip({ source: "schedule" })).toBe(false);
    expect(resolveRoutineNoopSkip({ source: "schedule", company: {}, agent: {}, routine: {} })).toBe(false);
  });

  it("lets the most specific level win: company < agent < routine", () => {
    expect(resolveRoutineNoopSkip({ source: "api", company: on })).toBe(true);
    expect(resolveRoutineNoopSkip({ source: "api", company: on, agent: off })).toBe(false);
    expect(resolveRoutineNoopSkip({ source: "api", company: off, agent: off, routine: on })).toBe(true);
  });

  it("lets a wake-type value beat the level-wide value of every level", () => {
    expect(resolveRoutineNoopSkip({ source: "api", routine: { skipUnchanged: true }, company: { bySource: { api: false } } })).toBe(false);
    expect(resolveRoutineNoopSkip({ source: "schedule", routine: { skipUnchanged: false, bySource: { schedule: true } } })).toBe(true);
    expect(resolveRoutineNoopSkip({ source: "schedule", routine: { bySource: { api: true } } })).toBe(false);
  });

  it("lets the most specific level win within the wake type", () => {
    expect(resolveRoutineNoopSkip({ source: "api", company: { bySource: { api: true } }, agent: { bySource: { api: false } } })).toBe(false);
  });
});

describeEmbeddedPostgres("routine run skip when unchanged", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-noop-skip-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(layers?: {
    company?: RoutineNoopSkipSettings;
    agent?: RoutineNoopSkipSettings;
    routine?: RoutineNoopSkipSettings;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
      routineNoopSkipSettings: layers?.company ?? {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: layers?.agent ? { heartbeat: { routineNoopSkipSettings: layers.agent } } : {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Routines", status: "in_progress" });

    const wakeups: string[] = [];
    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (_agentId, opts) => {
          const issueId = typeof opts.contextSnapshot?.issueId === "string" ? opts.contextSnapshot.issueId : null;
          if (!issueId) return null;
          wakeups.push(issueId);
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId,
            agentId,
            invocationSource: "assignment",
            status: "queued",
            contextSnapshot: { issueId },
          });
          return { id: runId };
        },
      },
    });
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "status check",
        description: "Check the status",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        routineNoopSkipSettings: layers?.routine,
      },
      {},
    );
    return { companyId, agentId, projectId, routine, svc, wakeups };
  }

  /** Plays the agent: runs the issue, leaves `activity` rows on its run, and closes it. */
  async function finishIssue(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: "done" | "cancelled";
    activity?: Array<{ action: string; entityType?: string; entityId?: string }>;
  }) {
    const runId = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, input.companyId))
      .then((rows) => rows[0]?.id ?? randomUUID());
    for (const item of input.activity ?? [{ action: "issue.updated" }]) {
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        runId,
        action: item.action,
        entityType: item.entityType ?? "issue",
        entityId: item.entityId ?? input.issueId,
      });
    }
    await db.update(issues).set({ status: input.status ?? "done" }).where(eq(issues.id, input.issueId));
  }

  async function allRuns(routineId: string) {
    return db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
  }

  it("defaults unchanged: with nothing set, every run creates an issue and wakes the agent", async () => {
    const { companyId, agentId, routine, svc, wakeups } = await seed();
    expect(routine.routineNoopSkipSettings).toEqual({});

    const first = await svc.runRoutine(routine.id, { source: "api" });
    expect(first.status).toBe("issue_created");
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });

    const second = await svc.runRoutine(routine.id, { source: "api" });
    expect(second.status).toBe("issue_created");
    expect(second.linkedIssueId).not.toBe(first.linkedIssueId);
    expect(wakeups).toHaveLength(2);
    expect(await db.select().from(issues)).toHaveLength(2);
  });

  it("skips the issue and the wake when inputs match and the last issue closed without changes", async () => {
    const { companyId, agentId, routine, svc, wakeups } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    expect(first.status).toBe("issue_created");
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });

    const second = await svc.runRoutine(routine.id, { source: "api" });
    const third = await svc.runRoutine(routine.id, { source: "api" });

    for (const run of [second, third]) {
      expect(run.status).toBe("skipped");
      expect(run.failureReason).toBe(ROUTINE_RUN_UNCHANGED_SKIP_REASON);
      expect(run.linkedIssueId).toBeNull();
    }
    expect(wakeups).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("runs again when the last issue was not resolved done", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId!, status: "cancelled" });
    const second = await svc.runRoutine(routine.id, { source: "api" });
    expect(second.status).toBe("issue_created");
  });

  it("runs again when the last run changed something besides its own issue", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({
      companyId,
      agentId,
      issueId: first.linkedIssueId!,
      activity: [{ action: "issue.updated" }, { action: "issue.updated", entityId: randomUUID() }],
    });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("runs again when the last run did something other than bookkeeping on its issue", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({
      companyId,
      agentId,
      issueId: first.linkedIssueId!,
      activity: [{ action: "issue.updated" }, { action: "issue.work_product_created" }],
    });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("runs again when the input digest differs", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api", payload: { build: 1 } });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    expect((await svc.runRoutine(routine.id, { source: "api", payload: { build: 2 } })).status).toBe("issue_created");
  });

  it("runs again after outside activity, and a skipped run does not move that window", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("skipped");

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "someone",
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
    });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("runs again when a person touched the finished issue outside any run", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "someone",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: first.linkedIssueId!,
    });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("never skips a project-scoped gate routine that has no project", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    await db.update(routines).set({ projectId: null, activityGateScope: "project" }).where(eq(routines.id, routine.id));
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("never skips a manual run", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    expect((await svc.runRoutine(routine.id, { source: "manual" })).status).toBe("issue_created");
  });

  it("fails closed: a first run with no history is never skipped", async () => {
    const { routine, svc } = await seed({ routine: { skipUnchanged: true } });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
    expect(await allRuns(routine.id)).toHaveLength(1);
  });

  it.each([
    ["company setting", { company: { skipUnchanged: true } }, true],
    ["agent setting", { agent: { skipUnchanged: true } }, true],
    ["agent off over company on", { company: { skipUnchanged: true }, agent: { skipUnchanged: false } }, false],
    ["routine off over company and agent on", { company: { skipUnchanged: true }, agent: { skipUnchanged: true }, routine: { skipUnchanged: false } }, false],
    ["routine wake type on over routine off", { routine: { skipUnchanged: false, bySource: { api: true } } }, true],
    ["company wake type off over routine on", { company: { bySource: { api: false } }, routine: { skipUnchanged: true } }, false],
    ["other wake type does not apply", { routine: { bySource: { schedule: true } } }, false],
  ] as const)("resolves layers on a real dispatch: %s", async (_name, layers, expectSkip) => {
    const { companyId, agentId, routine, svc } = await seed(layers);
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    const second = await svc.runRoutine(routine.id, { source: "api" });
    expect(second.status).toBe(expectSkip ? "skipped" : "issue_created");
  });

  it("applies routine settings on update without a new revision", async () => {
    const { routine, svc } = await seed();
    const updated = await svc.update(routine.id, { routineNoopSkipSettings: { skipUnchanged: true } }, {});
    expect(updated?.routineNoopSkipSettings).toEqual({ skipUnchanged: true });
    expect(updated?.latestRevisionNumber).toBe(routine.latestRevisionNumber);
  });
  it("skips repeat API runs even though the API route audits each run", async () => {
    const { companyId, agentId, routine, svc, wakeups } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    // The row POST /routines/:id/run writes after svc.runRoutine returns.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board",
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: first.id,
      details: { routineId: routine.id, source: first.source, status: first.status },
    });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("skipped");
    expect(wakeups).toHaveLength(1);
  });

  it.each(["manual", "api"] as const)(
    "keeps the scheduler gate unchanged with settings unset: a failed %s dispatch is retried",
    async (source) => {
      const { companyId, routine, svc, wakeups } = await seed();
      await svc.update(routine.id, { activityGatePolicy: "require_external_activity" }, {});
      const failed = await db
        .insert(routineRuns)
        .values({
          companyId,
          routineId: routine.id,
          source,
          status: "failed",
          failureReason: "wakeup rejected",
          triggeredAt: new Date(Date.now() - 60_000),
        })
        .returning()
        .then((rows) => rows[0]!);
      // The row the board/API route writes after a dispatch, even a failed one.
      await db.insert(activityLog).values({
        companyId,
        actorType: "user",
        actorId: "board",
        action: "routine.run_triggered",
        entityType: "routine_run",
        entityId: failed.id,
        details: { routineId: routine.id, source, status: "failed" },
      });
      const { trigger } = await svc.createTrigger(routine.id, { kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }, {});
      const due = new Date(Date.now() + 1_000);
      await db.update(routineTriggers).set({ nextRunAt: due }).where(eq(routineTriggers.id, trigger.id));

      expect(await svc.tickScheduledTriggers(due)).toEqual({ triggered: 1 });
      expect(wakeups).toHaveLength(1);
      expect(await db.select().from(issues)).toHaveLength(1);
    },
  );

  it("runs again after the assigned agent changed, even with project scope", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    await db.update(routines).set({ activityGateScope: "project" }).where(eq(routines.id, routine.id));
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("skipped");

    // The agent PATCH route's audit row carries no projectId.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board",
      action: "agent.updated",
      entityType: "agent",
      entityId: agentId,
      details: { changedTopLevelKeys: ["adapterConfig"] },
    });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("ignores runless read markers on the finished issue", async () => {
    const { companyId, agentId, routine, svc } = await seed({ routine: { skipUnchanged: true } });
    const first = await svc.runRoutine(routine.id, { source: "api" });
    await finishIssue({ companyId, agentId, issueId: first.linkedIssueId! });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "someone",
      action: "issue.read_marked",
      entityType: "issue",
      entityId: first.linkedIssueId!,
    });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("skipped");
  });
});
