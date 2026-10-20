import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, eventDeliveries, issues } from "@paperclipai/db";
import type { RoutineStep } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture } from "./helpers/event-source-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

// The create routes wake the new task's assignee fire-and-forget. Those two wakes are recorded and
// swallowed, so the test sees whether the route asked for them without starting an agent. Every other
// caller of the function, such as the code that starts a routine's steps, runs for real.
const ROUTE_WAKE_SOURCES = new Set(["issue.create", "issue.child_create"]);
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: vi.fn((input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      ROUTE_WAKE_SOURCES.has(input.contextSource) ? Promise.resolve(undefined) : actual.queueIssueAssignmentWakeup(input),
    ),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create routine steps route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

const EVENT_ISSUE = { issueMode: "event_issue" } as const;

describeEmbeddedPostgres("creating a task while a routine listens for new tasks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-routine-steps-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.mocked(queueIssueAssignmentWakeup).mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const fx = await seedEventFixture(db);
    const leadId = await fx.createAgent("Lead");
    const builderId = await fx.createAgent("Builder");
    const reviewerId = await fx.createAgent("Reviewer");
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
        steps: [
          step("build", [], { assigneeAgentId: builderId }),
          step("review", ["build"], { assigneeAgentId: reviewerId }),
        ],
      } as never,
      {},
    );
    const listen = (trigger: Parameters<typeof fx.subscribe>[2] = { grouping: EVENT_ISSUE }) =>
      fx.subscribe(routine.id, source.id, trigger);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        actor: { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" },
      });
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, { eventSources: fx.sources }));
    app.use(errorHandler);

    const create = (body: Record<string, unknown>) =>
      request(app)
        .post(`/api/companies/${fx.companyId}/issues`)
        .send({ title: "Fix login", status: "todo", projectId: fx.projectId, ...body });
    const createChild = (parentId: string, body: Record<string, unknown>) =>
      request(app).post(`/api/issues/${parentId}/children`).send({ title: "Fix login", status: "todo", ...body });
    const childrenOf = (taskId: string) =>
      db.select().from(issues).where(and(eq(issues.companyId, fx.companyId), eq(issues.parentId, taskId)));
    const deliveries = () => db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id));
    /** The wakes the create routes asked for, by the task they were asked for. */
    const routeWakesFor = (taskId: string) =>
      vi
        .mocked(queueIssueAssignmentWakeup)
        .mock.calls.filter(([input]) => ROUTE_WAKE_SOURCES.has(input.contextSource) && input.issue.id === taskId);

    return { fx, leadId, builderId, reviewerId, listen, create, createChild, childrenOf, deliveries, routeWakesFor };
  }

  describe("a task the routine takes", () => {
    it("answers with the task waiting on the steps and wakes only the first step's agent", async () => {
      const s = await seed();
      await s.listen();

      const response = await s.create({ assigneeAgentId: s.leadId });

      expect(response.status).toBe(201);
      const children = await s.childrenOf(response.body.id);
      expect(children).toHaveLength(2);
      expect(response.body.status).toBe("blocked");
      expect(response.body.blockedBy.map((blocker: { id: string }) => blocker.id).sort()).toEqual(
        children.map((child) => child.id).sort(),
      );
      const [stored] = await db.select().from(issues).where(eq(issues.id, response.body.id));
      expect(stored).toMatchObject({ status: "blocked", assigneeAgentId: s.leadId });
      expect(response.body.statusVersion).toBe(stored!.statusVersion);
      expect(s.routeWakesFor(response.body.id)).toHaveLength(0);
      expect(s.fx.wakeups.map((wake) => wake.agentId)).toEqual([s.builderId]);
    });

    it("leaves a task nobody owns in its status", async () => {
      const s = await seed();
      await s.listen();

      const response = await s.create({});

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("todo");
      expect(response.body.blockedBy).toHaveLength(2);
      expect(await s.childrenOf(response.body.id)).toHaveLength(2);
      expect(s.routeWakesFor(response.body.id)).toHaveLength(0);
    });

    it("does the same for a subtask a person creates", async () => {
      const s = await seed();
      await s.listen();
      const parent = await s.fx.issueSvc.create(s.fx.companyId, {
        title: "Parent",
        status: "todo",
        priority: "medium",
        projectId: s.fx.projectId,
        createdByUserId: "board-user",
      });

      const response = await s.createChild(parent.id, { assigneeAgentId: s.leadId });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("blocked");
      expect(await s.childrenOf(response.body.id)).toHaveLength(2);
      expect(s.routeWakesFor(response.body.id)).toHaveLength(0);
      expect(s.fx.wakeups.map((wake) => wake.agentId)).toEqual([s.builderId]);
    });
  });

  describe("a task the routine leaves alone", () => {
    it("wakes its assignee as before and writes no event while no trigger listens", async () => {
      const s = await seed();

      const response = await s.create({ assigneeAgentId: s.leadId });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("todo");
      expect(await s.childrenOf(response.body.id)).toEqual([]);
      expect(await s.deliveries()).toEqual([]);
      expect(s.routeWakesFor(response.body.id)).toHaveLength(1);
      expect(s.fx.wakeups).toEqual([]);
    });

    it("wakes its assignee as before when the trigger asks for something else", async () => {
      const s = await seed();
      await s.listen({ grouping: EVENT_ISSUE, match: { labels: { created_by: "agent" } } });

      const response = await s.create({ assigneeAgentId: s.leadId });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("todo");
      expect(await s.childrenOf(response.body.id)).toEqual([]);
      expect(s.routeWakesFor(response.body.id)).toHaveLength(1);
      expect(s.fx.wakeups).toEqual([]);
    });

    it("wakes the assignee of a subtask under a routine step as before, so a step cannot start the routine again", async () => {
      const s = await seed();
      await s.listen();
      const stepTask = await s.fx.issueSvc.create(s.fx.companyId, {
        title: "A step",
        status: "in_progress",
        priority: "medium",
        projectId: s.fx.projectId,
        assigneeAgentId: s.builderId,
        originKind: "routine_step",
        createdByUserId: "board-user",
      });

      const response = await s.createChild(stepTask.id, { assigneeAgentId: s.leadId });

      expect(response.status).toBe(201);
      expect(await s.childrenOf(response.body.id)).toEqual([]);
      expect(s.routeWakesFor(response.body.id)).toHaveLength(1);
      expect(await s.deliveries()).toEqual([]);
    });
  });
});
