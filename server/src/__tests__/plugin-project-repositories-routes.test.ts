import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, plugins, activityLog } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native Projects with a plugin repository source", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  const repo = { id: "42", fullName: "my-org/my-repo", url: "https://github.com/my-org/my-repo" };
  const call = vi.fn().mockResolvedValue({ repositories: [repo], connectionCount: 1, failedConnectionCount: 0 });
  const manifest: PaperclipPluginManifestV1 = { id: "test.repository-source", apiVersion: 1, version: "1.0.0", author: "Test", description: "Test", displayName: "My GitHub App", categories: ["connector"], capabilities: ["ui.action.register"], entrypoints: { worker: "dist/worker.js" }, projectRepositories: { listAction: "repositories" } };
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-project-repositories-"); db = createDb(temp.connectionString);
    const [company] = await db.insert(companies).values({ name: "Plugin repository test", issuePrefix: "PRT" }).returning(); companyId = company.id;
    await db.insert(plugins).values({ pluginKey: manifest.id, packageName: "test", version: "1.0.0", manifestJson: manifest, status: "ready" });
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });
  function app(withPlugin = true) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "alice", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: "admin", status: "active" }] }; next(); });
    app.use("/api", projectRoutes(db, withPlugin ? { pluginWorkerManager: { call } } : {})); app.use(errorHandler); return app;
  }
  it("makes repositories visible to the native picker and creates/updates ordinary project workspaces", async () => {
    const baseline = await request(app(false)).get(`/api/companies/${companyId}/project-repositories`);
    expect(baseline.body.repositories).toEqual([]); // Previous host behavior: only built-in Apps.
    const host = app();
    const available = await request(host).get(`/api/companies/${companyId}/project-repositories`);
    expect(available.status).toBe(200); expect(available.body.repositories[0]).toMatchObject(repo);
    const created = await request(host).post(`/api/companies/${companyId}/projects`).send({ name: "From org repo", repositoryIds: ["42"] });
    expect(created.status).toBe(201);
    expect(created.body.workspaces).toHaveLength(1);
    expect(created.body.workspaces[0]).toMatchObject({ companyId, repoUrl: repo.url, metadata: { githubRepositoryId: "42" } });
    const changed = await request(host).put(`/api/projects/${created.body.id}/repositories`).send({ repositoryIds: ["42"] });
    expect(changed.status).toBe(200); expect(changed.body.workspaces[0].id).toBe(created.body.workspaces[0].id);
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    expect(events.map(row => row.action)).toContain("project.created"); expect(events.map(row => row.action)).toContain("project.repositories_updated");
  });
  it("rejects foreign-company requests before calling the plugin and rejects unavailable repository IDs", async () => {
    call.mockClear();
    const [foreign] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTH" }).returning();
    expect((await request(app()).get(`/api/companies/${foreign.id}/project-repositories`)).status).toBe(403);
    expect(call).not.toHaveBeenCalled();
    expect((await request(app()).post(`/api/companies/${companyId}/projects`).send({ name: "Unlisted", repositoryIds: ["999"] })).status).toBe(422);
  });
});
