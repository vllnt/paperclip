import { createHmac, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, eventDeliveries } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { eventSourceBodyParser } from "../middleware/event-source-body.js";
import { eventSourcePublicRoutes, eventSourceRoutes } from "../routes/event-sources.js";
import { routineRoutes } from "../routes/routines.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture, wireEvent } from "./helpers/event-source-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres event source route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestActor = Express.Request["actor"];

function sign(secret: string, raw: Buffer, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
  return { timestamp, signature };
}

describeEmbeddedPostgres("event source routes: ingress parsing, auth bypass and permissions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-event-sources-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Mirrors the production order in app.ts: the 64 KB event parser, then the global parser,
   * then the real actor middleware, then the public and board routes.
   */
  async function ingressApp() {
    const fx = await seedEventFixture(db, { now: () => Date.now() });
    const app = express();
    const captureRawBody = (req: Request, _res: Response, buf: Buffer) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    };
    app.use("/api/event-sources/public", eventSourceBodyParser(captureRawBody));
    app.use(express.json({ limit: "10mb", verify: captureRawBody }));
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api", eventSourcePublicRoutes(fx.sources));
    app.use(errorHandler);
    return { fx, app };
  }

  function boardApp(fx: Awaited<ReturnType<typeof seedEventFixture>>, actor: () => TestActor) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.actor = actor();
      next();
    });
    const api = Router();
    api.use(eventSourceRoutes(db, fx.sources));
    api.use(routineRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  }

  const boardActor = (companyId: string, extra: Partial<TestActor> = {}): TestActor => ({
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
    ...extra,
  });
  const agentActor = (companyId: string, agentId: string): TestActor => ({
    type: "agent",
    agentId,
    companyId,
    keyId: randomUUID(),
    source: "agent_key",
  });

  async function seedSource(signingMode: "hmac_sha256" | "bearer" = "hmac_sha256") {
    const { fx, app } = await ingressApp();
    const agentId = await fx.createAgent();
    const routine = await fx.createRoutine({ assigneeAgentId: agentId });
    const { source, secret } = await fx.createSource({ signingMode });
    await fx.subscribe(routine.id, source.id);
    return { fx, app, agentId, routine, source, secret };
  }

  const ingestPath = (publicId: string) => `/api/event-sources/public/${publicId}/events`;

  describe("body parsing", () => {
    it("rejects a body over 64 KB with 413 before any credential is checked", async () => {
      const { fx, app, source } = await seedSource();
      const big = JSON.stringify({ ...wireEvent(), summary: "x".repeat(70 * 1024) });
      const res = await request(app).post(ingestPath(source.publicId)).set("Content-Type", "application/json").send(big);
      expect(res.status).toBe(413);
      expect(res.body.details?.code ?? res.body.code).toBe("event_body_too_large");
      expect(await db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id))).toEqual([]);
      expect(fx.wakeups).toHaveLength(0);
    });

    it("accepts a body just under 64 KB through the real parser", async () => {
      const { app, source, secret } = await seedSource();
      const compact = JSON.stringify(wireEvent());
      const raw = Buffer.from(compact + " ".repeat(64 * 1024 - 64 - compact.length));
      expect(raw.length).toBeLessThan(64 * 1024);
      const { timestamp, signature } = sign(secret, raw);
      const res = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("X-Paperclip-Timestamp", timestamp)
        .set("X-Paperclip-Signature", signature)
        .send(raw.toString("utf8"));
      expect(res.status).toBe(202);
    });

    it.each([
      ["text/plain", "hello"],
      ["application/x-www-form-urlencoded", "a=b"],
    ])("rejects Content-Type %s with 415", async (contentType, payload) => {
      const { app, source, secret } = await seedSource();
      const res = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", contentType)
        .set("Authorization", `Bearer ${secret}`)
        .send(payload);
      expect(res.status).toBe(415);
    });

    it("rejects a content-encoded body with 415 instead of inflating it", async () => {
      const { app, source, secret } = await seedSource();
      const res = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "gzip")
        .set("Authorization", `Bearer ${secret}`)
        .send(gzipSync(Buffer.from(JSON.stringify(wireEvent()))));
      expect(res.status).toBe(415);
    });

    it.each([
      ["malformed JSON", "{not json"],
      ["a JSON array", "[1,2,3]"],
      ["a JSON scalar", "42"],
      ["a JSON null", "null"],
    ])("rejects %s with 400", async (_label, payload) => {
      const { app, source, secret } = await seedSource();
      const res = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${secret}`)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it("verifies the HMAC over the exact bytes sent, including non-canonical spacing", async () => {
      const { app, source, secret } = await seedSource();
      const raw = Buffer.from(`{ "schema" : "paperclip.event.v1",\n  "source":"gatus", "type":"uptime.down",\n "severity":"critical","state":"problem","dedupeKey":"spaced",\n "title":"Café 🚀 down" }`, "utf8");
      const { timestamp, signature } = sign(secret, raw);
      const res = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("X-Paperclip-Timestamp", timestamp)
        .set("X-Paperclip-Signature", signature)
        .send(raw.toString("utf8"));
      expect(res.status).toBe(202);
      expect(res.body.matched).toBe(1);
    });
  });

  describe("authentication through the real actor middleware", () => {
    it("lets a source bearer past actorMiddleware (not interpreted as an agent key)", async () => {
      const { app, source, secret } = await seedSource("bearer");
      const res = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${secret}`)
        .send(wireEvent({ dedupeKey: "bearer-through-middleware" }));
      expect(res.status).toBe(202);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("gives unknown sources, bad credentials and disabled sources a uniform error shape", async () => {
      const { fx, app, source, secret } = await seedSource("bearer");
      const unknown = await request(app)
        .post(ingestPath("0".repeat(24)))
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${secret}`)
        .send(wireEvent());
      const wrong = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer not-the-secret")
        .send(wireEvent());
      expect([401, 404]).toContain(unknown.status);
      expect(wrong.status).toBe(401);
      const ok = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${secret}`)
        .send(wireEvent({ dedupeKey: "before-disable" }));
      expect(ok.status).toBe(202);
      await fx.sources.update(source.id, { enabled: false }, { userId: "board-user" });
      const disabled = await request(app)
        .post(ingestPath(source.publicId))
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${secret}`)
        .send(wireEvent());
      expect(disabled.status).toBe(unknown.status);
      expect(disabled.body).toEqual(unknown.body);
    });

    it("does not bypass actor authentication for sibling paths", async () => {
      const { app, source, secret } = await seedSource();
      for (const path of [
        `/api/event-sources/public/${source.publicId}/events/extra`,
        `/api/event-sources/public/${source.publicId}/deliveries`,
      ]) {
        const res = await request(app).post(path).set("Authorization", `Bearer ${secret}`).send({});
        expect(res.status).toBe(401);
      }
    });
  });

  describe("board and agent permissions", () => {
    it("lets a board member create a source and shows the secret exactly once", async () => {
      const fx = await seedEventFixture(db);
      const app = boardApp(fx, () => boardActor(fx.companyId));
      const created = await request(app)
        .post(`/api/companies/${fx.companyId}/event-sources`)
        .send({ name: "Gatus prod", signingMode: "hmac_sha256" });
      expect(created.status).toBe(201);
      const secret = created.body.secretMaterial.secret as string;
      expect(secret).toEqual(expect.any(String));
      expect(created.body.secretMaterial.ingressUrl).toContain(created.body.source.publicId);

      const fetched = await request(app).get(`/api/event-sources/${created.body.source.id}`);
      expect(fetched.status).toBe(200);
      const listed = await request(app).get(`/api/companies/${fx.companyId}/event-sources`);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(fetched.body)).not.toContain(secret);
      expect(JSON.stringify(listed.body)).not.toContain(secret);
      expect(fetched.body.secretMaterial).toBeUndefined();

      const rotated = await request(app).post(`/api/event-sources/${created.body.source.id}/rotate-secret`).send({});
      expect(rotated.status).toBe(200);
      expect(rotated.body.secretMaterial.secret).not.toBe(secret);
      const afterRotate = await request(app).get(`/api/event-sources/${created.body.source.id}`);
      expect(JSON.stringify(afterRotate.body)).not.toContain(rotated.body.secretMaterial.secret);
    });

    it("lets agents read sources but not create, edit, rotate or archive them", async () => {
      const fx = await seedEventFixture(db);
      const agentId = await fx.createAgent();
      const { source } = await fx.createSource();
      const app = boardApp(fx, () => agentActor(fx.companyId, agentId));

      expect((await request(app).get(`/api/companies/${fx.companyId}/event-sources`)).status).toBe(200);
      const read = await request(app).get(`/api/event-sources/${source.id}`);
      expect(read.status).toBe(200);
      expect(read.body.secretMaterial).toBeUndefined();
      expect((await request(app).get(`/api/event-sources/${source.id}/deliveries`)).status).toBe(200);

      expect(
        (await request(app).post(`/api/companies/${fx.companyId}/event-sources`).send({ name: "Nope", signingMode: "hmac_sha256" }))
          .status,
      ).toBe(403);
      expect((await request(app).patch(`/api/event-sources/${source.id}`).send({ name: "Renamed" })).status).toBe(403);
      expect((await request(app).post(`/api/event-sources/${source.id}/rotate-secret`).send({})).status).toBe(403);
      expect((await request(app).delete(`/api/event-sources/${source.id}`)).status).toBe(403);
      expect((await fx.sources.get(source.id)).name).toBe("Gatus");
      expect((await fx.sources.get(source.id)).archived).toBe(false);
    });

    it("keeps companies isolated for lists, reads and writes", async () => {
      const a = await seedEventFixture(db);
      const b = await seedEventFixture(db);
      const { source } = await a.createSource();
      const appB = boardApp(b, () => boardActor(b.companyId));
      const agentB = await b.createAgent();
      const agentApp = boardApp(b, () => agentActor(b.companyId, agentB));

      for (const app of [appB, agentApp]) {
        expect((await request(app).get(`/api/companies/${a.companyId}/event-sources`)).status).toBe(403);
        const read = await request(app).get(`/api/event-sources/${source.id}`);
        expect(read.status).toBe(404);
        expect((await request(app).get(`/api/event-sources/${source.id}/deliveries`)).status).toBe(404);
      }
      expect((await request(appB).patch(`/api/event-sources/${source.id}`).send({ name: "Hijack" })).status).toBe(404);
      expect((await request(appB).post(`/api/event-sources/${source.id}/rotate-secret`).send({})).status).toBe(404);
      expect((await request(appB).delete(`/api/event-sources/${source.id}`)).status).toBe(404);
      expect(
        (await request(appB).post(`/api/companies/${a.companyId}/event-sources`).send({ name: "x", signingMode: "hmac_sha256" })).status,
      ).toBe(403);
      expect((await a.sources.get(source.id)).name).toBe("Gatus");
    });

    it("keeps viewers read-only", async () => {
      const fx = await seedEventFixture(db);
      const { source } = await fx.createSource();
      const app = boardApp(fx, () =>
        boardActor(fx.companyId, { memberships: [{ companyId: fx.companyId, membershipRole: "viewer", status: "active" }] }),
      );
      expect((await request(app).get(`/api/event-sources/${source.id}`)).status).toBe(200);
      expect((await request(app).patch(`/api/event-sources/${source.id}`).send({ name: "x" })).status).toBe(403);
      expect((await request(app).post(`/api/event-sources/${source.id}/rotate-secret`).send({})).status).toBe(403);
    });

    it("does not let an agent add an event trigger to another agent's routine", async () => {
      const fx = await seedEventFixture(db);
      const owner = await fx.createAgent("Owner");
      const intruder = await fx.createAgent("Intruder");
      const routine = await fx.createRoutine({ assigneeAgentId: owner });
      const { source } = await fx.createSource();

      const intruderApp = boardApp(fx, () => agentActor(fx.companyId, intruder));
      const denied = await request(intruderApp)
        .post(`/api/routines/${routine.id}/triggers`)
        .send({ kind: "event", eventSourceId: source.id });
      expect(denied.status).toBe(403);
      expect((await fx.routinesSvc.getDetail(routine.id))?.triggers.filter((t) => t.kind === "event")).toHaveLength(0);

      const ownerApp = boardApp(fx, () => agentActor(fx.companyId, owner));
      const allowed = await request(ownerApp)
        .post(`/api/routines/${routine.id}/triggers`)
        .send({ kind: "event", eventSourceId: source.id });
      expect(allowed.status).toBe(201);
      expect(allowed.body.trigger.kind).toBe("event");
    });

    it("exposes event groups of a routine to the company only", async () => {
      const fx = await seedEventFixture(db);
      const other = await seedEventFixture(db);
      const agentId = await fx.createAgent();
      const routine = await fx.createRoutine({ assigneeAgentId: agentId });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(routine.id, source.id);
      await fx.send(source, secret, wireEvent());

      const app = boardApp(fx, () => boardActor(fx.companyId));
      const groups = await request(app).get(`/api/routines/${routine.id}/event-groups`);
      expect(groups.status).toBe(200);
      expect(groups.body).toHaveLength(1);

      const otherApp = boardApp(other, () => boardActor(other.companyId));
      expect((await request(otherApp).get(`/api/routines/${routine.id}/event-groups`)).status).toBe(404);
    });

    it("tests a payload without writing anything", async () => {
      const fx = await seedEventFixture(db);
      const agentId = await fx.createAgent();
      const routine = await fx.createRoutine({ assigneeAgentId: agentId });
      const { source } = await fx.createSource();
      await fx.subscribe(routine.id, source.id);
      const app = boardApp(fx, () => boardActor(fx.companyId));
      const res = await request(app).post(`/api/event-sources/${source.id}/test`).send({ payload: wireEvent() });
      expect(res.status).toBe(200);
      expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      expect(fx.wakeups).toHaveLength(0);
    });
  });
});
