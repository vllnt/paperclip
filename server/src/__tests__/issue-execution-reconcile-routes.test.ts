import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  deliverReconciledExecutions,
  settleUnrecoverableExecutions,
} from "../services/execution-recovery-resolution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution reconcile route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOTE =
  "Provider quota outage: the stopped run made no external writes; the transcript ends before any tool call.";

describeEmbeddedPostgres("POST /issues/:id/execution/reconcile", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const boardActor = { type: "board", source: "local_implicit" };

  function issueApp(actor: Record<string, unknown> = boardActor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  function agentApp(actor: Record<string, unknown> = boardActor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const responsibleUserId = randomUUID();
    const prefix = `RC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Recovery operator",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Reconcile Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: responsibleUserId,
    });
    await db.insert(agents).values({
      id: coderId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // One dispatch slot, occupied below, keeps continuation runs queued:
      // these tests exercise real wake admission without launching a provider.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the quota-outage fix",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
    });
    return { companyId, coderId, issueId };
  }

  /** Two provider failures, each settled by the real automatic disposition. */
  async function seedStackedHolds() {
    const fixture = await seedCompany();
    const runIds: string[] = [];
    const holdIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const runId = randomUUID();
      const failedAt = new Date(Date.UTC(2026, 9, 1, 10, index * 10));
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.coderId,
        invocationSource: "assignment",
        status: "failed",
        runtimeMode: "legacy",
        errorCode: "provider_quota_exceeded",
        startedAt: failedAt,
        finishedAt: failedAt,
        createdAt: failedAt,
        contextSnapshot: { issueId: fixture.issueId },
      });
      const [hold] = await db.insert(issueRecoveryActions).values({
        companyId: fixture.companyId,
        sourceIssueId: fixture.issueId,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: fixture.coderId,
        cause: "legacy_execution_requires_reconciliation",
        fingerprint: runId,
        evidence: { runId },
        nextAction: "Reconcile the stopped execution before continuing.",
        createdAt: failedAt,
        updatedAt: failedAt,
      }).returning();
      await settleUnrecoverableExecutions(db);
      runIds.push(runId);
      holdIds.push(hold!.id);
    }
    const holds = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
    expect(holds).toHaveLength(2);
    for (const hold of holds) {
      expect(hold).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue!.status).toBe("blocked");
    return { ...fixture, runIds, holdIds };
  }

  async function snapshot(issueId: string, companyId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const holds = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .orderBy(issueRecoveryActions.createdAt);
    const continuationWakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      like(agentWakeupRequests.idempotencyKey, "execution-reconciliation:%"),
    ));
    const continuationRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' is not null`,
    ));
    const reconciledActivity = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.execution_reconciled"),
    ));
    return { issue: issue!, holds, continuationWakes, continuationRuns, reconciledActivity };
  }

  async function expectUnchanged(issueId: string, companyId: string) {
    const state = await snapshot(issueId, companyId);
    expect(state.issue.status).toBe("blocked");
    expect(state.holds).toHaveLength(2);
    for (const hold of state.holds) {
      expect(hold.status).toBe("resolved");
      expect(hold.evidence).toMatchObject({ automaticRecovery: { replay: "blocked" } });
      expect(hold.evidence).not.toHaveProperty("executionReconciliation");
      expect(hold.evidence).not.toHaveProperty("continuationDelivery");
    }
    expect(state.continuationWakes).toHaveLength(0);
    expect(state.continuationRuns).toHaveLength(0);
    expect(state.reconciledActivity).toHaveLength(0);
  }

  it("reconciles every stacked hold and starts exactly one continuation on the same issue", async () => {
    const { companyId, coderId, issueId, runIds, holdIds } = await seedStackedHolds();
    const app = issueApp();

    const response = await request(app)
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE, expectedRunId: runIds[1] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      issueId,
      reconciledRunIds: runIds,
      recoveryActionIds: holdIds,
      continuation: { status: "queued" },
    });
    expect(response.body.continuation.runId).toEqual(expect.any(String));

    const state = await snapshot(issueId, companyId);
    expect(state.issue.status).toBe("todo");
    expect(state.issue.assigneeAgentId).toBe(coderId);
    expect(state.holds.map((hold) => hold.status)).toEqual(["resolved", "resolved"]);
    for (const hold of state.holds) {
      expect(hold.evidence).not.toHaveProperty("automaticRecovery");
      expect(hold.evidence).toMatchObject({
        executionReconciliation: {
          runId: hold.evidence.runId,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence: NOTE,
        },
      });
      expect(hold.resolutionNote).toBe(NOTE);
    }
    // Exactly one hold owns delivery; older holds never start a continuation.
    expect(state.holds[0]!.evidence.continuationDelivery).toBe("superseded");
    expect(["pending", "delivered"]).toContain(state.holds[1]!.evidence.continuationDelivery);

    expect(state.continuationWakes).toHaveLength(1);
    expect(state.continuationWakes[0]).toMatchObject({
      agentId: coderId,
      idempotencyKey: `execution-reconciliation:${holdIds[1]}`,
      status: "queued",
    });
    expect(state.continuationRuns).toHaveLength(1);
    expect(state.continuationRuns[0]!.id).toBe(response.body.continuation.runId);
    expect(state.continuationRuns[0]!.contextSnapshot).toMatchObject({
      issueId,
      recoveryActionId: holdIds[1],
      previousRunId: runIds[1],
      forceFreshSession: true,
    });

    expect(state.reconciledActivity).toHaveLength(1);
    expect(state.reconciledActivity[0]!.details).toMatchObject({
      outcome: "none",
      actionOutcome: "not_performed",
      holdsCount: 2,
      reconciledRunIds: runIds,
      recoveryActionIds: holdIds,
    });
    expect(JSON.stringify(state.reconciledActivity[0]!.details)).not.toContain(NOTE);

    // Idempotent: a repeated request finds nothing to reconcile, and the
    // fallback sweep cannot mint a second continuation either.
    const again = await request(app)
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/Nothing to reconcile/);
    await deliverReconciledExecutions(db, heartbeatService(db).wakeup);
    const after = await snapshot(issueId, companyId);
    expect(after.continuationWakes).toHaveLength(1);
    expect(after.continuationRuns).toHaveLength(1);
    expect(after.reconciledActivity).toHaveLength(1);
  });

  it("maps done and mixed outcomes and records workspace repair evidence", async () => {
    const { companyId, issueId } = await seedStackedHolds();
    const repair = "Workspace re-staged from the last pushed commit; git status is clean.";
    const response = await request(issueApp())
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "done", note: `  ${NOTE}  `, workspaceRepairNote: repair });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const state = await snapshot(issueId, companyId);
    for (const hold of state.holds) {
      expect(hold.evidence.executionReconciliation).toMatchObject({
        actionOutcome: "completed",
        outcomeEvidence: NOTE,
        workspaceRepairEvidence: repair,
      });
    }
  });

  it("rejects agents, including the assignee, without changing anything", async () => {
    const { companyId, coderId, issueId } = await seedStackedHolds();
    const response = await request(issueApp({
      type: "agent", agentId: coderId, companyId, runId: randomUUID(), source: "agent_key",
    }))
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE });
    expect(response.status).toBe(403);
    await expectUnchanged(issueId, companyId);
  });

  it("rejects a board user of another company without changing anything", async () => {
    const { companyId, issueId } = await seedStackedHolds();
    const otherCompanyId = randomUUID();
    const response = await request(issueApp({
      type: "board",
      source: "session",
      userId: "outsider",
      companyIds: [otherCompanyId],
      memberships: [{ companyId: otherCompanyId, status: "active", membershipRole: "owner" }],
      isInstanceAdmin: false,
    }))
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE });
    expect([403, 404]).toContain(response.status);
    await expectUnchanged(issueId, companyId);
  });

  it("rejects a read-only board member of the company without changing anything", async () => {
    const { companyId, issueId } = await seedStackedHolds();
    const response = await request(issueApp({
      type: "board",
      source: "session",
      userId: "viewer-user",
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "viewer" }],
      isInstanceAdmin: false,
    }))
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await expectUnchanged(issueId, companyId);
  });

  it("refuses a stale expectedRunId without changing anything", async () => {
    const { companyId, issueId, runIds } = await seedStackedHolds();
    const response = await request(issueApp())
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE, expectedRunId: runIds[0] });
    expect(response.status).toBe(409);
    await expectUnchanged(issueId, companyId);
  });

  it("rolls back every hold when any stopped run fails validation", async () => {
    const { companyId, issueId, runIds } = await seedStackedHolds();
    // The newest run still owns a live process. The older hold is processed
    // first, so a partial commit would leave it reconciled.
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, runIds[1]!));
    const response = await request(issueApp())
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/still running/);
    await expectUnchanged(issueId, companyId);
  });

  it("rejects malformed requests", async () => {
    const { companyId, issueId } = await seedStackedHolds();
    const app = issueApp();
    for (const body of [
      { outcome: "none", note: "too short" },
      { outcome: "maybe", note: NOTE },
      { outcome: "none", note: NOTE, expectedRunId: "not-a-uuid" },
      { outcome: "none", note: NOTE, extra: true },
    ]) {
      const response = await request(app).post(`/api/issues/${issueId}/execution/reconcile`).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    await expectUnchanged(issueId, companyId);
  });

  it("reports nothing to reconcile on an issue without a hold", async () => {
    const { issueId } = await seedCompany();
    const response = await request(issueApp())
      .post(`/api/issues/${issueId}/execution/reconcile`)
      .send({ outcome: "none", note: NOTE });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Nothing to reconcile/);
  });

  it("lists execution holds read-only on the recovery-actions endpoint", async () => {
    const { companyId, issueId, runIds, holdIds } = await seedStackedHolds();
    const response = await request(issueApp()).get(`/api/issues/${issueId}/recovery-actions`);
    expect(response.status).toBe(200);
    expect(response.body.active).toBeNull();
    expect(response.body.executionHolds).toEqual([
      expect.objectContaining({ id: holdIds[1], runId: runIds[1], replay: "blocked", status: "resolved",
        cause: "legacy_execution_requires_reconciliation" }),
      expect.objectContaining({ id: holdIds[0], runId: runIds[0], replay: "blocked", status: "resolved" }),
    ]);
    expect(response.body.executionHolds[0].createdAt).toEqual(expect.any(String));
    await expectUnchanged(issueId, companyId);
  });

  it("explains why wakes wait in wake diagnostics and in the skipped wakeup response", async () => {
    const { companyId, coderId, issueId, runIds, holdIds } = await seedStackedHolds();
    // An automatic wake records a skipped execution wait.
    expect(await heartbeatService(db).wakeup(coderId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "reconcile-test",
      payload: { issueId }, contextSnapshot: { issueId },
    })).toBeNull();
    // A board comment's wake is kept as a deferred receipt with its wait reason.
    const executionWait = {
      recoveryActionId: holdIds[1],
      reason: "execution_recovery",
      message: "Waiting for execution recovery. Your message is saved.",
    };
    await db.insert(agentWakeupRequests).values({
      companyId, agentId: coderId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution",
      payload: { issueId, executionWait },
      requestedByActorType: "user", requestedByActorId: "board-user",
    });

    const diagnostics = await request(issueApp()).get(`/api/issues/${issueId}/diagnostics/wakes`);
    expect(diagnostics.status).toBe(200);
    const waits = diagnostics.body.events.filter((event: any) => event.kind === "wake_request");
    expect(waits.find((event: any) => event.status === "deferred_issue_execution")?.executionWait).toEqual(executionWait);
    expect(waits.find((event: any) => event.status === "skipped")?.executionWait).toMatchObject({
      recoveryActionId: holdIds[1],
      reason: expect.any(String),
      message: expect.any(String),
    });

    const skipped = await request(agentApp({
      type: "board",
      source: "session",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }],
      isInstanceAdmin: true,
    }))
      .post(`/api/agents/${coderId}/wakeup`)
      .send({ source: "on_demand", payload: { issueId } });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(202);
    expect(skipped.body).toMatchObject({
      status: "skipped",
      reason: "execution_reconciliation_required",
      issueId,
      recoveryActionId: holdIds[1],
      runId: runIds[1],
      nextAction: {
        actor: "board",
        method: "POST",
        path: `/api/issues/${issueId}/execution/reconcile`,
      },
    });
    expect(skipped.body.nextAction.cli).toContain(`paperclipai issue reconcile ${issueId}`);
    await expectUnchanged(issueId, companyId);
  });
});
