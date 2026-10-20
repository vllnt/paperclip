import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "../services/execution-continuation.js";
import { CONTINUATION_ENVELOPE_MAX_CHARS } from "../services/continuation-window.js";
import { TASK_PLAN_BODY_MAX_CHARS, getTaskPlanContext } from "../services/task-plan-context.js";

const support = await getEmbeddedPostgresTestSupport();

/** Each comment body starts with a unique marker so a prompt can be searched for it. */
const bodyFor = (index: number) => `marker-${String(index).padStart(4, "0")} `.padEnd(2_000, "lorem ipsum ");

(support.supported ? describe : describe.skip)("bounded continuation window on a long thread", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const commentIds: string[] = [];
  const firstRunId = randomUUID();
  let firstEnvelope: ExecutionContinuationEnvelope;

  const insertComments = async (from: number, to: number) => {
    const rows = [];
    for (let index = from; index < to; index += 1) {
      const id = randomUUID();
      commentIds[index] = id;
      // The ten oldest comments are the human brief; the rest are agent progress notes.
      rows.push(index < 10
        ? { id, companyId, issueId, authorType: "user", authorUserId: "board-user", body: bodyFor(index), createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)) }
        : { id, companyId, issueId, authorType: "agent", authorAgentId: agentId, body: bodyFor(index), createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)) });
    }
    await db.insert(issueComments).values(rows);
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-window-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Window", issuePrefix: "WIN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Long-lived task", status: "in_progress", assigneeAgentId: agentId });
    await insertComments(0, 300);
    const planId = randomUUID();
    const planRevisionId = randomUUID();
    const planBody = "plan line\n".repeat(50_000);
    await db.insert(documents).values({ id: planId, companyId, title: "Plan", latestBody: planBody, latestRevisionId: planRevisionId, latestRevisionNumber: 3 });
    await db.insert(documentRevisions).values({ id: planRevisionId, companyId, documentId: planId, revisionNumber: 3, body: planBody });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: planId, key: "plan" });
    const notesId = randomUUID();
    await db.insert(documents).values({ id: notesId, companyId, title: "Notes", latestBody: "n".repeat(1_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: notesId, key: "notes" });
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("carries the pinned request and wake comment, the newest comments, an older index and a document index", async () => {
    firstEnvelope = await buildExecutionContinuation({
      db,
      companyId,
      issueId,
      agentId,
      context: { issueId, wakeReason: "issue_commented", commentId: commentIds[120] },
      summary: null,
      exposeLowTrustRaw: false,
    });
    const ids = firstEnvelope.messages.map((message) => message.id);
    expect(ids).toEqual([commentIds[9], commentIds[120], ...commentIds.slice(282, 300)]);
    expect(firstEnvelope.objective).toBe(bodyFor(9));
    expect(firstEnvelope.objectiveSource).toMatchObject({ kind: "comment", id: commentIds[9] });
    expect(firstEnvelope.coverage).toMatchObject({ kind: "bounded_task_history", throughCommentId: commentIds[299] });
    expect(firstEnvelope.window).toMatchObject({
      totalMessages: 300,
      includedMessages: 20,
      indexedMessages: 50,
      unindexedMessages: 230,
      oldestIncludedCommentId: commentIds[282],
    });
    expect(firstEnvelope.olderMessages!.map((entry) => entry.id)).toEqual(commentIds.slice(232, 282));
    expect(firstEnvelope.olderMessages![0]!.preview.startsWith("marker-0232 lorem ipsum")).toBe(true);
    expect(firstEnvelope.documents).toHaveLength(2);
    expect(firstEnvelope.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "notes", title: "Notes", chars: 1_000, revisionNumber: 1 }),
      expect.objectContaining({ key: "plan", title: "Plan", chars: 500_000, revisionNumber: 3 }),
    ]));
    expect(JSON.stringify(firstEnvelope).length).toBeLessThanOrEqual(CONTINUATION_ENVELOPE_MAX_CHARS);
  });

  it("cuts a huge plan body in the task brief", async () => {
    const plan = await getTaskPlanContext({ db, companyId, issueId });
    expect(plan!.body.length).toBeLessThan(TASK_PLAN_BODY_MAX_CHARS + 200);
    expect(plan!.body).toContain(`[truncated: ${500_000 - TASK_PLAN_BODY_MAX_CHARS} more characters; read revision 3 with GET /api/issues/${issueId}/documents/plan/revisions]`);
  });

  it("renders a fresh-session prompt that is a fraction of the thread and says how to read older comments", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: { id: issueId, identifier: "WIN-1", title: "Long-lived task", status: "in_progress" },
      executionContinuation: firstEnvelope,
    });
    const threadChars = commentIds.slice(0, 300).reduce((sum, _id, index) => sum + bodyFor(index).length, 0);
    expect(threadChars).toBe(600_000);
    expect(prompt.length).toBeLessThan(threadChars * 0.15);
    expect(prompt).toContain("History is bounded to fit the model context. `messages` holds 20 of the 300 comments");
    expect(prompt).toContain(`GET /api/issues/${issueId}/comments?order=desc&after=${commentIds[282]}&limit=20`);
    expect(prompt).toContain(`paperclipai issue comment:get ${issueId} <commentId>`);
    expect(prompt).toContain("marker-0299");
    expect(prompt).toContain("marker-0009");
    expect(prompt).not.toContain("marker-0200 lorem");
  });

  it("gives a resumed session only the delta of the window, with the newly indexed older comments", async () => {
    await db.insert(heartbeatRuns).values({
      id: firstRunId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId, executionContinuation: firstEnvelope },
    });
    await insertComments(300, 325);
    const resumed = await buildExecutionContinuation({
      db,
      companyId,
      issueId,
      agentId,
      context: { issueId, wakeReason: "issue_commented", commentId: commentIds[324] },
      previousContextRunId: firstRunId,
      summary: null,
      exposeLowTrustRaw: false,
    });
    expect(resumed.messages.map((message) => message.id)).toEqual([commentIds[9], ...commentIds.slice(306, 325)]);
    expect(resumed.resumeDelta!.baseRunId).toBe(firstRunId);
    expect(resumed.resumeDelta!.messages.map((message) => message.id)).toEqual(commentIds.slice(306, 325));
    expect(resumed.resumeDelta!.olderMessages!.map((entry) => entry.id)).toEqual(commentIds.slice(300, 306));

    const prompt = renderPaperclipWakePrompt(
      {
        reason: "issue_commented",
        issue: { id: issueId, identifier: "WIN-1", title: "Long-lived task", status: "in_progress" },
        executionContinuation: resumed,
      },
      { resumedSession: true },
    );
    expect(prompt).toContain("These are new or edited messages since the named run; earlier history remains in this session.");
    expect(prompt).toContain("marker-0324");
    expect(prompt).not.toContain("marker-0299 lorem");
    expect(prompt.length).toBeLessThan(60_000);
  });
});
