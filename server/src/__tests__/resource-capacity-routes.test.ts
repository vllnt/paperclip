import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environments,
  resourceCapacitySamples,
  resourceCapacityTargets,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resourceCapacityRoutes } from "../routes/resource-capacity.ts";
import { environmentTargetKey, resourceCapacityService } from "../services/resource-capacity.ts";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping resource capacity route tests: ${support.reason ?? "unsupported environment"}`);
}

const GIB = 1024 ** 3;
const PRIVATE_HOSTNAME = "private-build-host.internal.example";

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", resourceCapacityRoutes(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describePostgres("resource capacity routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let alpha: string;
  let beta: string;
  let shared: string;
  let betaOnly: string;
  let alphaAgentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-capacity-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(resourceCapacitySamples);
    await db.delete(resourceCapacityTargets);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    // Migrations seed a local environment; these tests use SSH environments only.
    await db.delete(environments);
    const sshConfig = (name: string) => ({
      name,
      driver: "ssh",
      config: { host: PRIVATE_HOSTNAME, port: 22, username: "paperclip", remoteWorkspacePath: "/srv/secret-root" },
    });
    const [sharedRow] = await db.insert(environments).values(sshConfig("shared-worker")).returning();
    const [betaRow] = await db.insert(environments).values(sshConfig("beta-worker")).returning();
    shared = sharedRow!.id;
    betaOnly = betaRow!.id;
    alpha = randomUUID();
    beta = randomUUID();
    for (const [companyId, name] of [[alpha, "Alpha"], [beta, "Beta"]] as const) {
      await db.insert(companies).values({ id: companyId, name, issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    }
    const [alphaAgent] = await db
      .insert(agents)
      .values({ companyId: alpha, name: "Alpha agent", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: shared })
      .returning();
    alphaAgentId = alphaAgent!.id;
    await db.insert(agents).values([
      { companyId: beta, name: "Beta agent 1", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: shared },
      { companyId: beta, name: "Beta agent 2", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: betaOnly },
    ]);
    const svc = resourceCapacityService(db, { hostname: PRIVATE_HOSTNAME });
    for (const environmentId of [shared, betaOnly]) {
      await svc.recordReading({
        targetKey: environmentTargetKey(environmentId),
        targetKind: "environment",
        environmentId,
        source: "sweep",
        reading: {
          cpuCount: 8,
          load1: 1,
          load5: 2,
          load15: 3,
          memTotalBytes: 16 * GIB,
          memAvailableBytes: 8 * GIB,
          disks: [{ labels: ["workspaces"], totalBytes: 100 * GIB, freeBytes: 3 * GIB }],
        },
      });
    }
    await svc.recordReading({
      targetKey: svc.currentInstanceKey,
      targetKind: "instance",
      hostLabel: PRIVATE_HOSTNAME,
      source: "interval",
      reading: { cpuCount: 4, load1: 0, load5: 0, load15: 0, memTotalBytes: GIB, memAvailableBytes: GIB, disks: [] },
    });
  }

  const alphaAgent = () => ({ type: "agent" as const, agentId: alphaAgentId, companyId: alpha, runId: null, source: "agent_key" as const });
  const alphaMember = () => ({ type: "board" as const, userId: "alpha-user", companyIds: [alpha], source: "session" as const, isInstanceAdmin: false });
  const admin = () => ({ type: "board" as const, userId: "admin", companyIds: [], source: "session" as const, isInstanceAdmin: true });

  it("serves the instance view to instance admins only", async () => {
    await seed();
    const forbidden = await request(createApp(db, alphaMember() as any)).get("/api/instance/resource-capacity");
    expect(forbidden.status).toBe(403);
    const agent = await request(createApp(db, alphaAgent() as any)).get("/api/instance/resource-capacity");
    expect(agent.status).toBe(403);

    const res = await request(createApp(db, admin() as any)).get("/api/instance/resource-capacity");
    expect(res.status).toBe(200);
    // The route's process runs on this machine, not on the seeded host.
    expect(res.body.hosts).toHaveLength(1);
    expect(res.body.hosts[0]).toMatchObject({ hostLabel: PRIVATE_HOSTNAME, current: false });
    expect(res.body.hosts[0].targetKey).not.toContain(PRIVATE_HOSTNAME);
    expect(res.body.environments.map((environment: { environmentName: string }) => environment.environmentName)).toEqual([
      "beta-worker",
      "shared-worker",
    ]);
  });

  it("shows a company's members and agents only the environments its agents run on, with no host or path", async () => {
    await seed();
    for (const actor of [alphaMember(), alphaAgent()]) {
      const res = await request(createApp(db, actor as any)).get(`/api/companies/${alpha}/resource-capacity`);
      expect(res.status).toBe(200);
      expect(res.body.environments).toHaveLength(1);
      expect(res.body.environments[0]).toMatchObject({
        environmentId: shared,
        environmentName: "shared-worker",
        driver: "ssh",
        level: "critical",
        loadPerCore: 0.25,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(PRIVATE_HOSTNAME);
      expect(text).not.toContain("/srv/secret-root");
    }
    const other = await request(createApp(db, alphaAgent() as any)).get(`/api/companies/${beta}/resource-capacity`);
    expect(other.status).toBe(403);
  });

  it("returns 404 for an environment the caller's company does not run on", async () => {
    await seed();
    for (const actor of [alphaMember(), alphaAgent()]) {
      const app = createApp(db, actor as any);
      const allowed = await request(app).get(`/api/environments/${shared}/resource-capacity`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.environment.disks).toEqual([
        { labels: ["workspaces"], totalBytes: 100 * GIB, freeBytes: 3 * GIB, freePercent: 3 },
      ]);
      const hidden = await request(app).get(`/api/environments/${betaOnly}/resource-capacity`);
      const missing = await request(app).get(`/api/environments/${randomUUID()}/resource-capacity`);
      const malformed = await request(app).get("/api/environments/not-a-uuid/resource-capacity");
      expect([hidden.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
      expect(hidden.body).toEqual(missing.body);
    }
    const adminView = await request(createApp(db, admin() as any)).get(`/api/environments/${betaOnly}/resource-capacity`);
    expect(adminView.status).toBe(200);
    const anonymous = await request(createApp(db, { type: "none", source: "none" } as any)).get(
      `/api/environments/${shared}/resource-capacity`,
    );
    expect(anonymous.status).toBe(403);
  });
});
