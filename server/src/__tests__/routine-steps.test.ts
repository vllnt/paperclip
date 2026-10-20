import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
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

    it("reports the open root as the routine's active issue", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      const detail = await fx.svc.getDetail(routine.id);

      expect(detail?.activeIssue?.id).toBe(run.linkedIssueId);
    });

    it("does not mark a run failed while its blocked root waits for open steps", async () => {
      const fx = await seed();
      const routine = await fx.create(releaseSteps(fx.builderId, fx.reviewerId));
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });

      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(stored!.status).toBe("issue_created");
    });

    it("still marks a run failed when a root without open steps is blocked", async () => {
      const fx = await seed();
      const routine = await fx.create([step("only", [], { assigneeAgentId: fx.builderId })]);
      const run = await fx.svc.runRoutine(routine.id, { source: "manual" });
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.originKind, "routine_step"));

      await fx.svc.syncRunStatusForIssue(run.linkedIssueId!);

      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
      expect(stored!.status).toBe("failed");
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

    it("creates no issue and no steps for a recovery event without an open group", async () => {
      const { fx, routine, source, secret } = await setupEventRoutine();

      const recovery = outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "e1", state: "recovery", severity: "info" })));

      expect(recovery.status).toBe("recovery_without_issue");
      expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      expect(fx.wakeups).toHaveLength(0);
    });

    it("adds no steps when events are appended to an existing issue", async () => {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const routine = await fx.createRoutine({ assigneeAgentId: leadId });
      await fx.routinesSvc.update(routine.id, { steps: [step("triage"), step("fix", ["triage"])] }, {});
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
      expect(await stepIssuesOf(routine.id)).toHaveLength(0);
      expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      const [appended] = await db.select().from(issues).where(eq(issues.id, target.id));
      expect(appended!.status).toBe("todo");
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
