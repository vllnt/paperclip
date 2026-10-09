import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company recovery action route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(companyIds: string[], source: "local_implicit" | "session" = "local_implicit"): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "operator", status: "active" })),
    isInstanceAdmin: source === "local_implicit",
    source,
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return { type: "agent", agentId: agent.id, companyId: company.id, runId, source: "agent_jwt" };
}

async function seedCompany(db: Db, label = "Recovery List") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `RL${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({ companyId, name, status: "in_progress" }).returning();
  return project!;
}

async function seedIssue(db: Db, input: {
  companyId: string;
  title: string;
  identifier?: string;
  projectId?: string | null;
  status?: string;
  assigneeAgentId?: string | null;
}) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    title: input.title,
    identifier: input.identifier ?? null,
    status: input.status ?? "blocked",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function seedAction(db: Db, input: {
  companyId: string;
  sourceIssueId: string;
  status?: string;
  createdAt?: Date;
}) {
  const [action] = await db.insert(issueRecoveryActions).values({
    companyId: input.companyId,
    sourceIssueId: input.sourceIssueId,
    kind: "stranded_assigned_issue",
    status: input.status ?? "active",
    ownerType: "board",
    cause: "stranded",
    fingerprint: randomUUID(),
    nextAction: "Review the stranded issue",
    attemptCount: 1,
    createdAt: input.createdAt ?? new Date(),
    updatedAt: input.createdAt ?? new Date(),
    resolvedAt: input.status === "resolved" || input.status === "cancelled" ? new Date() : null,
    outcome: input.status === "resolved" ? "restored" : input.status === "cancelled" ? "cancelled" : null,
  }).returning();
  return action!;
}

describeEmbeddedPostgres("GET /api/companies/:companyId/recovery-actions", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists open actions newest first with their issue, filters by status, and honors limit", async () => {
    const company = await seedCompany(db);
    const other = await seedCompany(db, "Other");
    const first = await seedIssue(db, { companyId: company.id, title: "First stuck", identifier: "RL-1" });
    const second = await seedIssue(db, { companyId: company.id, title: "Second stuck", identifier: "RL-2" });
    const done = await seedIssue(db, { companyId: company.id, title: "Recovered", identifier: "RL-3", status: "done" });
    const otherIssue = await seedIssue(db, { companyId: other.id, title: "Other company issue" });
    const older = await seedAction(db, { companyId: company.id, sourceIssueId: first.id, createdAt: new Date(Date.now() - 60_000) });
    const escalated = await seedAction(db, { companyId: company.id, sourceIssueId: second.id, status: "escalated" });
    const resolved = await seedAction(db, { companyId: company.id, sourceIssueId: done.id, status: "resolved" });
    await seedAction(db, { companyId: other.id, sourceIssueId: otherIssue.id });
    const app = createApp(db, boardActor([company.id, other.id]));

    const res = await request(app).get(`/api/companies/${company.id}/recovery-actions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((action: { id: string }) => action.id)).toEqual([escalated.id, older.id]);
    expect(res.body[0]).toMatchObject({
      status: "escalated",
      kind: "stranded_assigned_issue",
      sourceIssueId: second.id,
      issue: { id: second.id, identifier: "RL-2", title: "Second stuck", status: "blocked" },
    });

    const resolvedRes = await request(app).get(`/api/companies/${company.id}/recovery-actions?status=resolved`);
    expect(resolvedRes.status, JSON.stringify(resolvedRes.body)).toBe(200);
    expect(resolvedRes.body.map((action: { id: string }) => action.id)).toEqual([resolved.id]);

    const limited = await request(app).get(`/api/companies/${company.id}/recovery-actions?status=active,escalated,resolved&limit=2`);
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body).toHaveLength(2);
  });

  it("does not revalidate or mutate actions while listing", async () => {
    const company = await seedCompany(db);
    const doneIssue = await seedIssue(db, { companyId: company.id, title: "Already done", status: "done" });
    const action = await seedAction(db, { companyId: company.id, sourceIssueId: doneIssue.id });

    const res = await request(createApp(db, boardActor([company.id])))
      .get(`/api/companies/${company.id}/recovery-actions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([action.id]);
    const [stored] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(stored?.status).toBe("active");
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("rejects unknown statuses and out-of-range limits with 400", async () => {
    const company = await seedCompany(db);
    const app = createApp(db, boardActor([company.id]));

    for (const query of ["status=active,bogus", "limit=0", "limit=201", "limit=abc"]) {
      const res = await request(app).get(`/api/companies/${company.id}/recovery-actions?${query}`);
      expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it("only returns actions on issues inside a restricted agent's issue-read boundary", async () => {
    const company = await seedCompany(db);
    const ownerAgent = await seedAgent(db, company.id);
    const mentionedAgent = await seedAgent(db, company.id);
    const allowedProject = await seedProject(db, company.id, "Allowed");
    const targetProject = await seedProject(db, company.id, "Target");
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: targetProject.id,
      title: "Mention-visible root",
      assigneeAgentId: ownerAgent.id,
    });
    const hidden = await seedIssue(db, {
      companyId: company.id,
      projectId: targetProject.id,
      title: "Hidden from the mentioned agent",
      assigneeAgentId: ownerAgent.id,
    });
    const visibleAction = await seedAction(db, { companyId: company.id, sourceIssueId: root.id });
    const hiddenAction = await seedAction(db, { companyId: company.id, sourceIssueId: hidden.id });

    const authorizationPolicy = {
      trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET,
        companyId: company.id,
        projectIds: [allowedProject.id],
        issueIds: [],
        allowedAgentIds: [],
      },
    };
    await db.update(agents).set({
      permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET, authorizationPolicy },
    }).where(eq(agents.id, mentionedAgent.id));
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: root.id,
      authorAgentId: ownerAgent.id,
      body: `[@Mentioned Agent](agent://${mentionedAgent.id}) please inspect this root.`,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: mentionedAgent.id,
      status: "running",
      contextSnapshot: { issueId: root.id, executionPolicy: { authorizationPolicy } },
    }).returning();

    const res = await request(createApp(db, agentActor(company, mentionedAgent, run!.id)))
      .get(`/api/companies/${company.id}/recovery-actions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((action: { id: string }) => action.id)).toEqual([visibleAction.id]);
    expect(JSON.stringify(res.body)).not.toContain(hiddenAction.id);
    expect(JSON.stringify(res.body)).not.toContain(hidden.id);

    // A standard agent of the same company reads the whole company scope.
    const [ownerRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: ownerAgent.id,
      status: "running",
      contextSnapshot: {},
    }).returning();
    const ownerRes = await request(createApp(db, agentActor(company, ownerAgent, ownerRun!.id)))
      .get(`/api/companies/${company.id}/recovery-actions`);
    expect(ownerRes.status, JSON.stringify(ownerRes.body)).toBe(200);
    expect(ownerRes.body.map((action: { id: string }) => action.id).sort()).toEqual(
      [visibleAction.id, hiddenAction.id].sort(),
    );
  });

  it("denies another company's agent and board user", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const issueA = await seedIssue(db, { companyId: companyA.id, title: "A issue" });
    await seedAction(db, { companyId: companyA.id, sourceIssueId: issueA.id });
    const agentB = await seedAgent(db, companyB.id);
    const [runB] = await db.insert(heartbeatRuns).values({
      companyId: companyB.id,
      agentId: agentB.id,
      status: "running",
      contextSnapshot: {},
    }).returning();

    const agentRes = await request(createApp(db, agentActor(companyB, agentB, runB!.id)))
      .get(`/api/companies/${companyA.id}/recovery-actions`);
    expect(agentRes.status, JSON.stringify(agentRes.body)).toBe(403);

    const boardRes = await request(createApp(db, boardActor([companyB.id], "session")))
      .get(`/api/companies/${companyA.id}/recovery-actions`);
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(403);
  });
});
