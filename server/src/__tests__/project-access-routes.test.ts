import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  projectPrincipalAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { authorizationService } from "../services/authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project access tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Role = "owner" | "admin" | "operator" | "viewer";

function boardActor(companyId: string, userId: string, role: Role): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_key" };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("project access routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-access-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_PROJECT_ACCESS_MODE;
    await db.delete(activityLog);
    await db.delete(projectPrincipalAccess);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const leadAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    const otherCompanyAgentId = randomUUID();
    const ownerId = `owner-${randomUUID()}`;
    const operatorId = `operator-${randomUUID()}`;
    const outsiderId = `outsider-${randomUUID()}`;
    const issuePrefix = (id: string) => `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: issuePrefix(companyId), requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other", issuePrefix: issuePrefix(otherCompanyId), requireBoardApprovalForNewAgents: false },
    ]);
    const now = new Date();
    await db.insert(authUsers).values([
      { id: ownerId, name: "Olivia Owner", email: `${ownerId}@example.com`, createdAt: now, updatedAt: now },
      { id: operatorId, name: "Omar Operator", email: `${operatorId}@example.com`, createdAt: now, updatedAt: now },
      { id: outsiderId, name: "Otto Outsider", email: `${outsiderId}@example.com`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: operatorId, status: "active", membershipRole: "operator" },
      { companyId: otherCompanyId, principalType: "user", principalId: outsiderId, status: "active", membershipRole: "owner" },
    ]);
    const agentRow = (id: string, company: string, name: string, status = "active") => ({
      id,
      companyId: company,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values([
      agentRow(leadAgentId, companyId, "Lead"),
      agentRow(workerAgentId, companyId, "Worker"),
      agentRow(terminatedAgentId, companyId, "Gone", "terminated"),
      agentRow(otherCompanyAgentId, otherCompanyId, "Foreign"),
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Secret", status: "in_progress", leadAgentId });
    return { companyId, projectId, leadAgentId, workerAgentId, terminatedAgentId, otherCompanyAgentId, ownerId, operatorId, outsiderId };
  }

  it("lists every member and agent in company mode, with owner and lead reasons", async () => {
    const s = await seed();
    const res = await request(createApp(db, boardActor(s.companyId, s.operatorId, "operator")))
      .get(`/api/projects/${s.projectId}/access`);

    expect(res.status).toBe(200);
    expect(res.body.accessMode).toBe("company");
    expect(res.body.enforcement).toBe("off");
    const byId = new Map(res.body.principals.map((p: { principalId: string }) => [p.principalId, p]));
    expect(byId.get(s.ownerId)).toMatchObject({ principalType: "user", name: "Olivia Owner", sources: ["company_mode", "company_admin"] });
    expect(byId.get(s.operatorId)).toMatchObject({ sources: ["company_mode"] });
    expect(byId.get(s.leadAgentId)).toMatchObject({ principalType: "agent", name: "Lead", sources: ["company_mode", "lead_agent"] });
    expect(byId.get(s.workerAgentId)).toMatchObject({ sources: ["company_mode"] });
    expect(byId.has(s.terminatedAgentId)).toBe(false);
    expect(byId.has(s.outsiderId)).toBe(false);
    expect(byId.has(s.otherCompanyAgentId)).toBe(false);
  });

  it("lets a company owner restrict a project and manage its access list, with activity entries", async () => {
    const s = await seed();
    const app = createApp(db, boardActor(s.companyId, s.ownerId, "owner"));

    const mode = await request(app).put(`/api/projects/${s.projectId}/access/mode`).send({ accessMode: "restricted" });
    expect(mode.status).toBe(200);
    expect(mode.body.accessMode).toBe("restricted");
    const restrictedIds = mode.body.principals.map((p: { principalId: string }) => p.principalId).sort();
    expect(restrictedIds).toEqual([s.leadAgentId, s.ownerId].sort());

    const grantAgent = await request(app)
      .post(`/api/projects/${s.projectId}/access/principals`)
      .send({ principalType: "agent", principalId: s.workerAgentId });
    expect(grantAgent.status).toBe(201);
    const again = await request(app)
      .post(`/api/projects/${s.projectId}/access/principals`)
      .send({ principalType: "agent", principalId: s.workerAgentId });
    expect(again.status).toBe(200);

    const grantUser = await request(app)
      .post(`/api/projects/${s.projectId}/access/principals`)
      .send({ principalType: "user", principalId: s.operatorId });
    expect(grantUser.status).toBe(201);
    const operator = grantUser.body.principals.find((p: { principalId: string }) => p.principalId === s.operatorId);
    expect(operator).toMatchObject({ principalType: "user", sources: ["explicit"] });
    expect(operator.grantedAt).toBeTruthy();

    const revoke = await request(app).delete(`/api/projects/${s.projectId}/access/principals/agent/${s.workerAgentId}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.principals.some((p: { principalId: string }) => p.principalId === s.workerAgentId)).toBe(false);
    const revokeMissing = await request(app).delete(`/api/projects/${s.projectId}/access/principals/agent/${s.workerAgentId}`);
    expect(revokeMissing.status).toBe(404);

    const [project] = await db.select().from(projects).where(eq(projects.id, s.projectId));
    expect(project?.accessMode).toBe("restricted");
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, s.projectId)))
      .map((row) => row.action)
      .sort();
    expect(actions).toEqual([
      "project_access.granted",
      "project_access.granted",
      "project_access.mode_changed",
      "project_access.revoked",
    ]);
  });

  it("refuses access management to operators, viewers and agents, even the lead agent", async () => {
    const s = await seed();
    for (const actor of [
      boardActor(s.companyId, s.operatorId, "operator"),
      boardActor(s.companyId, s.operatorId, "viewer"),
      agentActor(s.companyId, s.leadAgentId),
    ]) {
      const app = createApp(db, actor);
      const mode = await request(app).put(`/api/projects/${s.projectId}/access/mode`).send({ accessMode: "restricted" });
      expect(mode.status).toBe(403);
      const grant = await request(app)
        .post(`/api/projects/${s.projectId}/access/principals`)
        .send({ principalType: "agent", principalId: s.workerAgentId });
      expect(grant.status).toBe(403);
      const revoke = await request(app).delete(`/api/projects/${s.projectId}/access/principals/user/${s.ownerId}`);
      expect(revoke.status).toBe(403);
    }
    const rows = await db.select().from(projectPrincipalAccess);
    expect(rows).toEqual([]);
    const [project] = await db.select().from(projects).where(eq(projects.id, s.projectId));
    expect(project?.accessMode).toBe("company");
  });

  it("rejects principals outside the company, terminated agents and bad input", async () => {
    const s = await seed();
    const app = createApp(db, boardActor(s.companyId, s.ownerId, "owner"));
    const cases = [
      { principalType: "user", principalId: s.outsiderId },
      { principalType: "agent", principalId: s.otherCompanyAgentId },
      { principalType: "agent", principalId: s.terminatedAgentId },
    ];
    for (const body of cases) {
      const res = await request(app).post(`/api/projects/${s.projectId}/access/principals`).send(body);
      expect(res.status).toBe(422);
    }
    const badType = await request(app)
      .post(`/api/projects/${s.projectId}/access/principals`)
      .send({ principalType: "robot", principalId: s.workerAgentId });
    expect(badType.status).toBe(400);
    const badMode = await request(app).put(`/api/projects/${s.projectId}/access/mode`).send({ accessMode: "private" });
    expect(badMode.status).toBe(400);
    const badPath = await request(app).delete(`/api/projects/${s.projectId}/access/principals/robot/x`);
    expect(badPath.status).toBe(400);
    expect(await db.select().from(projectPrincipalAccess)).toEqual([]);
  });

  it("hides another company's project from the access endpoints", async () => {
    const s = await seed();
    const app = createApp(db, boardActor(randomUUID(), s.outsiderId, "owner"));
    const res = await request(app).get(`/api/projects/${s.projectId}/access`);
    expect([403, 404]).toContain(res.status);
    const mode = await request(app).put(`/api/projects/${s.projectId}/access/mode`).send({ accessMode: "restricted" });
    expect([403, 404]).toContain(mode.status);
  });

  describe("shadow gate", () => {
    async function restrictedSeed() {
      const s = await seed();
      await db.update(projects).set({ accessMode: "restricted" }).where(eq(projects.id, s.projectId));
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: s.companyId,
        projectId: s.projectId,
        title: "Assigned work",
        status: "todo",
        assigneeAgentId: s.workerAgentId,
      });
      return { ...s, issueId };
    }

    function wouldDenyCalls(warn: ReturnType<typeof vi.spyOn>) {
      return warn.mock.calls.filter((call) => call[1] === "project access would deny");
    }

    it("never denies and logs nothing while off", async () => {
      const s = await restrictedSeed();
      const warn = vi.spyOn(logger, "warn");
      const res = await request(createApp(db, boardActor(s.companyId, s.operatorId, "operator"))).get(`/api/projects/${s.projectId}`);
      expect(res.status).toBe(200);
      expect(wouldDenyCalls(warn)).toEqual([]);
    });

    it("logs would-deny for an unlisted principal in shadow mode but still allows", async () => {
      process.env.PAPERCLIP_PROJECT_ACCESS_MODE = "shadow";
      const s = await restrictedSeed();
      const warn = vi.spyOn(logger, "warn");
      const res = await request(createApp(db, boardActor(s.companyId, s.operatorId, "operator"))).get(`/api/projects/${s.projectId}`);
      expect(res.status).toBe(200);
      const calls = wouldDenyCalls(warn);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toMatchObject({ projectId: s.projectId, actorUserId: s.operatorId, action: "project:read" });
    });

    it("stays quiet for owners, listed principals, the lead agent and the issue assignee", async () => {
      process.env.PAPERCLIP_PROJECT_ACCESS_MODE = "shadow";
      const s = await restrictedSeed();
      await db.insert(projectPrincipalAccess).values({
        companyId: s.companyId,
        projectId: s.projectId,
        principalType: "user",
        principalId: s.operatorId,
      });
      const warn = vi.spyOn(logger, "warn");
      for (const actor of [boardActor(s.companyId, s.ownerId, "owner"), boardActor(s.companyId, s.operatorId, "operator")]) {
        const res = await request(createApp(db, actor)).get(`/api/projects/${s.projectId}`);
        expect(res.status).toBe(200);
      }
      const authz = authorizationService(db);
      const lead = await authz.decide({
        actor: agentActor(s.companyId, s.leadAgentId),
        action: "project:read",
        resource: { type: "project", companyId: s.companyId, projectId: s.projectId },
      });
      expect(lead.allowed).toBe(true);
      const assignee = await authz.decide({
        actor: agentActor(s.companyId, s.workerAgentId),
        action: "issue:read",
        resource: { type: "issue", companyId: s.companyId, issueId: s.issueId },
      });
      expect(assignee.allowed).toBe(true);
      expect(wouldDenyCalls(warn)).toEqual([]);

      await db.delete(projectPrincipalAccess).where(and(eq(projectPrincipalAccess.projectId, s.projectId)));
      const unlistedAgent = await authz.decide({
        actor: agentActor(s.companyId, s.workerAgentId),
        action: "project:read",
        resource: { type: "project", companyId: s.companyId, projectId: s.projectId },
      });
      expect(unlistedAgent.allowed).toBe(true);
      expect(wouldDenyCalls(warn)).toHaveLength(1);
    });
  });
});
