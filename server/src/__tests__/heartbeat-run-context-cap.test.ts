import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues, routines } from "@paperclipai/db";
import {
  RUN_CONTEXT_DEFAULTS,
  resolveRunContextSettings,
  updateCompanySchema,
  updateRoutineSchema,
  createAgentSchema,
  createRoutineSchema,
  type RunContextPolicy,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { companyService } from "../services/companies.js";
import { documentService } from "../services/documents.js";
import { documentAnnotationService } from "../services/document-annotations.js";
import { routineService } from "../services/routines.js";

const support = await getEmbeddedPostgresTestSupport();

describe("resolveRunContextSettings", () => {
  it("equals the pre-feature behavior when nothing is set", () => {
    expect(resolveRunContextSettings({})).toEqual(RUN_CONTEXT_DEFAULTS);
    expect(RUN_CONTEXT_DEFAULTS).toEqual({
      maxComments: 8, maxCommentChars: 4000, maxTotalCommentChars: 12000, window: "oldest", truncationMarker: false,
    });
  });

  it("lets the most specific level win: company < agent < routine < wake type", () => {
    const company: RunContextPolicy = { maxComments: 10, maxCommentChars: 500, byWakeReason: { issue_commented: { maxComments: 50 } } };
    const agent: RunContextPolicy = { maxComments: 20, window: "newest" };
    const routine: RunContextPolicy = { maxComments: 30, byWakeReason: { issue_commented: { truncationMarker: true } } };
    const layers = { company, agent, routine };
    expect(resolveRunContextSettings(layers, "other")).toMatchObject({ maxComments: 30, maxCommentChars: 500, window: "newest", truncationMarker: false });
    // wake-type beats every base level; among wake-type layers the more specific level wins
    expect(resolveRunContextSettings(layers, "issue_commented")).toMatchObject({ maxComments: 50, truncationMarker: true });
    expect(resolveRunContextSettings({ company, agent }, null).maxComments).toBe(20);
  });

  it("ignores invalid stored layers", () => {
    expect(resolveRunContextSettings({ company: { maxComments: -1 }, agent: "x" })).toEqual(RUN_CONTEXT_DEFAULTS);
  });

  it("validates at the API boundary", () => {
    expect(updateCompanySchema.safeParse({ runContextPolicy: { maxComments: 0 } }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ runContextPolicy: { bogus: 1 } }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ runContextPolicy: null }).success).toBe(true);
    expect(updateRoutineSchema.safeParse({ runContextPolicy: { window: "newest" } }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: "a", adapterType: "process", runtimeConfig: { runContext: { window: "x" } } }).success).toBe(false);
  });
});

