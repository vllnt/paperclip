import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyPolicyService: () => ({
    list: vi.fn(),
    getByKey: vi.fn(),
    listRevisions: vi.fn(),
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  }),
  logActivity: mocks.logActivity,
}));

const { companyPolicyRoutes } = await import("../routes/company-policies.js");

const companyId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

/** The error Drizzle throws when Postgres refuses a write: its own wrapper, with the driver error in `cause`. */
function drizzleWrapped(code: string, constraint: string) {
  return Object.assign(new Error("Failed query: insert into company_policies"), {
    cause: Object.assign(new Error(`violates constraint "${constraint}"`), {
      code,
      constraint_name: constraint,
    }),
  });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", companyPolicyRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

describe("company policy writes that lose a race with the deletion of their project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers 404 when a create hits a foreign-key violation on the project", async () => {
    mocks.create.mockRejectedValue(drizzleWrapped("23503", "company_policies_project_id_projects_id_fk"));

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/policies`)
      .send({ key: "code-review", title: "Code review", projectId });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("The project or owner of this policy no longer exists");
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("answers 404 when an update hits a foreign-key violation on the project", async () => {
    mocks.update.mockRejectedValue(drizzleWrapped("23503", "company_policies_project_id_projects_id_fk"));

    const response = await request(createApp())
      .patch(`/api/companies/${companyId}/policies/code-review`)
      .send({ projectId });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("The project or owner of this policy no longer exists");
    expect(mocks.update).toHaveBeenCalledWith(companyId, "code-review", { projectId }, expect.any(Object));
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("answers 404 for a violation on the owner agent as well", async () => {
    mocks.create.mockRejectedValue(drizzleWrapped("23503", "company_policies_owner_agent_id_agents_id_fk"));

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/policies`)
      .send({ key: "code-review", title: "Code review", ownerAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(response.status).toBe(404);
  });

  it("keeps a failure that is not a foreign-key violation as a 500", async () => {
    mocks.create.mockRejectedValue(drizzleWrapped("57014", "statement_timeout"));
    mocks.update.mockRejectedValue(new Error("connection reset"));
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/policies`)
      .send({ key: "code-review", title: "Code review", projectId });
    const updated = await request(app)
      .patch(`/api/companies/${companyId}/policies/code-review`)
      .send({ title: "Code review v2" });

    expect(created.status).toBe(500);
    expect(updated.status).toBe(500);
  });

  it("keeps the service's own refusals, such as a duplicate key, unchanged", async () => {
    mocks.create.mockRejectedValue(conflict('A policy with the key "code-review" already exists'));

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/policies`)
      .send({ key: "code-review", title: "Code review" });

    expect(response.status).toBe(409);
  });

  it("does not turn a refused delete into a 404", async () => {
    mocks.remove.mockRejectedValue(drizzleWrapped("23001", "some_restrict_fk"));

    const response = await request(createApp()).delete(`/api/companies/${companyId}/policies/code-review`);

    expect(response.status).toBe(500);
  });
});
