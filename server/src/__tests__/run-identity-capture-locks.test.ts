import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { acceptSteeredIdentity, captureRunIdentity, initializeRunIdentity, reserveSteeredIdentity } from "../services/run-identity.js";

// captureRunIdentity runs for every agent API request that carries a run token (the auth middleware) and for every
// GitHub credential request. These tests pin that a capture with no identity waiting to be accepted waits for no lock
// and keeps no pooled connection while it waits, because a request that waits on a row lock held by someone else holds
// one of the few pooled connections of the whole API, and the requests behind it queue for a connection.

const support = await getEmbeddedPostgresTestSupport();
const sleep = (ms: number) => new Promise<"waited">(resolve => setTimeout(() => resolve("waited"), ms));

(support.supported ? describe : describe.skip)("capturing a run's identity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, small: ReturnType<typeof createDb>, holder: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-identity-locks-");
    db = createDb(database.connectionString);
    small = createDb(database.connectionString, { maxConnections: 2 });
    holder = createDb(database.connectionString, { maxConnections: 1 });
  }, 30_000);
  afterAll(async () => {
    await Promise.all([small?.$client.end({ timeout: 1 }), holder?.$client.end({ timeout: 1 })]);
    await database?.cleanup();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Shared", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Lock test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const context = await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "A", cause: "instruction" });
    return { companyId, agentId, runId, issueId, contextId: context.id };
  }

  /** Another transaction (a heartbeat writer) that holds the issue row and the run row, as the wake and finish paths do. */
  async function holdLocks(input: { companyId: string; issueId: string; runId: string }) {
    let release: () => void = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let locked: () => void = () => {};
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const transaction = holder.transaction(async tx => {
      await tx.execute(sql`select id from issues where id = ${input.issueId} and company_id = ${input.companyId} for update`);
      await tx.execute(sql`select id from heartbeat_runs where id = ${input.runId} and company_id = ${input.companyId} for update`);
      locked();
      await released;
    });
    await ready;
    return { release: async () => { release(); await transaction; } };
  }

  it("does not wait for a lock that another transaction holds on the run's task or on the run", async () => {
    const input = await seed();
    const held = await holdLocks(input);
    try {
      const outcome = await Promise.race([captureRunIdentity(db, input), sleep(2_000)]);

      expect(outcome).not.toBe("waited");
      expect((outcome as Awaited<ReturnType<typeof captureRunIdentity>>).context?.id).toBe(input.contextId);
    } finally { await held.release(); }
  }, 30_000);

  it("keeps no pooled connection while a lock is held, so other requests are not starved", async () => {
    const input = await seed();
    const held = await holdLocks(input);
    try {
      // Two captures: with a pool of two, they would hold both connections for as long as the lock is held.
      const captures = [captureRunIdentity(small, input), captureRunIdentity(small, input)];
      const unrelated = await Promise.race([small.execute(sql`select 1 as one`), sleep(2_000)]);

      expect(unrelated).not.toBe("waited");
      await Promise.all(captures);
    } finally { await held.release(); }
  }, 30_000);

  it("still serializes with a steered identity that waits to be accepted", async () => {
    const input = await seed();
    const message = randomUUID();
    await db.insert(issueComments).values({ id: message, companyId: input.companyId, issueId: input.issueId, authorUserId: "B", body: "Next instruction" });
    await reserveSteeredIdentity(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId, issueId: input.issueId, messageId: message } as never);

    await expect(captureRunIdentity(db, input)).rejects.toThrow(/Message acceptance is being reconciled/);
  }, 30_000);

  it("returns the identity that was accepted last", async () => {
    const input = await seed();
    const message = randomUUID();
    await db.insert(issueComments).values({ id: message, companyId: input.companyId, issueId: input.issueId, authorUserId: "B", body: "Next instruction" });
    const reserved = await reserveSteeredIdentity(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId, issueId: input.issueId, messageId: message } as never);
    await acceptSteeredIdentity(db, reserved!);

    const captured = await captureRunIdentity(db, input);

    expect(captured.context?.id).toBe(reserved!.id);
    expect(captured.context?.responsibleUserId).toBe("B");
    expect(captured.run.activeIdentityContextId).toBe(reserved!.id);
  }, 30_000);

  it("refuses a run that is not running, and a run of another agent", async () => {
    const input = await seed();
    const other = await seed();

    await expect(captureRunIdentity(db, { ...input, agentId: other.agentId })).rejects.toThrow(/active run/);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
    await expect(captureRunIdentity(db, input)).rejects.toThrow(/active run/);
  }, 30_000);

  it("fails closed for a run bound to a task id that is not a UUID, without taking a lock", async () => {
    const input = await seed();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: "not-a-uuid" } }).where(eq(heartbeatRuns.id, input.runId));
    const held = await holdLocks(input);
    try {
      const outcome = await Promise.race([captureRunIdentity(db, input).then(() => "captured", (error: unknown) => error), sleep(2_000)]);

      expect(outcome).toMatchObject({ status: 403, message: "Run task identity is invalid" });
    } finally { await held.release(); }
  }, 30_000);

  it("returns no context for a run that has none, as before", async () => {
    const input = await seed();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: null }).where(eq(heartbeatRuns.id, input.runId));

    const captured = await captureRunIdentity(db, input);

    expect(captured.context).toBeNull();
    expect(captured.run.id).toBe(input.runId);
  }, 30_000);
});