(support.supported ? describe : describe.skip)("run context in the wake payload", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-context-cap-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(opts: { comments: number; body?: (i: number) => string; origin?: { routineId: string } }) {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cap", defaultResponsibleUserId: "board", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Thread", description: "Brief", status: "in_progress",
      ...(opts.origin ? { originKind: "routine_execution", originId: opts.origin.routineId } : {}),
    });
    const base = Date.parse("2026-09-11T00:00:00Z");
    const ids = Array.from({ length: opts.comments }, () => randomUUID());
    await db.insert(issueComments).values(ids.map((id, i) => ({
      id, companyId, issueId, authorType: "user" as const, authorUserId: "board",
      body: (opts.body ?? ((n) => `message ${n}`))(i), createdAt: new Date(base + i * 1000),
    })));
    return { companyId, issueId, agentId, ids };
  }

  function wake(s: { companyId: string; issueId: string; agentId: string; ids: string[] }, wakeReason = "issue_commented") {
    return buildPaperclipWakePayload({
      db, companyId: s.companyId, agentId: s.agentId,
      contextSnapshot: { wakeReason, issueId: s.issueId, wakeCommentId: s.ids[s.ids.length - 1], wakeCommentIds: s.ids },
      issueSummary: { id: s.issueId, identifier: null, title: "Thread", description: "Brief", status: "in_progress", priority: "medium", workMode: "standard" },
    });
  }

  it("defaults keep the pre-feature behavior: first 8 comments, 4000 chars each, 12000 total, no marker", async () => {
    const s = await seed({ comments: 12 });
    const payload = await wake(s);
    expect(payload?.comments.map((c) => c.id)).toEqual(s.ids.slice(0, 8));
    expect(payload).toMatchObject({ truncated: true, fallbackFetchNeeded: true, commentWindow: { requestedCount: 12, includedCount: 8 } });

    const long = await seed({ comments: 5, body: () => "x".repeat(5000) });
    const longPayload = await wake(long);
    expect(longPayload?.comments[0]).toMatchObject({ body: "x".repeat(4000), bodyTruncated: true });
    // 12000 total budget: 3 full 4000-char bodies, then the budget is spent
    expect(longPayload?.comments).toHaveLength(3);
    expect(longPayload?.truncated).toBe(true);
  });

  it("company settings override the defaults", async () => {
    const s = await seed({ comments: 12 });
    const patch = updateCompanySchema.parse({ runContextPolicy: { maxComments: 3, window: "newest", maxCommentChars: 100, truncationMarker: true } });
    await companyService(db).update(s.companyId, patch);
    const payload = await wake(s);
    expect(payload?.comments.map((c) => c.id)).toEqual(s.ids.slice(-3));

    const long = await seed({ comments: 1, body: () => "y".repeat(300) });
    await companyService(db).update(long.companyId, patch);
    expect((await wake(long))?.comments[0]?.body).toBe(`${"y".repeat(100)}\n[truncated: 200 more characters]`);
  });

  it("most specific level wins when levels disagree", async () => {
    const routineId = randomUUID();
    const s = await seed({ comments: 40, origin: { routineId } });
    const companyPolicy: RunContextPolicy = { maxComments: 5, window: "newest", byWakeReason: { issue_commented: { maxComments: 6 } } };
    await companyService(db).update(s.companyId, { runContextPolicy: companyPolicy });
    expect((await wake(s, "other"))?.comments).toHaveLength(5);

    await db.update(agents).set({ runtimeConfig: { runContext: { maxComments: 10 } } }).where(eq(agents.id, s.agentId));
    expect((await wake(s, "other"))?.comments).toHaveLength(10);

    await db.insert(routines).values({ id: routineId, companyId: s.companyId, title: "R", responsibleUserId: "board", runContextPolicy: { maxComments: 15 } });
    expect((await wake(s, "other"))?.comments).toHaveLength(15);

    // wake-type override on the company beats the agent and routine base settings
    expect((await wake(s, "issue_commented"))?.comments).toHaveLength(6);

    await db.update(routines).set({ runContextPolicy: { maxComments: 15, byWakeReason: { issue_commented: { maxComments: 2 } } } }).where(eq(routines.id, routineId));
    expect((await wake(s, "issue_commented"))?.comments.map((c) => c.id)).toEqual(s.ids.slice(-2));
  });
  it("caps annotation-only wakes with the configured limit", async () => {
    const s = await seed({ comments: 1 });
    await companyService(db).update(s.companyId, { runContextPolicy: { maxCommentChars: 100 } });
    const { document } = await documentService(db).upsertIssueDocument({
      issueId: s.issueId, key: "plan", title: "Plan", format: "markdown", body: "Alpha selected text omega",
    });
    const thread = await documentAnnotationService(db).createThread(s.issueId, "plan", {
      baseRevisionId: document.latestRevisionId ?? "",
      baseRevisionNumber: document.latestRevisionNumber,
      selector: {
        quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
        position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
      },
      body: "a".repeat(300),
    }, { actorType: "user", actorId: "board", userId: "board" });
    const contextSnapshot = {
      issueId: s.issueId, annotationCommentId: thread.comments[0]?.id, wakeReason: "document_annotation_commented",
    };
    const capped = await buildPaperclipWakePayload({ db, companyId: s.companyId, agentId: s.agentId, contextSnapshot });
    expect(capped?.annotationDeltas[0]?.body).toHaveLength(100);

  });
});

(support.supported ? describe : describe.skip)("routine run-context policy revisions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-context-routine-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  it("snapshots, conflict-checks and restores policy-only edits", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rev", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" });
    const svc = routineService(db);
    const routine = await svc.create(companyId, createRoutineSchema.parse({
      title: "Routine", description: "Body", assigneeAgentId: agentId, status: "paused", runContextPolicy: { maxComments: 5 },
    }), { userId: "board" });
    const firstRevisionId = routine.latestRevisionId ?? "";

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.find((r) => r.id === firstRevisionId)?.snapshot.routine.runContextPolicy).toEqual({ maxComments: 5 });

    const changed = await svc.update(routine.id, { baseRevisionId: firstRevisionId, runContextPolicy: { maxComments: 10 } }, { userId: "editor-a" });
    expect(changed?.latestRevisionId).not.toBe(firstRevisionId);
    expect(changed?.runContextPolicy).toEqual({ maxComments: 10 });
    expect(changed?.updatedByUserId).toBe("editor-a");

    await expect(
      svc.update(routine.id, { baseRevisionId: firstRevisionId, runContextPolicy: { maxComments: 15 } }, { userId: "editor-b" }),
    ).rejects.toThrow(/updated by someone else/);
    expect((await svc.get(routine.id))?.runContextPolicy).toEqual({ maxComments: 10 });

    const restored = await svc.restoreRevision(routine.id, firstRevisionId, { userId: "board" });
    expect(restored.routine.runContextPolicy).toEqual({ maxComments: 5 });
  });

  it("does not add a revision for an unchanged or unset policy", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rev2", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" });
    const svc = routineService(db);
    const routine = await svc.create(companyId, createRoutineSchema.parse({
      title: "Routine", description: "Body", assigneeAgentId: agentId, status: "paused",
    }), { userId: "board" });
    const same = await svc.update(routine.id, { title: "Routine" }, { userId: "board" });
    expect(same?.latestRevisionId).toBe(routine.latestRevisionId);
    const cleared = await svc.update(routine.id, { runContextPolicy: null }, { userId: "board" });
    expect(cleared?.latestRevisionId).toBe(routine.latestRevisionId);
  });
});
