import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySkills,
  costEvents,
  createDb,
  documents,
  documentRevisions,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { HttpError } from "../errors.ts";
import { logger } from "../middleware/logger.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("refuses to delete a company whose runs another company's rows reference, and changes nothing", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const failure = await companyService(db)
      .remove(companyId)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({
      status: 409,
      details: { table: "heartbeat_run_events", blockingRows: 1 },
    });
    expect(failure).toHaveProperty("message", expect.stringContaining("heartbeat_run_events"));
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(1);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(1);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(1);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
    await expect(
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, otherCompanyId)),
    ).resolves.toHaveLength(1);
  });

  it("deletes the company's own run events and leaves another company's events alone", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const other = await seedFixture();

    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 1, eventType: "output", message: "own event" },
      {
        companyId: other.companyId,
        runId: other.runId,
        agentId: other.agentId,
        seq: 1,
        eventType: "output",
        message: "other company event",
      },
    ]);

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, other.companyId)),
    ).resolves.toHaveLength(1);
  });

  it("removes routines before deleting company agents", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      assigneeAgentId: agentId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(routines).where(eq(routines.id, routineId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });

  async function seedSpend(fixture: { agentId: string; companyId: string; issueId: string; runId: string }) {
    const costEventId = randomUUID();
    const now = new Date();

    await db.insert(costEvents).values({
      id: costEventId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: fixture.issueId,
      heartbeatRunId: fixture.runId,
      provider: "anthropic",
      model: "claude-test",
      costCents: 12,
      occurredAt: now,
    });
    await db.insert(financeEvents).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      heartbeatRunId: fixture.runId,
      costEventId,
      eventKind: "inference_charge",
      biller: "anthropic",
      amountCents: 12,
      occurredAt: now,
    });
  }

  it("removes cost and finance events before deleting the runs they reference", async () => {
    const fixture = await seedFixture();
    const { companyId, runId } = fixture;
    const other = await seedFixture();
    await seedSpend(fixture);
    await seedSpend(other);

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(financeEvents).where(eq(financeEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(costEvents).where(eq(costEvents.companyId, other.companyId))).resolves.toHaveLength(1);
    await expect(db.select().from(financeEvents).where(eq(financeEvents.companyId, other.companyId))).resolves.toHaveLength(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.runId))).resolves.toHaveLength(1);
  });
  function companyDeletedEntries(info: ReturnType<typeof vi.spyOn>): unknown[] {
    return info.mock.calls
      .map((call) => call[0])
      .filter((fields) => typeof fields === "object" && fields !== null && Reflect.get(fields, "event") === "company_deleted");
  }

  it("writes one structured log entry after a company is deleted, with the actor and row counts, and no content", async () => {
    const { companyId } = await seedFixture();
    const info = vi.spyOn(logger, "info");

    try {
      await companyService(db).remove(companyId, { actorUserId: "user-1", actorKeyId: "key-1" });

      const entries = companyDeletedEntries(info);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        event: "company_deleted",
        companyId,
        actorUserId: "user-1",
        actorKeyId: "key-1",
        rowCounts: { companies: 1, agents: 1, issues: 1, heartbeat_runs: 1 },
      });
      const written = JSON.stringify(info.mock.calls);
      for (const content of ["Paperclip", "CodexCoder", "Regression fixture"]) {
        expect(written).not.toContain(content);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("writes no deletion log entry when the delete is refused", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });
    const info = vi.spyOn(logger, "info");

    try {
      await expect(companyService(db).remove(companyId, { actorUserId: "user-1" })).rejects.toBeInstanceOf(HttpError);

      expect(companyDeletedEntries(info)).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });
});
