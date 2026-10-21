import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import type { IssueTriageMode, IssueTriagePage } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { createIssueTriage } from "../modules/issue-triage/index.js";
import { issueTriageRoutes } from "../routes/issue-triage.js";
import type { JudgeClient, JudgeOutcome, JudgeRequest } from "../services/judge-client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** A judge that answers every owner question by naming the agent whose option text starts with `owner`. */
function fakeJudge(options: { owner: string; ownerProbability: number; rival?: number }): JudgeClient & {
  asked: JudgeRequest[];
} {
  const asked: JudgeRequest[] = [];
  return {
    asked,
    isAvailable: async () => true,
    ask: async (req): Promise<JudgeOutcome> => {
      asked.push(req);
      const answers: Record<string, never> = {};
      const result: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(req.questions)) {
        if (question.type !== "choice") continue;
        const keys = Object.keys(question.options);
        let pick = keys[0] ?? "";
        if (id === "owner") {
          pick = keys.find((key) => question.options[key]?.startsWith(options.owner)) ?? "none";
          const probabilities: Record<string, number> = {};
          for (const key of keys) probabilities[key] = 0.01;
          probabilities[pick] = options.ownerProbability;
          const rival = keys.find((key) => key !== pick);
          if (rival && options.rival !== undefined) probabilities[rival] = options.rival;
          result[id] = { type: "choice", choice: pick, probabilities, confidence: 1, abstained: false };
        } else {
          result[id] = { type: "choice", choice: pick, probabilities: { [pick]: 0.9 }, confidence: 1, abstained: false };
        }
      }
      void answers;
      return {
        ok: true,
        answers: result as never,
        modelId: "typesafe-ai/jev",
        inputHash: `hash-${asked.length}`,
        cached: false,
      };
    },
  };
}

