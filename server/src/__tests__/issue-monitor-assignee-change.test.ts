import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import { ISSUE_EXECUTION_MONITOR_CLEAR_REASONS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { scheduleIssueWaitMonitor } from "../services/issue-waits.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue monitor and assignee changes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-monitor-assignee-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWaiting() {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [[agentA, "Agent A"], [agentB, "Agent B"]] as const) {
      await db.insert(agents).values({
        id, companyId, name, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {},
        runtimeConfig: {}, permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId, companyId, title: "Deploy", status: "in_progress", priority: "medium",
      assigneeAgentId: agentA, issueNumber: 1, identifier: "M-1",
    });
    const svc = issueService(db);
    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    await scheduleIssueWaitMonitor(db, svc, {
      issue: row,
      nextCheckAt: new Date(Date.now() + 3_600_000),
      notes: "Check deploy",
      serviceName: "Issue wait",
      externalRef: null,
      activity: { actorType: "agent", actorId: agentA, agentId: agentA, runId: null, source: "test" },
    });
    return { svc, agentA, agentB, issueId };
  }

  const load = (issueId: string) => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);

  function expectClearedForReassignment(issue: Awaited<ReturnType<typeof load>>) {
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorNotes ?? null).toBeNull();
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "invalid_assignee",
    });
    const persisted = parseIssueExecutionState(issue.executionState)?.monitor?.clearReason;
    expect(ISSUE_EXECUTION_MONITOR_CLEAR_REASONS).toContain(persisted);
  }

  it("clears the previous agent's wait when another agent checks the issue out after a release", async () => {
    const { svc, agentA, agentB, issueId } = await seedWaiting();
    expect((await load(issueId)).monitorNextCheckAt).not.toBeNull();

    await svc.release(issueId, agentA, null);
    await svc.checkout(issueId, agentB, ["todo", "backlog", "blocked", "in_progress"], null);

    const issue = await load(issueId);
    expect(issue.assigneeAgentId).toBe(agentB);
    expect(issue.status).toBe("in_progress");
    expectClearedForReassignment(issue);
  });

  it("clears the wait at release, before anyone else checks the issue out", async () => {
    const { svc, agentA, issueId } = await seedWaiting();
    await svc.release(issueId, agentA, null);
    const issue = await load(issueId);
    expect(issue.assigneeAgentId).toBeNull();
    expectClearedForReassignment(issue);
  });

  it("clears a leftover wait when a different agent checks out an issue directly", async () => {
    const { svc, agentB, issueId } = await seedWaiting();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    await svc.checkout(issueId, agentB, ["in_progress"], null);
    expectClearedForReassignment(await load(issueId));
  });

  it("keeps the wait when the same agent checks the issue out again", async () => {
    const { svc, agentA, issueId } = await seedWaiting();
    await svc.checkout(issueId, agentA, ["in_progress"], null);
    const issue = await load(issueId);
    expect(issue.monitorNextCheckAt).not.toBeNull();
    expect(issue.monitorNotes).toBe("Check deploy");
  });
});
