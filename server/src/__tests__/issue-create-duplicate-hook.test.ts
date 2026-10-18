import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  documentRevisions,
  documents,
  goals,
  issueComments,
  issueDocuments,
  issueDuplicatePairs,
  issuePlanDecompositions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { duplicateDetectionService } from "../services/duplicate-detection.js";
import { issueService, setIssueCreatedListener, type IssueCreatedEvent } from "../services/issues.js";
import type { JudgeClient } from "../services/judge-client.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

type Seeded = Awaited<ReturnType<typeof seedCompanyWithBoardAccess>>;

describeEmbeddedPostgres("every issue create path reaches the duplicate check", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-create-duplicate-hook-", {
    resetEach: async (db) => {
      await db.delete(issuePlanDecompositions);
      await db.delete(issueThreadInteractions);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(issueDuplicatePairs);
      await db.delete(issueComments);
      await db.delete(activityLog);
      await db.delete(issues).where(eq(issues.originKind, "never"));
      await resetBeforeCompanies(db);
    },
  });

  async function resetBeforeCompanies(db: typeof ctx.db) {
    await db.delete(agents).where(eq(agents.adapterType, "never-matches")).catch(() => {});
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(goals);
    await resetCompanyIssueFixtures(db);
  }

  afterEach(() => {
    setIssueCreatedListener(null);
  });

  function listen() {
    const events: IssueCreatedEvent[] = [];
    setIssueCreatedListener((event) => events.push(event));
    return events;
  }

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  async function createViaRoute(seeded: Seeded, body: Record<string, unknown>) {
    const res = await request(appFor(seeded)).post(`/api/companies/${seeded.companyId}/issues`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  it("root create reports the new issue, and a throwing listener never breaks creation", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Root");
    const events = listen();
    const created = await createViaRoute(seeded, { title: "Remove the compatibility barrels" });
    expect(events).toEqual([{ id: created.id, companyId: seeded.companyId }]);

    setIssueCreatedListener(() => {
      throw new Error("listener exploded");
    });
    await createViaRoute(seeded, { title: "Another plain issue" });
  });

  it("child create (POST /issues/:id/children) reports the child", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Child");
    const parent = await createViaRoute(seeded, { title: "Parent issue" });
    const events = listen();

    const res = await request(appFor(seeded))
      .post(`/api/issues/${parent.id}/children`)
      .send({ title: "Child issue to build" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(events).toEqual([{ id: res.body.id, companyId: seeded.companyId }]);
    expect(res.body.parentId).toBe(parent.id);
  });

  it("a root create that core resolves to an existing issue reports nothing", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Core dedupe");
    const body = { title: "Enforce PR assignee and GitHub issue linkage", allowDuplicate: false };
    const events = listen();

    await createViaRoute(seeded, body);
    const second = await request(appFor(seeded)).post(`/api/companies/${seeded.companyId}/issues`).send(body);

    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("a child create that core resolves to an existing child reports nothing", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Child replay");
    const parent = await createViaRoute(seeded, { title: "Parent issue" });
    const svc = issueService(ctx.db);
    const events = listen();

    const first = await svc.createChild(parent.id, { title: "Replayed child", idempotencyKey: "child-replay-1" });
    const second = await svc.createChild(parent.id, { title: "Replayed child", idempotencyKey: "child-replay-1" });

    expect(second.issue.id).toBe(first.issue.id);
    expect(events).toEqual([{ id: first.issue.id, companyId: seeded.companyId }]);
  });

  async function seedAcceptedPlan(seeded: Seeded) {
    const { companyId } = seeded;
    const agentId = randomUUID();
    const goalId = randomUUID();
    const sourceIssueId = randomUUID();
    const planDocumentId = randomUUID();
    const revisionId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await ctx.db.insert(goals).values({ id: goalId, companyId, title: "Plan", level: "task", status: "active" });
    await ctx.db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      goalId,
      title: "Planning issue",
      status: "in_progress",
      priority: "medium",
      workMode: "planning",
      assigneeAgentId: agentId,
    });
    await ctx.db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
    });
    await ctx.db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId: planDocumentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByAgentId: agentId,
    });
    await ctx.db.insert(issueDocuments).values({ companyId, issueId: sourceIssueId, documentId: planDocumentId, key: "plan" });
    await ctx.db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: { type: "issue_document", issueId: sourceIssueId, documentId: planDocumentId, key: "plan", revisionId, revisionNumber: 1 },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: new Date(),
      createdByUserId: "local-board",
      resolvedByUserId: "local-board",
    });
    return { sourceIssueId, revisionId };
  }

  it("accepted-plan decomposition reports every child it creates, once", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Plan");
    const { sourceIssueId, revisionId } = await seedAcceptedPlan(seeded);
    const events = listen();
    const body = {
      acceptedPlanRevisionId: revisionId,
      children: [{ title: "Build the importer" }, { title: "Write the migration guide" }],
    };

    const first = await request(appFor(seeded)).post(`/api/issues/${sourceIssueId}/accepted-plan-decompositions`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const childIds = (await ctx.db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, sourceIssueId))).map((row) => row.id);
    expect(childIds).toHaveLength(2);
    expect(events.map((event) => event.id).sort()).toEqual([...childIds].sort());
    expect(events.every((event) => event.companyId === seeded.companyId)).toBe(true);

    const replay = await request(appFor(seeded)).post(`/api/issues/${sourceIssueId}/accepted-plan-decompositions`).send(body);
    expect(replay.status).toBeLessThan(300);
    expect(events).toHaveLength(2);
  });

  it("reports an issue created inside a caller-owned transaction before it is visible elsewhere", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Tx");
    let visibleWhenReported: boolean | null = null;
    const events: IssueCreatedEvent[] = [];
    setIssueCreatedListener((event) => {
      events.push(event);
      void ctx.db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, event.id))
        .then((rows) => {
          visibleWhenReported = rows.length > 0;
        });
    });

    await ctx.db.transaction(async (tx) => {
      await issueService(tx as unknown as typeof ctx.db).create(seeded.companyId, { title: "Created in a transaction" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(events).toHaveLength(1);
    expect(visibleWhenReported).toBe(false);
  });

  it("end to end: a child issue that duplicates an older one gets a ledger row through the real check", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "End to end");
    await ctx.db.update(companies).set({ duplicateDetectionMode: "suggest" }).where(eq(companies.id, seeded.companyId));
    await createViaRoute(seeded, { title: "Remove songtrivia client compatibility barrels from the monorepo" });
    const parent = await createViaRoute(seeded, { title: "Cleanup parent" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const judge: JudgeClient = {
      isAvailable: async () => true,
      ask: vi.fn(async () => ({
        ok: true as const,
        answers: { same_outcome: { type: "predicate" as const, probability: 0.96, abstained: false } },
        modelId: "typesafe-ai/jev-1.2",
        inputHash: "h",
        cached: false,
      })),
    };
    const detection = duplicateDetectionService({
      db: ctx.db,
      judge,
      postSystemComment: (issueId, body, tx) => issueService(ctx.db).addComment(issueId, body, {}, { authorType: "system" }, tx),
      retryDelaysMs: [20, 20, 20],
    });
    setIssueCreatedListener((event) => void detection.checkAfterCreate(event));

    const res = await request(appFor(seeded))
      .post(`/api/issues/${parent.id}/children`)
      .send({ title: "Remove songtrivia client compatibility barrels from the monorepo today" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const deadline = Date.now() + 5_000;
    let pairs: Array<typeof issueDuplicatePairs.$inferSelect> = [];
    while (Date.now() < deadline && pairs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pairs = await ctx.db
        .select()
        .from(issueDuplicatePairs)
        .where(and(eq(issueDuplicatePairs.companyId, seeded.companyId), eq(issueDuplicatePairs.issueId, res.body.id)));
    }
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ verdict: "likely_duplicate", sameOutcomeProbability: 0.96 });
  });

  it("creates issues normally when nothing is listening", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "No listener");
    await createViaRoute(seeded, { title: "Plain create" });
  });
});
