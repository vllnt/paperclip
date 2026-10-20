import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, issues, projects, routineRuns } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, readRoutineStepsRunPayload, type RoutineStep } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture } from "./helpers/event-source-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";
import { routineService } from "../services/routines.js";

// The routes wake the agents of the steps that start. Recording the wakes shows which agents the run
// asked for, and keeps the test from starting an adapter.
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: vi.fn(async () => undefined) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine run on task tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

describeEmbeddedPostgres("running a routine on an existing task", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-run-on-task-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.mocked(queueIssueAssignmentWakeup).mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const newProject = async (name: string) => {
      const id = randomUUID();
      await db.insert(projects).values({ id, companyId, name, status: "in_progress" });
      return id;
    };
    const newAgent = async (name: string, extra: { status?: "active" | "paused"; permissions?: Record<string, unknown> } = {}) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: extra.status ?? "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: extra.permissions ?? {},
      });
      return id;
    };
    return { companyId, newProject, newAgent };
  }

  async function seed() {
    const company = await seedCompany();
    const { companyId } = company;
    const projectId = await company.newProject("Work");
    const leadId = await company.newAgent("Lead");
    const builderId = await company.newAgent("Builder");
    const reviewerId = await company.newAgent("Reviewer");
    const issueSvc = issueService(db);
    const routineSvc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const createRoutine = (patch: { steps?: RoutineStep[]; assigneeAgentId?: string } = {}) =>
      routineSvc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "Release check",
          description: "Lead brief",
          assigneeAgentId: patch.assigneeAgentId ?? leadId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          steps: patch.steps ?? [
            step("build", [], { assigneeAgentId: builderId, title: "Build {{issue.identifier}}: {{issue.title}}" }),
            step("review", ["build"], { assigneeAgentId: reviewerId }),
          ],
        } as never,
        {},
      );
    const newTask = (extra: Partial<Parameters<typeof issueSvc.create>[1]> = {}, forCompanyId = companyId) =>
      issueSvc.create(forCompanyId, {
        title: "Fix login",
        status: "todo",
        priority: "medium",
        projectId,
        assigneeAgentId: leadId,
        createdByUserId: "board-user",
        ...extra,
      });
    const childrenOf = (taskId: string) =>
      db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.parentId, taskId)));
    const runsOf = (routineId: string) => db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
    return { ...company, projectId, leadId, builderId, reviewerId, createRoutine, newTask, childrenOf, runsOf, issueSvc };
  }

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { actor });
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardActor = (companyId: string) => ({
    type: "board",
    userId: "board-user",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
  });
  const agentActor = (companyId: string, agentId: string) => ({ type: "agent", agentId, companyId, source: "agent_key" });

  describe("on success", () => {
    it("answers 202 with the run on the task, puts the steps under it and wakes only the first step's agent", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ status: "issue_created", linkedIssueId: task.id, source: "manual", warnings: [] });
      const children = await s.childrenOf(task.id);
      expect(children.map((child) => child.title).sort()).toEqual([`Build ${task.identifier}: Fix login`, "Step review"]);
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after).toMatchObject({ status: "blocked", assigneeAgentId: s.leadId });
      const wakes = vi.mocked(queueIssueAssignmentWakeup).mock.calls.map(([input]) => input.issue.assigneeAgentId);
      expect(wakes).toEqual([s.builderId]);
    });

    it("records the task and the steps on the run, and the task in the activity entry", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      const [run] = await s.runsOf(routine.id);
      expect(run).toMatchObject({ id: response.body.id, linkedIssueId: task.id, triggerId: null });
      expect(run?.triggerPayload).toMatchObject({ targetIssueId: task.id });
      expect(Object.keys(readRoutineStepsRunPayload(run?.triggerPayload)?.stepIssueIds ?? {}).sort()).toEqual(["build", "review"]);
      const [entry] = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.action, "routine.run_triggered"), eq(activityLog.entityId, run!.id)));
      expect(entry?.details).toMatchObject({ routineId: routine.id, status: "issue_created", targetIssueId: task.id });
      // The step rows keep the system as their actor, so the activity gate leaves them out, and name the caller.
      const requestedBy = { actorType: "user", actorId: "board-user", runId: null };
      const [blocked] = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.action, "issue.updated"), eq(activityLog.entityId, task.id)));
      expect(blocked).toMatchObject({ actorType: "system", details: { status: "blocked", requestedBy } });
      const stepRows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.action, "issue.child_created"), eq(activityLog.companyId, s.companyId)));
      expect(stepRows).toHaveLength(2);
      for (const row of stepRows) expect(row).toMatchObject({ actorType: "system", details: { parentId: task.id, requestedBy } });
    });

    it("leaves a task nobody owns in its status", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask({ assigneeAgentId: null });

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(202);
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after?.status).toBe("todo");
      expect(await s.childrenOf(task.id)).toHaveLength(2);
    });

    it("returns the run it made again for a repeated idempotency key, without a second tree", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();
      const app = appFor(boardActor(s.companyId));

      const first = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id, idempotencyKey: "start-1" });
      const second = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id, idempotencyKey: "start-1" });

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(await s.childrenOf(task.id)).toHaveLength(2);
      expect(await s.runsOf(routine.id)).toHaveLength(1);
    });
  });

  describe("when the task is refused", () => {
    it("answers 409 for a task being worked on and leaves no run, no steps and the task as it was", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask({ status: "in_progress" });

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("in_progress");
      expect(await s.childrenOf(task.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after?.status).toBe("in_progress");
      expect(queueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });

    it("answers 409 for a second run while the first run's steps are open", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();
      const app = appFor(boardActor(s.companyId));

      const first = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id });
      const second = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id });

      expect(first.status).toBe(202);
      expect(second.status).toBe(409);
      expect(second.body.error).toContain("routine steps in progress");
      expect(await s.childrenOf(task.id)).toHaveLength(2);
      expect(await s.runsOf(routine.id)).toHaveLength(1);
    });

    it("lets the routine run on the task again once its steps are done", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();
      const app = appFor(boardActor(s.companyId));
      await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id }).expect(202);
      await db
        .update(issues)
        .set({ status: "done" })
        .where(and(eq(issues.parentId, task.id), eq(issues.originKind, "routine_step")));
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, task.id));

      const again = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id });

      expect(again.status).toBe(202);
      expect(await s.childrenOf(task.id)).toHaveLength(4);
    });

    it("answers 422 for a routine without steps", async () => {
      const s = await seed();
      const routine = await s.createRoutine({ steps: [] });
      const task = await s.newTask();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(422);
      expect(response.body.error).toContain("no steps");
      expect(await s.childrenOf(task.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
    });

    it("answers 404 for a task of another company and does not touch it", async () => {
      const s = await seed();
      const other = await seed();
      const routine = await s.createRoutine();
      const foreign = await other.newTask();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: foreign.id });

      expect(response.status).toBe(404);
      expect(await other.childrenOf(foreign.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
    });

    it("answers 404 for a task that does not exist", async () => {
      const s = await seed();
      const routine = await s.createRoutine();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: randomUUID() });

      expect(response.status).toBe(404);
    });

    it("answers 409 when the first step's agent cannot be woken and leaves the task alone", async () => {
      const s = await seed();
      const pausedId = await s.newAgent("Paused", { status: "paused" });
      const routine = await s.createRoutine({ steps: [step("build", [], { assigneeAgentId: pausedId })] });
      const task = await s.newTask();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(409);
      expect(await s.childrenOf(task.id)).toEqual([]);
      const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
      expect(after?.status).toBe("todo");
    });

    it("answers 422 for a run that names a trigger, whatever the trigger is", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const otherRoutine = await s.createRoutine();
      const task = await s.newTask();
      const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
      const schedule = { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" } as const;
      const { trigger } = await svc.createTrigger(routine.id, schedule, {});
      const { trigger: switchedOff } = await svc.createTrigger(routine.id, { ...schedule, enabled: false }, {});
      const { trigger: foreign } = await svc.createTrigger(otherRoutine.id, schedule, {});
      const app = appFor(boardActor(s.companyId));

      for (const triggerId of [trigger.id, switchedOff.id, foreign.id, randomUUID()]) {
        const response = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id, triggerId });
        expect(response.status, triggerId).toBe(422);
      }
      expect(await s.childrenOf(task.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
    });

    it("answers 422 for a run that also names a project or a workspace", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();
      const app = appFor(boardActor(s.companyId));

      const withProject = await request(app)
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id, projectId: s.projectId });
      const withWorkspace = await request(app)
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id, executionWorkspacePreference: "shared_workspace" });

      expect(withProject.status).toBe(422);
      expect(withWorkspace.status).toBe(422);
      expect(await s.childrenOf(task.id)).toEqual([]);
    });

    it("answers 404 for a hidden task, to the board and to an agent", async () => {
      const s = await seed();
      const outsideProjectId = await s.newProject("Elsewhere");
      const guardedId = await s.newAgent("Guarded", {
        permissions: {
          authorizationPolicy: {
            trustPreset: LOW_TRUST_REVIEW_PRESET,
            trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: s.companyId, projectIds: [s.projectId] },
          },
        },
      });
      const routine = await s.createRoutine();
      const guardedRoutine = await s.createRoutine({ assigneeAgentId: guardedId });
      const task = await s.newTask();
      const outside = await s.newTask({ projectId: outsideProjectId, assigneeAgentId: null });
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, task.id));
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, outside.id));

      const asBoard = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });
      const asAgent = await request(appFor(agentActor(s.companyId, s.leadId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });
      const asAgentOutsideItsBoundary = await request(appFor(agentActor(s.companyId, guardedId)))
        .post(`/api/routines/${guardedRoutine.id}/run`)
        .send({ targetIssueId: outside.id });

      expect(asBoard.status).toBe(404);
      expect(asAgent.status).toBe(404);
      expect(asAgentOutsideItsBoundary.status).toBe(404);
      expect(await s.childrenOf(task.id)).toEqual([]);
      expect(await s.childrenOf(outside.id)).toEqual([]);
    });

    it("answers 409 for an idempotency key already used on another task, and starts nothing there", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const first = await s.newTask();
      const second = await s.newTask({ title: "Fix logout" });
      const app = appFor(boardActor(s.companyId));

      const onFirst = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: first.id, idempotencyKey: "k-1" });
      const onSecond = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: second.id, idempotencyKey: "k-1" });

      expect(onFirst.status).toBe(202);
      expect(onSecond.status).toBe(409);
      expect(await s.childrenOf(second.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toHaveLength(1);
    });

    it("answers 409 for a run without a task that reuses the key of a run on a task", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();
      const app = appFor(boardActor(s.companyId));

      const onTask = await request(app).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: task.id, idempotencyKey: "k-1" });
      const plain = await request(app).post(`/api/routines/${routine.id}/run`).send({ idempotencyKey: "k-1" });

      expect(onTask.status).toBe(202);
      expect(plain.status).toBe(409);
      expect(await s.runsOf(routine.id)).toHaveLength(1);
    });
  });

  describe("for a board member", () => {
    it("is refused when the task blocks a step's agent, and the task is left alone", async () => {
      const s = await seed();
      await db.insert(companyMemberships).values({
        companyId: s.companyId,
        principalType: "user",
        principalId: "operator-user",
        status: "active",
        membershipRole: "operator",
      });
      const operator = { type: "board", userId: "operator-user", source: "session", isInstanceAdmin: false, companyIds: [s.companyId] };
      const routine = await s.createRoutine();
      const guarded = await s.newTask();
      const open = await s.newTask();
      await db
        .update(issues)
        .set({
          executionPolicy: {
            authorizationPolicy: {
              assignmentPolicy: { mode: "protected" },
              protectedAgent: { blockAssignment: true, blockReason: "Release owner only" },
              managedBy: "permissions-extension",
            },
          } as never,
        })
        .where(eq(issues.id, guarded.id));

      const refused = await request(appFor(operator)).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: guarded.id });
      const allowed = await request(appFor(operator)).post(`/api/routines/${routine.id}/run`).send({ targetIssueId: open.id });

      expect(refused.status).toBe(403);
      expect(await s.childrenOf(guarded.id)).toEqual([]);
      expect(allowed.status).toBe(202);
      expect(await s.childrenOf(open.id)).toHaveLength(2);
    });
  });

  describe("for an agent", () => {
    const lowTrustPermissions = (companyId: string, projectIds: string[]) => ({
      authorizationPolicy: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, projectIds },
      },
    });

    it("starts the steps on a task the agent may change", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();

      const response = await request(appFor(agentActor(s.companyId, s.leadId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(202);
      expect(await s.childrenOf(task.id)).toHaveLength(2);
    });

    it("is refused on a task outside its authorization boundary and the task is left alone", async () => {
      const s = await seed();
      const insideProjectId = s.projectId;
      const outsideProjectId = await s.newProject("Elsewhere");
      const guardedId = await s.newAgent("Guarded", { permissions: lowTrustPermissions(s.companyId, [insideProjectId]) });
      const routine = await s.createRoutine({ assigneeAgentId: guardedId });
      const outside = await s.newTask({ projectId: outsideProjectId, assigneeAgentId: null });

      const response = await request(appFor(agentActor(s.companyId, guardedId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: outside.id });

      expect(response.status).toBe(403);
      expect(await s.childrenOf(outside.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
    });

    it("is refused when the steps may not be assigned under the task, and the task is left alone", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();
      await db
        .update(issues)
        .set({
          executionPolicy: {
            authorizationPolicy: {
              assignmentPolicy: { mode: "protected" },
              protectedAgent: { blockAssignment: true, blockReason: "Release owner only" },
              managedBy: "permissions-extension",
            },
          } as never,
        })
        .where(eq(issues.id, task.id));

      const response = await request(appFor(agentActor(s.companyId, s.leadId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(403);
      expect(await s.childrenOf(task.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
    });

    it("cannot set up an event_issue trigger, even on its own routine", async () => {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const { source } = await fx.sources.ensureInternal(fx.companyId, { userId: "board-user" });
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
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          steps: [step("build")],
        } as never,
        {},
      );
      const body = { kind: "event", eventSourceId: source.id, eventGrouping: { issueMode: "event_issue" } };

      const asAgent = await request(appFor(agentActor(fx.companyId, leadId))).post(`/api/routines/${routine.id}/triggers`).send(body);
      const asBoard = await request(appFor(boardActor(fx.companyId))).post(`/api/routines/${routine.id}/triggers`).send(body);

      expect(asAgent.status).toBe(403);
      expect(asBoard.status).toBe(201);
    });

    it("sees the task of a run only when it may read the task", async () => {
      const s = await seed();
      const outsideProjectId = await s.newProject("Elsewhere");
      const guardedId = await s.newAgent("Guarded", { permissions: lowTrustPermissions(s.companyId, [s.projectId]) });
      const routine = await s.createRoutine();
      const outside = await s.newTask({ title: "Quarterly figures", projectId: outsideProjectId, assigneeAgentId: null });
      const run = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: outside.id });
      expect(run.status).toBe(202);
      const read = async (agentId: string) => {
        const app = appFor(agentActor(s.companyId, agentId));
        const [runs, detail, list] = await Promise.all([
          request(app).get(`/api/routines/${routine.id}/runs`),
          request(app).get(`/api/routines/${routine.id}`),
          request(app).get(`/api/companies/${s.companyId}/routines`),
        ]);
        expect([runs.status, detail.status, list.status]).toEqual([200, 200, 200]);
        const listed = list.body.find((item: { id: string }) => item.id === routine.id);
        return { bodies: JSON.stringify([runs.body, detail.body, list.body]), shown: [runs.body[0], detail.body.recentRuns[0], listed.lastRun] };
      };

      const guarded = await read(guardedId);
      const lead = await read(s.leadId);

      expect(guarded.bodies).not.toContain("Quarterly figures");
      for (const shown of guarded.shown) expect(shown).toMatchObject({ linkedIssueId: outside.id, linkedIssue: null });
      for (const shown of lead.shown) expect(shown.linkedIssue).toMatchObject({ id: outside.id, title: "Quarterly figures" });
    });

    it("cannot hand the steps on a task to another agent", async () => {
      const s = await seed();
      const routine = await s.createRoutine({ steps: [step("build")] });
      const task = await s.newTask();

      const response = await request(appFor(agentActor(s.companyId, s.leadId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id, assigneeAgentId: s.builderId });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Agents can only assign routine steps to themselves");
      expect(await s.childrenOf(task.id)).toEqual([]);
      expect(await s.runsOf(routine.id)).toEqual([]);
    });

    it("cannot run a routine assigned to another agent", async () => {
      const s = await seed();
      const routine = await s.createRoutine();
      const task = await s.newTask();

      const response = await request(appFor(agentActor(s.companyId, s.builderId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(403);
      expect(await s.childrenOf(task.id)).toEqual([]);
    });
  });

  describe("warnings about the agents of the steps", () => {
    it("come with a saved routine and name each step whose agent cannot take work", async () => {
      const s = await seed();
      const pausedId = await s.newAgent("Paused", { status: "paused" });
      const app = appFor(boardActor(s.companyId));

      const created = await request(app)
        .post(`/api/companies/${s.companyId}/routines`)
        .send({
          title: "Release",
          assigneeAgentId: s.leadId,
          projectId: s.projectId,
          steps: [
            step("build", [], { assigneeAgentId: s.builderId }),
            step("review", ["build"], { assigneeAgentId: pausedId }),
            step("ship", ["review"]),
          ],
        });

      expect(created.status).toBe(201);
      expect(created.body.warnings).toEqual([
        { code: "step_agent_unavailable", stepKey: "review", agentId: pausedId, reason: "paused" },
      ]);
    });

    it("are an empty list when every agent can start, and for a routine without steps", async () => {
      const s = await seed();
      const app = appFor(boardActor(s.companyId));

      const withSteps = await request(app)
        .post(`/api/companies/${s.companyId}/routines`)
        .send({ title: "Release", assigneeAgentId: s.leadId, projectId: s.projectId, steps: [step("build")] });
      const withoutSteps = await request(app)
        .post(`/api/companies/${s.companyId}/routines`)
        .send({ title: "Plain", assigneeAgentId: s.leadId, projectId: s.projectId });

      expect(withSteps.body.warnings).toEqual([]);
      expect(withoutSteps.body.warnings).toEqual([]);
    });

    it("come with an update, and clear once the agent is back", async () => {
      const s = await seed();
      const pausedId = await s.newAgent("Paused", { status: "paused" });
      const routine = await s.createRoutine({ steps: [step("build", [], { assigneeAgentId: pausedId })] });
      const app = appFor(boardActor(s.companyId));

      const renamed = await request(app).patch(`/api/routines/${routine.id}`).send({ title: "Renamed" });
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, pausedId));
      const renamedAgain = await request(app).patch(`/api/routines/${routine.id}`).send({ title: "Renamed again" });

      expect(renamed.status).toBe(200);
      expect(renamed.body.warnings).toEqual([
        { code: "step_agent_unavailable", stepKey: "build", agentId: pausedId, reason: "paused" },
      ]);
      expect(renamedAgain.body.warnings).toEqual([]);
    });

    it("come with a run on a task, for a step that starts later", async () => {
      const s = await seed();
      const pausedId = await s.newAgent("Paused", { status: "paused" });
      const routine = await s.createRoutine({
        steps: [step("build", [], { assigneeAgentId: s.builderId }), step("review", ["build"], { assigneeAgentId: pausedId })],
      });
      const task = await s.newTask();

      const response = await request(appFor(boardActor(s.companyId)))
        .post(`/api/routines/${routine.id}/run`)
        .send({ targetIssueId: task.id });

      expect(response.status).toBe(202);
      expect(response.body.warnings).toEqual([
        { code: "step_agent_unavailable", stepKey: "review", agentId: pausedId, reason: "paused" },
      ]);
    });

    it("come with an ordinary run too", async () => {
      const s = await seed();
      const pausedId = await s.newAgent("Paused", { status: "paused" });
      const routine = await s.createRoutine({
        steps: [step("build", [], { assigneeAgentId: s.builderId }), step("review", ["build"], { assigneeAgentId: pausedId })],
      });

      const response = await request(appFor(boardActor(s.companyId))).post(`/api/routines/${routine.id}/run`).send({});

      expect(response.status).toBe(202);
      expect(response.body.warnings).toEqual([
        { code: "step_agent_unavailable", stepKey: "review", agentId: pausedId, reason: "paused" },
      ]);
    });
  });

  describe("an event and a manual run on one task", () => {
    async function setup() {
      const fx = await seedEventFixture(db);
      const leadId = await fx.createAgent("Lead");
      const builderId = await fx.createAgent("Builder");
      const reviewerId = await fx.createAgent("Reviewer");
      const { source } = await fx.sources.ensureInternal(fx.companyId, { userId: "board-user" });
      const createRoutine = (title: string) =>
        fx.routinesSvc.create(
          fx.companyId,
          {
            projectId: fx.projectId,
            goalId: null,
            parentIssueId: null,
            title,
            description: "Lead brief",
            assigneeAgentId: leadId,
            priority: "medium",
            status: "active",
            concurrencyPolicy: "coalesce_if_active",
            catchUpPolicy: "skip_missed",
            steps: [step("build", [], { assigneeAgentId: builderId }), step("review", ["build"], { assigneeAgentId: reviewerId })],
          } as never,
          {},
        );
      const listen = (routineId: string) => fx.subscribe(routineId, source.id, { grouping: { issueMode: "event_issue" } });
      const task = await fx.issueSvc.create(fx.companyId, {
        title: "Fix login",
        status: "todo",
        priority: "medium",
        projectId: fx.projectId,
        assigneeAgentId: leadId,
        createdByUserId: "board-user",
      });
      const race = (manualRoutineId: string) =>
        Promise.allSettled([
          fx.sources.publishInternal(fx.companyId, { issueId: task.id }),
          fx.routinesSvc.runRoutine(manualRoutineId, { source: "manual", targetIssueId: task.id }, { userId: "board-user" }),
        ]);
      const children = () =>
        db.select().from(issues).where(and(eq(issues.companyId, fx.companyId), eq(issues.parentId, task.id)));
      const runsOf = (routineIds: string[]) => db.select().from(routineRuns).where(inArray(routineRuns.routineId, routineIds));
      return { createRoutine, listen, race, children, runsOf };
    }

    type Setup = Awaited<ReturnType<typeof setup>>;

    /** Exactly one start built the tree; the other was refused, and the task's assignee stays asleep either way. */
    async function expectOneTree(t: Setup, [published, manual]: Awaited<ReturnType<Setup["race"]>>, routineIds: string[]) {
      expect(published.status === "fulfilled" && published.value.stepsAttached).toBe(true);
      if (manual.status === "rejected") expect(manual.reason).toMatchObject({ status: 409 });
      expect(await t.children()).toHaveLength(2);
      const runs = await t.runsOf(routineIds);
      expect(runs.filter((run) => run.status === "issue_created")).toHaveLength(1);
      const eventRun = runs.find((run) => run.source === "event");
      expect(manual.status === "fulfilled" ? eventRun?.status === "failed" : eventRun?.status === "issue_created").toBe(true);
    }

    it("produce exactly one tree, whichever gets the task first", async () => {
      const t = await setup();
      const routine = await t.createRoutine("Release check");
      await t.listen(routine.id);

      await expectOneTree(t, await t.race(routine.id), [routine.id]);
    });

    it("produce exactly one tree when they belong to two routines, so only the task lock decides", async () => {
      const t = await setup();
      const listening = await t.createRoutine("Release check");
      const manual = await t.createRoutine("Hand check");
      await t.listen(listening.id);

      await expectOneTree(t, await t.race(manual.id), [listening.id, manual.id]);
    });
  });
});
