import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, goals, issues, type Db } from "@paperclipai/db";
import { COMPANY_FOCUS_GUIDANCE } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { goalRoutes } from "../routes/goals.js";
import { issueRoutes } from "../routes/issues.js";
import { goalFocusService } from "../services/goal-focus.js";
import { goalService } from "../services/goals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal focus tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-10-09T12:00:00.000Z");

describeEmbeddedPostgres("goal horizons, milestones and company focus", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    // A local worktree instance env file sets this and filters the agent inbox; tests must not depend on it.
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-focus-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    testApp.use("/api", goalRoutes(db as Db));
    testApp.use("/api", agentRoutes(db as Db));
    testApp.use("/api", issueRoutes(db as Db, {} as never, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  const board = (companyId: string) => ({
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  });
  const member = (companyId: string) => ({
    type: "board",
    userId: "member-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  });
  const agentActor = (companyId: string, agentId: string) => ({ type: "agent", source: "agent_key", companyId, agentId });

  function randomPrefix(): string {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    return `G${Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join("")}`;
  }

  async function seedCompany() {
    const id = randomUUID();
    const prefix = randomPrefix();
    await db.insert(companies).values({ id, name: `Co ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    return { id, prefix };
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id, companyId, name: `Agent ${id.slice(0, 4)}`, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return id;
  }

  async function seedGoal(companyId: string, values: Partial<typeof goals.$inferInsert> = {}) {
    const [row] = await db.insert(goals).values({ companyId, title: "Goal", status: "active", ...values }).returning();
    return row!;
  }

  let issueCounter = 0;
  async function seedIssue(
    company: { id: string; prefix: string },
    values: Partial<typeof issues.$inferInsert> = {},
  ) {
    issueCounter += 1;
    const [row] = await db.insert(issues).values({
      companyId: company.id,
      title: `Task ${issueCounter}`,
      status: "todo",
      identifier: `${company.prefix}-${issueCounter}`,
      issueNumber: issueCounter,
      ...values,
    }).returning();
    return row!;
  }

  describe("goal fields", () => {
    it("creates a short term milestone with a target date and success criteria", async () => {
      const company = await seedCompany();
      const parent = await seedGoal(company.id, { title: "Ship v2", level: "company" });

      const res = await request(app(board(company.id))).post(`/api/companies/${company.id}/goals`).send({
        title: "Land all open pull requests",
        kind: "milestone",
        horizon: "short",
        status: "active",
        parentId: parent.id,
        targetDate: "2026-10-16",
        successCriteria: "Open pull requests = 0",
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: "milestone",
        horizon: "short",
        targetDate: "2026-10-16",
        successCriteria: "Open pull requests = 0",
        parentId: parent.id,
      });
    });

    it("defaults new goals to kind goal with no horizon or date", async () => {
      const company = await seedCompany();

      const res = await request(app(board(company.id))).post(`/api/companies/${company.id}/goals`).send({ title: "Plain" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: "goal", horizon: null, targetDate: null, successCriteria: null });
    });

    it("rejects an impossible target date and an unknown horizon", async () => {
      const company = await seedCompany();
      const client = request(app(board(company.id)));

      const badDate = await client.post(`/api/companies/${company.id}/goals`).send({ title: "x", targetDate: "2026-02-30" });
      const badHorizon = await client.post(`/api/companies/${company.id}/goals`).send({ title: "x", horizon: "soon" });

      expect(badDate.status).toBe(400);
      expect(badHorizon.status).toBe(400);
    });

    it("updates and clears the new fields", async () => {
      const company = await seedCompany();
      const goal = await seedGoal(company.id, { horizon: "long", targetDate: "2027-01-01" });
      const client = request(app(board(company.id)));

      const changed = await client.patch(`/api/goals/${goal.id}`).send({ horizon: "short", targetDate: null, successCriteria: "Done" });

      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ horizon: "short", targetDate: null, successCriteria: "Done" });
    });

    it("refuses a parent goal or owner from another company", async () => {
      const mine = await seedCompany();
      const theirs = await seedCompany();
      const foreignGoal = await seedGoal(theirs.id);
      const foreignAgent = await seedAgent(theirs.id);
      const goal = await seedGoal(mine.id);
      const client = request(app(board(mine.id)));

      const createWithForeignParent = await client.post(`/api/companies/${mine.id}/goals`).send({ title: "x", parentId: foreignGoal.id });
      const createWithForeignOwner = await client.post(`/api/companies/${mine.id}/goals`).send({ title: "x", ownerAgentId: foreignAgent });
      const updateWithForeignParent = await client.patch(`/api/goals/${goal.id}`).send({ parentId: foreignGoal.id });

      expect(createWithForeignParent.status).toBe(422);
      expect(createWithForeignOwner.status).toBe(422);
      expect(updateWithForeignParent.status).toBe(422);
    });

    it("refuses a parent that would make a loop", async () => {
      const company = await seedCompany();
      const root = await seedGoal(company.id, { title: "Root" });
      const child = await seedGoal(company.id, { title: "Child", parentId: root.id });
      const grandchild = await seedGoal(company.id, { title: "Grandchild", parentId: child.id });
      const client = request(app(board(company.id)));

      const self = await client.patch(`/api/goals/${root.id}`).send({ parentId: root.id });
      const loop = await client.patch(`/api/goals/${root.id}`).send({ parentId: grandchild.id });
      const fine = await client.patch(`/api/goals/${grandchild.id}`).send({ parentId: root.id });

      expect(self.status).toBe(422);
      expect(loop.status).toBe(422);
      expect(fine.status).toBe(200);
    });
  });

  describe("progress", () => {
    it("counts tasks under a goal and all goals below it, leaving out cancelled and hidden tasks", async () => {
      const company = await seedCompany();
      const goal = await seedGoal(company.id, { title: "Land PRs" });
      const milestone = await seedGoal(company.id, { title: "First half", kind: "milestone", parentId: goal.id });
      const other = await seedGoal(company.id, { title: "Other" });
      await seedIssue(company, { goalId: goal.id, status: "done" });
      await seedIssue(company, { goalId: milestone.id, status: "in_review" });
      await seedIssue(company, { goalId: milestone.id, status: "done" });
      await seedIssue(company, { goalId: milestone.id, status: "cancelled" });
      await seedIssue(company, { goalId: goal.id, status: "todo", hiddenAt: new Date() });
      await seedIssue(company, { goalId: other.id, status: "todo" });

      const res = await request(app(board(company.id))).get(`/api/companies/${company.id}/goals/progress`);

      expect(res.status).toBe(200);
      expect(res.body[goal.id]).toEqual({ total: 3, done: 2, open: 1 });
      expect(res.body[milestone.id]).toEqual({ total: 2, done: 1, open: 1 });
      expect(res.body[other.id]).toEqual({ total: 1, done: 0, open: 1 });
    });
  });

  describe("company focus", () => {
    it("lists active short term goals, nearest date first, with their open milestones", async () => {
      const company = await seedCompany();
      const later = await seedGoal(company.id, { title: "Later short", horizon: "short", targetDate: "2026-10-30" });
      const sooner = await seedGoal(company.id, { title: "Land PRs", horizon: "short", targetDate: "2026-10-16", successCriteria: "Open PRs = 0" });
      await seedGoal(company.id, { title: "Undated short", horizon: "short" });
      await seedGoal(company.id, { title: "Planned short", horizon: "short", status: "planned" });
      await seedGoal(company.id, { title: "Medium", horizon: "medium" });
      await seedGoal(company.id, { title: "No horizon" });
      const m2 = await seedGoal(company.id, { title: "Second", kind: "milestone", parentId: sooner.id, targetDate: "2026-10-14" });
      const m1 = await seedGoal(company.id, { title: "First", kind: "milestone", parentId: sooner.id, targetDate: "2026-10-11" });
      await seedGoal(company.id, { title: "Achieved", kind: "milestone", parentId: sooner.id, status: "achieved", targetDate: "2026-10-10" });
      await seedIssue(company, { goalId: m1.id, status: "done" });
      await seedIssue(company, { goalId: m2.id, status: "todo" });

      const focus = await goalFocusService(db as Db, { now: () => NOW }).getFocus(company.id);

      expect(focus.guidance).toBe(COMPANY_FOCUS_GUIDANCE);
      expect(focus.goals.map((g) => g.title)).toEqual(["Land PRs", "Later short", "Undated short"]);
      expect(focus.goals[0]).toMatchObject({
        id: sooner.id,
        targetDate: "2026-10-16",
        daysLeft: 7,
        successCriteria: "Open PRs = 0",
        progress: { total: 2, done: 1, open: 1 },
      });
      expect(focus.goals[0]!.milestones.map((m) => [m.title, m.daysLeft, m.progress.done])).toEqual([
        ["First", 2, 1],
        ["Second", 5, 0],
      ]);
      expect(focus.goals.find((g) => g.id === later.id)!.daysLeft).toBe(21);
    });

    it("is empty when no short term goal is active", async () => {
      const company = await seedCompany();
      await seedGoal(company.id, { horizon: "medium" });

      const res = await request(app(board(company.id))).get(`/api/companies/${company.id}/goals/focus`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ goals: [], guidance: COMPANY_FOCUS_GUIDANCE });
    });

    it("never shows another company's goals", async () => {
      const mine = await seedCompany();
      const theirs = await seedCompany();
      await seedGoal(theirs.id, { title: "Secret", horizon: "short" });

      const own = await request(app(member(mine.id))).get(`/api/companies/${mine.id}/goals/focus`);
      const foreign = await request(app(member(mine.id))).get(`/api/companies/${theirs.id}/goals/focus`);
      const foreignProgress = await request(app(member(mine.id))).get(`/api/companies/${theirs.id}/goals/progress`);
      const agentId = await seedAgent(mine.id);
      const foreignForAgent = await request(app(agentActor(mine.id, agentId))).get(`/api/companies/${theirs.id}/goals/focus`);

      expect(own.body.goals).toEqual([]);
      expect(foreign.status).toBe(403);
      expect(foreignProgress.status).toBe(403);
      expect(foreignForAgent.status).toBe(403);
    });
  });

  describe("agents", () => {
    it("put tasks that serve the focus first in the inbox, after critical work, and say which goal they serve", async () => {
      const company = await seedCompany();
      const agentId = await seedAgent(company.id);
      const focusGoal = await seedGoal(company.id, { title: "Land PRs", horizon: "short" });
      const milestone = await seedGoal(company.id, { kind: "milestone", parentId: focusGoal.id });
      const elsewhere = await seedGoal(company.id, { title: "Elsewhere", horizon: "long" });
      const high = await seedIssue(company, { assigneeAgentId: agentId, priority: "high", goalId: elsewhere.id });
      const viaMilestone = await seedIssue(company, { assigneeAgentId: agentId, priority: "low", goalId: milestone.id });
      const none = await seedIssue(company, { assigneeAgentId: agentId, priority: "critical" });

      const res = await request(app(agentActor(company.id, agentId))).get("/api/agents/me/inbox-lite");

      expect(res.status).toBe(200);
      expect(res.body.map((row: { id: string }) => row.id)).toEqual([none.id, viaMilestone.id, high.id]);
      expect(res.body[0]).toMatchObject({ focusGoalId: null, priority: "critical" });
      expect(res.body[1]).toMatchObject({ focusGoalId: focusGoal.id });
    });

    it("keep the normal inbox order when there is no focus", async () => {
      const company = await seedCompany();
      const agentId = await seedAgent(company.id);
      const critical = await seedIssue(company, { assigneeAgentId: agentId, priority: "critical" });
      const low = await seedIssue(company, { assigneeAgentId: agentId, priority: "low" });

      const res = await request(app(agentActor(company.id, agentId))).get("/api/agents/me/inbox-lite");

      expect(res.body.map((row: { id: string }) => row.id)).toEqual([critical.id, low.id]);
      expect(res.body.every((row: { focusGoalId: string | null }) => row.focusGoalId === null)).toBe(true);
    });

    it("see the company focus and whether their task serves it in the heartbeat context", async () => {
      const company = await seedCompany();
      const agentId = await seedAgent(company.id);
      const focusGoal = await seedGoal(company.id, { title: "Land PRs", horizon: "short", targetDate: "2026-10-16", successCriteria: "Open PRs = 0" });
      const serving = await seedIssue(company, { assigneeAgentId: agentId, goalId: focusGoal.id });
      const other = await seedIssue(company, { assigneeAgentId: agentId });

      const client = request(app(agentActor(company.id, agentId)));
      const servingRes = await client.get(`/api/issues/${serving.id}/heartbeat-context`);
      const otherRes = await client.get(`/api/issues/${other.id}/heartbeat-context`);

      expect(servingRes.status).toBe(200);
      expect(servingRes.body.companyFocus).toMatchObject({
        guidance: COMPANY_FOCUS_GUIDANCE,
        issueFocusGoalId: focusGoal.id,
        goals: [{ id: focusGoal.id, title: "Land PRs", successCriteria: "Open PRs = 0", progress: { total: 1, done: 0, open: 1 } }],
      });
      expect(servingRes.body.goal).toMatchObject({ id: focusGoal.id, horizon: "short", kind: "goal", targetDate: "2026-10-16" });
      expect(otherRes.body.companyFocus).toMatchObject({ issueFocusGoalId: null });
    });
  });

  describe("review fixes", () => {
    it("keeps a goal in its company and validates updates that bypass the route", async () => {
      const mine = await seedCompany();
      const theirs = await seedCompany();
      const goal = await seedGoal(mine.id, { title: "Stay" });
      const svc = goalService(db as Db);

      const moved = await svc.update(goal.id, { companyId: theirs.id, title: "Renamed" } as never);
      expect(moved).toMatchObject({ companyId: mine.id, title: "Renamed" });
      await expect(svc.update(goal.id, { horizon: "soon" } as never)).rejects.toThrow(/horizon/i);
      await expect(svc.update(goal.id, { targetDate: "20266-10-09" } as never)).rejects.toThrow(/date/i);
    });

    it("rejects the year 0000, which Postgres cannot store", async () => {
      const company = await seedCompany();

      const res = await request(app(board(company.id))).post(`/api/companies/${company.id}/goals`).send({ title: "x", targetDate: "0000-01-01" });

      expect(res.status).toBe(400);
    });

    it("tags only the focus goals it lists, so agents never see a focus goal id that is not in the focus", async () => {
      const company = await seedCompany();
      const agentId = await seedAgent(company.id);
      const goalsByDay = [];
      for (let day = 10; day <= 20; day += 1) {
        goalsByDay.push(await seedGoal(company.id, { title: `Push ${day}`, horizon: "short", targetDate: `2026-10-${day}` }));
      }
      const latest = goalsByDay.at(-1)!;
      const earliest = goalsByDay[0]!;
      const late = await seedIssue(company, { assigneeAgentId: agentId, goalId: latest.id });
      const early = await seedIssue(company, { assigneeAgentId: agentId, goalId: earliest.id });

      const focus = await goalFocusService(db as Db, { now: () => NOW }).getFocus(company.id);
      const inbox = await request(app(agentActor(company.id, agentId))).get("/api/agents/me/inbox-lite");
      const context = await request(app(agentActor(company.id, agentId))).get(`/api/issues/${late.id}/heartbeat-context`);

      expect(focus.goals).toHaveLength(10);
      expect(focus.goals.some((g) => g.id === latest.id)).toBe(false);
      expect(inbox.body.find((row: { id: string }) => row.id === late.id).focusGoalId).toBeNull();
      expect(inbox.body.find((row: { id: string }) => row.id === early.id).focusGoalId).toBe(earliest.id);
      expect(context.body.companyFocus.issueFocusGoalId).toBeNull();
    });

    it("bounds the success criteria agents receive", async () => {
      const company = await seedCompany();
      await seedGoal(company.id, { horizon: "short", successCriteria: "x".repeat(2000) });

      const focus = await goalFocusService(db as Db, { now: () => NOW }).getFocus(company.id);

      expect(focus.goals[0]!.successCriteria!.length).toBeLessThanOrEqual(280);
    });

    it("never shows another company's goal in the heartbeat context", async () => {
      const mine = await seedCompany();
      const theirs = await seedCompany();
      const agentId = await seedAgent(mine.id);
      const foreign = await seedGoal(theirs.id, { title: "Secret plan", horizon: "short", successCriteria: "secret" });
      const issue = await seedIssue(mine, { assigneeAgentId: agentId, goalId: foreign.id });

      const res = await request(app(agentActor(mine.id, agentId))).get(`/api/issues/${issue.id}/heartbeat-context`);

      expect(res.status).toBe(200);
      expect(res.body.goal).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("Secret plan");
      expect(res.body.companyFocus).toMatchObject({ goals: [], issueFocusGoalId: null });
    });
  });
});
