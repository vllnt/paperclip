import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  routineRuns,
} from "@paperclipai/db";
import { readRoutineStepsRunPayload, type RoutineStep } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { untilAStatementWaitsForALock } from "./helpers/lock-wait.js";
import { MAX_CHILD_ISSUES_CREATED_BY_HELPER, issueService } from "../services/issues.ts";
import { attachRoutineStepsToIssue } from "../services/routine-steps.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine step attach tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

describeEmbeddedPostgres("attaching routine steps to an existing task", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-steps-attach-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { steps?: (ids: { builderId: string; reviewerId: string }) => RoutineStep[] } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    const newAgent = async (name: string) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    };
    const leadId = await newAgent("Lead");
    const builderId = await newAgent("Builder");
    const reviewerId = await newAgent("Reviewer");
    const issueSvc = issueService(db);
    const routineSvc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const steps = options.steps
      ? options.steps({ builderId, reviewerId })
      : [
          step("build", [], { assigneeAgentId: builderId, title: "Build {{issue.identifier}}: {{issue.title}}" }),
          step("review", ["build"], { assigneeAgentId: reviewerId }),
        ];
    const routine = await routineSvc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Release check",
        description: "Lead brief",
        assigneeAgentId: leadId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        steps,
      } as never,
      {},
    );
    const newTask = (extra: Partial<Parameters<typeof issueSvc.create>[1]> = {}) =>
      issueSvc.create(companyId, {
        title: "Fix login",
        status: "todo",
        priority: "medium",
        projectId,
        assigneeAgentId: leadId,
        ...extra,
      });
    const newRun = async () => {
      const id = randomUUID();
      await db.insert(routineRuns).values({ id, companyId, routineId: routine.id, source: "manual", status: "received" });
      return { id };
    };
    const attach = async (
      issueId: string,
      extra: Partial<Parameters<typeof attachRoutineStepsToIssue>[0]> = {},
      forCompanyId = companyId,
      database: ReturnType<typeof createDb> = db,
    ) => {
      const run = await newRun();
      return database.transaction((tx) =>
        attachRoutineStepsToIssue({
          tx,
          issueSvc,
          companyId: forCompanyId,
          issueId,
          run,
          routine,
          steps,
          defaultAssigneeAgentId: leadId,
          variables: {},
          ...extra,
        }),
      );
    };
    return { companyId, projectId, leadId, builderId, reviewerId, routine, steps, newAgent, newTask, newRun, attach };
  }

  async function refusal(work: Promise<unknown>): Promise<HttpError> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }

  async function childrenOf(parentId: string) {
    return db.select().from(issues).where(eq(issues.parentId, parentId)).orderBy(asc(issues.createdAt), asc(issues.id));
  }

  async function blockersOf(issueId: string) {
    const rows = await db
      .select({ blockerId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
    return rows.map((row) => row.blockerId).sort();
  }

  async function taskRow(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  it("puts the steps under an agent-owned task and sets it to blocked", async () => {
    const fx = await seed();
    const task = await fx.newTask();

    const { root, attached } = await fx.attach(task.id);

    expect(root).toMatchObject({ id: task.id, status: "blocked", assigneeAgentId: fx.leadId });
    expect(await taskRow(task.id)).toMatchObject({ status: "blocked", originKind: task.originKind });
    const children = await childrenOf(task.id);
    const build = children.find((child) => child.title === `Build ${task.identifier}: Fix login`);
    const review = children.find((child) => child.title === "Step review");
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.originKind === "routine_step")).toBe(true);
    expect(await blockersOf(task.id)).toEqual(children.map((child) => child.id).sort());
    expect(build).toMatchObject({ status: "todo", assigneeAgentId: fx.builderId });
    expect(review).toMatchObject({ status: "blocked", assigneeAgentId: fx.reviewerId });
    expect(attached.startingIssues.map((issue) => issue.id)).toEqual([build!.id]);
  });

  it("records the steps on the run and the status change in the activity log", async () => {
    const fx = await seed();
    const task = await fx.newTask({ status: "backlog" });
    const run = await fx.newRun();

    const { attached } = await db.transaction((tx) =>
      attachRoutineStepsToIssue({
        tx,
        issueSvc: issueService(db),
        companyId: fx.companyId,
        issueId: task.id,
        run,
        routine: fx.routine,
        steps: fx.steps,
        defaultAssigneeAgentId: fx.leadId,
        variables: {},
      }),
    );

    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
    const recorded = readRoutineStepsRunPayload(stored!.triggerPayload);
    expect(Object.keys(recorded?.stepIssueIds ?? {})).toEqual(["build", "review"]);
    const updates = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.updated")));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ actorType: "system", actorId: "routine-steps" });
    expect(updates[0]!.details).toMatchObject({ status: "blocked", _previous: { status: "backlog" }, routineRunId: run.id });
    expect(attached.activityPublications.length).toBe(1 + fx.steps.length);
  });

  it("leaves a task no agent owns in its status and only adds the blocker edges", async () => {
    const fx = await seed();
    await db.insert(companyMemberships).values({
      companyId: fx.companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
    });
    const task = await fx.newTask({ assigneeAgentId: null, assigneeUserId: "board-user", status: "todo" });

    const { root } = await fx.attach(task.id);

    expect(root.status).toBe("todo");
    expect(await taskRow(task.id)).toMatchObject({ status: "todo", assigneeUserId: "board-user" });
    const children = await childrenOf(task.id);
    expect(children).toHaveLength(2);
    expect(await blockersOf(task.id)).toEqual(children.map((child) => child.id).sort());
    const updates = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.updated")));
    expect(updates).toHaveLength(0);
  });

  it("keeps a task that is already blocked as it is and keeps its other blockers", async () => {
    const fx = await seed();
    const other = await fx.newTask({ title: "Other work" });
    const task = await fx.newTask({ status: "blocked", blockedByIssueIds: [other.id] });

    await fx.attach(task.id);

    const children = await childrenOf(task.id);
    expect(await blockersOf(task.id)).toEqual([other.id, ...children.map((child) => child.id)].sort());
    expect((await taskRow(task.id)).status).toBe("blocked");
  });

  it("keeps the task, removes the created steps and restores the status when a later step fails", async () => {
    const fx = await seed({
      steps: ({ builderId, reviewerId }) => [
        step("first", [], { assigneeAgentId: builderId }),
        step("second", ["first"], { assigneeAgentId: reviewerId }),
      ],
    });
    const task = await fx.newTask();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, fx.reviewerId));
    const run = await fx.newRun();

    const error = await refusal(
      db.transaction((tx) =>
        attachRoutineStepsToIssue({
          tx,
          issueSvc: issueService(db),
          companyId: fx.companyId,
          issueId: task.id,
          run,
          routine: fx.routine,
          steps: fx.steps,
          defaultAssigneeAgentId: fx.leadId,
          variables: {},
        }),
      ),
    );

    expect(error.message).toContain('Step "second"');
    expect(await taskRow(task.id)).toMatchObject({ status: "todo", assigneeAgentId: fx.leadId });
    expect(await childrenOf(task.id)).toHaveLength(0);
    expect(await blockersOf(task.id)).toEqual([]);
    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
    expect(readRoutineStepsRunPayload(stored!.triggerPayload)).toBeNull();
    const updates = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.updated")));
    expect(updates).toHaveLength(0);
  });

  it("keeps the task when the caller's own transaction goes on after the refusal", async () => {
    const fx = await seed({
      steps: ({ builderId, reviewerId }) => [
        step("first", [], { assigneeAgentId: builderId }),
        step("second", ["first"], { assigneeAgentId: reviewerId }),
      ],
    });
    const task = await fx.newTask();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, fx.reviewerId));
    const run = await fx.newRun();

    await db.transaction(async (tx) => {
      await attachRoutineStepsToIssue({
        tx,
        issueSvc: issueService(db),
        companyId: fx.companyId,
        issueId: task.id,
        run,
        routine: fx.routine,
        steps: fx.steps,
        defaultAssigneeAgentId: fx.leadId,
        variables: {},
      }).catch(() => null);
      await tx.update(routineRuns).set({ status: "failed" }).where(eq(routineRuns.id, run.id));
    });

    expect(await taskRow(task.id)).toMatchObject({ status: "todo" });
    expect(await childrenOf(task.id)).toHaveLength(0);
    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, run.id));
    expect(stored!.status).toBe("failed");
  });

  describe("refusals", () => {
    it("answers 404 for a task of another company and for a task that does not exist", async () => {
      const fx = await seed();
      const other = await seed();
      const foreign = await other.newTask();

      expect((await refusal(fx.attach(foreign.id))).status).toBe(404);
      expect((await refusal(fx.attach(randomUUID()))).status).toBe(404);
      expect(await childrenOf(foreign.id)).toHaveLength(0);
    });

    it("answers 404 for a hidden task", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, task.id));

      expect((await refusal(fx.attach(task.id))).status).toBe(404);
    });

    it.each(["routine_execution", "routine_step", "chat_channel"])(
      "answers 422 for a task whose origin is %s",
      async (originKind) => {
        const fx = await seed();
        const task = await fx.newTask();
        await db.update(issues).set({ originKind }).where(eq(issues.id, task.id));

        expect((await refusal(fx.attach(task.id))).status).toBe(422);
        expect(await childrenOf(task.id)).toHaveLength(0);
      },
    );

    it("answers 422 for a conversation", async () => {
      const fx = await seed();
      const task = await fx.newTask({
        conversationAgentId: fx.leadId,
        conversationUserId: "board-user",
        conversationState: "active",
        assigneeAgentId: fx.leadId,
      });

      expect((await refusal(fx.attach(task.id))).status).toBe(422);
    });

    it.each(["in_progress", "in_review", "done", "cancelled"])("answers 409 for a task in %s", async (status) => {
      const fx = await seed();
      const task = await fx.newTask();
      await db.update(issues).set({ status }).where(eq(issues.id, task.id));

      const error = await refusal(fx.attach(task.id));

      expect(error.status).toBe(409);
      expect(await childrenOf(task.id)).toHaveLength(0);
      expect((await taskRow(task.id)).status).toBe(status);
    });

    it("answers 409 for a task that holds a checkout or an execution run", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fx.companyId,
        agentId: fx.leadId,
        invocationSource: "assignment",
        status: "running",
        responsibleUserId: randomUUID(),
        contextSnapshot: {},
      });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, task.id));
      const checkedOut = await fx.newTask();
      await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, checkedOut.id));

      expect((await refusal(fx.attach(task.id))).status).toBe(409);
      expect((await refusal(fx.attach(checkedOut.id))).status).toBe(409);
      expect(await childrenOf(task.id)).toHaveLength(0);
      expect(await childrenOf(checkedOut.id)).toHaveLength(0);
    });

    it("answers 409 for a task a queued run is about to work on, and allows it once the run finished", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fx.companyId,
        agentId: fx.leadId,
        invocationSource: "assignment",
        status: "queued",
        responsibleUserId: randomUUID(),
        contextSnapshot: { issueId: task.id },
      });

      expect((await refusal(fx.attach(task.id))).status).toBe(409);

      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      await fx.attach(task.id);
      expect(await childrenOf(task.id)).toHaveLength(2);
    });

    it("answers 409 when the task already has routine steps in progress, whatever started them", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      await fx.attach(task.id);

      const error = await refusal(fx.attach(task.id));

      expect(error.status).toBe(409);
      expect(await childrenOf(task.id)).toHaveLength(2);
    });

    it("attaches again once the earlier steps are done", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      await fx.attach(task.id);
      await db.update(issues).set({ status: "done" }).where(eq(issues.parentId, task.id));
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, task.id));

      await fx.attach(task.id);

      expect(await childrenOf(task.id)).toHaveLength(4);
    });

    it("answers 422 when the steps would pass the child limit, and allows exactly the limit", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      for (let index = 0; index < MAX_CHILD_ISSUES_CREATED_BY_HELPER - fx.steps.length + 1; index += 1) {
        await db.insert(issues).values({
          companyId: fx.companyId,
          title: `Existing ${index}`,
          status: "done",
          priority: "medium",
          parentId: task.id,
        });
      }

      expect((await refusal(fx.attach(task.id))).status).toBe(422);
      expect(await childrenOf(task.id)).toHaveLength(MAX_CHILD_ISSUES_CREATED_BY_HELPER - fx.steps.length + 1);

      const edge = await fx.newTask({ title: "Edge" });
      for (let index = 0; index < MAX_CHILD_ISSUES_CREATED_BY_HELPER - fx.steps.length; index += 1) {
        await db.insert(issues).values({
          companyId: fx.companyId,
          title: `Existing ${index}`,
          status: "done",
          priority: "medium",
          parentId: edge.id,
        });
      }
      await fx.attach(edge.id);
      expect(await childrenOf(edge.id)).toHaveLength(MAX_CHILD_ISSUES_CREATED_BY_HELPER);
    });

    it("lets the caller refuse a task before anything is created", async () => {
      const fx = await seed();
      const task = await fx.newTask();
      let seen: string | null = null;

      const error = await refusal(
        fx.attach(task.id, {
          assertCanStart: async (issue) => {
            seen = issue.id;
            throw new HttpError(409, "The agent is paused");
          },
        }),
      );

      expect(error.message).toBe("The agent is paused");
      expect(seen).toBe(task.id);
      expect(await childrenOf(task.id)).toHaveLength(0);
      expect((await taskRow(task.id)).status).toBe("todo");
    });
  });

  it("builds exactly one tree when two attaches race on one task", async () => {
    const fx = await seed();
    const task = await fx.newTask();
    const poolDb = createDb(tempDb!.connectionString, { maxConnections: 4 });

    const results = await Promise.allSettled([
      fx.attach(task.id, {}, fx.companyId, poolDb),
      fx.attach(task.id, {}, fx.companyId, poolDb),
      fx.attach(task.id, {}, fx.companyId, poolDb),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const reason of rejected) {
      expect(reason).toBeInstanceOf(HttpError);
      expect(reason.status).toBe(409);
    }
    expect(await childrenOf(task.id)).toHaveLength(2);
    expect((await taskRow(task.id)).status).toBe("blocked");
  }, 30_000);

  it("lets a subtask be created by hand while the steps are attached, without a deadlock", async () => {
    const fx = await seed();
    const task = await fx.newTask();
    let counterTaken!: () => void;
    const counterHeld = new Promise<void>((resolve) => {
      counterTaken = resolve;
    });
    let letChildGo!: () => void;
    const childMayGo = new Promise<void>((resolve) => {
      letChildGo = resolve;
    });
    // As a subtask create does: the company issue counter first, then the key-share lock on the parent.
    const handMade = db.transaction(async (tx) => {
      await tx
        .update(companies)
        .set({ issueCounter: sql`${companies.issueCounter} + 1` })
        .where(eq(companies.id, fx.companyId));
      counterTaken();
      await childMayGo;
      await tx.insert(issues).values({ companyId: fx.companyId, title: "Hand-made subtask", parentId: task.id });
    });
    await counterHeld;

    // The attach locks the task, then waits for the counter to number its first step.
    const attaching = fx.attach(task.id);
    await untilAStatementWaitsForALock(db);
    letChildGo();

    await expect(handMade).resolves.toBeUndefined();
    await expect(attaching).resolves.toMatchObject({ root: { id: task.id } });
    expect(await childrenOf(task.id)).toHaveLength(3);
  }, 30_000);

  it("lets a task blocked by the task be created while the steps are attached, without a deadlock", async () => {
    const fx = await seed();
    const task = await fx.newTask();
    let counterTaken!: () => void;
    const counterHeld = new Promise<void>((resolve) => {
      counterTaken = resolve;
    });
    let letBlockerGo!: () => void;
    const blockerMayGo = new Promise<void>((resolve) => {
      letBlockerGo = resolve;
    });
    // As a create with blockedByIssueIds does: the company issue counter first, then FOR UPDATE on the blocker.
    const blockedCreate = db.transaction(async (tx) => {
      await tx
        .update(companies)
        .set({ issueCounter: sql`${companies.issueCounter} + 1` })
        .where(eq(companies.id, fx.companyId));
      counterTaken();
      await blockerMayGo;
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${task.id} for update`);
    });
    await counterHeld;

    const attaching = fx.attach(task.id);
    await untilAStatementWaitsForALock(db);
    letBlockerGo();

    await expect(blockedCreate).resolves.toBeUndefined();
    await expect(attaching).resolves.toMatchObject({ root: { id: task.id } });
    expect(await childrenOf(task.id)).toHaveLength(2);
  }, 30_000);
});
