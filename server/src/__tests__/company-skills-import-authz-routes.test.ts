import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkillPolicies,
  companySkills,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { companySkillPolicyService } from "../services/company-skill-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill import auth route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company skill import authorization routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  const cleanupDirs = new Set<string>();
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;
  const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "company-skills-import-authz-test-secret";
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-skills-import-authz-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-import-authz-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companySkillPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
  });

  function authenticatedApp() {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    instance.use("/api", companySkillRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function writeSkillFixture(companyId: string) {
    if (!paperclipHome) throw new Error("Expected Paperclip test home");
    // Local imports must originate from an approved root (managed-skill
    // directory or a configured workspace); a bare tmpdir is rejected with
    // skill_workspace_boundary_denied.
    const managedRoot = path.join(paperclipHome, "instances", "default", "skills", companyId);
    await fs.mkdir(managedRoot, { recursive: true });
    const skillDir = await fs.mkdtemp(path.join(managedRoot, "paperclip-import-authz-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Import Authz Fixture",
        "description: Route-level import authorization fixture.",
        "---",
        "",
        "# Import Authz Fixture",
        "",
      ].join("\n"),
      "utf8",
    );
    return skillDir;
  }

  async function seedGrantedAgentWithResponsibleUser(options: { grant?: boolean; taskBound?: boolean } = {}) {
    const { grant = true, taskBound = false } = options;
    const [company] = await db.insert(companies).values({
      name: "Company Skill Import Authz",
      issuePrefix: `IA${randomUUID().replace(/-/g, "").slice(0, 6)}`,
    }).returning();
    const companyId = company!.id;

    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Skill Import Agent",
      role: "ceo",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateSkills: false },
    }).returning();
    const agentId = agent!.id;

    const responsibleUserId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Responsible User",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    if (grant) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "skills:create",
        scope: null,
        grantedByUserId: null,
      });
    }

    let issueId: string | null = null;
    if (taskBound) {
      const [issue] = await db.insert(issues).values({
        companyId,
        title: "Publish a skill",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      }).returning();
      issueId = issue!.id;
    }

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId,
      ...(issueId ? { contextSnapshot: { issueId } } : {}),
    });
    return { companyId, agent: agent!, responsibleUserId, runId, issueId };
  }

  async function restrictAgentsByDefault(companyId: string, userId: string) {
    await companySkillPolicyService(db).replace({
      companyId,
      expectedRevision: 0,
      policy: { schemaVersion: 1, defaultEffect: "deny", rules: [] },
      activity: { actorType: "user", actorId: userId },
    });
  }

  function agentToken(seed: Awaited<ReturnType<typeof seedGrantedAgentWithResponsibleUser>>) {
    return createLocalAgentJwt(seed.agent.id, seed.companyId, seed.agent.adapterType, seed.runId, seed.responsibleUserId);
  }

  it("lets a granted agent on a task-bound run create a company skill and records the actor", async () => {
    const seed = await seedGrantedAgentWithResponsibleUser({ taskBound: true });

    const res = await request(authenticatedApp())
      .post(`/api/companies/${seed.companyId}/skills`)
      .set("Authorization", `Bearer ${agentToken(seed)}`)
      .set("X-Paperclip-Run-Id", seed.runId)
      .send({ name: "Bridge Publish Fixture", markdown: "---\nname: Bridge Publish Fixture\ndescription: Create route fixture.\n---\n\n# Fixture\n" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ name: "Bridge Publish Fixture" });
    const activity = (await db.select().from(activityLog)).filter((row) => row.action === "company.skill_created");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId: seed.companyId,
      actorType: "agent",
      actorId: seed.agent.id,
      agentId: seed.agent.id,
      runId: seed.runId,
      entityType: "company_skill",
    });
  });

  it("denies an agent without the permission on create and import when the company policy denies by default", async () => {
    const seed = await seedGrantedAgentWithResponsibleUser({ grant: false, taskBound: true });
    await restrictAgentsByDefault(seed.companyId, seed.responsibleUserId);
    const skillDir = await writeSkillFixture(seed.companyId);
    const token = agentToken(seed);

    const created = await request(authenticatedApp())
      .post(`/api/companies/${seed.companyId}/skills`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", seed.runId)
      .send({ name: "Denied Create Fixture", markdown: "# Denied\n" });
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    expect(created.body).toMatchObject({ code: "skill_policy_denied", reason: "policy_default" });

    const imported = await request(authenticatedApp())
      .post(`/api/companies/${seed.companyId}/skills/import`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", seed.runId)
      .send({ source: skillDir });
    expect(imported.status, JSON.stringify(imported.body)).toBe(403);
    expect(imported.body).toMatchObject({ code: "skill_policy_denied", reason: "policy_default" });

    expect(await db.select().from(companySkills)).toEqual([]);
    expect((await db.select().from(activityLog)).filter((row) => /^company\.skills?_(created|imported)$/.test(row.action))).toEqual([]);
  });

  it("still lets an agent with skills:create write under a default-deny policy", async () => {
    const seed = await seedGrantedAgentWithResponsibleUser({ grant: true, taskBound: true });
    await restrictAgentsByDefault(seed.companyId, seed.responsibleUserId);

    const res = await request(authenticatedApp())
      .post(`/api/companies/${seed.companyId}/skills`)
      .set("Authorization", `Bearer ${agentToken(seed)}`)
      .set("X-Paperclip-Run-Id", seed.runId)
      .send({ name: "Granted Under Deny Fixture", markdown: "# Granted\n" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("denies an agent key on create and import in another company", async () => {
    const own = await seedGrantedAgentWithResponsibleUser({ taskBound: true });
    const other = await seedGrantedAgentWithResponsibleUser({ taskBound: true });
    const skillDir = await writeSkillFixture(other.companyId);
    const token = agentToken(own);

    const created = await request(authenticatedApp())
      .post(`/api/companies/${other.companyId}/skills`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", own.runId)
      .send({ name: "Cross Company Fixture", markdown: "# Cross\n" });
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    expect(created.body).toMatchObject({ code: "skill_company_boundary_denied" });

    const imported = await request(authenticatedApp())
      .post(`/api/companies/${other.companyId}/skills/import`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", own.runId)
      .send({ source: skillDir });
    expect(imported.status, JSON.stringify(imported.body)).toBe(403);
    expect(imported.body).toMatchObject({ code: "skill_company_boundary_denied" });
    expect(await db.select().from(companySkills)).toEqual([]);
  });

  it("lets a standard responsible-user agent JWT with skills:create import a company skill", async () => {
    const { companyId, agent, responsibleUserId, runId } = await seedGrantedAgentWithResponsibleUser();
    const skillDir = await writeSkillFixture(companyId);
    const token = createLocalAgentJwt(agent.id, companyId, agent.adapterType, runId, responsibleUserId);
    expect(token).toBeTruthy();

    const res = await request(authenticatedApp())
      .post(`/api/companies/${companyId}/skills/import`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ source: skillDir });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.imported).toHaveLength(1);
    expect(res.body.imported[0]).toMatchObject({
      slug: "import-authz-fixture",
      name: "Import Authz Fixture",
      sourceType: "local_path",
    });

    const [importActivity] = await db.select().from(activityLog);
    expect(importActivity).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      runId,
      action: "company.skills_imported",
      entityType: "company",
      entityId: companyId,
    });
  });
});
