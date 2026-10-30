import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, issueComments, issueRelations, issues, routineRuns } from "@paperclipai/db";
import {
  ROUTINE_STEP_SKIPPED_COMMENT,
  readRoutineStepsRunPayload,
  type RoutineStep,
  type RoutineStepCondition,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { FIXTURE_BOARD_USER_ID, seedEventFixture } from "./helpers/event-source-fixture.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "hash") }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry");
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Acknowledged.",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "../services/issues.ts";
import {
  reconcileRoutineStepRun,
  routineStepConditionsBackstop,
  type RoutineStepRunReconcileDeps,
} from "../services/routine-steps.ts";

vi.setConfig({ testTimeout: 60000 });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attached routine step condition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: RoutineStep["after"] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

const when = (stepKey: string, outcome: RoutineStepCondition) => ({ step: stepKey, when: outcome });

const EVENT_ISSUE = { issueMode: "event_issue" } as const;

/**
 * The steps of these runs hang under a task that a person or an event already made, so the task keeps
 * its own origin and the run never turns into a routine execution issue. The conditions must still
 * find the run through the steps and the steps the run recorded.
 */
function useAttachedTaskFixture(label: string) {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase(`paperclip-routine-step-conditions-${label}-`);
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const fx = await seedEventFixture(db);
    const leadId = await fx.createAgent("Lead");
    const builderId = await fx.createAgent("Builder");
    const reviewerId = await fx.createAgent("Reviewer");
    const { source } = await fx.sources.ensureInternal(fx.companyId, { userId: FIXTURE_BOARD_USER_ID });
    const routine = await fx.routinesSvc.create(
      fx.companyId,
      {
        projectId: fx.projectId,
        goalId: null,
        parentIssueId: null,
        title: "Release check",
        description: "Lead brief",
        assigneeAgentId: leadId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
        steps: [
          step("review", [], { assigneeAgentId: reviewerId }),
          step("ship", [when("review", "done")]),
          step("rework", [when("review", "cancelled")], { assigneeAgentId: builderId }),
          step("announce", ["ship", "rework"]),
        ],
      } as never,
      {},
    );
    await fx.subscribe(routine.id, source.id, { grouping: EVENT_ISSUE });
    const newTask = (extra: Partial<Parameters<typeof fx.issueSvc.create>[1]> = {}) =>
      fx.issueSvc.create(fx.companyId, {
        title: "Fix login",
        status: "todo",
        priority: "medium",
        projectId: fx.projectId,
        assigneeAgentId: leadId,
        createdByUserId: FIXTURE_BOARD_USER_ID,
        ...extra,
      });

    async function runFor(runId: string, task: { id: string }) {
      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
      const recorded = readRoutineStepsRunPayload(stored!.triggerPayload);
      if (!recorded) throw new Error("The run recorded no steps");
      return {
        runId,
        taskId: task.id,
        issueOf: (key: string) => recorded.stepIssueIds[key]!,
        target: { companyId: fx.companyId, rootIssueId: task.id, routineRunId: runId },
      };
    }

    /** An event on the task: the routine's event trigger attaches the steps. */
    const startOnEvent = async (task: { id: string }) => {
      const result = await fx.sources.publishInternal(fx.companyId, { issueId: task.id });
      expect(result.stepsAttached).toBe(true);
      return runFor(result.routineRunIds[0]!, task);
    };
    /** A run on the task (`targetIssueId`): the run attaches the steps. */
    const startOnTask = async (task: { id: string }) => {
      const run = await fx.routinesSvc.runRoutine(routine.id, { source: "manual", targetIssueId: task.id });
      return runFor(run.id, task);
    };
    return { fx, routine, leadId, builderId, reviewerId, newTask, startOnEvent, startOnTask };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;
  type AttachedRun = Awaited<ReturnType<Seeded["startOnEvent"]>>;

  const closeRows = async (issueIds: string[], status: "done" | "cancelled") => {
    for (const id of issueIds) {
      await db
        .update(issues)
        .set({ status, ...(status === "done" ? { completedAt: new Date() } : { cancelledAt: new Date() }) })
        .where(eq(issues.id, id));
    }
  };

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row!.status;
  }

  async function originKindOf(issueId: string) {
    const [row] = await db.select({ originKind: issues.originKind }).from(issues).where(eq(issues.id, issueId));
    return row!.originKind;
  }

  async function blockersOf(issueId: string) {
    const rows = await db
      .select({ blockerId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
    return rows.map((row) => row.blockerId).sort();
  }

  async function commentsOn(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    return rows.map((row) => row.body);
  }

  const ids = (...issueIds: string[]) => [...issueIds].sort();

  function recordingDeps() {
    const wakes: Array<{ agentId: string; issueId: string | null; reason: string | null | undefined }> = [];
    const deps: RoutineStepRunReconcileDeps = {
      issueSvc: issueService(db),
      heartbeat: {
        wakeup: async (agentId, opts) => {
          const issueId = typeof opts.payload?.issueId === "string" ? opts.payload.issueId : null;
          wakes.push({ agentId, issueId, reason: opts.reason });
          return null;
        },
      },
      executePostCommitActions: async () => undefined,
    };
    return { deps, wakes };
  }

  return {
    get db() {
      return db;
    },
    seed,
    closeRows,
    statusOf,
    originKindOf,
    blockersOf,
    commentsOn,
    ids,
    recordingDeps,
  };
}

describeEmbeddedPostgres("routine step conditions on a task that steps were attached to", () => {
  const t = useAttachedTaskFixture("attached");

  it("skips the rework branch of an event run when the gate is approved, and the task waits only for the live steps", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const originKind = await t.originKindOf(task.id);
    const run = await s.startOnEvent(task);
    await t.closeRows([run.issueOf("review")], "done");
    const { deps, wakes } = t.recordingDeps();

    const result = await reconcileRoutineStepRun(t.db, run.target, deps);

    expect(originKind).not.toBe("routine_execution");
    expect(await t.originKindOf(task.id)).toBe(originKind);
    expect(result.skippedIssueIds).toEqual([run.issueOf("rework")]);
    expect(await t.statusOf(run.issueOf("rework"))).toBe("cancelled");
    expect(await t.commentsOn(run.issueOf("rework"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
    expect(await t.blockersOf(task.id)).toEqual(t.ids(run.issueOf("review"), run.issueOf("ship"), run.issueOf("announce")));
    expect(await t.blockersOf(run.issueOf("announce"))).toEqual([run.issueOf("ship")]);
    expect(await t.statusOf(task.id)).toBe("blocked");
    expect(wakes).toEqual([]);
  });

  it("takes the rework branch of an event run when the board cancels the gate, and wakes its agent once", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const run = await s.startOnEvent(task);
    await t.closeRows([run.issueOf("review")], "cancelled");
    const { deps, wakes } = t.recordingDeps();

    const result = await reconcileRoutineStepRun(t.db, run.target, deps);

    expect(result.skippedIssueIds).toEqual([run.issueOf("ship")]);
    expect(await t.statusOf(run.issueOf("ship"))).toBe("cancelled");
    expect(await t.statusOf(run.issueOf("rework"))).toBe("todo");
    expect(await t.blockersOf(run.issueOf("rework"))).toEqual([]);
    expect(await t.blockersOf(task.id)).toEqual(t.ids(run.issueOf("rework"), run.issueOf("announce")));
    expect(wakes).toEqual([{ agentId: s.builderId, issueId: run.issueOf("rework"), reason: "issue_blockers_resolved" }]);

    const again = await reconcileRoutineStepRun(t.db, run.target, deps);
    expect(again).toEqual({ skippedIssueIds: [], releasedIssueIds: [], wokenIssueIds: [] });
    expect(wakes).toHaveLength(1);
  });

  it("skips the dead branch of a run on a task, with the same result", async () => {
    const s = await t.seed();
    const task = await s.newTask({ status: "backlog" });
    const originKind = await t.originKindOf(task.id);
    const run = await s.startOnTask(task);
    await t.closeRows([run.issueOf("review")], "done");
    const { deps } = t.recordingDeps();

    const result = await reconcileRoutineStepRun(t.db, run.target, deps);

    expect(await t.originKindOf(task.id)).toBe(originKind);
    expect(result.skippedIssueIds).toEqual([run.issueOf("rework")]);
    expect(await t.statusOf(run.issueOf("rework"))).toBe("cancelled");
    expect(await t.blockersOf(task.id)).toEqual(t.ids(run.issueOf("review"), run.issueOf("ship"), run.issueOf("announce")));
  });

  it("takes the rework branch of a run on a task when the board cancels the gate", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const run = await s.startOnTask(task);
    await t.closeRows([run.issueOf("review")], "cancelled");
    const { deps, wakes } = t.recordingDeps();

    await reconcileRoutineStepRun(t.db, run.target, deps);

    expect(await t.statusOf(run.issueOf("ship"))).toBe("cancelled");
    expect(await t.statusOf(run.issueOf("rework"))).toBe("todo");
    expect(wakes).toEqual([{ agentId: s.builderId, issueId: run.issueOf("rework"), reason: "issue_blockers_resolved" }]);
  });

  it("is queued by the step's own end and applies the conditions of an attached task", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const run = await s.startOnEvent(task);
    const queued: IssuePostCommitAction[] = [];

    await s.fx.issueSvc.update(run.issueOf("review"), { status: "done" }, t.db, [], queued);

    expect(queued).toEqual([
      { type: "reconcile_routine_steps", companyId: s.fx.companyId, rootIssueId: task.id, routineRunId: run.runId },
    ]);
    await executeIssuePostCommitActions(t.db, queued);
    expect(await t.statusOf(run.issueOf("rework"))).toBe("cancelled");
    expect(await t.commentsOn(run.issueOf("rework"))).toEqual([ROUTINE_STEP_SKIPPED_COMMENT]);
  });

  it("keeps the runs of one task apart when a later run attaches new steps", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const first = await s.startOnEvent(task);
    await t.closeRows([first.issueOf("review"), first.issueOf("ship"), first.issueOf("announce")], "done");
    await t.closeRows([first.issueOf("rework")], "cancelled");
    const second = await s.startOnTask(task);
    await t.closeRows([second.issueOf("review")], "cancelled");
    const { deps } = t.recordingDeps();

    const firstResult = await reconcileRoutineStepRun(t.db, first.target, deps);
    const secondResult = await reconcileRoutineStepRun(t.db, second.target, deps);

    expect(firstResult.skippedIssueIds).toEqual([]);
    expect(secondResult.skippedIssueIds).toEqual([second.issueOf("ship")]);
    expect(await t.statusOf(first.issueOf("ship"))).toBe("done");
    expect(await t.statusOf(second.issueOf("rework"))).toBe("todo");
  });
});

