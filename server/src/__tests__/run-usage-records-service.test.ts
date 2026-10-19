import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  runUsageRecords,
} from "@paperclipai/db";
import { RUN_USAGE_RECORD_SCHEMA_VERSION } from "@paperclipai/shared";
import { deriveRunUsageRecord } from "../services/run-usage-record-derive.js";
import {
  RUN_USAGE_WORKER_LOCK,
  runUsageRecordService,
  upsertRunUsageRecords,
} from "../services/run-usage-records.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-09T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describeEmbeddedPostgres.sequential("run usage record service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const service = () => runUsageRecordService(db);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-usage-records-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(runUsageRecords);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(
    scope: { companyId: string; agentId: string },
    values: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "succeeded",
      createdAt: ago(HOUR),
      startedAt: ago(HOUR - 5_000),
      finishedAt: ago(HOUR - 65_000),
      usageJson: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5, usageSource: "per_run" },
      ...values,
    });
    return id;
  }

  async function recordIds(): Promise<string[]> {
    const rows = await db.select({ runId: runUsageRecords.runId }).from(runUsageRecords);
    return rows.map((row) => row.runId).sort();
  }

  it("derives a record for each terminal status and none for runs still in flight", async () => {
    const scope = await seedCompany();
    const done = await Promise.all(
      ["succeeded", "failed", "cancelled", "timed_out"].map((status) => seedRun(scope, { status })),
    );
    await Promise.all(
      ["queued", "running", "scheduled_retry"].map((status) => seedRun(scope, { status, finishedAt: null })),
    );

    const result = await service().runPass({ now: NOW });

    expect(result).toMatchObject({ skipped: false, written: 4 });
    expect(await recordIds()).toEqual([...done].sort());
  });

  it("waits for the settle delay and uses created_at for a run with no finished_at", async () => {
    const scope = await seedCompany();
    const settling = await seedRun(scope, { finishedAt: ago(2 * MINUTE) });
    const settled = await seedRun(scope, { finishedAt: ago(11 * MINUTE) });
    const noFinish = await seedRun(scope, { finishedAt: null, createdAt: ago(30 * MINUTE) });
    const noFinishFresh = await seedRun(scope, { finishedAt: null, createdAt: ago(3 * MINUTE) });

    await service().runPass({ now: NOW });

    expect(await recordIds()).toEqual([settled, noFinish].sort());
    expect(await recordIds()).not.toContain(settling);
    expect(await recordIds()).not.toContain(noFinishFresh);

    await service().runPass({ now: new Date(NOW.getTime() + 10 * MINUTE) });
    expect(await recordIds()).toContain(settling);
  });

  it("ignores runs created before the lookback until a wider pass runs", async () => {
    const scope = await seedCompany();
    const old = await seedRun(scope, { createdAt: ago(3 * DAY), startedAt: ago(3 * DAY), finishedAt: ago(3 * DAY - MINUTE) });

    await service().runPass({ now: NOW });
    expect(await recordIds()).toEqual([]);

    const sweep = await service().runPass({ now: NOW, lookbackMs: 30 * DAY });
    expect(sweep.written).toBe(1);
    expect(await recordIds()).toEqual([old]);
  });

  it("is idempotent: a second pass writes nothing and keeps the stored row", async () => {
    const scope = await seedCompany();
    const runId = await seedRun(scope);

    await service().runPass({ now: NOW });
    const [first] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, runId));
    const second = await service().runPass({ now: NOW });
    const [after] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, runId));

    expect(second.written).toBe(0);
    expect(after?.derivedAt).toEqual(first?.derivedAt);
    expect(await db.select().from(runUsageRecords)).toHaveLength(1);
  });

  it("replaces a stored record only when its schema version is lower and a re-derive is asked for", async () => {
    const scope = await seedCompany();
    const stale = await seedRun(scope, { usageJson: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });
    await service().runPass({ now: NOW });
    await db.update(runUsageRecords).set({ schemaVersion: 0, inputTokens: 999 }).where(eq(runUsageRecords.runId, stale));
    const current = await seedRun(scope, { usageJson: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 1 } });
    await service().runPass({ now: NOW });
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 1 } }).where(eq(heartbeatRuns.id, current));

    await service().runPass({ now: NOW });
    const [untouched] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, stale));
    expect(untouched?.inputTokens).toBe(999);

    const rederived = await service().runPass({ now: NOW, rederive: true });
    const [replaced] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, stale));
    const [kept] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, current));
    expect(rederived.written).toBe(1);
    expect(replaced).toMatchObject({ inputTokens: 1, schemaVersion: RUN_USAGE_RECORD_SCHEMA_VERSION });
    expect(kept?.inputTokens).toBe(7);
  });

  it("never lowers a stored record's schema version when an older server writes late", async () => {
    const scope = await seedCompany();
    const runId = await seedRun(scope);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const derived = run && deriveRunUsageRecord({
      run,
      adapterType: "claude_local",
      issue: null,
      contextProjectId: null,
      wakeReason: null,
      retryDepth: 0,
      source: "derived",
    });
    expect(derived).toBeTruthy();
    if (!derived) return;

    await upsertRunUsageRecords(db, [{ ...derived, schemaVersion: 5, inputTokens: 500 }]);
    const olderWrite = await upsertRunUsageRecords(db, [{ ...derived, schemaVersion: 3, inputTokens: 300 }]);
    const [afterOlder] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, runId));
    const newerWrite = await upsertRunUsageRecords(db, [{ ...derived, schemaVersion: 6, inputTokens: 600 }]);
    const [afterNewer] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, runId));

    expect(olderWrite).toBe(0);
    expect(afterOlder).toMatchObject({ schemaVersion: 5, inputTokens: 500 });
    expect(newerWrite).toBe(1);
    expect(afterNewer).toMatchObject({ schemaVersion: 6, inputTokens: 600 });
  });

  it("backfills runs of any age with the backfill source", async () => {
    const scope = await seedCompany();
    const ancient = await seedRun(scope, { createdAt: ago(400 * DAY), startedAt: ago(400 * DAY), finishedAt: ago(400 * DAY - MINUTE) });

    const result = await service().backfill({ now: NOW, companyId: scope.companyId });

    expect(result.written).toBe(1);
    const [row] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, ancient));
    expect(row?.source).toBe("backfill");
  });

  it("does nothing while another worker holds the lock, then catches up", async () => {
    const scope = await seedCompany();
    await seedRun(scope);

    const skipped = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${RUN_USAGE_WORKER_LOCK.namespace}), hashtext(${RUN_USAGE_WORKER_LOCK.name}))`,
      );
      return service().runPass({ now: NOW });
    });

    expect(skipped).toMatchObject({ skipped: true, written: 0 });
    expect(await recordIds()).toEqual([]);
    expect(await service().runPass({ now: NOW })).toMatchObject({ skipped: false, written: 1 });
  });

  it("keeps companies apart: scoped passes, and foreign issue or project ids in a run context are dropped", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const foreignIssue = randomUUID();
    const foreignProject = randomUUID();
    await db.insert(projects).values({ id: foreignProject, companyId: b.companyId, name: "B project", status: "active" });
    await db.insert(issues).values({
      id: foreignIssue,
      companyId: b.companyId,
      title: "B issue",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "BBB-1",
      projectId: foreignProject,
    });
    const runA = await seedRun(a, { contextSnapshot: { issueId: foreignIssue, projectId: foreignProject } });
    const runB = await seedRun(b, { contextSnapshot: { issueId: foreignIssue, projectId: foreignProject } });

    await service().runPass({ now: NOW, companyId: a.companyId });
    expect(await recordIds()).toEqual([runA]);

    await service().runPass({ now: NOW });
    const rows = await db.select().from(runUsageRecords);
    const byRun = new Map(rows.map((row) => [row.runId, row]));
    expect(byRun.get(runA)).toMatchObject({ companyId: a.companyId, issueId: null, projectId: null });
    expect(byRun.get(runB)).toMatchObject({ companyId: b.companyId, issueId: foreignIssue, projectId: foreignProject });
  });

  it("resolves issue, project, routine, wake reason and retry depth", async () => {
    const scope = await seedCompany();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const routineId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: scope.companyId, name: "P", status: "active" });
    await db.insert(issues).values({
      id: issueId,
      companyId: scope.companyId,
      title: "Routine run",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "TST-1",
      projectId,
      originKind: "routine_execution",
      originId: routineId,
    });
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      source: "automation",
      reason: "routine_fired",
    });
    const first = await seedRun(scope, { status: "failed", errorCode: "process_lost" });
    const second = await seedRun(scope, { retryOfRunId: first });
    const third = await seedRun(scope, {
      retryOfRunId: second,
      scheduledRetryReason: "process_lost",
      wakeupRequestId: wakeId,
      contextSnapshot: { issueId },
    });

    await service().runPass({ now: NOW });
    const rows = await db.select().from(runUsageRecords);
    const byRun = new Map(rows.map((row) => [row.runId, row]));

    expect(byRun.get(first)).toMatchObject({ isRetry: false, retryDepth: 0, causeFamily: "interrupted_crash" });
    expect(byRun.get(second)).toMatchObject({ isRetry: true, retryDepth: 1 });
    expect(byRun.get(third)).toMatchObject({
      isRetry: true,
      retryDepth: 2,
      retryReason: "process_lost",
      issueId,
      projectId,
      routineId,
      wakeReason: "routine_fired",
    });
  });

  it("prefers the wake reason in the run context over the wake request", async () => {
    const scope = await seedCompany();
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      source: "automation",
      reason: "from_request",
    });
    const runId = await seedRun(scope, { wakeupRequestId: wakeId, contextSnapshot: { wakeReason: "issue_assigned" } });

    await service().runPass({ now: NOW });

    const [row] = await db.select().from(runUsageRecords).where(eq(runUsageRecords.runId, runId));
    expect(row?.wakeReason).toBe("issue_assigned");
  });

  it("never stores prompt, context or stderr text", async () => {
    const scope = await seedCompany();
    const canary = "CANARY-PROMPT-SECRET-4410";
    await seedRun(scope, {
      status: "failed",
      errorCode: "adapter_failed",
      stderrExcerpt: `ENOSPC ${canary}`,
      error: canary,
      contextSnapshot: { prompt: canary, wakeReason: canary },
      resultJson: { summary: canary },
      usageJson: { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, summary: canary, model: canary },
    });

    await service().runPass({ now: NOW });

    const rows = await db.select().from(runUsageRecords);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(canary);
    expect(rows[0]?.causeFamily).toBe("disk_or_workspace");
  });

  it("reports health for one company: derived share, pending work, late and unreconciled runs", async () => {
    const mine = await seedCompany();
    const other = await seedCompany();
    await seedRun(mine);
    await seedRun(mine);
    await seedRun(other);
    await service().runPass({ now: NOW, companyId: mine.companyId });
    await seedRun(mine, { createdAt: ago(5 * HOUR), startedAt: ago(5 * HOUR), finishedAt: ago(4 * HOUR) });
    await seedRun(mine, { createdAt: ago(10 * DAY), startedAt: ago(10 * DAY), finishedAt: ago(10 * DAY - MINUTE) });

    const health = await service().health(mine.companyId, NOW);

    expect(health).toMatchObject({
      schemaVersion: RUN_USAGE_RECORD_SCHEMA_VERSION,
      terminalRuns24h: 3,
      derivedRuns24h: 2,
      pendingRuns: 1,
      unreconciledRuns30d: 1,
      lateRecords30d: 0,
    });
    expect(health.lastDerivedAt).not.toBeNull();
    expect(health.oldestPendingAt).toBe(ago(5 * HOUR).toISOString());
  });

  it("counts runs found by the wide sweep as late and clears them from the unreconciled count", async () => {
    const scope = await seedCompany();
    await seedRun(scope, { createdAt: ago(10 * DAY), startedAt: ago(10 * DAY), finishedAt: ago(10 * DAY - MINUTE) });

    const before = await service().health(scope.companyId, NOW);
    await service().runPass({ now: NOW, lookbackMs: 30 * DAY });
    const after = await service().health(scope.companyId, NOW);

    expect(before).toMatchObject({ unreconciledRuns30d: 1, lateRecords30d: 0 });
    expect(after).toMatchObject({ unreconciledRuns30d: 0, lateRecords30d: 1 });
  });

  it("sweeps on the first scheduled pass, then only once a day", async () => {
    const scope = await seedCompany();
    await seedRun(scope, { createdAt: ago(3 * DAY), startedAt: ago(3 * DAY), finishedAt: ago(3 * DAY - MINUTE) });
    const scheduled = service();

    const first = await scheduled.runScheduledPass(NOW);
    const second = await scheduled.runScheduledPass(new Date(NOW.getTime() + MINUTE));
    const nextDay = await scheduled.runScheduledPass(new Date(NOW.getTime() + 25 * HOUR));

    expect(first).toMatchObject({ sweep: true, written: 1 });
    expect(second).toMatchObject({ sweep: false, written: 0 });
    expect(nextDay).toMatchObject({ sweep: true });
  });

  it("lists records after a keyset cursor, settled only, one company, with no gaps on equal times", async () => {
    const mine = await seedCompany();
    const other = await seedCompany();
    const sameTime = ago(HOUR);
    const ids = await Promise.all(
      [0, 1, 2, 3].map(() => seedRun(mine, { finishedAt: sameTime })),
    );
    await seedRun(mine, { finishedAt: ago(2 * MINUTE) });
    await seedRun(other, { finishedAt: sameTime });
    await service().runPass({ now: new Date(NOW.getTime() + HOUR) });

    const firstPage = await service().listUsageRecordsAfter({ companyId: mine.companyId, cursor: null, limit: 3, now: NOW });
    const secondPage = await service().listUsageRecordsAfter({ companyId: mine.companyId, cursor: firstPage.next, limit: 3, now: NOW });

    const seen = [...firstPage.records, ...secondPage.records].map((record) => record.runId);
    expect(seen).toEqual([...ids].sort());
    expect(firstPage.records).toHaveLength(3);
    expect(secondPage.next).toBeNull();
  });
});
