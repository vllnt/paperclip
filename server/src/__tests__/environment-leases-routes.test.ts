import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { environmentRoutes } from "../routes/environments.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment lease route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", environmentRoutes(db));
  app.use(errorHandler);
  return app;
}

function boardActor(companyIds: string[], source: "local_implicit" | "session" = "session"): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "operator", status: "active" })),
    isInstanceAdmin: false,
    source,
  };
}

function instanceAdminActor(companyIds: string[]): Express.Request["actor"] {
  return { ...boardActor(companyIds), isInstanceAdmin: true };
}

async function seedCompany(db: Db, label: string) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `EL${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedEnvironment(db: Db, name: string, driver = "ssh") {
  const [environment] = await db.insert(environments).values({
    name: `${name} ${randomUUID().slice(0, 6)}`,
    driver,
    status: "active",
    config: {},
  }).returning();
  return environment!;
}

async function seedLease(db: Db, input: {
  companyId: string;
  environmentId: string | null;
  status: string;
  lastUsedAt?: Date;
  metadata?: Record<string, unknown> | null;
}) {
  const [lease] = await db.insert(environmentLeases).values({
    companyId: input.companyId,
    environmentId: input.environmentId,
    status: input.status,
    leasePolicy: "ephemeral",
    provider: "ssh",
    providerLeaseId: `provider-${randomUUID().slice(0, 8)}`,
    lastUsedAt: input.lastUsedAt ?? new Date(),
    metadata: input.metadata ?? null,
  }).returning();
  return lease!;
}

describeEmbeddedPostgres("environment lease list routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-environment-leases-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("GET /api/environments/:id/leases", () => {
    it("filters by a comma-separated status list and rejects unknown statuses with 400", async () => {
      const company = await seedCompany(db, "Leases");
      const environment = await seedEnvironment(db, "Build box");
      const active = await seedLease(db, { companyId: company.id, environmentId: environment.id, status: "active" });
      const released = await seedLease(db, { companyId: company.id, environmentId: environment.id, status: "released" });
      const failed = await seedLease(db, { companyId: company.id, environmentId: environment.id, status: "failed" });
      const app = createApp(db, boardActor([company.id]));

      const all = await request(app).get(`/api/environments/${environment.id}/leases`);
      expect(all.status, JSON.stringify(all.body)).toBe(200);
      expect(all.body.map((lease: { id: string }) => lease.id).sort()).toEqual([active.id, released.id, failed.id].sort());

      const one = await request(app).get(`/api/environments/${environment.id}/leases?status=released`);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(one.body.map((lease: { id: string }) => lease.id)).toEqual([released.id]);

      const several = await request(app).get(`/api/environments/${environment.id}/leases?status=released,failed`);
      expect(several.status, JSON.stringify(several.body)).toBe(200);
      expect(several.body.map((lease: { id: string }) => lease.id).sort()).toEqual([released.id, failed.id].sort());

      for (const query of ["status=bogus", "status=active,bogus"]) {
        const res = await request(app).get(`/api/environments/${environment.id}/leases?${query}`);
        expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(400);
      }
    });

    it("still denies agents", async () => {
      const company = await seedCompany(db, "Leases");
      const environment = await seedEnvironment(db, "Build box");
      const app = createApp(db, {
        type: "agent",
        agentId: randomUUID(),
        companyId: company.id,
        runId: randomUUID(),
        source: "agent_jwt",
      });
      const res = await request(app).get(`/api/environments/${environment.id}/leases`);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });
  });

  describe("GET /api/companies/:companyId/environment-leases", () => {
    it("lists open leases across the company's environments with environment name and driver", async () => {
      const company = await seedCompany(db, "Leases");
      const other = await seedCompany(db, "Other");
      const ssh = await seedEnvironment(db, "Build box", "ssh");
      const sandbox = await seedEnvironment(db, "Sandbox", "sandbox");
      const activeSsh = await seedLease(db, {
        companyId: company.id, environmentId: ssh.id, status: "active", lastUsedAt: new Date(Date.now() - 60_000),
      });
      const pendingSandbox = await seedLease(db, {
        companyId: company.id, environmentId: sandbox.id, status: "pending_cleanup", lastUsedAt: new Date(),
      });
      const orphan = await seedLease(db, {
        companyId: company.id, environmentId: null, status: "pending_cleanup", lastUsedAt: new Date(Date.now() - 120_000),
      });
      const released = await seedLease(db, { companyId: company.id, environmentId: ssh.id, status: "released" });
      const otherCompanyLease = await seedLease(db, { companyId: other.id, environmentId: ssh.id, status: "active" });
      const app = createApp(db, boardActor([company.id, other.id]));

      const res = await request(app).get(`/api/companies/${company.id}/environment-leases`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // Default is active + pending_cleanup, most recently used first.
      expect(res.body.map((lease: { id: string }) => lease.id)).toEqual([
        pendingSandbox.id,
        activeSsh.id,
        orphan.id,
      ]);
      expect(res.body[0]).toMatchObject({
        status: "pending_cleanup",
        companyId: company.id,
        environment: { id: sandbox.id, name: sandbox.name, driver: "sandbox" },
      });
      expect(res.body[1].environment).toEqual({ id: ssh.id, name: ssh.name, driver: "ssh" });
      expect(res.body[2]).toMatchObject({ environmentId: null, environment: null });
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(released.id);
      expect(serialized).not.toContain(otherCompanyLease.id);

      const releasedOnly = await request(app).get(`/api/companies/${company.id}/environment-leases?status=released`);
      expect(releasedOnly.status, JSON.stringify(releasedOnly.body)).toBe(200);
      expect(releasedOnly.body.map((lease: { id: string }) => lease.id)).toEqual([released.id]);

      const everything = await request(app)
        .get(`/api/companies/${company.id}/environment-leases?status=active,pending_cleanup,released`);
      expect(everything.body).toHaveLength(4);
    });

    it("rejects unknown statuses with 400", async () => {
      const company = await seedCompany(db, "Leases");
      const app = createApp(db, boardActor([company.id]));
      for (const query of ["status=bogus", "status=active,nope"]) {
        const res = await request(app).get(`/api/companies/${company.id}/environment-leases?${query}`);
        expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(400);
      }
    });

    it("redacts secret-looking values in lease metadata", async () => {
      const company = await seedCompany(db, "Leases");
      const environment = await seedEnvironment(db, "Build box");
      const secretValue = `sk-live-${randomUUID()}`;
      await seedLease(db, {
        companyId: company.id,
        environmentId: environment.id,
        status: "active",
        metadata: { apiKey: secretValue, note: "kept", nested: { password: secretValue } },
      });

      const res = await request(createApp(db, boardActor([company.id])))
        .get(`/api/companies/${company.id}/environment-leases`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
      expect(res.body[0].metadata).toMatchObject({ note: "kept" });
    });

    it("denies agents, another company's board user, and a board user without company access", async () => {
      const companyA = await seedCompany(db, "Company A");
      const companyB = await seedCompany(db, "Company B");
      const environment = await seedEnvironment(db, "Build box");
      await seedLease(db, { companyId: companyA.id, environmentId: environment.id, status: "active" });

      const agentRes = await request(createApp(db, {
        type: "agent",
        agentId: randomUUID(),
        companyId: companyA.id,
        runId: randomUUID(),
        source: "agent_jwt",
      })).get(`/api/companies/${companyA.id}/environment-leases`);
      expect(agentRes.status, JSON.stringify(agentRes.body)).toBe(403);

      const otherBoard = await request(createApp(db, boardActor([companyB.id])))
        .get(`/api/companies/${companyA.id}/environment-leases`);
      expect(otherBoard.status, JSON.stringify(otherBoard.body)).toBe(403);

      const noCompanies = await request(createApp(db, boardActor([])))
        .get(`/api/companies/${companyA.id}/environment-leases`);
      expect(noCompanies.status, JSON.stringify(noCompanies.body)).toBe(403);
    });
  });

  // Environments can be shared across companies, but every lease row belongs to
  // one company. A board member of company A must never read company B's leases
  // (rows, provider IDs or metadata) through the per-environment or by-ID route.
  describe("company scoping of the per-environment and by-ID lease reads", () => {
    async function seedTwoCompanies() {
      const companyA = await seedCompany(db, "Company A");
      const companyB = await seedCompany(db, "Company B");
      const shared = await seedEnvironment(db, "Shared box");
      const secretValue = `sk-live-${randomUUID()}`;
      const leaseA = await seedLease(db, {
        companyId: companyA.id,
        environmentId: shared.id,
        status: "active",
        metadata: { apiKey: secretValue, note: "a" },
      });
      const leaseB = await seedLease(db, {
        companyId: companyB.id,
        environmentId: shared.id,
        status: "active",
        metadata: { apiKey: secretValue, note: "b" },
      });
      return { companyA, companyB, shared, leaseA, leaseB, secretValue };
    }

    it("lists only the caller's own company's leases of a shared environment", async () => {
      const { companyA, shared, leaseA, leaseB } = await seedTwoCompanies();

      const res = await request(createApp(db, boardActor([companyA.id])))
        .get(`/api/environments/${shared.id}/leases`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.map((lease: { id: string }) => lease.id)).toEqual([leaseA.id]);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(leaseB.id);
      expect(serialized).not.toContain(leaseB.providerLeaseId as string);
    });

    it("lists the leases of every company the caller belongs to", async () => {
      const { companyA, companyB, shared, leaseA, leaseB } = await seedTwoCompanies();

      const res = await request(createApp(db, boardActor([companyA.id, companyB.id])))
        .get(`/api/environments/${shared.id}/leases`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.map((lease: { id: string }) => lease.id).sort()).toEqual([leaseA.id, leaseB.id].sort());
    });

    it("lets instance admins and the local board see every company's leases", async () => {
      const { companyA, shared, leaseA, leaseB } = await seedTwoCompanies();

      for (const actor of [instanceAdminActor([companyA.id]), boardActor([companyA.id], "local_implicit")]) {
        const res = await request(createApp(db, actor)).get(`/api/environments/${shared.id}/leases`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.map((lease: { id: string }) => lease.id).sort()).toEqual([leaseA.id, leaseB.id].sort());
        const byId = await request(createApp(db, actor)).get(`/api/environment-leases/${leaseB.id}`);
        expect(byId.status, JSON.stringify(byId.body)).toBe(200);
        expect(byId.body.id).toBe(leaseB.id);
      }
    });

    it("returns 404 for another company's lease by ID, indistinguishable from a missing lease", async () => {
      const { companyA, leaseA, leaseB } = await seedTwoCompanies();
      const app = createApp(db, boardActor([companyA.id]));

      const own = await request(app).get(`/api/environment-leases/${leaseA.id}`);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.id).toBe(leaseA.id);

      const foreign = await request(app).get(`/api/environment-leases/${leaseB.id}`);
      const missing = await request(app).get(`/api/environment-leases/${randomUUID()}`);
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect(JSON.stringify(foreign.body)).not.toContain(leaseB.providerLeaseId as string);
    });

    it("redacts provider metadata on the per-environment and by-ID reads", async () => {
      const { companyA, shared, leaseA, secretValue } = await seedTwoCompanies();
      const app = createApp(db, boardActor([companyA.id]));

      const list = await request(app).get(`/api/environments/${shared.id}/leases`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(secretValue);
      expect(list.body[0].metadata).toMatchObject({ note: "a" });

      const byId = await request(app).get(`/api/environment-leases/${leaseA.id}`);
      expect(byId.status, JSON.stringify(byId.body)).toBe(200);
      expect(JSON.stringify(byId.body)).not.toContain(secretValue);
      expect(byId.body.metadata).toMatchObject({ note: "a" });
    });

    it("keeps the other company's leases out of the company-wide list, even for a multi-company member", async () => {
      const { companyA, companyB, leaseA, leaseB } = await seedTwoCompanies();
      const app = createApp(db, boardActor([companyA.id, companyB.id]));

      const res = await request(app).get(`/api/companies/${companyA.id}/environment-leases`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.map((lease: { id: string }) => lease.id)).toEqual([leaseA.id]);
      expect(JSON.stringify(res.body)).not.toContain(leaseB.id);
    });
  });
});
