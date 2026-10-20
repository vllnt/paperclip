import { randomUUID } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, createDb, eventDeliveries, eventSources } from "@paperclipai/db";
import {
  PAPERCLIP_INTERNAL_EVENT_NORMALIZER,
  PAPERCLIP_INTERNAL_EVENT_SOURCE_NAME,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { eventSourcePublicRoutes, eventSourceRoutes } from "../routes/event-sources.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture } from "./helpers/event-source-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres internal event source tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestActor = Express.Request["actor"];

describeEmbeddedPostgres("the built-in Paperclip event source", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-event-sources-internal-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const boardActor = (companyId: string): TestActor => ({
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  });

  const agentActor = (companyId: string, agentId: string): TestActor => ({
    type: "agent",
    agentId,
    companyId,
    keyId: randomUUID(),
    source: "agent_key",
  });

  function appFor(fx: Awaited<ReturnType<typeof seedEventFixture>>, actor: () => TestActor) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.actor = actor();
      next();
    });
    const api = Router();
    api.use(eventSourceRoutes(db, fx.sources));
    api.use(eventSourcePublicRoutes(fx.sources));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  }

  async function internalRows(companyId: string) {
    return db
      .select()
      .from(eventSources)
      .where(and(eq(eventSources.companyId, companyId), eq(eventSources.normalizer, PAPERCLIP_INTERNAL_EVENT_NORMALIZER)));
  }

  async function seed() {
    const fx = await seedEventFixture(db);
    const app = appFor(fx, () => boardActor(fx.companyId));
    const ensure = () => request(app).post(`/api/companies/${fx.companyId}/event-sources/paperclip`).send({});
    return { fx, app, ensure };
  }

  describe("ensure endpoint", () => {
    it("creates it on the first call with no secret and no ingress, and answers 200", async () => {
      const { fx, ensure } = await seed();

      const res = await ensure();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        companyId: fx.companyId,
        name: PAPERCLIP_INTERNAL_EVENT_SOURCE_NAME,
        normalizer: PAPERCLIP_INTERNAL_EVENT_NORMALIZER,
        ingressUrl: null,
        secretId: null,
        enabled: true,
        archived: false,
      });
      expect(await internalRows(fx.companyId)).toHaveLength(1);
    });

    it("returns the same source on every later call and logs the creation once", async () => {
      const { fx, ensure } = await seed();

      const first = await ensure();
      const second = await ensure();

      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      const created = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, fx.companyId), eq(activityLog.action, "event_source.created")));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ entityType: "event_source", entityId: first.body.id });
    });

    it("keeps exactly one source when calls race", async () => {
      const { fx, ensure } = await seed();

      const results = await Promise.all(Array.from({ length: 6 }, () => ensure()));

      expect(results.every((res) => res.status === 200)).toBe(true);
      expect(new Set(results.map((res) => res.body.id)).size).toBe(1);
      expect(await internalRows(fx.companyId)).toHaveLength(1);
      const created = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, fx.companyId), eq(activityLog.action, "event_source.created")));
      expect(created).toHaveLength(1);
    });

    it("gives each company its own source", async () => {
      const first = await seed();
      const second = await seed();

      const a = await first.ensure();
      const b = await second.ensure();

      expect(a.body.id).not.toBe(b.body.id);
      expect(a.body.companyId).toBe(first.fx.companyId);
      expect(b.body.companyId).toBe(second.fx.companyId);
    });

    it("is listed once it exists and not before", async () => {
      const { fx, app, ensure } = await seed();

      const before = await request(app).get(`/api/companies/${fx.companyId}/event-sources`);
      expect(before.body).toEqual([]);

      const ensured = await ensure();
      const after = await request(app).get(`/api/companies/${fx.companyId}/event-sources`);

      expect(after.body.map((source: { id: string }) => source.id)).toEqual([ensured.body.id]);
      expect(after.body[0].ingressUrl).toBeNull();
    });

    it("refuses an agent and a board user of another company", async () => {
      const { fx } = await seed();
      const agentId = await fx.createAgent();
      const asAgent = appFor(fx, () => agentActor(fx.companyId, agentId));
      const other = randomUUID();
      const asOutsider = appFor(fx, () => boardActor(other));

      const byAgent = await request(asAgent).post(`/api/companies/${fx.companyId}/event-sources/paperclip`).send({});
      const byOutsider = await request(asOutsider).post(`/api/companies/${fx.companyId}/event-sources/paperclip`).send({});

      expect(byAgent.status).toBe(403);
      expect(byOutsider.status).toBe(403);
      expect(await internalRows(fx.companyId)).toHaveLength(0);
    });

    it("does not touch another company's source", async () => {
      const first = await seed();
      const second = await seed();
      await second.ensure();

      await first.ensure();

      expect(await internalRows(first.fx.companyId)).toHaveLength(1);
      expect(await internalRows(second.fx.companyId)).toHaveLength(1);
    });
  });

  describe("managed by Paperclip", () => {
    it("lets only enabled change", async () => {
      const { app, ensure } = await seed();
      const { body: source } = await ensure();

      const rename = await request(app).patch(`/api/event-sources/${source.id}`).send({ name: "Mine" });
      const budget = await request(app).patch(`/api/event-sources/${source.id}`).send({ maxNewIssuesPerHour: 1 });
      const archive = await request(app).patch(`/api/event-sources/${source.id}`).send({ archived: true });
      const mixed = await request(app).patch(`/api/event-sources/${source.id}`).send({ enabled: false, name: "Mine" });
      const off = await request(app).patch(`/api/event-sources/${source.id}`).send({ enabled: false });
      const on = await request(app).patch(`/api/event-sources/${source.id}`).send({ enabled: true });

      for (const refused of [rename, budget, archive, mixed]) {
        expect(refused.status).toBe(409);
        expect(refused.body.error).toContain("managed by Paperclip");
      }
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ enabled: false, name: PAPERCLIP_INTERNAL_EVENT_SOURCE_NAME });
      expect(on.body.enabled).toBe(true);
    });

    it("cannot be archived, rotated or tested", async () => {
      const { fx, app, ensure } = await seed();
      const { body: source } = await ensure();

      const archived = await request(app).delete(`/api/event-sources/${source.id}`);
      const rotated = await request(app).post(`/api/event-sources/${source.id}/rotate-secret`).send({});
      const tested = await request(app).post(`/api/event-sources/${source.id}/test`).send({ payload: { type: "x" } });

      for (const refused of [archived, rotated, tested]) {
        expect(refused.status).toBe(409);
        expect(refused.body.error).toContain("managed by Paperclip");
      }
      const [row] = await internalRows(fx.companyId);
      expect(row).toMatchObject({ archived: false, secretId: null, enabled: true });
    });
  });

  describe("ingress", () => {
    it("answers its public id exactly like an unknown source", async () => {
      const { fx, ensure } = await seed();
      const { body: source } = await ensure();
      const app = appFor(fx, () => boardActor(fx.companyId));
      const body = { schema: "paperclip.event.v1", source: "x", type: "y", severity: "info", state: "info", dedupeKey: "k", title: "t" };

      const internal = await request(app)
        .post(`/api/event-sources/public/${source.publicId}/events`)
        .set("Authorization", "Bearer anything")
        .send(body);
      const unknown = await request(app)
        .post(`/api/event-sources/public/${randomUUID().replace(/-/g, "")}/events`)
        .set("Authorization", "Bearer anything")
        .send(body);

      expect(internal.status).toBe(404);
      expect(internal.status).toBe(unknown.status);
      expect(internal.body).toEqual(unknown.body);
      expect(await db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id))).toEqual([]);
    });
  });

});
