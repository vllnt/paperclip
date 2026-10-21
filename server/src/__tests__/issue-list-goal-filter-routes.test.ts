import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, goals, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { __clearIssueListResponseCacheForTests, issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list goal filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes goalId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-goal-filter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: "cloud-user-1" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `G${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return companyId;
  }

  it("returns only the tasks whose own goal is the given one", async () => {
    const companyId = await seedCompany();
    const goalId = randomUUID();
    const subGoalId = randomUUID();
    await db.insert(goals).values([
      { id: goalId, companyId, title: "Ship the beta", level: "company", status: "active" },
      { id: subGoalId, companyId, title: "Beta docs", level: "team", status: "active", parentId: goalId },
    ]);
    const goalTaskId = randomUUID();
    const doneGoalTaskId = randomUUID();
    await db.insert(issues).values([
      { id: goalTaskId, companyId, title: "Goal task", status: "todo", priority: "medium", goalId },
      { id: doneGoalTaskId, companyId, title: "Finished goal task", status: "done", priority: "medium", goalId },
      { id: randomUUID(), companyId, title: "Sub-goal task", status: "todo", priority: "medium", goalId: subGoalId },
      { id: randomUUID(), companyId, title: "No goal", status: "todo", priority: "medium", goalId: null },
    ]);
    const app = createApp(companyId);

    const all = await request(app).get(`/api/companies/${companyId}/issues`).query({ goalId });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.map((issue: { id: string }) => issue.id).sort()).toEqual([goalTaskId, doneGoalTaskId].sort());

    const open = await request(app).get(`/api/companies/${companyId}/issues`).query({ goalId, status: "todo,in_progress" });
    expect(open.body.map((issue: { id: string }) => issue.id)).toEqual([goalTaskId]);
  });

  it("refuses a goalId that is not a UUID", async () => {
    const companyId = await seedCompany();

    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues`).query({ goalId: "beta" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "goalId must be a UUID" });
  });
});
