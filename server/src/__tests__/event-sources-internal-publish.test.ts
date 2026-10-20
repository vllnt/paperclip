import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  createDb,
  eventDeliveries,
  eventSources,
  issueLabels,
  issues,
  labels,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { eventGroupingSchema, type RoutineStep } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture } from "./helpers/event-source-fixture.js";
import { untilAStatementWaitsForALock } from "./helpers/lock-wait.js";

// Lets a test make the routine dispatch throw after the delivery is claimed, before or after the run.
const dispatchFault = vi.hoisted(() => ({ when: null as "before_run" | "after_run" | null }));

vi.mock("../services/routines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/routines.js")>();
  return {
    ...actual,
    routineService: (...args: Parameters<typeof actual.routineService>) => {
      const svc = actual.routineService(...args);
      return {
        ...svc,
        dispatchEvent: async (...input: Parameters<typeof svc.dispatchEvent>) => {
          if (dispatchFault.when === "before_run") throw new Error("dispatch broke before the run");
          const outcome = await svc.dispatchEvent(...input);
          if (dispatchFault.when === "after_run") throw new Error("dispatch broke after the run");
          return outcome;
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres internal event publishing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

const EVENT_ISSUE = { issueMode: "event_issue" } as const;

describeEmbeddedPostgres("starting routine steps from the built-in Paperclip event source", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-event-sources-internal-publish-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Switches a trigger off in a board transaction that holds the routine lock and commits on
   * `release()`: a board write that lands between another call's first read and its own lock.
   */
  function switchOffUnderRoutineLock(routineId: string, triggerId: string) {
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${routines} where ${routines.id} = ${routineId} for update`);
      await tx.update(routineTriggers).set({ enabled: false }).where(eq(routineTriggers.id, triggerId));
      held();
      await released;
    });
    return { holding, release, done };
  }

  async function seed() {
    const fx = await seedEventFixture(db);
    const leadId = await fx.createAgent("Lead");
    const builderId = await fx.createAgent("Builder");
    const reviewerId = await fx.createAgent("Reviewer");
    const { source } = await fx.sources.ensureInternal(fx.companyId, { userId: "board-user" });
    const steps = [
      step("build", [], { assigneeAgentId: builderId, title: "Build {{issue.identifier}}: {{issue.title}}" }),
      step("review", ["build"], { assigneeAgentId: reviewerId }),
    ];

    const createRoutine = (patch: { steps?: RoutineStep[]; title?: string } = {}) =>
      fx.routinesSvc.create(
        fx.companyId,
        {
          projectId: fx.projectId,
          goalId: null,
          parentIssueId: null,
          title: patch.title ?? "Release check",
          description: "Lead brief",
          assigneeAgentId: leadId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          steps: patch.steps ?? steps,
        } as never,
        {},
      );
    const listen = async (
      routine: { id: string },
      trigger: Parameters<typeof fx.subscribe>[2] = { grouping: EVENT_ISSUE },
    ) => fx.subscribe(routine.id, source.id, trigger);
    const newTask = (extra: Partial<Parameters<typeof fx.issueSvc.create>[1]> = {}) =>
      fx.issueSvc.create(fx.companyId, {
        title: "Fix login",
        status: "todo",
        priority: "medium",
        projectId: fx.projectId,
        assigneeAgentId: leadId,
        createdByUserId: "board-user",
        ...extra,
      });
    const childrenOf = (taskId: string) =>
      db.select().from(issues).where(and(eq(issues.companyId, fx.companyId), eq(issues.parentId, taskId)));
    const deliveries = () => db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id));
    const runsOf = (routineId: string) => db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
    const publish = (issueId: string) => fx.sources.publishInternal(fx.companyId, { issueId });

    return { fx, source, leadId, builderId, reviewerId, steps, createRoutine, listen, newTask, childrenOf, deliveries, runsOf, publish };
  }

  describe("a task that gets the steps", () => {
    it("takes the steps as subtasks, waits on them, and wakes only the first step's agent", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask();

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(true);
      const children = await s.childrenOf(task.id);
      expect(children.map((child) => child.title).sort()).toEqual([`Build ${task.identifier}: Fix login`, "Step review"]);
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after).toMatchObject({ status: "blocked", assigneeAgentId: s.leadId });
      expect(s.fx.wakeups.map((wake) => wake.agentId)).toEqual([s.builderId]);
    });

    it("records one run on the task and one dispatched delivery that names it", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const trigger = await s.listen(routine);
      const task = await s.newTask();

      const result = await s.publish(task.id);

      const [run] = await s.runsOf(routine.id);
      expect(run).toMatchObject({
        source: "event",
        status: "issue_created",
        linkedIssueId: task.id,
        triggerId: trigger.id,
      });
      expect(result.routineRunIds).toEqual([run!.id]);
      const [delivery] = await s.deliveries();
      expect(delivery).toMatchObject({ status: "dispatched", httpStatus: 202 });
      expect(delivery!.issueIds).toEqual([task.id]);
      expect(delivery!.routineRunIds).toEqual([run!.id]);
    });

    it("leaves a task nobody owns in its status", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask({ assigneeAgentId: null, status: "backlog" });

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(true);
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after!.status).toBe("backlog");
      expect(await s.childrenOf(task.id)).toHaveLength(2);
    });

    it("attaches once when the same task is published twice", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask();

      const first = await s.publish(task.id);
      const second = await s.publish(task.id);

      expect(first.stepsAttached).toBe(true);
      expect(second).toEqual({ stepsAttached: false, routineRunIds: [] });
      expect(await s.childrenOf(task.id)).toHaveLength(2);
      expect(await s.deliveries()).toHaveLength(1);
      expect(await s.runsOf(routine.id)).toHaveLength(1);
    });

    it("starts each routine that listens, under one task, and refuses the second", async () => {
      const s = await seed();
      const first = await s.createRoutine({ title: "First" });
      const second = await s.createRoutine({ title: "Second" });
      await s.listen(first);
      await s.listen(second);
      const task = await s.newTask();

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(true);
      expect(await s.childrenOf(task.id)).toHaveLength(2);
      const runs = [...(await s.runsOf(first.id)), ...(await s.runsOf(second.id))];
      expect(runs.map((run) => run.status).sort()).toEqual(["failed", "issue_created"]);
    });
  });

  describe("a task that is matched by label and project", () => {
    it("starts the steps only for the labels the trigger asks for", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine, { grouping: EVENT_ISSUE, match: { labels: { label_needs_review: "true" } } });
      const [label] = await db
        .insert(labels)
        .values({ companyId: s.fx.companyId, name: "Needs Review", color: "#3366ff" })
        .returning();
      const plain = await s.newTask({ title: "Plain" });
      const tagged = await s.newTask({ title: "Tagged" });
      await db.insert(issueLabels).values({ issueId: tagged.id, labelId: label!.id, companyId: s.fx.companyId });

      const plainResult = await s.publish(plain.id);
      const taggedResult = await s.publish(tagged.id);

      expect(plainResult.stepsAttached).toBe(false);
      expect(taggedResult.stepsAttached).toBe(true);
      expect(await s.childrenOf(plain.id)).toHaveLength(0);
      expect(await s.childrenOf(tagged.id)).toHaveLength(2);
    });

    it("tells apart a task a person created from one an agent created", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine, { grouping: EVENT_ISSUE, match: { labels: { created_by: "agent" } } });
      const byUser = await s.newTask({ title: "By user" });
      const byAgent = await s.newTask({ title: "By agent" });
      await db
        .update(issues)
        .set({ createdByUserId: null, createdByAgentId: s.builderId })
        .where(eq(issues.id, byAgent.id));

      const userResult = await s.publish(byUser.id);
      const agentResult = await s.publish(byAgent.id);

      expect(userResult.stepsAttached).toBe(false);
      expect(agentResult.stepsAttached).toBe(true);
    });
  });

  describe("a task that never publishes", () => {
    it("writes nothing while no event trigger listens", async () => {
      const s = await seed();
      await s.createRoutine();
      const task = await s.newTask();

      const result = await s.publish(task.id);

      expect(result).toEqual({ stepsAttached: false, routineRunIds: [] });
      expect(await s.deliveries()).toEqual([]);
    });

    it("writes nothing for a company that never created the source", async () => {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const task = await fx.issueSvc.create(fx.companyId, {
        title: "Plain",
        status: "todo",
        priority: "medium",
        projectId: fx.projectId,
        assigneeAgentId: leadId,
      });

      const result = await fx.sources.publishInternal(fx.companyId, { issueId: task.id });

      expect(result).toEqual({ stepsAttached: false, routineRunIds: [] });
      expect(await db.select().from(eventSources).where(eq(eventSources.companyId, fx.companyId))).toEqual([]);
    });

    it("writes nothing once the trigger or the source is switched off", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const trigger = await s.listen(routine);
      await s.fx.routinesSvc.updateTrigger(trigger.id, { enabled: false } as never, {});
      const viaTrigger = await s.newTask({ title: "Trigger off" });
      await s.fx.routinesSvc.updateTrigger(trigger.id, { enabled: true } as never, {});
      await db.update(eventSources).set({ enabled: false }).where(eq(eventSources.id, s.source.id));
      const viaSource = await s.newTask({ title: "Source off" });

      const first = await s.publish(viaTrigger.id);
      const second = await s.publish(viaSource.id);

      expect(first.stepsAttached).toBe(false);
      expect(second.stepsAttached).toBe(false);
      expect(await s.deliveries()).toEqual([]);
      expect(await s.childrenOf(viaTrigger.id)).toHaveLength(0);
      expect(await s.childrenOf(viaSource.id)).toHaveLength(0);
    });

    it("skips the tasks the routines themselves create, and what hangs under them", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const root = await s.newTask({ title: "Run root" });
      await db.update(issues).set({ originKind: "routine_execution", originId: routine.id }).where(eq(issues.id, root.id));
      const hidden = await s.newTask({ title: "Hidden" });
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden.id));
      const underRun = await s.newTask({ title: "Under a run", parentId: root.id });
      const stepTask = await s.newTask({ title: "A step" });
      await db.update(issues).set({ originKind: "routine_step", originId: routine.id }).where(eq(issues.id, stepTask.id));

      for (const task of [root, hidden, underRun, stepTask]) {
        expect(await s.publish(task.id)).toEqual({ stepsAttached: false, routineRunIds: [] });
      }
      expect(await s.deliveries()).toEqual([]);
    });

    it("does not publish the steps it attached, so the tree cannot start itself again", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask();
      await s.publish(task.id);

      const results = await Promise.all((await s.childrenOf(task.id)).map((child) => s.publish(child.id)));

      expect(results).toEqual([
        { stepsAttached: false, routineRunIds: [] },
        { stepsAttached: false, routineRunIds: [] },
      ]);
      expect(await s.deliveries()).toHaveLength(1);
    });
  });

  describe("a task the steps cannot go under", () => {
    it("records the refusal on the run and the delivery and leaves the task alone", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask();
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, task.id));

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(false);
      const [run] = await s.runsOf(routine.id);
      expect(run).toMatchObject({ status: "failed" });
      expect(run!.failureReason).toContain("in_progress");
      const [delivery] = await s.deliveries();
      expect(delivery).toMatchObject({ status: "failed" });
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after!.status).toBe("in_progress");
      expect(await s.childrenOf(task.id)).toHaveLength(0);
      expect(s.fx.wakeups).toEqual([]);
    });

    it("refuses before touching the task when the first step's agent cannot be woken", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.builderId));
      const task = await s.newTask();

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(false);
      const [run] = await s.runsOf(routine.id);
      expect(run).toMatchObject({ status: "failed" });
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after!.status).toBe("todo");
      expect(await s.childrenOf(task.id)).toHaveLength(0);
      expect(s.fx.wakeups).toEqual([]);
    });

    it("fails the run and keeps the task when the routine lost its steps after the trigger was saved", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      await db.update(routines).set({ steps: [] }).where(eq(routines.id, routine.id));
      const task = await s.newTask();

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(false);
      const [delivery] = await s.deliveries();
      expect(delivery).toMatchObject({ status: "failed" });
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after!.status).toBe("todo");
    });
  });

  describe("a publish that breaks after the delivery is claimed", () => {
    afterEach(() => {
      dispatchFault.when = null;
    });

    it("records the failure on the delivery and reports no steps, so the caller wakes the assignee", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask();
      dispatchFault.when = "before_run";

      const result = await s.publish(task.id);

      expect(result).toEqual({ stepsAttached: false, routineRunIds: [] });
      const [delivery] = await s.deliveries();
      expect(delivery).toMatchObject({ status: "failed" });
      expect(delivery!.error).toContain("dispatch broke before the run");
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after!.status).toBe("todo");
      expect(await s.childrenOf(task.id)).toHaveLength(0);
    });

    it("still reports the steps when they were attached before the failure, so the assignee stays asleep", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      const task = await s.newTask();
      dispatchFault.when = "after_run";

      const result = await s.publish(task.id);

      expect(result.stepsAttached).toBe(true);
      const [delivery] = await s.deliveries();
      expect(delivery).toMatchObject({ status: "failed" });
      expect(await s.childrenOf(task.id)).toHaveLength(2);
    });
  });

  describe("the source's new-issue budget", () => {
    it("starts the steps on the tasks inside the budget and folds the rest", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      await db.update(eventSources).set({ maxNewIssuesPerHour: 1 }).where(eq(eventSources.id, s.source.id));
      const first = await s.newTask({ title: "First" });
      const second = await s.newTask({ title: "Second" });

      const inside = await s.publish(first.id);
      const over = await s.publish(second.id);

      expect(inside.stepsAttached).toBe(true);
      expect(over.stepsAttached).toBe(false);
      expect(await s.childrenOf(second.id)).toHaveLength(0);
      const runs = await s.runsOf(routine.id);
      const skipped = runs.find((run) => run.status === "skipped");
      expect(skipped?.failureReason).toBe("new_issue_budget_spent");
      const [trigger] = await db
        .select({ lastResult: routineTriggers.lastResult })
        .from(routineTriggers)
        .where(eq(routineTriggers.routineId, routine.id));
      expect(trigger!.lastResult).toContain("budget");
    });

    it("gives the slot back when the task refuses the steps", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);
      await db.update(eventSources).set({ maxNewIssuesPerHour: 1 }).where(eq(eventSources.id, s.source.id));
      const busy = await s.newTask({ title: "Busy" });
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, busy.id));
      const free = await s.newTask({ title: "Free" });

      await s.publish(busy.id);
      const result = await s.publish(free.id);

      expect(result.stepsAttached).toBe(true);
    });
  });

  describe("saving an event_issue trigger", () => {
    it("is refused on a source that is not the built-in one", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const { source: other } = await s.fx.createSource({ name: "Other" });

      await expect(s.fx.subscribe(routine.id, other.id, { grouping: EVENT_ISSUE })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("built-in Paperclip event source"),
      });
    });

    it("is required on the built-in source, and cannot be a fallback there", async () => {
      const s = await seed();
      const routine = await s.createRoutine();

      await expect(s.listen(routine, {})).rejects.toMatchObject({ status: 422, message: expect.stringContaining("event_issue") });
      await expect(s.listen(routine, { grouping: { issueMode: "group" } })).rejects.toMatchObject({ status: 422 });
      await expect(s.listen(routine, { grouping: EVENT_ISSUE, fallback: true })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("fallback"),
      });
    });

    it("is refused for a routine without steps", async () => {
      const s = await seed();
      const routine = await s.createRoutine({ steps: [] });

      await expect(s.listen(routine)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("at least one step") });
    });

    it("is refused when a gate script applies to events", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await db
        .update(routines)
        .set({ gate: { appliesTo: ["event"] } as never })
        .where(eq(routines.id, routine.id));

      await expect(s.listen(routine)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("gate") });
    });

    it("keeps the routine from losing its steps while the trigger is on", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      await s.listen(routine);

      await expect(s.fx.routinesSvc.update(routine.id, { steps: [] } as never, {})).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("at least one step"),
      });
      const [unchanged] = await db.select().from(routines).where(eq(routines.id, routine.id));
      expect(unchanged!.steps).toHaveLength(2);
    });

    it("is refused for an agent, even on its own routine", async () => {
      const s = await seed();
      const routine = await s.createRoutine();

      await expect(
        s.fx.routinesSvc.createTrigger(
          routine.id,
          { kind: "event", label: null, eventSourceId: s.source.id, eventMatch: null, eventGrouping: EVENT_ISSUE, fallback: false } as never,
          { agentId: s.leadId },
        ),
      ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("board") });
      expect(await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine.id))).toEqual([]);
    });

    it("cannot be widened, switched on or brought back by an agent, which may still switch it off or rename it", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const trigger = await s.listen(routine, { grouping: EVENT_ISSUE, match: { labels: { created_by: "user" } } });
      const agent = { agentId: s.leadId };
      const svc = s.fx.routinesSvc;

      await expect(svc.updateTrigger(trigger.id, { eventMatch: null } as never, agent)).rejects.toMatchObject({ status: 403 });
      await expect(svc.updateTrigger(trigger.id, { eventGrouping: EVENT_ISSUE } as never, agent)).rejects.toMatchObject({
        status: 403,
      });
      await svc.updateTrigger(trigger.id, { label: "Release check on new tasks" } as never, agent);
      await svc.updateTrigger(trigger.id, { enabled: false } as never, agent);
      await expect(svc.updateTrigger(trigger.id, { enabled: true } as never, agent)).rejects.toMatchObject({ status: 403 });
      await svc.updateTrigger(trigger.id, { archived: true } as never, agent);
      await expect(svc.updateTrigger(trigger.id, { archived: false } as never, agent)).rejects.toMatchObject({ status: 403 });

      const [after] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
      expect(after).toMatchObject({ label: "Release check on new tasks", enabled: false, archived: true });
      expect(after?.eventMatch).toEqual({ labels: { created_by: "user" } });
    });

    it("cannot be brought back by an agent from an older revision, unless it is unchanged", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const svc = s.fx.routinesSvc;
      const board = { userId: "board-user" };
      const agent = { agentId: s.leadId };
      const trigger = await s.listen(routine, { grouping: EVENT_ISSUE, match: { labels: { created_by: "user" } } });
      const [withTrigger] = await svc.listRevisions(routine.id);
      await svc.updateTrigger(trigger.id, { enabled: false } as never, board);

      await expect(svc.restoreRevision(routine.id, withTrigger!.id, agent)).rejects.toMatchObject({ status: 403 });
      const [stillOff] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
      expect(stillOff?.enabled).toBe(false);

      await svc.restoreRevision(routine.id, withTrigger!.id, board);
      await svc.update(routine.id, { title: "Release check, renamed" } as never, board);
      const restored = await svc.restoreRevision(routine.id, withTrigger!.id, agent);
      expect(restored.routine.title).toBe("Release check");
    });

    it("keeps an agent from changing the steps or the agent of the routine while the trigger is on", async () => {
      const s = await seed();
      const ownSteps = [step("build", [], { assigneeAgentId: s.leadId })];
      const routine = await s.createRoutine();
      const svc = s.fx.routinesSvc;
      const board = { userId: "board-user" };
      const agent = { agentId: s.leadId };
      await svc.update(routine.id, { steps: ownSteps } as never, board);
      const [withOwnSteps] = await svc.listRevisions(routine.id);
      await svc.update(routine.id, { steps: s.steps } as never, board);
      const trigger = await s.listen(routine);

      await expect(svc.update(routine.id, { steps: ownSteps } as never, agent)).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("steps"),
      });
      await expect(svc.update(routine.id, { assigneeAgentId: s.builderId } as never, agent)).rejects.toMatchObject({
        status: 403,
      });
      await expect(svc.restoreRevision(routine.id, withOwnSteps!.id, agent)).rejects.toMatchObject({ status: 403 });
      const [unchanged] = await db.select().from(routines).where(eq(routines.id, routine.id));
      expect(unchanged).toMatchObject({ steps: s.steps, assigneeAgentId: s.leadId });
      expect((await svc.update(routine.id, { title: "Release check, renamed" } as never, agent))?.title).toBe(
        "Release check, renamed",
      );

      await svc.updateTrigger(trigger.id, { enabled: false } as never, agent);
      expect((await svc.update(routine.id, { steps: ownSteps } as never, agent))?.steps).toMatchObject(ownSteps);
    });

    it("keeps a trigger the board switched off while an agent relabelled it switched off", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const trigger = await s.listen(routine);
      const { holding, release, done } = switchOffUnderRoutineLock(routine.id, trigger.id);
      await holding;

      const relabel = s.fx.routinesSvc.updateTrigger(trigger.id, { label: "Renamed" } as never, { agentId: s.leadId });
      await untilAStatementWaitsForALock(db);
      release();
      await done;
      await relabel;

      const [after] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
      expect(after).toMatchObject({ label: "Renamed", enabled: false });
    });

    it("lets an agent restore a trigger saved without the grouping defaults, when it is unchanged", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const svc = s.fx.routinesSvc;
      const trigger = await s.listen(routine, { grouping: EVENT_ISSUE });
      const [withTrigger] = await svc.listRevisions(routine.id);
      await svc.update(routine.id, { title: "Release check, renamed" } as never, { userId: "board-user" });

      const restored = await svc.restoreRevision(routine.id, withTrigger!.id, { agentId: s.leadId });

      expect(restored.routine.title).toBe("Release check");
      const [after] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
      expect(after?.enabled).toBe(true);
    });

    it("refuses an agent's restore that would switch back on a trigger the board just switched off", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const svc = s.fx.routinesSvc;
      // Saved with the grouping defaults, as the API saves it, so only the race can make it differ.
      const trigger = await s.listen(routine, { grouping: eventGroupingSchema.parse(EVENT_ISSUE) });
      const [withTrigger] = await svc.listRevisions(routine.id);
      await svc.update(routine.id, { title: "Release check, renamed" } as never, { userId: "board-user" });
      const { holding, release, done } = switchOffUnderRoutineLock(routine.id, trigger.id);
      await holding;

      const restore = svc.restoreRevision(routine.id, withTrigger!.id, { agentId: s.leadId });
      const refused = expect(restore).rejects.toMatchObject({ status: 403 });
      await untilAStatementWaitsForALock(db);
      release();
      await done;
      await refused;

      const [after] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
      expect(after?.enabled).toBe(false);
    });

    it("lets a routine with a disabled trigger lose its steps", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const trigger = await s.listen(routine);
      await s.fx.routinesSvc.updateTrigger(trigger.id, { enabled: false } as never, {});

      const updated = await s.fx.routinesSvc.update(routine.id, { steps: [] } as never, {});

      expect(updated?.steps).toEqual([]);
    });
  });
});
