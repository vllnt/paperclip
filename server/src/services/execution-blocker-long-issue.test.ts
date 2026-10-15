import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { selectInCommentBatches, COMMENT_LOOKUP_BATCH } from "./comment-id-batches.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";

const COMMENT_COUNT = 20000;
const CONSUMED_RUN_COUNT = 800;
const BOUND_MS = 2000;
const SEED_BATCH = 1000;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("comment id lookups on a long issue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("long-issue-comment-lookups-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seedLongIssue() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Long issue", defaultResponsibleUserId: "board", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Long", status: "in_progress", assigneeAgentId: agentId });
    const base = Date.parse("2026-09-11T00:00:00Z");
    const ids = Array.from({ length: COMMENT_COUNT }, () => randomUUID());
    const notPending = new Set<string>();
    const rows = ids.map((id, index) => {
      const row = { id, companyId, issueId, authorType: "user" as const, authorUserId: "board", body: `message ${index}`,
        createdAt: new Date(base + index * 1000) };
      if (index % 10 === 1) { notPending.add(id); return { ...row, authorType: "agent" as const, authorUserId: null, authorAgentId: agentId }; }
      if (index % 10 === 2) { notPending.add(id); return { ...row, deletedAt: new Date(base) }; }
      return row;
    });
    for (let offset = 0; offset < rows.length; offset += SEED_BATCH) {
      await db.insert(issueComments).values(rows.slice(offset, offset + SEED_BATCH));
    }
    return { companyId, agentId, issueId, ids, notPending };
  }

  it("counts saved messages of a blocked long issue within a bounded time", async () => {
    const { companyId, agentId, issueId, ids, notPending } = await seedLongIssue();
    const stoppedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: stoppedRunId, companyId, agentId, status: "failed", runtimeMode: "legacy",
      startedAt: new Date(), contextSnapshot: { issueId } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: stoppedRunId,
      evidence: { runId: stoppedRunId }, nextAction: "Inspect the stopped run before continuing." });
    // Every comment is saved on deferred wakes; earlier runs consumed some of them.
    await db.insert(agentWakeupRequests).values([
      { companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
        payload: withQueuedCommentIdsInWakePayload({ issueId }, ids.slice(0, COMMENT_COUNT / 2)) },
      { companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
        payload: withQueuedCommentIdsInWakePayload({ issueId }, ids.slice(COMMENT_COUNT / 2)) },
    ]);
    const pending = ids.filter((id) => !notPending.has(id));
    const consumed = pending.slice(0, CONSUMED_RUN_COUNT * 4);
    await db.insert(heartbeatRuns).values(Array.from({ length: CONSUMED_RUN_COUNT }, (_, index) => ({
      id: randomUUID(), companyId, agentId, status: "succeeded", runtimeMode: "native" as const, startedAt: new Date(),
      contextSnapshot: index % 2 === 0
        ? { issueId, wakeCommentId: consumed[index * 4], wakeCommentIds: consumed.slice(index * 4, index * 4 + 4) }
        : { issueId, wakeCommentIds: consumed.slice(index * 4, index * 4 + 4) },
    })));

    const started = performance.now();
    const blocker = await getExecutionBlocker(db, companyId, issueId);
    const elapsed = performance.now() - started;

    expect(blocker?.recoveryActionId).toBeTruthy();
    expect(blocker?.savedMessageCount).toBe(pending.length - consumed.length);
    expect(elapsed, "elapsed ms").toBeLessThan(BOUND_MS);
  }, 120000);

  it.each(["active", "resolved"] as const)("clears a %s execution blocker when the task is reassigned", async (status) => {
    const companyId = randomUUID(), agentId = randomUUID(), nextAgentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reassign", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values([agentId, nextAgentId].map((id) => ({ id, companyId, name: `Agent ${id.slice(0, 4)}`, role: "engineer",
      adapterType: "paperclip_runner", status: "idle", runtimeConfig: {} })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassign", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "legacy",
      startedAt: new Date(), contextSnapshot: { issueId } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status, ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: runId, returnOwnerAgentId: agentId,
      evidence: status === "active" ? { runId } : { runId, automaticRecovery: { replay: "blocked" } },
      nextAction: "Inspect the stopped run before continuing." }).returning();
    expect((await getExecutionBlocker(db, companyId, issueId))?.recoveryActionId).toBe(action!.id);

    await issueService(db).update(issueId, { assigneeAgentId: nextAgentId });

    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(after).toMatchObject({ status: "resolved", outcome: "cancelled" });
  }, 30000);

  it("selects every row across batches and never exceeds the batch size", async () => {
    const { companyId, issueId, ids } = await seedLongIssue();
    const batchSizes: number[] = [];
    const rows = await selectInCommentBatches(ids, (batch) => {
      batchSizes.push(batch.length);
      return db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, batch),
      ));
    });
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(ids));
    expect(rows).toHaveLength(ids.length);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(COMMENT_LOOKUP_BATCH);
    expect(await selectInCommentBatches([], async () => { throw new Error("must not query"); })).toEqual([]);
  }, 60000);
});
