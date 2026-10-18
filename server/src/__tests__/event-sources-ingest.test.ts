import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, eventDeliveries, issues, routineRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture, wireEvent } from "./helpers/event-source-fixture.js";
import {
  EVENT_AUTH_FAILURE_GLOBAL_PER_MINUTE,
  EVENT_AUTH_FAILURE_PER_IP_PER_MINUTE,
  EVENT_DELIVERY_LEASE_MS,
} from "../services/event-sources/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres event source ingest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("event source ingest: auth, idempotency and delivery claims", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-event-sources-ingest-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup(sourceInput: Parameters<Awaited<ReturnType<typeof seedEventFixture>>["createSource"]>[0] = {}) {
    const fx = await seedEventFixture(db);
    const agentId = await fx.createAgent();
    const routine = await fx.createRoutine({ assigneeAgentId: agentId });
    const { source, secret } = await fx.createSource(sourceInput);
    const trigger = await fx.subscribe(routine.id, source.id);
    return { fx, agentId, routine, source, secret, trigger };
  }

  async function deliveriesOf(sourceId: string) {
    return db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, sourceId));
  }

  describe("hmac signing", () => {
    it("accepts a correctly signed event and opens one issue", async () => {
      const { fx, source, secret, routine } = await setup();
      const result = await fx.send(source, secret, wireEvent());
      expect(result.status).toBe(202);
      expect(result.body).toMatchObject({ matched: 1 });
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("rejects a bad signature with 401 and no delivery row", async () => {
      const { fx, source, secret } = await setup();
      const result = await fx.send(source, secret, wireEvent(), { secretOverride: "not-the-secret" });
      expect(result.status).toBe(401);
      expect((await deliveriesOf(source.id)).filter((row) => row.status !== "rejected_aggregate")).toHaveLength(0);
    });

    it("rejects a stale timestamp", async () => {
      const { fx, source, secret } = await setup();
      const stale = String(Math.floor(fx.clock.ms / 1000) - 3600);
      const result = await fx.send(source, secret, wireEvent(), { timestamp: stale });
      expect(result.status).toBe(401);
    });

    it("rejects a body that was changed after signing", async () => {
      const { fx, source, secret } = await setup();
      const signed = fx.request(source, secret, wireEvent({ title: "original" }));
      const result = await fx.sources.ingest({ ...signed, body: wireEvent({ title: "tampered" }), rawBody: Buffer.from(JSON.stringify(wireEvent({ title: "tampered" }))) });
      expect(result.status).toBe(401);
    });

    it("treats a replay of the same signed request as a duplicate and creates nothing new", async () => {
      const { fx, source, secret, routine } = await setup();
      const body = wireEvent();
      const first = await fx.send(source, secret, body);
      const replay = await fx.send(source, secret, body);
      expect(first.status).toBe(202);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ duplicate: true });
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("treats a replay that differs only by the sha256= prefix as the same delivery", async () => {
      const { fx, source, secret, routine } = await setup();
      const body = wireEvent();
      const first = await fx.send(source, secret, body);
      const replay = await fx.send(source, secret, body, { signaturePrefix: "sha256=" });
      expect(first.status).toBe(202);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ duplicate: true });
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
      expect((await deliveriesOf(source.id)).filter((row) => row.status !== "rejected_aggregate")).toHaveLength(1);
    });

    it("answers a disabled, archived or unknown source exactly like a bad secret", async () => {
      const { fx, source, secret } = await setup();
      await fx.sources.update(source.id, { enabled: false }, { userId: "board-user" });
      const disabled = await fx.send(source, secret, wireEvent());
      const unknown = await fx.send({ publicId: "doesnotexist" }, secret, wireEvent());
      expect(disabled.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(disabled.body).toEqual(unknown.body);
    });

    it("stops accepting the old secret immediately after a rotation", async () => {
      const { fx, source, secret } = await setup();
      const rotated = await fx.sources.rotateSecret(source.id, { userId: "board-user" });
      expect((await fx.send(source, secret, wireEvent({ eventId: "a" }))).status).toBe(401);
      expect((await fx.send(source, rotated.secretMaterial.secret, wireEvent({ eventId: "a" }))).status).toBe(202);
    });
  });

  describe("bearer signing", () => {
    it("is idempotent when the event carries an eventId", async () => {
      const { fx, source, secret, routine } = await setup({ signingMode: "bearer" });
      const body = wireEvent({ eventId: "evt-1" });
      const first = await fx.send(source, secret, body);
      const second = await fx.send(source, secret, body);
      expect(first.status).toBe(202);
      expect(second).toMatchObject({ status: 200, body: { duplicate: true } });
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("has no idempotency key without an eventId, so grouping absorbs the repeat", async () => {
      const { fx, source, secret, routine } = await setup({ signingMode: "bearer" });
      const first = await fx.send(source, secret, wireEvent());
      const second = await fx.send(source, secret, wireEvent());
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const deliveries = (await deliveriesOf(source.id)).filter((row) => row.status !== "rejected_aggregate");
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((row) => row.deliveryKeyHash === null)).toBe(true);
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
      expect(deliveries.map((row) => row.status).sort()).toEqual(["dispatched", "grouped_silent"]);
    });

    it("rejects a wrong bearer token", async () => {
      const { fx, source } = await setup({ signingMode: "bearer" });
      const result = await fx.send(source, "x", wireEvent(), { bearer: "Bearer wrong" });
      expect(result.status).toBe(401);
    });
  });

  describe("validation", () => {
    it("returns 422 for an authenticated but invalid event and records an invalid delivery", async () => {
      const { fx, source, secret } = await setup();
      const result = await fx.send(source, secret, wireEvent({ severity: "apocalyptic" }));
      expect(result.status).toBe(422);
      expect(result.body.details).toEqual(expect.arrayContaining([expect.stringContaining("severity")]));
      const rows = await deliveriesOf(source.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "invalid", httpStatus: 422 });
    });

    it("does not leak whether a source exists to an invalid event with a bad signature", async () => {
      const { fx, source, secret } = await setup();
      const result = await fx.send(source, secret, wireEvent({ severity: "apocalyptic" }), { secretOverride: "nope" });
      expect(result.status).toBe(401);
    });
  });

  describe("rate limits", () => {
    it("returns 429 with Retry-After for an authenticated sender over its per-source limit", async () => {
      const { fx, source, secret } = await setup({ rateLimitPerMinute: 2 });
      expect((await fx.send(source, secret, wireEvent({ eventId: "1" }))).status).toBe(202);
      expect((await fx.send(source, secret, wireEvent({ eventId: "2" }))).status).toBe(202);
      const limited = await fx.send(source, secret, wireEvent({ eventId: "3" }));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThanOrEqual(1);
    });

    it("returns 429 once one IP exceeds the auth-failure budget", async () => {
      const { fx, source, secret } = await setup();
      let last = 0;
      for (let i = 0; i < EVENT_AUTH_FAILURE_PER_IP_PER_MINUTE + 1; i += 1) {
        last = (await fx.send(source, secret, wireEvent(), { secretOverride: "bad", ip: "198.51.100.9" })).status;
      }
      expect(last).toBe(429);
    });

    it("never limits an authenticated sender behind the same IP as a flood of bad-auth requests", async () => {
      const { fx, source, secret, routine } = await setup();
      const sharedIp = "198.51.100.9";
      for (let i = 0; i < EVENT_AUTH_FAILURE_PER_IP_PER_MINUTE * 2; i += 1) {
        await fx.send(source, secret, wireEvent(), { secretOverride: "bad", ip: sharedIp });
      }
      const flooded = await fx.send(source, secret, wireEvent({ eventId: "after-flood" }), { secretOverride: "bad", ip: sharedIp });
      expect(flooded.status).toBe(429);
      const legit = await fx.send(source, secret, wireEvent({ eventId: "legit" }), { ip: sharedIp });
      expect(legit.status).toBe(202);
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("does not let an unauthenticated flood from many IPs starve an authenticated sender", async () => {
      const { fx, source, secret } = await setup();
      for (let i = 0; i < EVENT_AUTH_FAILURE_GLOBAL_PER_MINUTE + 50; i += 1) {
        await fx.send(source, secret, wireEvent(), { secretOverride: "bad", ip: `10.${Math.floor(i / 250)}.${i % 250}.1` });
      }
      const flood = await fx.send(source, secret, wireEvent(), { secretOverride: "bad", ip: "203.0.113.200" });
      expect(flood.status).toBe(429);
      const legit = await fx.send(source, secret, wireEvent({ eventId: "legit-1" }), { ip: "203.0.113.201" });
      expect(legit.status).toBe(202);
    });

    it("charges unknown-source requests to the same failure budget", async () => {
      const { fx } = await setup();
      let status = 0;
      for (let i = 0; i < EVENT_AUTH_FAILURE_PER_IP_PER_MINUTE + 1; i += 1) {
        status = (await fx.sources.ingest({
          publicId: "ghost",
          ip: "198.51.100.77",
          authorizationHeader: "Bearer x",
          signatureHeader: undefined,
          timestampHeader: undefined,
          rawBody: Buffer.from("{}"),
          body: {},
        })).status;
      }
      expect(status).toBe(429);
    });
  });

  describe("delivery claim, lease and fencing", () => {
    it("answers 409 inProgress for a retry while the delivery is processing inside its lease", async () => {
      const { fx, source, secret } = await setup();
      const body = wireEvent({ eventId: "slow-1" });
      const first = await fx.send(source, secret, body);
      expect(first.status).toBe(202);
      const [row] = await deliveriesOf(source.id);
      await db.update(eventDeliveries).set({ status: "processing", claimedAt: new Date(fx.clock.ms) }).where(eq(eventDeliveries.id, row!.id));
      fx.advance(30_000);
      const retry = await fx.send(source, secret, body);
      expect(retry.status).toBe(409);
      expect(retry.body).toEqual({ inProgress: true });
      expect(retry.headers?.["Retry-After"]).toBe("30");
    });

    it("re-claims a delivery stuck in processing after its lease expired (simulated crash)", async () => {
      const { fx, source, secret, routine } = await setup();
      const body = wireEvent({ eventId: "crash-1" });
      // Simulate a worker that claimed the delivery and died before dispatching.
      const [stuck] = await db.insert(eventDeliveries).values({
        companyId: fx.companyId,
        sourceId: source.id,
        deliveryKeyHash: createHash("sha256").update(`${source.id}:gatus:crash-1`).digest("hex"),
        status: "processing",
        claimedAt: new Date(fx.clock.ms),
        attempts: 1,
      }).returning();
      fx.advance(EVENT_DELIVERY_LEASE_MS + 1000);
      const retry = await fx.send(source, secret, body);
      expect(retry.status).toBe(202);
      const [row] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, stuck!.id));
      expect(row).toMatchObject({ status: "dispatched", attempts: 2 });
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("lets exactly one of two concurrent retries of a failed delivery re-claim it", async () => {
      const { fx, source, secret, routine } = await setup();
      const body = wireEvent({ eventId: "retry-race" });
      const key = createHash("sha256").update(`${source.id}:gatus:retry-race`).digest("hex");
      const [failed] = await db.insert(eventDeliveries).values({
        companyId: fx.companyId,
        sourceId: source.id,
        deliveryKeyHash: key,
        status: "failed",
        attempts: 1,
        error: "boom",
      }).returning();
      const results = await Promise.all([fx.send(source, secret, body), fx.send(source, secret, body)]);
      const statuses = results.map((r) => r.status).sort();
      // One wins the compare-and-set and dispatches; the other sees it in progress or already done.
      expect(statuses.filter((s) => s === 202)).toHaveLength(1);
      expect([200, 409]).toContain(statuses.find((s) => s !== 202));
      const [row] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, failed!.id));
      expect(row!.attempts).toBe(2);
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("lets a stale attempt neither overwrite the newer attempt's outcome nor claim success", async () => {
      const { fx, source, secret } = await setup();
      // Attempt 1 is claimed and then superseded by attempt 2 before it can write its result.
      const body = wireEvent({ eventId: "fenced" });
      const key = createHash("sha256").update(`${source.id}:gatus:fenced`).digest("hex");
      const [row] = await db.insert(eventDeliveries).values({
        companyId: fx.companyId,
        sourceId: source.id,
        deliveryKeyHash: key,
        status: "processing",
        claimedAt: new Date(fx.clock.ms),
        attempts: 1,
      }).returning();
      fx.advance(EVENT_DELIVERY_LEASE_MS + 1000);
      const newer = await fx.send(source, secret, body);
      expect(newer.status).toBe(202);
      const after = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, row!.id)).then((r) => r[0]!);
      expect(after.attempts).toBe(2);
      // The stale attempt (attempts = 1) tries to record a failure: the fenced UPDATE matches nothing.
      const stale = await db
        .update(eventDeliveries)
        .set({ status: "failed", error: "stale writer" })
        .where(and(eq(eventDeliveries.id, row!.id), eq(eventDeliveries.attempts, 1)))
        .returning();
      expect(stale).toHaveLength(0);
      const final = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, row!.id)).then((r) => r[0]!);
      expect(final.status).toBe("dispatched");
      expect(final.error).toBeNull();
    });

    it("never lets two deliveries with different event ids collide", async () => {
      const { fx, source, secret, routine } = await setup();
      const a = await fx.send(source, secret, wireEvent({ eventId: "a", dedupeKey: "k1" }));
      const b = await fx.send(source, secret, wireEvent({ eventId: "b", dedupeKey: "k2" }));
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(await fx.issuesFor(routine.id)).toHaveLength(2);
    });
  });

  describe("unrouted events", () => {
    it("records an unrouted delivery visibly when nothing matches", async () => {
      const fx = await seedEventFixture(db);
      const { source, secret } = await fx.createSource();
      const result = await fx.send(source, secret, wireEvent());
      expect(result.status).toBe(202);
      expect(result.body).toMatchObject({ matched: 0 });
      const page = await fx.sources.listDeliveries(source.id, { limit: 50 });
      expect(page.items.map((item) => item.status)).toEqual(["unrouted"]);
      expect(await db.select().from(routineRuns).where(eq(routineRuns.companyId, fx.companyId))).toHaveLength(0);
      expect(await db.select().from(issues).where(eq(issues.companyId, fx.companyId))).toHaveLength(0);
    });
  });
});
