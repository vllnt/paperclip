import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issueComments,
  issueRelations,
  issues,
  labels,
  projects,
  routineRuns,
  routineRevisions,
  routines,
} from "@paperclipai/db";
import {
  MAX_ROUTINE_STEPS,
  readRoutineStepsRunPayload,
  type EventGrouping,
  type RoutineStep,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture, wireEvent } from "./helpers/event-source-fixture.js";
import { acquireExecutionWorkspaceLifecycleLock } from "../services/execution-workspaces.ts";
import { MAX_CHILD_ISSUES_CREATED_BY_HELPER, issueService } from "../services/issues.ts";
import { inheritRoutineStepWorkspace } from "../services/routine-steps.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine steps tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describeEmbeddedPostgres("routine steps", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-steps-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    const newAgent = async (agentName: string) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name: agentName,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    };
    return { companyId, projectId, newAgent };
  }

  async function seed(
    options: {
      steps?: RoutineStep[];
      concurrencyPolicy?: "coalesce_if_active" | "skip_if_active" | "always_enqueue";
      serviceDb?: ReturnType<typeof createDb>;
    } = {},
  ) {
    const company = await seedCompany();
    const leadId = await company.newAgent("Lead");
    const builderId = await company.newAgent("Builder");
    const reviewerId = await company.newAgent("Reviewer");
    const wakeups: Array<{ agentId: string; issueId: string | null; reason: string | null | undefined }> = [];
    const svc = routineService(options.serviceDb ?? db, {
      heartbeat: {
        wakeup: async (agentId, opts) => {
          const issueId =
            (typeof opts.payload?.issueId === "string" && opts.payload.issueId) ||
            (typeof opts.contextSnapshot?.issueId === "string" && opts.contextSnapshot.issueId) ||
            null;
          wakeups.push({ agentId, issueId, reason: opts.reason });
          return null;
        },
      },
    });
    const create = (steps: RoutineStep[] | undefined, extra: Record<string, unknown> = {}) =>
      svc.create(
        company.companyId,
        {
          projectId: company.projectId,
          goalId: null,
          parentIssueId: null,
          title: "Release check",
          description: "Lead brief",
          assigneeAgentId: leadId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: options.concurrencyPolicy ?? "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          ...(steps ? { steps } : {}),
          ...extra,
        } as never,
        {},
      );
    const routine = await create(options.steps);
    return { ...company, leadId, builderId, reviewerId, wakeups, svc, routine, create };
  }

  const releaseSteps = (builderId: string, reviewerId: string): RoutineStep[] => [
    step("implement", [], { assigneeAgentId: builderId, priority: "high" }),
    step("review", ["implement"], { assigneeAgentId: reviewerId }),
    step("lint", ["review"], { assigneeAgentId: reviewerId }),
    step("types", ["review"], { assigneeAgentId: reviewerId }),
    step("ship", ["lint", "types"]),
  ];

  async function stepIssuesOf(routineId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.originId, routineId), eq(issues.originKind, "routine_step")))
      .orderBy(asc(issues.createdAt), asc(issues.id));
  }

  async function blockersOf(issueId: string) {
    const rows = await db
      .select({ blockerId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
    return rows.map((row) => row.blockerId).sort();
  }

  describe("dispatch", () => {
    it("creates a blocked root and one step issue per step, wired by blockers", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));

      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      expect(run.status).toBe("issue_created");
      const [root] = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
      expect(root).toMatchObject({
        status: "blocked",
        originKind: "routine_execution",
        originId: routine.id,
        originRunId: run.id,
        assigneeAgentId: fx.leadId,
      });

      const stepIssues = await stepIssuesOf(routine.id);
      expect(stepIssues).toHaveLength(5);
      const byTitle = new Map(stepIssues.map((issue) => [issue.title, issue]));
      for (const issue of stepIssues) {
        expect(issue).toMatchObject({ parentId: root!.id, originKind: "routine_step", originRunId: run.id });
      }
      const issueOf = (key: string) => byTitle.get(`Step ${key}`)!;

      expect(issueOf("implement")).toMatchObject({ status: "todo", assigneeAgentId: fx.builderId, priority: "high" });
      expect(issueOf("review")).toMatchObject({ status: "blocked", assigneeAgentId: fx.reviewerId });
      expect(issueOf("ship")).toMatchObject({ status: "blocked", assigneeAgentId: fx.leadId, priority: "medium" });

      expect(await blockersOf(issueOf("implement").id)).toEqual([]);
      expect(await blockersOf(issueOf("review").id)).toEqual([issueOf("implement").id]);
      expect(await blockersOf(issueOf("lint").id)).toEqual([issueOf("review").id]);
      expect(await blockersOf(issueOf("types").id)).toEqual([issueOf("review").id]);
      expect(await blockersOf(issueOf("ship").id)).toEqual([issueOf("lint").id, issueOf("types").id].sort());
      expect(await blockersOf(root!.id)).toEqual(stepIssues.map((issue) => issue.id).sort());
    });

    it("writes the root's blockers once per run, not once per step", async () => {
      const fx = await seed();
      const steps = releaseSteps(fx.builderId, fx.reviewerId);
      const routine = await fx.create(steps);
      // Every blocker write starts with one delete of the issue's blocker rows: count those statements.
      await db.execute(sql`create table routine_steps_test_relation_writes (id serial primary key)`);
      await db.execute(sql`
        create function routine_steps_test_count_relation_write() returns trigger language plpgsql as $$
        begin insert into routine_steps_test_relation_writes default values; return null; end $$
      `);
      await db.execute(sql`
        create trigger routine_steps_test_count_relation_write after delete on issue_relations
        for each statement execute function routine_steps_test_count_relation_write()
      `);
      try {
        const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

        const writes = await db.execute(sql`select count(*)::int as count from routine_steps_test_relation_writes`);
        expect(writes[0]?.count).toBe(steps.length + 1);
        expect(await blockersOf(run.linkedIssueId!)).toHaveLength(steps.length);
      } finally {
        await db.execute(sql`drop trigger routine_steps_test_count_relation_write on issue_relations`);
        await db.execute(sql`drop function routine_steps_test_count_relation_write()`);
        await db.execute(sql`drop table routine_steps_test_relation_writes`);
      }
    });

    it("lets an agent hand the steps of a run only to itself, on the routine row the run uses", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));

      await expect(
        fx.svc.runRoutine(routine.id, { source: "manual", assigneeAgentId: fx.builderId }, { agentId: fx.leadId }),
      ).rejects.toMatchObject({ status: 403, message: "Agents can only assign routine steps to themselves" });
      expect(await stepIssuesOf(routine.id)).toHaveLength(0);

      const own = await fx.svc.runRoutine(
        routine.id,
        { source: "manual", assigneeAgentId: fx.leadId },
        { agentId: fx.leadId },
      );
      expect(own.status).toBe("issue_created");
    });

    it("still lets an agent run a routine without steps for another agent, and a board user name any agent", async () => {
      const fx = await seed({ concurrencyPolicy: "always_enqueue" });
      const stepped = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));

      const plain = await fx.svc.runRoutine(
        fx.routine.id,
        { source: "manual", assigneeAgentId: fx.builderId },
        { agentId: fx.leadId },
      );
      const byBoard = await fx.svc.runRoutine(
        stepped.id,
        { source: "manual", assigneeAgentId: fx.builderId },
        { userId: "board-user" },
      );

      expect(plain.status).toBe("issue_created");
      expect(byBoard.status).toBe("issue_created");
    });

    it("wakes only the steps that start the run, never the root", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));

      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      const stepIssues = await stepIssuesOf(routine.id);
      const implement = stepIssues.find((issue) => issue.title === "Step implement")!;
      expect(fx.wakeups).toEqual([{ agentId: fx.builderId, issueId: implement.id, reason: "issue_assigned" }]);
      expect(fx.wakeups.some((wake) => wake.issueId === run.linkedIssueId)).toBe(false);
    });

    it("still wakes the starting steps and keeps the run when publishing the activity throws", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const unsubscribe = subscribeCompanyLiveEvents(fx.companyId, (event) => {
        if (event.type === "activity.logged") throw new Error("subscriber failed");
      });

      try {
        const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

        expect(run.status).toBe("issue_created");
        const implement = (await stepIssuesOf(routine.id)).find((issue) => issue.title === "Step implement")!;
        expect(fx.wakeups).toEqual([{ agentId: fx.builderId, issueId: implement.id, reason: "issue_assigned" }]);
      } finally {
        unsubscribe();
      }
    });

    it("keeps the step limit equal to the number of children the helper may create under one parent", () => {
      expect(MAX_ROUTINE_STEPS).toBe(MAX_CHILD_ISSUES_CREATED_BY_HELPER);
    });

    it("records the steps and their issue ids on the run", async () => {
      const fx = await seed();
      const steps = releaseSteps(fx.builderId, fx.reviewerId);
      const routine = await fx.create(steps);

      const run = await fx.svc.runRoutine(routine.id, { source: "manual", variables: null });

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      const recorded = readRoutineStepsRunPayload(stored!.triggerPayload);
      expect(recorded?.steps.map((entry) => entry.key)).toEqual(steps.map((entry) => entry.key));
      const stepIssues = await stepIssuesOf(routine.id);
      expect(Object.values(recorded?.stepIssueIds ?? {}).sort()).toEqual(stepIssues.map((issue) => issue.id).sort());
      expect(recorded?.stepIssueIds.implement).toBe(stepIssues.find((issue) => issue.title === "Step implement")!.id);
    });

    it("keeps the recorded steps when the routine is edited later", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      await fx.svc.update(routine.id, { steps: [step("only", [], { assigneeAgentId: fx.builderId })] }, {});

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(readRoutineStepsRunPayload(stored!.triggerPayload)?.steps).toHaveLength(5);
    });

    it("lets steps without an agent run as the routine's agent and fills in variables", async () => {
      const fx = await seed();
      const routine = await fx.create(
        [
          step("prepare", [], {
            title: "Prepare {{target}}",
            description: "Look at {{target}}",
            acceptanceCriteria: ["{{target}} is ready"],
          }),
        ],
        { variables: [{ name: "target", label: null, type: "text", defaultValue: "alpha", required: false, options: [] }] },
      );

      await fx.svc.runRoutine(routine.id, { source: "manual", variables: { target: "beta" } });

      const [prepare] = await stepIssuesOf(routine.id);
      expect(prepare).toMatchObject({ title: "Prepare beta", assigneeAgentId: fx.leadId });
      expect(prepare!.description).toContain("Look at beta");
      expect(prepare!.description).toContain("beta is ready");
    });

    it("writes a child-created activity row per step, ignored by the activity gate actor list", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      await fx.svc.runRoutine(routine.id, { source: "manual" });

      const rows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, fx.companyId), eq(activityLog.action, "issue.child_created")));
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.actorId === "routine-steps")).toBe(true);
      expect(rows.every((row) => (row.details as { routineId?: string } | null)?.routineId === routine.id)).toBe(true);
    });

    it("rolls back the root and every step when a step cannot be created, and records a failed run", async () => {
      const fx = await seed();
      const doomedId = await fx.newAgent("Doomed");
      const routine = await fx.create([
        step("first", [], { assigneeAgentId: fx.builderId }),
        step("second", ["first"], { assigneeAgentId: doomedId }),
      ]);
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, doomedId));

      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      expect(run.status).toBe("failed");
      expect(run.failureReason).toContain('Step "second"');
      expect(run.linkedIssueId).toBeNull();
      expect(await db.select().from(issues).where(eq(issues.companyId, fx.companyId))).toHaveLength(0);
      expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, fx.companyId))).toHaveLength(0);
      expect(fx.wakeups).toHaveLength(0);
    });

    it("coalesces a second run into the open root of the first", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const first = await fx.svc.runRoutine(routine.id, { source: "manual" });

      const second = await fx.svc.runRoutine(routine.id, { source: "manual" });

      expect(second.status).toBe("coalesced");
      expect(second.linkedIssueId).toBe(first.linkedIssueId);
      expect(second.coalescedIntoRunId).toBe(first.id);
      expect(await stepIssuesOf(routine.id)).toHaveLength(5);
    });

    it("skips a second run under skip_if_active and enqueues another under always_enqueue", async () => {
      const skipFx = await seed({ concurrencyPolicy: "skip_if_active" });
      const skipRoutine = await skipFx.create(releaseSteps(skipFx.builderId, skipFx.reviewerId), {
        concurrencyPolicy: "skip_if_active",
      });
      await skipFx.svc.runRoutine(skipRoutine.id, { source: "manual" });
      expect((await skipFx.svc.runRoutine(skipRoutine.id, { source: "manual" })).status).toBe("skipped");

      const queueFx = await seed();
      const queueRoutine = await queueFx.create(releaseSteps(queueFx.builderId, queueFx.reviewerId), {
        concurrencyPolicy: "always_enqueue",
      });
      await queueFx.svc.runRoutine(queueRoutine.id, { source: "manual" });
      const queued = await queueFx.svc.runRoutine(queueRoutine.id, { source: "manual" });
      expect(queued.status).toBe("issue_created");
      expect(await stepIssuesOf(queueRoutine.id)).toHaveLength(10);
    });

    it("runs again once the previous root is closed", async () => {
      const fx = await seed();
      const routine = await fx.create([step("only", [], { assigneeAgentId: fx.builderId })]);
      const first = await fx.svc.runRoutine(routine.id, { source: "manual" });
      await db
        .update(issues)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(issues.id, first.linkedIssueId!));

      const second = await fx.svc.runRoutine(routine.id, { source: "manual" });

      expect(second.status).toBe("issue_created");
      expect(second.linkedIssueId).not.toBe(first.linkedIssueId);
    });

    describe("two runs started together", () => {
      it.each([
        { policy: "coalesce_if_active", followerStatus: "coalesced" },
        { policy: "skip_if_active", followerStatus: "skipped" },
      ] as const)(
        "leave one root and one set of steps under $policy",
        async ({ policy, followerStatus }) => {
          const fx = await seed({ concurrencyPolicy: policy });
          const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));

          const runs = await Promise.all([
            fx.svc.runRoutine(routine.id, { source: "manual" }),
            fx.svc.runRoutine(routine.id, { source: "manual" }),
          ]);

          expect(runs.map((run) => run.status).sort()).toEqual(["issue_created", followerStatus].sort());
          const roots = await db
            .select()
            .from(issues)
            .where(and(eq(issues.originId, routine.id), eq(issues.originKind, "routine_execution")));
          expect(roots).toHaveLength(1);
          expect(await stepIssuesOf(routine.id)).toHaveLength(5);
          expect(fx.wakeups).toHaveLength(1);
        },
      );
    });

    describe("a cancelled step", () => {
      async function setStatuses(routineId: string, statuses: Record<string, string>) {
        const stepIssues = await stepIssuesOf(routineId);
        for (const [key, status] of Object.entries(statuses)) {
          const issue = stepIssues.find((entry) => entry.title === `Step ${key}`)!;
          await db.update(issues).set({ status }).where(eq(issues.id, issue.id));
        }
      }

      it("lets the next run dispatch once a step in the middle of a chain was cancelled", async () => {
        const fx = await seed();
        const routine = await fx.create([
          step("a", [], { assigneeAgentId: fx.builderId }),
          step("b", ["a"], { assigneeAgentId: fx.builderId }),
          step("c", ["b"], { assigneeAgentId: fx.builderId }),
        ]);
        const first = await fx.svc.runRoutine(routine.id, { source: "manual" });
        expect((await fx.svc.runRoutine(routine.id, { source: "manual" })).status).toBe("coalesced");

        await setStatuses(routine.id, { a: "done", b: "cancelled", c: "blocked" });
        const detail = await fx.svc.getDetail(routine.id);
        const second = await fx.svc.runRoutine(routine.id, { source: "manual" });

        expect(detail?.activeIssue).toBeNull();
        expect(second.status).toBe("issue_created");
        expect(second.linkedIssueId).not.toBe(first.linkedIssueId);
        const [oldRoot] = await db.select().from(issues).where(eq(issues.id, first.linkedIssueId!));
        expect(oldRoot!.status).toBe("blocked");
        const stalled = (await stepIssuesOf(routine.id)).filter((entry) => entry.originRunId === first.id);
        expect(stalled.map((entry) => entry.status).sort()).toEqual(["blocked", "cancelled", "done"]);
      });

      it("fails the run when its root is synced after a step in the middle of a chain was cancelled", async () => {
        const fx = await seed();
        const routine = await fx.create([
          step("a", [], { assigneeAgentId: fx.builderId }),
          step("b", ["a"], { assigneeAgentId: fx.builderId }),
          step("c", ["b"], { assigneeAgentId: fx.builderId }),
        ]);
        const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
        await setStatuses(routine.id, { a: "done", b: "cancelled", c: "blocked" });

        await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

        const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
        expect(stored!.status).toBe("failed");
      });

      describe("with several open roots", () => {
        async function stallRun(runId: string) {
          const stepIssues = await db
            .select()
            .from(issues)
            .where(and(eq(issues.originRunId, runId), eq(issues.originKind, "routine_step")));
          for (const [title, status] of [["Step a", "done"], ["Step b", "cancelled"]] as const) {
            await db.update(issues).set({ status }).where(eq(issues.id, stepIssues.find((entry) => entry.title === title)!.id));
          }
        }

        async function touch(issueId: string, offsetMs: number) {
          await db.update(issues).set({ updatedAt: new Date(Date.now() + offsetMs) }).where(eq(issues.id, issueId));
        }

        it("shows the live root in the routine list when a stalled root was updated more recently", async () => {
          const fx = await seed({ concurrencyPolicy: "always_enqueue" });
          const routine = await fx.create([
            step("a", [], { assigneeAgentId: fx.builderId }),
            step("b", ["a"], { assigneeAgentId: fx.builderId }),
          ]);
          const stalled = await fx.svc.runRoutine(routine.id, { source: "manual" });
          const live = await fx.svc.runRoutine(routine.id, { source: "manual" });
          await stallRun(stalled.id);
          await touch(stalled.linkedIssueId!, 60_000);

          const item = (await fx.svc.list(fx.companyId)).find((entry) => entry.id === routine.id);

          expect(item?.activeIssue?.id).toBe(live.linkedIssueId);
        });

        it("finds the live root behind more stalled roots than are read", async () => {
          const fx = await seed();
          const routine = await fx.create([
            step("a", [], { assigneeAgentId: fx.builderId }),
            step("b", ["a"], { assigneeAgentId: fx.builderId }),
          ]);
          const stalledRoots: string[] = [];
          for (let index = 0; index < 27; index += 1) {
            const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
            expect(run.status).toBe("issue_created");
            await stallRun(run.id);
            stalledRoots.push(run.linkedIssueId!);
          }
          const live = await fx.svc.runRoutine(routine.id, { source: "manual" });
          expect(live.status).toBe("issue_created");
          for (const rootId of stalledRoots) await touch(rootId, 60_000);

          const again = await fx.svc.runRoutine(routine.id, { source: "manual" });

          expect(again.status).toBe("coalesced");
          expect(again.linkedIssueId).toBe(live.linkedIssueId);
        }, 60_000);
      });

      it("keeps the routine live while one branch of a fork still runs", async () => {
        const fx = await seed();
        const routine = await fx.create([
          step("a", [], { assigneeAgentId: fx.builderId }),
          step("b", ["a"], { assigneeAgentId: fx.builderId }),
          step("c", ["a"], { assigneeAgentId: fx.builderId }),
          step("d", ["b", "c"], { assigneeAgentId: fx.builderId }),
        ]);
        const first = await fx.svc.runRoutine(routine.id, { source: "manual" });

        await setStatuses(routine.id, { a: "done", b: "cancelled", c: "in_progress", d: "blocked" });
        const running = await fx.svc.runRoutine(routine.id, { source: "manual" });
        expect(running.status).toBe("coalesced");
        expect(running.linkedIssueId).toBe(first.linkedIssueId);
        expect((await fx.svc.getDetail(routine.id))?.activeIssue?.id).toBe(first.linkedIssueId);

        await setStatuses(routine.id, { c: "done" });
        const settled = await fx.svc.runRoutine(routine.id, { source: "manual" });
        expect(settled.status).toBe("issue_created");
        expect(settled.linkedIssueId).not.toBe(first.linkedIssueId);
      });

      it("shows no active issue for a stalled run in the routine list", async () => {
        const fx = await seed();
        const routine = await fx.create([
          step("a", [], { assigneeAgentId: fx.builderId }),
          step("b", ["a"], { assigneeAgentId: fx.builderId }),
        ]);
        await fx.svc.runRoutine(routine.id, { source: "manual" });
        expect((await fx.svc.list(fx.companyId)).find((item) => item.id === routine.id)?.activeIssue).not.toBeNull();

        await setStatuses(routine.id, { a: "cancelled" });

        expect((await fx.svc.list(fx.companyId)).find((item) => item.id === routine.id)?.activeIssue).toBeNull();
      });
    });

    it("reports the open root as the routine's active issue", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      const detail = await fx.svc.getDetail(routine.id);

      expect(detail?.activeIssue?.id).toBe(run.linkedIssueId);
    });

    it("reports the open root in the routine list next to a routine without steps", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
      await fx.svc.runRoutine(fx.routine.id, { source: "manual" });

      const listed = await fx.svc.list(fx.companyId);

      expect(listed.find((item) => item.id === routine.id)?.activeIssue?.id).toBe(run.linkedIssueId);
      expect(listed.find((item) => item.id === fx.routine.id)?.activeIssue).toBeNull();
    });

    it("does not mark a run failed while its blocked root waits for open steps", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(stored!.status).toBe("issue_created");
    });

    it("does not mark a run failed when every step is done and the root only waits to be woken", async () => {
      const fx = await seed();
      const routine = await fx.create([step("only", [], { assigneeAgentId: fx.builderId })]);
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.originKind, "routine_step"));

      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(stored!.status).toBe("issue_created");
    });

    it("still marks a run failed when a step was cancelled and the root is blocked with nothing left to run", async () => {
      const fx = await seed();
      const routine = await fx.create([step("only", [], { assigneeAgentId: fx.builderId })]);
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
      await db
        .update(issues)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(issues.originKind, "routine_step"));

      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(stored!.status).toBe("failed");
    });
  });

  describe("reserved run payload key", () => {
    const forgedPayload = {
      routineSteps: { steps: [step("forged")], stepIssueIds: { forged: randomUUID() } },
      build: 7,
    };

    it("drops the step record a caller sends, so a blocked root of a routine without steps still fails its run", async () => {
      const fx = await seed();
      const run = await fx.svc.runRoutine(fx.routine.id, { source: "api", payload: forgedPayload });
      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(stored!.triggerPayload).toEqual({ build: 7 });

      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, run.linkedIssueId!));
      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [synced] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(synced!.status).toBe("failed");
    });

    it("fails the run of a blocked root instead of throwing when the stored payload is not an object", async () => {
      const fx = await seed();
      const run = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });
      await db.update(routineRuns).set({ triggerPayload: sql`'"text"'::jsonb` }).where(eq(routineRuns.id, run.id));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, run.linkedIssueId!));

      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [synced] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(synced!.status).toBe("failed");
    });
  });

  describe("connection pool", () => {
    it("finishes a 25-step dispatch while concurrent creates queue on the issue counter", async () => {
      const poolDb = createDb(tempDb!.connectionString, { maxConnections: 3 });
      try {
        const fx = await seed({ serviceDb: poolDb });
        const chain = Array.from({ length: 25 }, (_, index) =>
          step(`s${index}`, index === 0 ? [] : [`s${index - 1}`]),
        );
        const routine = await fx.create(chain);
        const issueSvc = issueService(poolDb);

        const counterLockHeld = async () =>
          (
            await db.execute(sql`
              select 1 from pg_locks l join pg_class c on c.oid = l.relation
              where c.relname = 'companies' and l.mode = 'RowExclusiveLock' and l.granted
              limit 1
            `)
          ).length > 0;

        const startedAt = performance.now();
        const elapsed = () => Math.round(performance.now() - startedAt);
        const dispatch = fx.svc.runRoutine(routine.id, { source: "manual" }).then((value) => ({ value, ms: elapsed() }));
        let lockSeenMs = -1;
        while (lockSeenMs < 0 && elapsed() < 10_000) {
          if (await counterLockHeld()) lockSeenMs = elapsed();
          else await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(lockSeenMs).toBeGreaterThanOrEqual(0);

        const others = [0, 1, 2].map((index) =>
          issueSvc
            .create(fx.companyId, { title: `Other ${index}`, status: "todo", assigneeAgentId: fx.leadId })
            .then(() => elapsed()),
        );
        const [dispatched, ...finishedAt] = await within(
          Promise.all([dispatch, ...others]),
          45_000,
          "a 25-step dispatch with three concurrent creates on a 3-connection pool",
        );

        console.info(
          `issue counter lock seen at ${lockSeenMs}ms, dispatch done at ${dispatched.ms}ms, concurrent creates done at ${finishedAt.join("ms, ")}ms`,
        );
        expect(dispatched.value.status).toBe("issue_created");
        expect(await stepIssuesOf(routine.id)).toHaveLength(25);
        expect(Math.min(...finishedAt)).toBeGreaterThanOrEqual(lockSeenMs);
      } finally {
        await poolDb.$client.end({ timeout: 0 }).catch(() => undefined);
      }
    }, 60_000);
  });

  describe("a routine without steps", () => {
    it("creates one todo issue and wakes its agent, exactly as before", async () => {
      const fx = await seed();

      const run = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });

      const [root] = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
      expect(root).toMatchObject({ status: "todo", originKind: "routine_execution", assigneeAgentId: fx.leadId });
      expect(await stepIssuesOf(fx.routine.id)).toHaveLength(0);
      expect(await db.select().from(issues).where(eq(issues.parentId, root!.id))).toHaveLength(0);
      expect(fx.wakeups).toEqual([{ agentId: fx.leadId, issueId: root!.id, reason: "issue_assigned" }]);
      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(readRoutineStepsRunPayload(stored!.triggerPayload)).toBeNull();
      expect(stored!.triggerPayload ?? {}).not.toHaveProperty("routineSteps");
    });

    it("does not treat an open root without a live heartbeat run as active", async () => {
      const fx = await seed();
      const first = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });

      const second = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });

      expect(second.status).toBe("issue_created");
      expect(second.linkedIssueId).not.toBe(first.linkedIssueId);
    });

    it("does not treat an open task from before the routine had steps as active once steps are added", async () => {
      const fx = await seed();
      const plain = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });
      await fx.svc.update(fx.routine.id, { steps: releaseSteps(fx.builderId, fx.reviewerId) }, {});

      expect((await fx.svc.list(fx.companyId)).find((item) => item.id === fx.routine.id)?.activeIssue).toBeNull();
      expect((await fx.svc.getDetail(fx.routine.id))?.activeIssue).toBeNull();
      const stepped = await fx.svc.runRoutine(fx.routine.id, { source: "manual" });

      expect(stepped.status).toBe("issue_created");
      expect(stepped.linkedIssueId).not.toBe(plain.linkedIssueId);
    });

    it("stores no steps in its revision snapshot and an empty list on the row", async () => {
      const fx = await seed();
      const [row] = await db.select().from(routines).where(eq(routines.id, fx.routine.id));
      expect(row!.steps).toEqual([]);
      const [revision] = await db.select().from(routineRevisions).where(eq(routineRevisions.routineId, fx.routine.id));
      expect(revision!.snapshot.routine).not.toHaveProperty("steps");
    });
  });

  describe("saving steps", () => {
    it("rejects a step with no agent when the routine has no default agent", async () => {
      const fx = await seed();
      await expect(
        fx.create([step("orphan")], { assigneeAgentId: null, status: "paused" }),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('Step "orphan"'),
        details: { stepKey: "orphan" },
      });
    });

    it("rejects an agent from another company and names the step", async () => {
      const fx = await seed();
      const other = await seedCompany("Other");
      const strangerId = await other.newAgent("Stranger");
      await expect(
        fx.create([step("ok", [], { assigneeAgentId: fx.builderId }), step("a", ["ok"], { assigneeAgentId: strangerId })]),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Step "a"'), details: { stepKey: "a" } });
    });

    it("rejects a terminated agent and names the step, keeping the conflict status", async () => {
      const fx = await seed();
      const doomedId = await fx.newAgent("Doomed");
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, doomedId));
      await expect(fx.create([step("late", [], { assigneeAgentId: doomedId })])).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('Step "late"'),
        details: { stepKey: "late", code: "agent_not_assignable" },
      });
    });

    it("rejects a label from another company and names the step", async () => {
      const fx = await seed();
      const other = await seedCompany("Other");
      const labelId = randomUUID();
      await db.insert(labels).values({ id: labelId, companyId: other.companyId, name: "theirs", color: "#ff0000" });
      await expect(fx.create([step("a"), step("b", ["a"], { labelIds: [labelId] })])).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('Step "b"'),
        details: { stepKey: "b" },
      });
    });

    it("rejects an agent named in a review stage that belongs to another company", async () => {
      const fx = await seed();
      const other = await seedCompany("Other");
      const strangerId = await other.newAgent("Stranger");
      await expect(
        fx.create([
          step("a", [], {
            executionPolicy: {
              mode: "normal",
              commentRequired: true,
              stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: strangerId }] }],
            },
          }),
        ]),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Step "a"'), details: { stepKey: "a" } });
    });

    it("records steps in the revision, restores them and clears them", async () => {
      const fx = await seed();
      const withSteps = await fx.svc.update(fx.routine.id, { steps: releaseSteps(fx.builderId, fx.reviewerId) }, {});
      expect(withSteps?.steps).toHaveLength(5);
      const revisionWithSteps = withSteps!.latestRevisionId!;

      const cleared = await fx.svc.update(fx.routine.id, { steps: [] }, {});
      expect(cleared?.steps).toEqual([]);
      const [clearedRevision] = await db.select().from(routineRevisions).where(eq(routineRevisions.id, cleared!.latestRevisionId!));
      expect(clearedRevision!.snapshot.routine).not.toHaveProperty("steps");

      const restored = await fx.svc.restoreRevision(fx.routine.id, revisionWithSteps, {});
      expect(restored.routine.steps).toHaveLength(5);
    });

    it("accepts an unrelated edit that sends the stored steps back after a step agent was terminated", async () => {
      const fx = await seed();
      const doomedId = await fx.newAgent("Doomed");
      const steps = [step("a", [], { assigneeAgentId: doomedId }), step("b", ["a"])];
      await fx.svc.update(fx.routine.id, { steps }, {});
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, doomedId));

      const renamed = await fx.svc.update(
        fx.routine.id,
        { title: "Renamed", steps: structuredClone(steps), assigneeAgentId: fx.leadId },
        {},
      );

      expect(renamed?.title).toBe("Renamed");
      await expect(fx.svc.update(fx.routine.id, { steps: [...steps, step("c", ["b"])] }, {})).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('Step "a"'),
      });
    });

    it("re-checks steps when the default agent is removed", async () => {
      const fx = await seed();
      await fx.svc.update(fx.routine.id, { steps: [step("a")] }, {});
      await expect(fx.svc.update(fx.routine.id, { assigneeAgentId: null }, {})).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("workspace handoff", () => {
    async function seedWorkspace(companyId: string, projectId: string) {
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Step worktree",
        status: "active",
        providerType: "git_worktree",
      });
      return executionWorkspaceId;
    }

    async function inherit(companyId: string, issueId: string) {
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      return inheritRoutineStepWorkspace(db, companyId, row!);
    }

    async function seedForkedRun(options: { workspaceStatus?: string } = {}) {
      const fx = await seed();
      const routine = await fx.create([
        step("implement", [], { assigneeAgentId: fx.builderId }),
        step("left", ["implement"], { assigneeAgentId: fx.reviewerId }),
        step("right", ["implement"], { assigneeAgentId: fx.reviewerId }),
      ]);
      await fx.svc.runRoutine(routine.id, { source: "manual" });
      const stepIssues = await stepIssuesOf(routine.id);
      const issueOf = (key: string) => stepIssues.find((issue) => issue.title === `Step ${key}`)!;
      const workspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      if (options.workspaceStatus) {
        await db
          .update(executionWorkspaces)
          .set({ status: options.workspaceStatus })
          .where(eq(executionWorkspaces.id, workspaceId));
      }
      await db
        .update(issues)
        .set({ executionWorkspaceId: workspaceId, status: "done" })
        .where(eq(issues.id, issueOf("implement").id));
      return { fx, issueOf, workspaceId };
    }

    it("points a step at the workspace of the step it waited for", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      await fx.svc.runRoutine(routine.id, { source: "manual" });
      const stepIssues = await stepIssuesOf(routine.id);
      const implement = stepIssues.find((issue) => issue.title === "Step implement")!;
      const review = stepIssues.find((issue) => issue.title === "Step review")!;
      const workspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      await db
        .update(issues)
        .set({ executionWorkspaceId: workspaceId, status: "done" })
        .where(eq(issues.id, implement.id));

      expect(review.executionWorkspaceId).toBeNull();
      expect(await inherit(fx.companyId, review.id)).toBe(true);

      const [updated] = await db.select().from(issues).where(eq(issues.id, review.id));
      expect(updated).toMatchObject({
        executionWorkspaceId: workspaceId,
        executionWorkspacePreference: "reuse_existing",
      });
      expect(updated!.executionWorkspaceSettings).toMatchObject({ mode: "isolated_workspace" });
    });

    it("does not hand a step the workspace of another run's step blocking it by hand", async () => {
      const fx = await seed({ concurrencyPolicy: "always_enqueue" });
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const first = await fx.svc.runRoutine(routine.id, { source: "manual" });
      const second = await fx.svc.runRoutine(routine.id, { source: "manual" });
      const stepIssues = await stepIssuesOf(routine.id);
      const issueOf = (runId: string, key: string) =>
        stepIssues.find((issue) => issue.originRunId === runId && issue.title === `Step ${key}`)!;
      const workspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      await db
        .update(issues)
        .set({ executionWorkspaceId: workspaceId, status: "done" })
        .where(eq(issues.id, issueOf(first.id, "implement").id));
      await db.insert(issueRelations).values({
        companyId: fx.companyId,
        issueId: issueOf(first.id, "implement").id,
        relatedIssueId: issueOf(second.id, "review").id,
        type: "blocks",
      });

      expect(await inherit(fx.companyId, issueOf(second.id, "review").id)).toBe(false);
      const [review] = await db.select().from(issues).where(eq(issues.id, issueOf(second.id, "review").id));
      expect(review!.executionWorkspaceId).toBeNull();
    });

    it("changes nothing for a step without a predecessor workspace, one that has a workspace, or a plain issue", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
      const stepIssues = await stepIssuesOf(routine.id);
      const implement = stepIssues.find((issue) => issue.title === "Step implement")!;
      const review = stepIssues.find((issue) => issue.title === "Step review")!;

      expect(await inherit(fx.companyId, implement.id)).toBe(false);
      expect(await inherit(fx.companyId, review.id)).toBe(false);
      expect(await inherit(fx.companyId, run.linkedIssueId!)).toBe(false);

      const ownWorkspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      const otherWorkspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      await db.update(issues).set({ executionWorkspaceId: ownWorkspaceId }).where(eq(issues.id, implement.id));
      await db.update(issues).set({ executionWorkspaceId: otherWorkspaceId }).where(eq(issues.id, review.id));
      expect(await inherit(fx.companyId, review.id)).toBe(false);
      const [kept] = await db.select().from(issues).where(eq(issues.id, review.id));
      expect(kept!.executionWorkspaceId).toBe(otherWorkspaceId);
    });

    it.each(["archived", "cleanup_failed"])("does not inherit a workspace that is %s", async (workspaceStatus) => {
      const { fx, issueOf } = await seedForkedRun({ workspaceStatus });

      expect(await inherit(fx.companyId, issueOf("left").id)).toBe(false);
      const [left] = await db.select().from(issues).where(eq(issues.id, issueOf("left").id));
      expect(left!.executionWorkspaceId).toBeNull();
    });

    it("waits for an archive in progress and then leaves the step without the workspace", async () => {
      const { fx, issueOf, workspaceId } = await seedForkedRun();
      let archiveMayCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        archiveMayCommit = resolve;
      });
      let archiveHoldsLock!: () => void;
      const lockGate = new Promise<void>((resolve) => {
        archiveHoldsLock = resolve;
      });
      const archive = db.transaction(async (tx) => {
        await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
        await tx
          .update(executionWorkspaces)
          .set({ status: "archived", closedAt: new Date() })
          .where(eq(executionWorkspaces.id, workspaceId));
        archiveHoldsLock();
        await commitGate;
      });
      await lockGate;

      let settled = false;
      const inherited = inherit(fx.companyId, issueOf("left").id);
      inherited.then(
        () => (settled = true),
        () => (settled = true),
      );
      const waitsOnLock = async () =>
        (await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`)).length > 0;
      const startedAt = performance.now();
      while (!settled && !(await waitsOnLock()) && performance.now() - startedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      archiveMayCommit();
      await archive;

      expect(await within(inherited, 10_000, "workspace inheritance after the archive")).toBe(false);
      const [left] = await db.select().from(issues).where(eq(issues.id, issueOf("left").id));
      expect(left!.executionWorkspaceId).toBeNull();
    });

    it("does not overwrite a workspace the step received after it was read", async () => {
      const { fx, issueOf, workspaceId } = await seedForkedRun();
      const [stale] = await db.select().from(issues).where(eq(issues.id, issueOf("left").id));
      const ownWorkspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      await db.update(issues).set({ executionWorkspaceId: ownWorkspaceId }).where(eq(issues.id, stale!.id));

      expect(await inheritRoutineStepWorkspace(db, fx.companyId, stale!)).toBe(false);
      const [after] = await db.select().from(issues).where(eq(issues.id, stale!.id));
      expect(after!.executionWorkspaceId).toBe(ownWorkspaceId);
      expect(after!.executionWorkspaceId).not.toBe(workspaceId);
    });

    it("gives a parallel branch its own workspace while a sibling step still holds the predecessor's", async () => {
      const { fx, issueOf, workspaceId } = await seedForkedRun();

      expect(await inherit(fx.companyId, issueOf("left").id)).toBe(true);
      expect(await inherit(fx.companyId, issueOf("right").id)).toBe(false);
      const [right] = await db.select().from(issues).where(eq(issues.id, issueOf("right").id));
      expect(right!.executionWorkspaceId).toBeNull();

      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueOf("left").id));
      expect(await inherit(fx.companyId, issueOf("right").id)).toBe(true);
      const [reused] = await db.select().from(issues).where(eq(issues.id, issueOf("right").id));
      expect(reused!.executionWorkspaceId).toBe(workspaceId);
    });

    it("lets exactly one of several parallel branches woken together take the predecessor's workspace", async () => {
      const fx = await seed();
      const branchKeys = ["b1", "b2", "b3", "b4", "b5", "b6"];
      const routine = await fx.create([
        step("implement", [], { assigneeAgentId: fx.builderId }),
        ...branchKeys.map((key) => step(key, ["implement"], { assigneeAgentId: fx.reviewerId })),
      ]);
      await fx.svc.runRoutine(routine.id, { source: "manual" });
      const stepIssues = await stepIssuesOf(routine.id);
      const issueOf = (key: string) => stepIssues.find((issue) => issue.title === `Step ${key}`)!;
      const workspaceId = await seedWorkspace(fx.companyId, fx.projectId);
      await db
        .update(issues)
        .set({ executionWorkspaceId: workspaceId, status: "done" })
        .where(eq(issues.id, issueOf("implement").id));

      const results = await Promise.all(branchKeys.map((key) => inherit(fx.companyId, issueOf(key).id)));

      expect(results.filter(Boolean)).toHaveLength(1);
      const holders = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.originId, routine.id), eq(issues.executionWorkspaceId, workspaceId)));
      expect(holders.map((holder) => holder.id).filter((id) => id !== issueOf("implement").id)).toHaveLength(1);
    });

    it("picks the earliest predecessor by issue number", async () => {
      const fx = await seed();
      const routine = await fx.create([
        step("zeta", [], { assigneeAgentId: fx.builderId }),
        step("alpha", [], { assigneeAgentId: fx.builderId }),
        step("join", ["zeta", "alpha"], { assigneeAgentId: fx.reviewerId }),
      ]);
      await fx.svc.runRoutine(routine.id, { source: "manual" });
      const stepIssues = await stepIssuesOf(routine.id);
      const issueOf = (key: string) => stepIssues.find((issue) => issue.title === `Step ${key}`)!;
      const first = await seedWorkspace(fx.companyId, fx.projectId);
      const second = await seedWorkspace(fx.companyId, fx.projectId);
      const [earlier, later] = [issueOf("zeta"), issueOf("alpha")].sort((a, b) => a.issueNumber! - b.issueNumber!);
      await db.update(issues).set({ executionWorkspaceId: first, status: "done" }).where(eq(issues.id, earlier!.id));
      await db.update(issues).set({ executionWorkspaceId: second, status: "done" }).where(eq(issues.id, later!.id));

      expect(await inherit(fx.companyId, issueOf("join").id)).toBe(true);
      const [join] = await db.select().from(issues).where(eq(issues.id, issueOf("join").id));
      expect(join!.executionWorkspaceId).toBe(first);
    });
  });

  describe("event-triggered routines", () => {
    async function setupEventRoutine(grouping: Partial<EventGrouping> = {}) {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const builderId = await fx.createAgent("Builder");
      const routine = await fx.createRoutine({ assigneeAgentId: leadId });
      await fx.routinesSvc.update(
        routine.id,
        { steps: [step("triage", [], { assigneeAgentId: builderId }), step("fix", ["triage"])] },
        {},
      );
      const { source, secret } = await fx.createSource();
      await fx.subscribe(routine.id, source.id, { grouping: { repeatCommentCooldownSec: 600, ...grouping } });
      return { fx, routine, leadId, builderId, source, secret };
    }

    function outcomeOf(response: { body: Record<string, unknown> }) {
      return (response.body.outcomes as Array<{ status: string; issueId?: string | null }>)[0]!;
    }

    it("gives a new group its steps and wakes only the starting step, and a repeat adds none", async () => {
      const { fx, routine, builderId, source, secret } = await setupEventRoutine();

      const first = await fx.send(source, secret, wireEvent({ eventId: "e1" }));
      const outcome = (first.body.outcomes as Array<{ status: string; issueId?: string | null }>)[0]!;
      expect(outcome.status).toBe("issue_created");

      const [root] = await db.select().from(issues).where(eq(issues.id, outcome.issueId!));
      expect(root).toMatchObject({ status: "blocked", originKind: "routine_execution" });
      const stepIssues = await stepIssuesOf(routine.id);
      expect(stepIssues).toHaveLength(2);
      const triage = stepIssues.find((issue) => issue.title === "Step triage")!;
      const fix = stepIssues.find((issue) => issue.title === "Step fix")!;
      expect(triage).toMatchObject({ parentId: root!.id, status: "todo", assigneeAgentId: builderId });
      expect(fix).toMatchObject({ parentId: root!.id, status: "blocked" });
      expect(await blockersOf(fix.id)).toEqual([triage.id]);
      expect(fx.wakeups).toHaveLength(1);
      expect(fx.wakeups[0]).toMatchObject({ agentId: builderId, opts: { reason: "issue_assigned" } });
      expect(fx.wakeups[0]!.opts.contextSnapshot?.issueId).toBe(triage.id);

      const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
      expect(runs).toHaveLength(1);
      expect(readRoutineStepsRunPayload(runs[0]!.triggerPayload)?.stepIssueIds).toEqual({ triage: triage.id, fix: fix.id });

      fx.advance(60_000);
      const silent = await fx.send(source, secret, wireEvent({ eventId: "e2" }));
      expect((silent.body.outcomes as Array<{ status: string }>)[0]!.status).toBe("grouped_silent");
      fx.advance(600_000);
      const repeat = await fx.send(source, secret, wireEvent({ eventId: "e3" }));
      expect((repeat.body.outcomes as Array<{ status: string }>)[0]!.status).toBe("grouped");

      expect(await stepIssuesOf(routine.id)).toHaveLength(2);
      expect(await db.select().from(issues).where(eq(issues.parentId, root!.id))).toHaveLength(2);
    });

    it.each(["ignore", "comment_only", "comment_and_wake"] as const)(
      "adds no steps when a recovery event reaches an open group (onRecovery=%s)",
      async (onRecovery) => {
        const { fx, routine, source, secret } = await setupEventRoutine({ onRecovery });
        const first = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1" })));
        expect(first.status).toBe("issue_created");
        const wakesBefore = fx.wakeups.length;

        fx.advance(60_000);
        const recovery = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e2", state: "recovery", severity: "info" })));
        expect(recovery.status).toBe(onRecovery === "ignore" ? "recovery_ignored" : "recovered");
        expect(recovery.issueId).toBe(first.issueId);

        expect(await stepIssuesOf(routine.id)).toHaveLength(2);
        expect(await db.select().from(issues).where(eq(issues.parentId, first.issueId!))).toHaveLength(2);
        const [root] = await db.select().from(issues).where(eq(issues.id, first.issueId!));
        expect(root!.status).toBe("blocked");
        const stepWakes = fx.wakeups.slice(wakesBefore).filter((wake) => wake.opts.reason === "issue_assigned");
        expect(stepWakes).toEqual([]);
      },
    );

    describe("a repeat or recovery reaching an open group", () => {
      const commentWakes = (fx: Awaited<ReturnType<typeof setupEventRoutine>>["fx"], from: number) =>
        fx.wakeups.slice(from).filter((wake) => wake.opts.reason === "issue_commented");

      async function commentsOn(issueId: string) {
        return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      }

      it("posts the comment but leaves the lead asleep while a step is still open", async () => {
        const { fx, source, secret } = await setupEventRoutine();
        const first = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1" })));
        const wakesBefore = fx.wakeups.length;

        fx.advance(600_000);
        const repeat = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e2" })));

        expect(repeat).toMatchObject({ status: "grouped", issueId: first.issueId });
        expect(await commentsOn(first.issueId!)).toHaveLength(1);
        expect(fx.wakeups.slice(wakesBefore)).toEqual([]);
      });

      it("posts a recovery comment but leaves the lead asleep while a step is still open", async () => {
        const { fx, source, secret } = await setupEventRoutine({ onRecovery: "comment_and_wake" });
        const first = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1" })));
        const wakesBefore = fx.wakeups.length;

        fx.advance(60_000);
        const recovery = outcomeOf(
          await fx.send(source, secret, wireEvent({ eventId: "e2", state: "recovery", severity: "info" })),
        );

        expect(recovery).toMatchObject({ status: "recovered", issueId: first.issueId });
        expect(await commentsOn(first.issueId!)).toHaveLength(1);
        expect(fx.wakeups.slice(wakesBefore)).toEqual([]);
      });

      it("wakes the lead for a repeat once every step is closed", async () => {
        const { fx, leadId, routine, source, secret } = await setupEventRoutine();
        const first = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1" })));
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date() })
          .where(and(eq(issues.originId, routine.id), eq(issues.originKind, "routine_step")));
        const wakesBefore = fx.wakeups.length;

        fx.advance(600_000);
        const repeat = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e2" })));

        expect(repeat).toMatchObject({ status: "grouped", issueId: first.issueId });
        const woken = commentWakes(fx, wakesBefore);
        expect(woken).toHaveLength(1);
        expect(woken[0]).toMatchObject({ agentId: leadId });
      });

      it("still wakes the assignee of a routine without steps", async () => {
        const fx = await seedEventFixture(db);
        const leadId = await fx.createAgent("Lead");
        const routine = await fx.createRoutine({ assigneeAgentId: leadId });
        const { source, secret } = await fx.createSource();
        await fx.subscribe(routine.id, source.id, { grouping: { repeatCommentCooldownSec: 600 } });
        await fx.send(source, secret, wireEvent({ eventId: "e1" }));
        const wakesBefore = fx.wakeups.length;

        fx.advance(600_000);
        await fx.send(source, secret, wireEvent({ eventId: "e2" }));

        const woken = commentWakes(fx, wakesBefore);
        expect(woken).toHaveLength(1);
        expect(woken[0]).toMatchObject({ agentId: leadId });
      });
    });

    it("creates no issue and no steps for a recovery event without an open group", async () => {
      const { fx, routine, source, secret } = await setupEventRoutine();

      const recovery = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1", state: "recovery", severity: "info" })));

      expect(recovery.status).toBe("recovery_without_issue");
      expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      expect(fx.wakeups).toHaveLength(0);
    });

    describe("append issue mode", () => {
      async function setupAppendTarget() {
        const fx = await seedEventFixture(db);
        const leadId = await fx.createAgent("Lead");
        const routine = await fx.createRoutine({ assigneeAgentId: leadId });
        const { source } = await fx.createSource();
        const target = await fx.issueSvc.create(fx.companyId, {
          projectId: fx.projectId,
          title: "ongoing",
          status: "todo",
          priority: "medium",
          assigneeAgentId: leadId,
        } as never);
        return { fx, routine, source, target };
      }

      it("rejects an append-mode trigger on a routine that has steps", async () => {
        const { fx, routine, source, target } = await setupAppendTarget();
        await fx.routinesSvc.update(routine.id, { steps: [step("triage"), step("fix", ["triage"])] }, {});

        await expect(
          fx.subscribe(routine.id, source.id, { grouping: { issueMode: { appendToIssueId: target.id } } }),
        ).rejects.toMatchObject({ status: 422, message: "Steps are not supported with append issue mode" });
      });

      it("rejects steps on a routine that has an append-mode trigger", async () => {
        const { fx, routine, source, target } = await setupAppendTarget();
        await fx.subscribe(routine.id, source.id, { grouping: { issueMode: { appendToIssueId: target.id } } });

        await expect(fx.routinesSvc.update(routine.id, { steps: [step("triage")] }, {})).rejects.toMatchObject({
          status: 422,
          message: "Steps are not supported with append issue mode",
        });
        await expect(fx.routinesSvc.update(routine.id, { title: "Renamed" }, {})).resolves.toMatchObject({
          title: "Renamed",
        });
      });

      it("keeps appending to the target for a routine without steps", async () => {
        const fx = await seedEventFixture(db);
        const leadId = await fx.createAgent("Lead");
        const routine = await fx.createRoutine({ assigneeAgentId: leadId });
        const { source, secret } = await fx.createSource();
        const target = await fx.issueSvc.create(fx.companyId, {
          projectId: fx.projectId,
          title: "ongoing",
          status: "todo",
          priority: "medium",
          assigneeAgentId: leadId,
        } as never);
        await fx.subscribe(routine.id, source.id, {
          grouping: { issueMode: { appendToIssueId: target.id }, repeatCommentCooldownSec: 600 },
        });

        const outcome = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1" })));

        expect(outcome).toMatchObject({ status: "grouped", issueId: target.id });
        expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      });
    });

    it("re-checks event-trigger variables when only the steps add a placeholder without a default", async () => {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const routine = await fx.createRoutine({ assigneeAgentId: leadId });
      const { source } = await fx.createSource();
      await fx.subscribe(routine.id, source.id);

      await expect(
        fx.routinesSvc.update(routine.id, { steps: [{ ...step("triage"), title: "Triage {{target}}" }] }, {}),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Event triggers require defaults for required routine variables"),
      });
    });

    it("opens a fresh group with its own steps once the first group's root is closed", async () => {
      const { fx, routine, source, secret } = await setupEventRoutine();
      const first = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1" })));
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, first.issueId!));

      fx.advance(60_000);
      const second = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e2" })));

      expect(second.status).toBe("issue_created");
      expect(second.issueId).not.toBe(first.issueId);
      expect(await stepIssuesOf(routine.id)).toHaveLength(4);
      expect(await db.select().from(issues).where(eq(issues.parentId, second.issueId!))).toHaveLength(2);
      expect(fx.wakeups.filter((wake) => wake.opts.reason === "issue_assigned")).toHaveLength(2);
    });

    it("keeps a routine without steps on a single todo group issue", async () => {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const routine = await fx.createRoutine({ assigneeAgentId: leadId });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(routine.id, source.id, { grouping: { repeatCommentCooldownSec: 600 } });

      await fx.send(source, secret, wireEvent({ eventId: "e1" }));

      const all = await fx.issuesFor(routine.id);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ status: "todo", originKind: "routine_execution" });
      expect(fx.wakeups).toHaveLength(1);
      expect(fx.wakeups[0]!.opts.contextSnapshot?.issueId).toBe(all[0]!.id);
    });
  });
});
