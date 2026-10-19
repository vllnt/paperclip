import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("recovery hold across task reassignment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("reassign-recovery-hold-");
    db = createDb(database.connectionString);
  }, 90000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const nextAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reassign hold", defaultResponsibleUserId: "board", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await db.insert(agents).values([agentId, nextAgentId].map((id) => ({ id, companyId, name: `Reviewer fixture ${id}`, role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: {} })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Original title", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId } }).returning();
    if (!run) throw new Error("Expected seeded run");
    return { companyId, agentId, nextAgentId, issueId, runId, run };
  }

  it("retains a real unsafe-workspace recovery hold across reassignment until repair", async () => {
    const fixture = await seed();
    const [run] = await db.update(heartbeatRuns).set({ errorCode: "workspace_restore_failed", resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }).where(eq(heartbeatRuns.id, fixture.runId)).returning();
    if (!run) throw new Error("Expected unsafe-workspace run");
    await terminalizeLegacyExecution({ db, run, status: "failed" });
    await settleUnrecoverableExecutions(db);
    const before = await getExecutionBlocker(db, fixture.companyId, fixture.issueId);
    expect(before?.runId).toBe(fixture.runId);
    const [beforeAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, before?.recoveryActionId ?? randomUUID()));
    expect(beforeAction).toMatchObject({ evidence: { workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" } } });

    const updated = await issueService(db).update(fixture.issueId, { assigneeAgentId: fixture.nextAgentId });

    expect(updated?.assigneeAgentId).toBe(fixture.nextAgentId);
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueId)).toMatchObject({ recoveryActionId: before?.recoveryActionId, runId: fixture.runId });
  }, 30000);

  it("does not cancel the current owners hold when a title edit waited behind reassignment", async () => {
    const fixture = await seed();
    let pendingEdit: ReturnType<ReturnType<typeof issueService>["update"]> | undefined;
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.nextAgentId, status: "failed", runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId: fixture.issueId } }).returning();
    if (!nextRun) throw new Error("Expected second owners run");
    await db.transaction(async (transaction) => {
      await transaction.select().from(issues).where(eq(issues.id, fixture.issueId)).for("update");
      const [lockOwner] = await transaction.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      if (!lockOwner) throw new Error("Expected lock holder process");
      pendingEdit = issueService(db).update(fixture.issueId, { title: "Concurrent title edit" });
      const deadline = Date.now() + 10000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await db.execute<{ waiting: boolean }>(sql`select exists (select 1 from pg_stat_activity where datname = current_database() and ${lockOwner.pid} = any(pg_blocking_pids(pid))) as waiting`);
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await delay(20);
      }
      expect(waiting, "title edit must have read owner A and be waiting on the issue row lock").toBe(true);
      await issueService(db).update(fixture.issueId, { assigneeAgentId: fixture.nextAgentId }, transaction);
      await transaction.insert(issueRecoveryActions).values({ companyId: fixture.companyId, sourceIssueId: fixture.issueId, kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: nextRun.id, returnOwnerAgentId: fixture.nextAgentId, evidence: { runId: nextRun.id }, nextAction: "Reconcile owner B stopped run." });
    });
    if (!pendingEdit) throw new Error("Expected title update");
    const updated = await pendingEdit;
    expect(updated?.title).toBe("Concurrent title edit");
    expect(updated?.assigneeAgentId).toBe(fixture.nextAgentId);
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueId)).toMatchObject({ runId: nextRun.id });
  }, 30000);
});