describeEmbeddedPostgres("issue triage on Postgres", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const amyId = randomUUID();
  const benId = randomUUID();
  const pausedId = randomUUID();
  const terminatedId = randomUUID();
  const strangerId = randomUUID();
  const wakeups: Array<{ agentId: string; reason: string | undefined }> = [];
  const heartbeat = {
    wakeup: vi.fn(async (agentId: string, opts: { reason?: string }) => {
      wakeups.push({ agentId, reason: opts.reason });
      return null;
    }),
  };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-issue-triage-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    for (const [id, prefix] of [
      [companyId, "TRG"],
      [otherCompanyId, "OTH"],
    ] as const) {
      await db.insert(companies).values({ id, name: `Company ${id}`, issuePrefix: prefix });
    }
    await db.insert(agents).values([
      { id: amyId, companyId, name: "Amy", role: "engineer", title: "Backend engineer", status: "idle" },
      { id: benId, companyId, name: "Ben", role: "designer", status: "idle" },
      { id: pausedId, companyId, name: "Paula", role: "engineer", status: "paused" },
      { id: terminatedId, companyId, name: "Terry", role: "engineer", status: "terminated" },
      { id: strangerId, companyId: otherCompanyId, name: "Sam", role: "engineer", status: "idle" },
    ]);
  }, 30_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(async () => {
    wakeups.length = 0;
    heartbeat.wakeup.mockClear();
  });

  async function setMode(mode: IssueTriageMode) {
    await db.update(companies).set({ issueTriageMode: mode }).where(eq(companies.id, companyId));
  }

  let counter = 0;
  async function createIssue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    counter += 1;
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Fix the login redirect loop",
      status: "todo",
      identifier: `TRG-${counter}`,
      ...overrides,
    });
    return id;
  }

  async function reload(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row;
  }

  function triageWith(judge: JudgeClient) {
    return createIssueTriage({ db, judge, heartbeat, retryDelaysMs: [] });
  }

  function appFor(triage: ReturnType<typeof triageWith>, actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueTriageRoutes(db, triage));
    app.use(errorHandler);
    return app;
  }

  const board = (ids: string[]): Express.Request["actor"] => ({
    type: "board",
    userId: "board-user",
    source: "session",
    companyIds: ids,
    memberships: ids.map((id) => ({ companyId: id, membershipRole: "owner" as const, status: "active" as const })),
  });

  it("does nothing while the mode is off", async () => {
    await setMode("off");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const id = await createIssue();
    await triageWith(judge).checkAfterCreate({ id, companyId });
    expect(judge.asked).toHaveLength(0);
    expect((await reload(id))?.assigneeAgentId).toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, id))).toEqual([]);
  });

  it("suggest mode records the triage and changes nothing", async () => {
    await setMode("suggest");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const triage = triageWith(judge);
    const id = await createIssue();
    await triage.checkAfterCreate({ id, companyId });

    const row = await reload(id);
    expect(row?.assigneeAgentId).toBeNull();
    expect(row?.priority).toBe("medium");
    expect(heartbeat.wakeup).not.toHaveBeenCalled();

    const res = await request(appFor(triage, board([companyId]))).get(`/api/issues/${id}/triage`);
    expect(res.status).toBe(200);
    const page = res.body as IssueTriagePage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      outcome: "suggested",
      mode: "suggest",
      modelId: "typesafe-ai/jev",
      owner: { suggestedAgentId: amyId, suggestedAgentName: "Amy", decision: "mode_suggest", appliedAgentId: null },
    });
    expect(page.items[0]?.owner?.probabilities?.[amyId]).toBe(0.95);
    expect(page.items[0]?.inputHashes).toEqual(["hash-1"]);
  });

  it("offers only agents that can be woken, from this company", async () => {
    await setMode("suggest");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const id = await createIssue();
    await triageWith(judge).checkAfterCreate({ id, companyId });
    const owner = judge.asked[0]?.questions.owner;
    const text = JSON.stringify(owner);
    expect(text).toContain("Amy");
    expect(text).toContain("Ben");
    expect(text).not.toContain("Paula");
    expect(text).not.toContain("Terry");
    expect(text).not.toContain("Sam");
  });

  it("redacts secret-like text and cuts a long description before it is sent", async () => {
    await setMode("suggest");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const id = await createIssue({
      description: `Deploy fails. Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 ${"filler ".repeat(600)}`,
    });
    await triageWith(judge).checkAfterCreate({ id, companyId });
    const sent = JSON.stringify(judge.asked[0]?.state);
    expect(sent).toContain("Deploy fails");
    expect(sent).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    const description = (judge.asked[0]?.state.issue as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(1_500);
  });

  it("apply mode fills an empty assignee of a todo issue and wakes the agent", async () => {
    await setMode("apply");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const triage = triageWith(judge);
    const id = await createIssue();
    const before = await reload(id);
    await triage.checkAfterCreate({ id, companyId });

    const after = await reload(id);
    expect(after?.assigneeAgentId).toBe(amyId);
    expect(after?.priority).toBe("medium");
    expect(after?.statusVersion).toBe((before?.statusVersion ?? 0) + 1);
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(wakeups).toEqual([{ agentId: amyId, reason: "issue_assigned" }]);

    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, id))).map((row) => row.action);
    expect(actions.sort()).toEqual(["issue.triaged", "issue.updated"]);

    const res = await request(appFor(triage, board([companyId]))).get(`/api/issues/TRG-${counter}/triage`);
    expect(res.body.items[0]).toMatchObject({ outcome: "applied", owner: { decision: "applied", appliedAgentId: amyId } });
  });

  it("apply mode leaves the issue alone when the owner is not clear enough", async () => {
    await setMode("apply");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.85, rival: 0.7 });
    const id = await createIssue();
    await triageWith(judge).checkAfterCreate({ id, companyId });
    expect((await reload(id))?.assigneeAgentId).toBeNull();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("never reassigns an issue that already has an assignee, and never asks for an owner", async () => {
    await setMode("apply");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const id = await createIssue({ assigneeAgentId: benId });
    await triageWith(judge).checkAfterCreate({ id, companyId });
    expect((await reload(id))?.assigneeAgentId).toBe(benId);
    expect(Object.keys(judge.asked[0]?.questions ?? {})).not.toContain("owner");
  });

  it("never assigns a backlog issue", async () => {
    await setMode("apply");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const id = await createIssue({ status: "backlog" });
    await triageWith(judge).checkAfterCreate({ id, companyId });
    expect((await reload(id))?.assigneeAgentId).toBeNull();
  });

  it("does not take over an issue that a person assigns while the model is thinking", async () => {
    await setMode("apply");
    const id = await createIssue();
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const slow: JudgeClient = {
      ...judge,
      ask: async (req) => {
        const outcome = await judge.ask(req);
        await db.update(issues).set({ assigneeUserId: "someone" }).where(eq(issues.id, id));
        return outcome;
      },
    };
    const triage = triageWith(slow);
    await triage.checkAfterCreate({ id, companyId });
    const row = await reload(id);
    expect(row?.assigneeAgentId).toBeNull();
    expect(row?.assigneeUserId).toBe("someone");
    const res = await request(appFor(triage, board([companyId]))).get(`/api/issues/${id}/triage`);
    expect(res.body.items[0]).toMatchObject({ outcome: "suggested", owner: { decision: "assignee_changed" } });
  });

  it("records degraded when the company has no key, and changes nothing", async () => {
    await setMode("apply");
    const noKey: JudgeClient = {
      isAvailable: async () => false,
      ask: async () => ({ ok: false, reason: "no_key", inputHash: "h" }),
    };
    const triage = triageWith(noKey);
    const id = await createIssue();
    await triage.checkAfterCreate({ id, companyId });
    expect((await reload(id))?.assigneeAgentId).toBeNull();
    const res = await request(appFor(triage, board([companyId]))).get(`/api/issues/${id}/triage`);
    expect(res.body.items[0]).toMatchObject({ outcome: "degraded", reason: "no_key" });
  });

  it("triages an issue once", async () => {
    await setMode("suggest");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const triage = triageWith(judge);
    const id = await createIssue();
    await triage.checkAfterCreate({ id, companyId });
    await triage.checkAfterCreate({ id, companyId });
    expect(judge.asked).toHaveLength(1);
  });

  it("skips a routine-created issue without a model call", async () => {
    await setMode("apply");
    const judge = fakeJudge({ owner: "Amy", ownerProbability: 0.95 });
    const triage = triageWith(judge);
    const id = await createIssue({ originKind: "routine_execution", originId: randomUUID() });
    await triage.checkAfterCreate({ id, companyId });
    expect(judge.asked).toHaveLength(0);
    const res = await request(appFor(triage, board([companyId]))).get(`/api/issues/${id}/triage`);
    expect(res.body.items[0]).toMatchObject({ outcome: "skipped", reason: "routine_origin" });
  });

  it("pages the history with a cursor and rejects a bad cursor or limit", async () => {
    await setMode("suggest");
    const id = await createIssue();
    const now = Date.now();
    for (let n = 0; n < 3; n += 1) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "issue-triage",
        action: "issue.triaged",
        entityType: "issue",
        entityId: id,
        createdAt: new Date(now - n * 1000),
        details: {
          version: 1,
          issueId: id,
          companyId,
          mode: "suggest",
          outcome: "suggested",
          reason: null,
          modelId: "typesafe-ai/jev",
          modelCalls: 1,
          inputHashes: [`h${n}`],
          thresholds: { ownerMinProbability: 0.8, ownerMinMargin: 0.2 },
          priority: null,
          category: null,
          owner: null,
        },
      });
    }
    const app = appFor(triageWith(fakeJudge({ owner: "Amy", ownerProbability: 0.95 })), board([companyId]));
    const first = await request(app).get(`/api/issues/${id}/triage?limit=2`);
    expect(first.body.items.map((item: { inputHashes: string[] }) => item.inputHashes[0])).toEqual(["h0", "h1"]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app).get(`/api/issues/${id}/triage?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((item: { inputHashes: string[] }) => item.inputHashes[0])).toEqual(["h2"]);
    expect(second.body.nextCursor).toBeNull();
    expect((await request(app).get(`/api/issues/${id}/triage?cursor=garbage`)).status).toBe(400);
    expect((await request(app).get(`/api/issues/${id}/triage?limit=0`)).status).toBe(400);
  });

  it("hides other companies' issues exactly like missing ones, and 401s a stranger", async () => {
    const triage = triageWith(fakeJudge({ owner: "Amy", ownerProbability: 0.95 }));
    const id = await createIssue();
    const outsider = appFor(triage, board([otherCompanyId]));
    const missing = await request(outsider).get(`/api/issues/${randomUUID()}/triage`);
    const hidden = await request(outsider).get(`/api/issues/${id}/triage`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    const none = await request(appFor(triage, { type: "none", source: "none" })).get(`/api/issues/${id}/triage`);
    expect(none.status).toBe(401);
  });
});
