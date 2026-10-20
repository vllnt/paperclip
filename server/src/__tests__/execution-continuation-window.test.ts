import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { buildNativeContinuationPrompt } from "../services/native-runtime/native-continuation.js";
import { CONTINUATION_ENVELOPE_MAX_CHARS } from "../services/continuation-window.js";
import { TASK_PLAN_BODY_MAX_CHARS, getTaskPlanContext } from "../services/task-plan-context.js";

const support = await getEmbeddedPostgresTestSupport();

/** Each comment body starts with a unique marker so a prompt can be searched for it. */
const bodyFor = (index: number) => `marker-${String(index).padStart(4, "0")} `.padEnd(2_000, "lorem ipsum ");
const quarantined = { preset: "low_trust_review", disposition: "quarantined" } as const;

(support.supported ? describe : describe.skip)("bounded continuation window on a long thread", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const commentIds: string[] = [];
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  let firstEnvelope: ExecutionContinuationEnvelope;
  let resumed: ExecutionContinuationEnvelope;

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
    const untrustedId = randomUUID();
    await db.insert(documents).values({ id: untrustedId, companyId, title: "Injected title", latestBody: "u".repeat(10), sourceTrust: quarantined });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: untrustedId, key: "untrusted" });
    const summaryId = randomUUID();
    await db.insert(documents).values({ id: summaryId, companyId, title: "Summary", latestBody: "s".repeat(10) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: summaryId, key: "continuation-summary" });
    await db.update(issueComments).set({ sourceTrust: quarantined }).where(eq(issueComments.id, commentIds[250]!));
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
    const quarantinedEntry = firstEnvelope.olderMessages!.find((entry) => entry.id === commentIds[250]);
    expect(quarantinedEntry!.preview).not.toContain("marker-0250");
    expect(firstEnvelope.documents).toHaveLength(3);
    expect(firstEnvelope.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "notes", title: "Notes", chars: 1_000, revisionNumber: 1 }),
      expect.objectContaining({ key: "plan", title: "Plan", chars: 500_000, revisionNumber: 3 }),
      expect.objectContaining({ key: "untrusted", title: null }),
    ]));
    expect(JSON.stringify(firstEnvelope).length).toBeLessThanOrEqual(CONTINUATION_ENVELOPE_MAX_CHARS);
  });

  it("cuts a huge plan body in the task brief", async () => {
    const plan = await getTaskPlanContext({ db, companyId, issueId });
    expect(plan!.body.length).toBeLessThan(TASK_PLAN_BODY_MAX_CHARS + 200);
    expect(plan!.body).toContain(`[truncated: ${500_000 - TASK_PLAN_BODY_MAX_CHARS} more characters; read it with GET /api/issues/${issueId}/documents/plan (CLI: paperclipai issue document:get ${issueId} plan)]`);
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
    // An edit to a comment that the first run had in its window, now outside the window.
    await db.update(issueComments).set({ body: `${bodyFor(290)} edited`, updatedAt: new Date(Date.UTC(2026, 9, 3)) }).where(eq(issueComments.id, commentIds[290]!));
    resumed = await buildExecutionContinuation({
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
    expect(resumed.resumeDelta!.olderMessages!.map((entry) => entry.id)).toEqual([commentIds[290], ...commentIds.slice(300, 306)]);
    expect(resumed.resumeDelta).not.toHaveProperty("unlistedMessages");

    const prompt = renderPaperclipWakePrompt(
      {
        reason: "issue_commented",
        issue: { id: issueId, identifier: "WIN-1", title: "Long-lived task", status: "in_progress" },
        executionContinuation: resumed,
      },
      { resumedSession: true },
    );
    expect(prompt).toContain("These are new or edited messages since the named run; earlier history remains in this session.");
    expect(prompt).toContain("7 more new or edited comments are listed only in `olderMessages` with a one-line preview");
    expect(prompt).toContain("marker-0324");
    expect(prompt).not.toContain("marker-0299 lorem");
    expect(prompt.length).toBeLessThan(60_000);
  });

  it("lists the newest new comments outside the window on a long resume, counts the rest, and sends native runs to the full prompt", async () => {
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId, executionContinuation: resumed },
    });
    await insertComments(325, 405);
    const next = await buildExecutionContinuation({
      db,
      companyId,
      issueId,
      agentId,
      context: { issueId, wakeReason: "issue_commented", commentId: commentIds[404] },
      previousContextRunId: secondRunId,
      summary: null,
      exposeLowTrustRaw: false,
    });
    expect(next.resumeDelta!.messages.map((message) => message.id)).toEqual(commentIds.slice(386, 405));
    expect(next.resumeDelta!.olderMessages!.map((entry) => entry.id)).toEqual(commentIds.slice(336, 386));
    expect(next.resumeDelta!.unlistedMessages).toBe(11);
    const payload = {
      reason: "issue_commented",
      issue: { id: issueId, identifier: "WIN-1", title: "Long-lived task", status: "in_progress" },
      executionContinuation: next,
    };
    const prompt = renderPaperclipWakePrompt(payload, { resumedSession: true });
    expect(prompt).toContain("50 more new or edited comments are listed only in `olderMessages`");
    expect(prompt).toContain(`11 more new or edited comments are not listed; page back with \`GET /api/issues/${issueId}/comments?order=desc&after=${commentIds[336]}&limit=20\``);
    const task = { title: "Long-lived task", description: null };
    expect(buildNativeContinuationPrompt({ wakePayload: payload, previousRunId: secondRunId, issue: task, previousIssue: task })).toBeNull();
  });

  it("holds the envelope ceiling with a huge plan document and 50 long comments that woke the run", async () => {
    const heavyIssueId = randomUUID();
    await db.insert(issues).values({ id: heavyIssueId, companyId, title: "Plan-heavy task", status: "in_progress", assigneeAgentId: agentId });
    const wakeIds = Array.from({ length: 50 }, () => randomUUID());
    await db.insert(issueComments).values(wakeIds.map((id, index) => ({
      id,
      companyId,
      issueId: heavyIssueId,
      authorType: "user",
      authorUserId: "board-user",
      body: `heavy-${String(index).padStart(2, "0")} `.padEnd(20_000, "detail "),
      createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, index)),
    })));
    const planId = randomUUID();
    const planRevisionId = randomUUID();
    const planBody = "plan line\n".repeat(50_000);
    await db.insert(documents).values({ id: planId, companyId, title: "Plan", latestBody: planBody, latestRevisionId: planRevisionId, latestRevisionNumber: 1 });
    await db.insert(documentRevisions).values({ id: planRevisionId, companyId, documentId: planId, revisionNumber: 1, body: planBody });
    await db.insert(issueDocuments).values({ companyId, issueId: heavyIssueId, documentId: planId, key: "plan" });

    const envelope = await buildExecutionContinuation({
      db,
      companyId,
      issueId: heavyIssueId,
      agentId,
      context: { issueId: heavyIssueId, wakeReason: "issue_commented", wakeCommentIds: wakeIds },
      summary: null,
      exposeLowTrustRaw: false,
    });
    const plan = await getTaskPlanContext({ db, companyId, issueId: heavyIssueId });
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: { id: heavyIssueId, identifier: "WIN-2", title: "Plan-heavy task", status: "in_progress" },
      executionContinuation: envelope,
    });
    expect(envelope.messages.map((message) => message.id)).toEqual(wakeIds);
    // The newest wake comment is also the latest request: it is budgeted first and the objective stays whole.
    expect(envelope.messages.at(-1)!.body.startsWith(`heavy-49 `.padEnd(16_000, "detail "))).toBe(true);
    expect(envelope.objective).toHaveLength(20_000);
    expect(prompt).toContain(`"objective":"heavy-49 detail`);
    expect(prompt).toContain("more characters; read the issue and its latest comment]");
    expect(envelope.window).toMatchObject({ totalMessages: 50, includedMessages: 50, truncatedMessages: 50 });
    expect(envelope.messages.every((message) => message.body.includes(`read comment ${message.id}`))).toBe(true);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(CONTINUATION_ENVELOPE_MAX_CHARS);
    expect(plan!.body.length).toBeLessThan(TASK_PLAN_BODY_MAX_CHARS + 200);
    // The thread and the plan hold 1.5M characters; the history and the plan brief stay far below a 200K-token context.
    expect(prompt.length + plan!.body.length).toBeLessThan(CONTINUATION_ENVELOPE_MAX_CHARS + TASK_PLAN_BODY_MAX_CHARS);
  });
});
