import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, issueTriages } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { createGuardedAssignment } from "../modules/issue-triage/adapters/assignment.js";
import { createIssueTriageModule } from "../modules/issue-triage/index.js";
import { issueTriageRoutes } from "../routes/issue-triage.js";
import { prepareIssueText } from "../services/duplicate-lexical.js";
import type { JudgeClient, JudgeOutcome, JudgeRequest } from "../services/judge-client.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue triage on Postgres", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const prefix = `TRI${companyId.slice(0, 4).toUpperCase()}`;
  const otherPrefix = `OTH${otherCompanyId.slice(0, 4).toUpperCase()}`;
  const engineerId = randomUUID();
  const designerId = randomUUID();
  const pausedId = randomUUID();
  const otherCompanyAgentId = randomUUID();

  const wakeups: Array<{ agentId: string; reason: string | undefined }> = [];
  const heartbeat = {
    wakeup: async (agentId: string, opts: { reason?: string }) => {
      wakeups.push({ agentId, reason: opts.reason });
      return null;
    },
  };

  /** The judge sees only role and title: this stand-in picks the option whose text mentions `pick`. */
  let pick = "Engineer";
  let ownerConfidence = 0.9;
  const asked: JudgeRequest[] = [];
  const judge: JudgeClient = {
    isAvailable: async () => true,
    ask: async (req): Promise<JudgeOutcome> => {
      asked.push(req);
      const out: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(req.questions)) {
        const keys = Object.keys(question.options);
        if (id === "category") out[id] = { type: "choice", choice: "bug", probabilities: { bug: 0.9, other: 0.1 } };
        else if (id === "priority") out[id] = { type: "choice", choice: "high", probabilities: { high: 0.7, medium: 0.3 } };
        else {
          const match = keys.find((key) => key !== "none" && question.options[key]?.includes(pick));
          const probabilities: Record<string, number> = {};
          for (const key of keys) probabilities[key] = key === match ? ownerConfidence : key === "none" ? 1 - ownerConfidence : 0;
          out[id] = { type: "choice", choice: match ?? "none", probabilities };
        }
      }
      return {
        ok: true,
        modelId: "typesafe-ai/jev",
        inputHash: `h${asked.length}`,
        cached: false,
        answers: out as never,
      };
    },
  };

  const triage = () =>
    createIssueTriageModule({ db, judge, issues: issueService(db), heartbeat, text: { prepare: prepareIssueText } });

  async function createIssue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Fix the login redirect loop",
      description: "Users bounce between two pages.",
      status: "todo",
      identifier: `${prefix}-${id.slice(0, 8)}`,
      ...overrides,
    });
    return id;
  }

  async function setMode(mode: "off" | "suggest" | "apply") {
    await db.update(companies).set({ issueTriageMode: mode }).where(eq(companies.id, companyId));
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-issue-triage-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    for (const [id, issuePrefix] of [
      [companyId, prefix],
      [otherCompanyId, otherPrefix],
    ] as const) {
      await db.insert(companies).values({
        id,
        name: `Company ${id}`,
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values([
      { id: engineerId, companyId, name: "Agent One", role: "engineer", title: "Backend Engineer", status: "idle" },
      { id: designerId, companyId, name: "Agent Two", role: "designer", title: "Product Designer", status: "idle" },
      { id: pausedId, companyId, name: "Agent Three", role: "qa", title: "QA Engineer", status: "paused" },
      {
        id: otherCompanyAgentId,
        companyId: otherCompanyId,
        name: "Agent Four",
        role: "engineer",
        title: "Backend Engineer",
        status: "idle",
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(async () => {
    wakeups.length = 0;
    asked.length = 0;
    pick = "Engineer";
    ownerConfidence = 0.9;
    await setMode("off");
  });

  describe("use case with the Postgres adapters", () => {
    it("does nothing while the company mode is off", async () => {
      const id = await createIssue();
      expect(await triage().triage({ id, companyId })).toBe("off");
      expect(asked).toHaveLength(0);
      expect(await triage().find(companyId, id)).toBeNull();
    });

    it("suggest mode records the triage and an activity entry and leaves the issue alone", async () => {
      await setMode("suggest");
      const id = await createIssue();
      expect(await triage().triage({ id, companyId })).toBe("recorded");

      const record = await triage().find(companyId, id);
      expect(record).toMatchObject({
        status: "scored",
        mode: "suggest",
        suggestedPriority: "high",
        category: "bug",
        suggestedAssigneeAgentId: engineerId,
        applyOutcome: "suggest_mode",
        appliedAt: null,
        modelId: "typesafe-ai/jev",
        modelCalls: 1,
      });
      const [issue] = await db.select().from(issues).where(eq(issues.id, id));
      expect(issue).toMatchObject({ assigneeAgentId: null, priority: "medium", status: "todo" });
      expect(wakeups).toHaveLength(0);

      const entries = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, id), eq(activityLog.action, "issue.triage_recorded")));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.companyId).toBe(companyId);
    });

    it("offers only this company's agents that can take work, and no names or ids", async () => {
      await setMode("suggest");
      const id = await createIssue();
      await triage().triage({ id, companyId });
      const owner = asked[0]?.questions.owner_1;
      const text = Object.values(owner?.options ?? {}).join("\n");
      expect(text).toContain("Backend Engineer");
      expect(text).toContain("Product Designer");
      expect(text).not.toContain("QA Engineer");
      const sent = JSON.stringify({ state: asked[0]?.state, questions: asked[0]?.questions });
      for (const secret of [engineerId, designerId, otherCompanyAgentId, "Agent One", "Agent Two", companyId]) {
        expect(sent).not.toContain(secret);
      }
    });

    it("apply mode assigns an unassigned todo, wakes the agent and logs it, without touching priority", async () => {
      await setMode("apply");
      const id = await createIssue();
      expect(await triage().triage({ id, companyId })).toBe("recorded");

      const [issue] = await db.select().from(issues).where(eq(issues.id, id));
      expect(issue).toMatchObject({ assigneeAgentId: engineerId, priority: "medium", status: "todo" });
      expect(wakeups).toEqual([{ agentId: engineerId, reason: "issue_assigned" }]);

      const record = await triage().find(companyId, id);
      expect(record).toMatchObject({ applyOutcome: "applied", suggestedPriority: "high" });
      expect(record?.appliedAt).toBeInstanceOf(Date);

      const assigned = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, id), eq(activityLog.action, "issue.triage_assigned")));
      expect(assigned).toHaveLength(1);
    });

    it("apply mode never assigns a backlog issue, an assigned issue or one below the threshold", async () => {
      await setMode("apply");
      const backlog = await createIssue({ status: "backlog" });
      const assigned = await createIssue({ assigneeAgentId: designerId });
      await triage().triage({ id: backlog, companyId });
      await triage().triage({ id: assigned, companyId });
      expect((await triage().find(companyId, backlog))?.applyOutcome).toBe("not_unassigned_todo");
      expect((await triage().find(companyId, assigned))?.applyOutcome).toBe("not_requested");
      const [stillAssigned] = await db.select().from(issues).where(eq(issues.id, assigned));
      expect(stillAssigned?.assigneeAgentId).toBe(designerId);

      ownerConfidence = 0.7;
      const weak = await createIssue();
      await triage().triage({ id: weak, companyId });
      expect((await triage().find(companyId, weak))?.applyOutcome).toBe("below_threshold");
      expect(wakeups).toHaveLength(0);
    });

    it("never triages a routine-made issue and never twice", async () => {
      await setMode("suggest");
      const routine = await createIssue({ originKind: "routine_execution" });
      expect(await triage().triage({ id: routine, companyId })).toBe("ignored");
      expect(await triage().find(companyId, routine)).toBeNull();

      const id = await createIssue();
      expect(await triage().triage({ id, companyId })).toBe("recorded");
      const calls = asked.length;
      expect(await triage().triage({ id, companyId })).toBe("already_recorded");
      expect(asked).toHaveLength(calls);
      const rows = await db.select().from(issueTriages).where(eq(issueTriages.issueId, id));
      expect(rows).toHaveLength(1);
    });

    it("reports an issue of another company as not visible", async () => {
      await setMode("suggest");
      const id = await createIssue();
      expect(await triage().triage({ id, companyId: otherCompanyId })).toBe("off");
      await db.update(companies).set({ issueTriageMode: "suggest" }).where(eq(companies.id, otherCompanyId));
      expect(await triage().triage({ id, companyId: otherCompanyId })).toBe("not_visible");
      await db.update(companies).set({ issueTriageMode: "off" }).where(eq(companies.id, otherCompanyId));
    });
  });

  describe("guarded assignment", () => {
    const assign = () => createGuardedAssignment({ db, issues: issueService(db), heartbeat });

    it("leaves an issue that was assigned after the triage read it", async () => {
      const id = await createIssue({ assigneeAgentId: designerId });
      expect(await assign().assignIfUnassignedTodo({ companyId, issueId: id, agentId: engineerId })).toEqual({
        applied: false,
        reason: "not_unassigned_todo",
      });
      const [issue] = await db.select().from(issues).where(eq(issues.id, id));
      expect(issue?.assigneeAgentId).toBe(designerId);
    });

    it("leaves an issue that left todo", async () => {
      const id = await createIssue({ status: "in_progress" });
      expect((await assign().assignIfUnassignedTodo({ companyId, issueId: id, agentId: engineerId })).applied).toBe(false);
    });

    it("refuses a paused agent and an agent of another company", async () => {
      const id = await createIssue();
      expect(await assign().assignIfUnassignedTodo({ companyId, issueId: id, agentId: pausedId })).toEqual({
        applied: false,
        reason: "owner_unavailable",
      });
      expect(await assign().assignIfUnassignedTodo({ companyId, issueId: id, agentId: otherCompanyAgentId })).toEqual({
        applied: false,
        reason: "owner_unavailable",
      });
      const [issue] = await db.select().from(issues).where(eq(issues.id, id));
      expect(issue?.assigneeAgentId).toBeNull();
      expect(wakeups).toHaveLength(0);
    });

    it("lets exactly one of two concurrent assignments win", async () => {
      const id = await createIssue();
      const results = await Promise.all([
        assign().assignIfUnassignedTodo({ companyId, issueId: id, agentId: engineerId }),
        assign().assignIfUnassignedTodo({ companyId, issueId: id, agentId: designerId }),
      ]);
      expect(results.filter((result) => result.applied)).toHaveLength(1);
      expect(wakeups).toHaveLength(1);
    });
  });

  describe("GET /issues/:id/triage", () => {
    const ownBoard = {
      type: "board" as const,
      userId: "own-board-user",
      source: "session" as const,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner" as const, status: "active" as const }],
    };

    function appAs(actor: Express.Request["actor"]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      app.use("/api", issueTriageRoutes(db, triage()));
      app.use(errorHandler);
      return app;
    }

    it("returns the recorded triage by id and by identifier, to a board user and an agent of the company", async () => {
      await setMode("suggest");
      const id = await createIssue();
      const [row] = await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, id));
      await triage().triage({ id, companyId });

      const byId = await request(appAs(ownBoard)).get(`/api/issues/${id}/triage`);
      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({ issueId: id, status: "scored", category: "bug", suggestedPriority: "high" });
      const byIdentifier = await request(appAs(ownBoard)).get(`/api/issues/${row?.identifier}/triage`);
      expect(byIdentifier.status).toBe(200);
      const agent = await request(appAs({ type: "agent", agentId: engineerId, companyId, source: "agent_key" })).get(
        `/api/issues/${id}/triage`,
      );
      expect(agent.status).toBe(200);
    });

    it("answers 404 when no triage was recorded", async () => {
      const id = await createIssue();
      const response = await request(appAs(ownBoard)).get(`/api/issues/${id}/triage`);
      expect(response.status).toBe(404);
    });

    it("answers another company's issue exactly like a missing issue", async () => {
      await setMode("suggest");
      const id = await createIssue();
      await triage().triage({ id, companyId });
      const [row] = await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, id));
      const otherBoard = {
        type: "board" as const,
        userId: "other-board-user",
        source: "session" as const,
        companyIds: [otherCompanyId],
        memberships: [{ companyId: otherCompanyId, membershipRole: "owner" as const, status: "active" as const }],
      };
      const missing = await request(appAs(otherBoard)).get(`/api/issues/${randomUUID()}/triage`);
      const foreignById = await request(appAs(otherBoard)).get(`/api/issues/${id}/triage`);
      const missingByIdentifier = await request(appAs(otherBoard)).get("/api/issues/NOPE-999999/triage");
      const foreignByIdentifier = await request(appAs(otherBoard)).get(`/api/issues/${row?.identifier}/triage`);
      const foreignAgent = await request(
        appAs({ type: "agent", agentId: otherCompanyAgentId, companyId: otherCompanyId, source: "agent_key" }),
      ).get(`/api/issues/${id}/triage`);
      expect(foreignById.status).toBe(404);
      expect(foreignById.body).toEqual(missing.body);
      expect(foreignByIdentifier.status).toBe(404);
      expect(foreignByIdentifier.body).toEqual(missingByIdentifier.body);
      expect(foreignAgent.status).toBe(404);
      expect(foreignAgent.body).toEqual(missing.body);
    });

    it("answers an unauthenticated caller with the same 401 whether or not the issue exists", async () => {
      const id = await createIssue();
      const none = appAs({ type: "none", source: "none" });
      const existing = await request(none).get(`/api/issues/${id}/triage`);
      const missing = await request(none).get(`/api/issues/${randomUUID()}/triage`);
      expect(existing.status).toBe(401);
      expect(existing.body).toEqual(missing.body);
    });
  });
});
