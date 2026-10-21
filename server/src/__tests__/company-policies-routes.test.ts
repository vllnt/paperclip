import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companyPolicies,
  documentRevisions,
  documents,
  principalPermissionGrants,
  companyMemberships,
  companies,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { companyPolicyRoutes } from "../routes/company-policies.js";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { projectRoutes } from "../routes/projects.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

type Db = Parameters<typeof companyPolicyRoutes>[0];

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", companyPolicyRoutes(db));
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

async function resetPolicyFixtures(db: Db) {
  await db.delete(companyPolicies);
  await db.delete(documentRevisions);
  await db.delete(documents);
  await db.delete(activityLog);
  await db.delete(projects);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

async function seedAgent(db: Db, companyId: string, name = "Builder") {
  const [agent] = await db
    .insert(agents)
    .values({ companyId, name, role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {} })
    .returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name = "Website") {
  const [project] = await db.insert(projects).values({ companyId, name }).returning();
  return project!;
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", companyId, agentId, runId: null, source: "agent_key" };
}

describeEmbeddedPostgres("company policy routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-company-policies-", { resetEach: resetPolicyFixtures });

  it("creates a company policy with revision 1 and logs the activity", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const app = createApp(ctx.db, seeded.actor);

    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/policies`)
      .send({ key: "code-review", title: "Code review", summary: "Every change gets a review.", body: "# Review\nAsk for one." });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      companyId: seeded.companyId,
      projectId: null,
      key: "code-review",
      title: "Code review",
      summary: "Every change gets a review.",
      body: "# Review\nAsk for one.",
      status: "draft",
      latestRevisionNumber: 1,
      createdByUserId: seeded.userId,
    });

    const activity = await ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "policy.created")));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ entityType: "policy", entityId: created.body.id, actorId: seeded.userId });

    const fetched = await request(app).get(`/api/companies/${seeded.companyId}/policies/code-review`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.body).toBe("# Review\nAsk for one.");
  });

  it("refuses a duplicate key across company and project scopes with 409", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const project = await seedProject(ctx.db, seeded.companyId);
    const app = createApp(ctx.db, seeded.actor);

    const first = await request(app)
      .post(`/api/companies/${seeded.companyId}/policies`)
      .send({ key: "deploys", title: "Deploys" });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post(`/api/companies/${seeded.companyId}/policies`)
      .send({ key: "deploys", title: "Project deploys", projectId: project.id });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain("deploys");
  });

  it("rejects an invalid key, a two-line summary and two owners with 400", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const agent = await seedAgent(ctx.db, seeded.companyId);
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;

    expect((await request(app).post(url).send({ key: "Bad Key", title: "x" })).status).toBe(400);
    expect((await request(app).post(url).send({ key: "ok", title: "x", summary: "one\ntwo" })).status).toBe(400);
    expect(
      (await request(app).post(url).send({ key: "ok", title: "x", ownerAgentId: agent.id, ownerUserId: seeded.userId })).status,
    ).toBe(400);
    expect((await request(app).post(url).send({ key: "ok", title: "x", unknownField: 1 })).status).toBe(400);
  });

  it("refuses a project or owner agent from another company with 404", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const otherProject = await seedProject(ctx.db, other.companyId);
    const otherAgent = await seedAgent(ctx.db, other.companyId);
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;

    const project = await request(app).post(url).send({ key: "a", title: "A", projectId: otherProject.id });
    expect(project.status).toBe(404);
    const owner = await request(app).post(url).send({ key: "b", title: "B", ownerAgentId: otherAgent.id });
    expect(owner.status).toBe(404);
    expect(await ctx.db.select().from(companyPolicies)).toHaveLength(0);
  });

  it("lists company policies first and filters by scope, project and status", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const project = await seedProject(ctx.db, seeded.companyId);
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;

    await request(app).post(url).send({ key: "project-style", title: "A project style", projectId: project.id, status: "active" });
    await request(app).post(url).send({ key: "security", title: "Security", status: "active" });
    await request(app).post(url).send({ key: "naming", title: "Naming" });

    const all = await request(app).get(url);
    expect(all.status).toBe(200);
    expect(all.body.map((policy: { key: string }) => policy.key)).toEqual(["naming", "security", "project-style"]);

    const companyOnly = await request(app).get(url).query({ scope: "company" });
    expect(companyOnly.body.map((policy: { key: string }) => policy.key)).toEqual(["naming", "security"]);

    const projectOnly = await request(app).get(url).query({ scope: "project" });
    expect(projectOnly.body.map((policy: { key: string }) => policy.key)).toEqual(["project-style"]);

    const byProject = await request(app).get(url).query({ projectId: project.id });
    expect(byProject.body.map((policy: { key: string }) => policy.key)).toEqual(["project-style"]);

    const active = await request(app).get(url).query({ status: "active" });
    expect(active.body.map((policy: { key: string }) => policy.key)).toEqual(["security", "project-style"]);

    expect((await request(app).get(url).query({ status: "deleted" })).status).toBe(400);
    expect((await request(app).get(url).query({ scope: "company", projectId: project.id })).status).toBe(400);
  });

  it("stores an empty summary as no summary", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;

    const created = await request(app).post(url).send({ key: "naming", title: "Naming", summary: "  " });
    expect(created.status).toBe(201);
    expect(created.body.summary).toBeNull();

    await request(app).patch(`${url}/naming`).send({ summary: "Use clear names." });
    const cleared = await request(app).patch(`${url}/naming`).send({ summary: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.summary).toBeNull();
  });

  it("lets only the board delete a project that has policies, and removes their documents with it", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const project = await seedProject(ctx.db, seeded.companyId);
    const agent = await seedAgent(ctx.db, seeded.companyId);
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;
    const projectPolicy = await request(app)
      .post(url)
      .send({ key: "release", title: "Release", body: "Tag every release.", status: "active", projectId: project.id });
    const companyPolicy = await request(app).post(url).send({ key: "naming", title: "Naming", status: "active" });

    const agentApp = createApp(ctx.db, agentActor(seeded.companyId, agent.id));
    const emptyProject = await seedProject(ctx.db, seeded.companyId, "Scratch");
    expect((await request(agentApp).delete(`/api/projects/${emptyProject.id}`)).status).toBe(200);
    const agentDelete = await request(agentApp).delete(`/api/projects/${project.id}`);
    expect(agentDelete.status).toBe(403);
    expect(agentDelete.body.error).toBe("Only the board can delete a project that has policies.");
    expect((await request(app).get(url)).body.map((policy: { key: string }) => policy.key)).toEqual(["naming", "release"]);

    const boardDelete = await request(app).delete(`/api/projects/${project.id}`);
    expect(boardDelete.status).toBe(200);
    expect(boardDelete.body.id).toBe(project.id);
    const [deletedEntry] = await ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "project.deleted"), eq(activityLog.entityId, project.id)));
    expect(deletedEntry?.details).toEqual({ removedPolicyKeys: ["release"] });
    expect((await request(app).get(url)).body.map((policy: { key: string }) => policy.key)).toEqual(["naming"]);
    const remainingDocuments = await ctx.db.select({ id: documents.id }).from(documents);
    expect(remainingDocuments.map((row) => row.id)).toEqual([companyPolicy.body.documentId]);
    const remainingRevisions = await ctx.db
      .select({ id: documentRevisions.id })
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, projectPolicy.body.documentId));
    expect(remainingRevisions).toEqual([]);
  });

  it("saves a revision for a body change, edits other fields in place, and logs what changed", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const agent = await seedAgent(ctx.db, seeded.companyId);
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;
    const created = await request(app).post(url).send({ key: "testing", title: "Testing", body: "v1" });

    const statusOnly = await request(app).patch(`${url}/testing`).send({ status: "active", ownerAgentId: agent.id });
    expect(statusOnly.status).toBe(200);
    expect(statusOnly.body).toMatchObject({ status: "active", ownerAgentId: agent.id, latestRevisionNumber: 1 });

    const bodyChange = await request(app)
      .patch(`${url}/testing`)
      .send({ body: "v2", changeSummary: "Add coverage", baseRevisionId: created.body.latestRevisionId });
    expect(bodyChange.status).toBe(200);
    expect(bodyChange.body).toMatchObject({ body: "v2", latestRevisionNumber: 2 });

    const unchanged = await request(app).patch(`${url}/testing`).send({ body: "v2", status: "active" });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.latestRevisionNumber).toBe(2);

    const revisions = await request(app).get(`${url}/testing/revisions`);
    expect(revisions.status).toBe(200);
    expect(revisions.body.map((revision: { revisionNumber: number; body: string }) => [revision.revisionNumber, revision.body])).toEqual([
      [2, "v2"],
      [1, "v1"],
    ]);
    expect(revisions.body[0]).toMatchObject({ changeSummary: "Add coverage", policyId: created.body.id });

    const updates = await ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "policy.updated")));
    expect(updates.map((row) => (row.details as { changed: string[] }).changed)).toEqual(
      expect.arrayContaining([["status", "ownerAgentId"], ["body"]]),
    );
    expect(updates).toHaveLength(2);
  });

  it("returns 409 when the base revision is stale", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;
    const created = await request(app).post(url).send({ key: "stale", title: "Stale", body: "v1" });
    await request(app).patch(`${url}/stale`).send({ body: "v2" });

    const stale = await request(app)
      .patch(`${url}/stale`)
      .send({ body: "v3", baseRevisionId: created.body.latestRevisionId });
    expect(stale.status).toBe(409);
    expect((await request(app).get(`${url}/stale`)).body.body).toBe("v2");
  });

  it("moves an owner from an agent to a user and back", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const agent = await seedAgent(ctx.db, seeded.companyId);
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;
    await request(app).post(url).send({ key: "owner", title: "Owner", ownerAgentId: agent.id });

    const toUser = await request(app).patch(`${url}/owner`).send({ ownerUserId: seeded.userId });
    expect(toUser.body).toMatchObject({ ownerAgentId: null, ownerUserId: seeded.userId });

    const toAgent = await request(app).patch(`${url}/owner`).send({ ownerAgentId: agent.id });
    expect(toAgent.body).toMatchObject({ ownerAgentId: agent.id, ownerUserId: null });

    const unknownUser = await request(app).patch(`${url}/owner`).send({ ownerUserId: "user-not-a-member" });
    expect(unknownUser.status).toBe(404);
  });

  it("deletes only an archived policy, with its document and revisions", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const app = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;
    const created = await request(app).post(url).send({ key: "old", title: "Old", status: "active" });

    const refused = await request(app).delete(`${url}/old`);
    expect(refused.status).toBe(409);

    await request(app).patch(`${url}/old`).send({ status: "archived" });
    const deleted = await request(app).delete(`${url}/old`);
    expect(deleted.status).toBe(200);
    expect(await ctx.db.select().from(companyPolicies)).toHaveLength(0);
    expect(await ctx.db.select().from(documents).where(eq(documents.id, created.body.documentId))).toHaveLength(0);
    expect(
      await ctx.db.select().from(documentRevisions).where(eq(documentRevisions.documentId, created.body.documentId)),
    ).toHaveLength(0);
    const deletes = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "policy.deleted"));
    expect(deletes).toHaveLength(1);

    expect((await request(app).get(`${url}/old`)).status).toBe(404);
  });

  it("lets a company agent read policies and refuses every agent write with 403", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const agent = await seedAgent(ctx.db, seeded.companyId);
    const board = createApp(ctx.db, seeded.actor);
    const url = `/api/companies/${seeded.companyId}/policies`;
    await request(board).post(url).send({ key: "read-me", title: "Read me", body: "Full text", status: "active" });

    const asAgent = createApp(ctx.db, agentActor(seeded.companyId, agent.id));
    expect((await request(asAgent).get(url)).body).toHaveLength(1);
    expect((await request(asAgent).get(`${url}/read-me`)).body.body).toBe("Full text");
    expect((await request(asAgent).get(`${url}/read-me/revisions`)).status).toBe(200);

    expect((await request(asAgent).post(url).send({ key: "mine", title: "Mine" })).status).toBe(403);
    expect((await request(asAgent).patch(`${url}/read-me`).send({ body: "changed" })).status).toBe(403);
    await request(board).patch(`${url}/read-me`).send({ status: "archived" });
    expect((await request(asAgent).delete(`${url}/read-me`)).status).toBe(403);

    const stored = await request(board).get(`${url}/read-me`);
    expect(stored.body).toMatchObject({ body: "Full text", status: "archived" });
  });

  it("refuses an agent or board user from another company", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const otherAgent = await seedAgent(ctx.db, other.companyId);
    await request(createApp(ctx.db, seeded.actor))
      .post(`/api/companies/${seeded.companyId}/policies`)
      .send({ key: "private", title: "Private" });
    const url = `/api/companies/${seeded.companyId}/policies`;

    expect((await request(createApp(ctx.db, agentActor(other.companyId, otherAgent.id))).get(url)).status).toBe(403);
    expect((await request(createApp(ctx.db, other.actor)).get(`${url}/private`)).status).toBe(403);
    expect((await request(createApp(ctx.db, other.actor)).patch(`${url}/private`).send({ title: "x" })).status).toBe(403);
  });

  it("refuses a viewer board member's write with 403", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Policies");
    const viewer: Express.Request["actor"] = {
      ...seeded.actor,
      memberships: [{ companyId: seeded.companyId, membershipRole: "viewer", status: "active" }],
    };
    const response = await request(createApp(ctx.db, viewer))
      .post(`/api/companies/${seeded.companyId}/policies`)
      .send({ key: "viewer", title: "Viewer" });
    expect(response.status).toBe(403);
  });
});

describe("company policy OpenAPI document", () => {
  it("marks the writes board-only and the reads open to company agents", () => {
    const paths = buildOpenApiSpec().paths as Record<string, Record<string, { "x-paperclip-authorization"?: unknown }>>;
    const actorOf = (method: string, path: string) =>
      (paths[path]?.[method]?.["x-paperclip-authorization"] as { actor?: string } | undefined)?.actor;

    expect(actorOf("get", "/api/companies/{companyId}/policies")).toBe("board_or_agent");
    expect(actorOf("get", "/api/companies/{companyId}/policies/{key}")).toBe("board_or_agent");
    expect(actorOf("get", "/api/companies/{companyId}/policies/{key}/revisions")).toBe("board_or_agent");
    expect(actorOf("post", "/api/companies/{companyId}/policies")).toBe("board");
    expect(actorOf("patch", "/api/companies/{companyId}/policies/{key}")).toBe("board");
    expect(actorOf("delete", "/api/companies/{companyId}/policies/{key}")).toBe("board");
  });
});

describe("company policy key parsing", () => {
  it("returns 400 for a key with an invalid character before any database read", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "u", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", companyPolicyRoutes({} as Db));
    app.use(errorHandler);
    const response = await request(app).get("/api/companies/c/policies/Not_Valid");
    expect(response.status).toBe(400);
  });
});
