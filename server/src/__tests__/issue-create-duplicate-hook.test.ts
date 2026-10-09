import request from "supertest";
import { expect, it, vi } from "vitest";
import { activityLog } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue create triggers the duplicate check off the request path", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-create-duplicate-hook-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await resetCompanyIssueFixtures(db);
    },
  });

  function appWith(
    seeded: Awaited<ReturnType<typeof seedCompanyWithBoardAccess>>,
    checkAfterCreate: (issue: unknown) => Promise<void>,
  ) {
    return routeApp(ctx.db, seeded.actor, (db, storage) =>
      issueRoutes(db, storage, { duplicateDetection: { checkAfterCreate } }),
    );
  }

  it("responds 201 even when the check never finishes, and hands it the created issue", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Hook");
    const checkAfterCreate = vi.fn(() => new Promise<void>(() => {}));

    const res = await request(appWith(seeded, checkAfterCreate))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Remove the compatibility barrels", description: "Delete the barrel files." })
      .expect(201);

    expect(checkAfterCreate).toHaveBeenCalledTimes(1);
    expect(checkAfterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: res.body.id,
        companyId: seeded.companyId,
        identifier: res.body.identifier,
        title: "Remove the compatibility barrels",
        description: "Delete the barrel files.",
        parentId: null,
        originKind: "manual",
        originId: null,
        createdAt: expect.any(Date),
      }),
    );
  });

  it("does not run for a create that core resolved to an existing issue", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Core dedupe");
    const checkAfterCreate = vi.fn(async () => {});
    const app = appWith(seeded, checkAfterCreate);
    const body = { title: "Enforce PR assignee and GitHub issue linkage", allowDuplicate: false };

    await request(app).post(`/api/companies/${seeded.companyId}/issues`).send(body).expect(201);
    const second = await request(app).post(`/api/companies/${seeded.companyId}/issues`).send(body);

    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(checkAfterCreate).toHaveBeenCalledTimes(1);
  });

  it("creates issues normally when duplicate detection is not wired", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "No detector");
    const res = await request(routeApp(ctx.db, seeded.actor, issueRoutes))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Plain create" });
    expect(res.status).toBe(201);
  });
});