describeEmbeddedPostgres("routine step condition backstop on a task that steps were attached to", () => {
  const t = useAttachedTaskFixture("attached-backstop");

  beforeEach(async () => {
    // The backstop scans every company, so close the tasks of earlier tests first.
    await t.db.execute(
      sql`update issues set status = 'cancelled' where id in (select parent_id from issues where origin_kind = 'routine_step' and parent_id is not null)`,
    );
  });

  function backstop() {
    const { deps, wakes } = t.recordingDeps();
    return { wakes, backstop: routineStepConditionsBackstop(t.db, deps) };
  }

  it("finds a task that an event attached steps to, when its step ended without the post-commit action", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const run = await s.startOnEvent(task);
    await t.closeRows([run.issueOf("review")], "cancelled");
    const { backstop: pass, wakes } = backstop();

    const result = await pass.reconcileOpenRuns();

    expect(result).toMatchObject({ checked: 1, skipped: 1, failed: 0 });
    expect(await t.statusOf(run.issueOf("ship"))).toBe("cancelled");
    expect(await t.statusOf(run.issueOf("rework"))).toBe("todo");
    expect(wakes).toEqual([{ agentId: s.builderId, issueId: run.issueOf("rework"), reason: "issue_blockers_resolved" }]);
  });

  it("finds a task that a run on the task attached steps to", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const run = await s.startOnTask(task);
    await t.closeRows([run.issueOf("review")], "done");
    const { backstop: pass } = backstop();

    const result = await pass.reconcileOpenRuns();

    expect(result).toMatchObject({ checked: 1, skipped: 1, failed: 0 });
    expect(await t.statusOf(run.issueOf("rework"))).toBe("cancelled");
  });

  it("finds a task that no agent owns, which keeps its status while the steps run", async () => {
    const s = await t.seed();
    const task = await s.newTask({ assigneeAgentId: null, status: "backlog" });
    const run = await s.startOnEvent(task);
    expect(await t.statusOf(task.id)).toBe("backlog");
    await t.closeRows([run.issueOf("review")], "cancelled");
    const { backstop: pass } = backstop();

    const result = await pass.reconcileOpenRuns();

    expect(result).toMatchObject({ checked: 1, skipped: 1, failed: 0 });
    expect(await t.statusOf(run.issueOf("ship"))).toBe("cancelled");
    expect(await t.statusOf(run.issueOf("rework"))).toBe("todo");
    expect(await t.statusOf(task.id)).toBe("backlog");
  });

  it("leaves a task that is finished alone", async () => {
    const s = await t.seed();
    const task = await s.newTask();
    const run = await s.startOnEvent(task);
    await t.closeRows([run.issueOf("review")], "done");
    await t.closeRows([task.id], "cancelled");
    const { backstop: pass } = backstop();

    const result = await pass.reconcileOpenRuns();

    expect(result.checked).toBe(0);
    expect(await t.statusOf(run.issueOf("rework"))).toBe("blocked");
  });
});
