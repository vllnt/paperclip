import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  decodeCompanyArchiveCursor,
  type CompanyArchiveRecord,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { companyArchiveRoutes } from "../routes/company-archive.js";
import { companyArchiveExportService, type CompanyArchiveExportOptions } from "../services/company-archive-export.js";
import { createDurableRunLogStore } from "../services/run-log-store.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REGISTERED_SECRET = "registered-secret-canary-7f3a";
const PAYLOAD_SECRET = "payload-api-key-canary-91c2";
const FOREIGN_CANARY = "foreign-company-canary-55d0";
// Written by "direct writers" that skip write-time redaction.
const BEARER_CANARY = "bearer-canary-0f9e8d7c6b5a4932";

describeEmbeddedPostgres("company archive export", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-company-archive-export-${randomUUID()}`);
  const logBase = path.join(tmpDir, "run-logs");
  const runLogStore = createDurableRunLogStore({ basePath: logBase });

  beforeAll(async () => {
    mkdirSync(logBase, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("company-archive-export");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany(label: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Archive ${label}`,
      issuePrefix: `A${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Archivist ${label}`,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function seedRun(
    fixture: { companyId: string; agentId: string },
    input: { status?: string; finishedAt: string | null; createdAt?: string; logLines?: string[] },
  ) {
    const id = randomUUID();
    let logRef: string | null = null;
    if (input.logLines) {
      logRef = path.join(fixture.companyId, fixture.agentId, `${id}.ndjson`);
      mkdirSync(path.join(logBase, fixture.companyId, fixture.agentId), { recursive: true });
      writeFileSync(path.join(logBase, logRef), input.logLines.map((line) => `${line}\n`).join(""));
    }
    await db.insert(heartbeatRuns).values({
      id,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: input.status ?? "succeeded",
      contextSnapshot: {},
      logStore: input.logLines ? "local_file" : null,
      logRef,
      createdAt: sql`${input.createdAt ?? input.finishedAt ?? new Date().toISOString()}::timestamptz`,
      finishedAt: input.finishedAt ? sql`${input.finishedAt}::timestamptz` : null,
    });
    return id;
  }

  function minutesAgo(minutes: number) {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  async function collect(options: Partial<CompanyArchiveExportOptions> & { companyId: string }) {
    const exporter = companyArchiveExportService(db, { runLogStore });
    const records: CompanyArchiveRecord[] = [];
    for await (const record of exporter.stream({ cursor: null, limit: 50, ...options })) records.push(record);
    return records;
  }

  it("exports settled runs only, in settle-key order, without another company's data", async () => {
    const company = await seedCompany("main");
    const foreign = await seedCompany("foreign");
    const older = await seedRun(company, { finishedAt: minutesAgo(120) });
    const newer = await seedRun(company, { status: "failed", finishedAt: minutesAgo(30) });
    await seedRun(company, { status: "running", finishedAt: null, createdAt: minutesAgo(200) });
    await seedRun(company, { finishedAt: minutesAgo(1) });
    const foreignRun = await seedRun(foreign, { finishedAt: minutesAgo(60) });
    await db.insert(heartbeatRunEvents).values({
      companyId: foreign.companyId,
      runId: foreignRun,
      agentId: foreign.agentId,
      seq: 1,
      eventType: "lifecycle",
      message: FOREIGN_CANARY,
    });

    const until = new Date(Date.now() - 20 * 60_000);
    const records = await collect({ companyId: company.companyId, until });
    const kinds = records.map((record) => record.kind);
    expect(kinds[0]).toBe("export.header");
    expect(records[0]?.data).toMatchObject({ requestedUntil: until.toISOString(), until: until.toISOString() });
    expect(kinds.at(-1)).toBe("export.end");
    expect(records.filter((record) => record.kind === "run").map((record) => record.runId)).toEqual([older, newer]);
    expect(JSON.stringify(records)).not.toContain(FOREIGN_CANARY);
    expect(records.every((record) => record.companyId === company.companyId)).toBe(true);
    expect(records.at(-1)?.data).toMatchObject({ runs: 2, next: null });
  });

  it("applies the read-time redaction chain to runs, events, transcripts and activity", async () => {
    const company = await seedCompany("redaction");
    const runId = await seedRun(company, {
      finishedAt: minutesAgo(90),
      logLines: [
        JSON.stringify({ ts: "2026-10-09T10:00:00.000Z", stream: "stdout", chunk: `tool printed ${REGISTERED_SECRET} and café 漢字`, seq: 1 }),
        JSON.stringify({ ts: "2026-10-09T10:00:00.500Z", stream: "stderr", chunk: `curl -H "Authorization: Bearer ${BEARER_CANARY}"`, seq: 2 }),
        "{\"ts\":\"2026-10-09T10:00:01.000Z\",\"stream\":\"stdout\",\"chunk\":\"torn",
      ],
    });
    await createRunSecretRedactionRegistry(db).register(company.companyId, runId, REGISTERED_SECRET);
    await db.insert(heartbeatRunEvents).values([
      {
        companyId: company.companyId,
        runId,
        agentId: company.agentId,
        seq: 1,
        eventType: "adapter.invoke",
        message: `echo ${REGISTERED_SECRET}`,
        payload: { apiKey: PAYLOAD_SECRET, note: "kept" },
      },
      {
        companyId: company.companyId,
        runId,
        agentId: company.agentId,
        seq: 2,
        eventType: "lifecycle",
        message: `retry failed: Authorization: Bearer ${BEARER_CANARY}`,
        payload: null,
      },
    ]);
    await db.insert(costEvents).values({
      companyId: company.companyId,
      agentId: company.agentId,
      heartbeatRunId: runId,
      provider: "openai",
      model: "gpt-test",
      billingCode: `Bearer ${BEARER_CANARY}`,
      inputTokens: 10,
      outputTokens: 5,
      costCents: 1,
      occurredAt: new Date(),
    });
    await db.insert(activityLog).values({
      companyId: company.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      runId,
      details: { token: PAYLOAD_SECRET, summary: `mentions ${REGISTERED_SECRET}` },
    });

    const records = await collect({ companyId: company.companyId });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(REGISTERED_SECRET);
    expect(serialized).not.toContain(PAYLOAD_SECRET);
    expect(serialized).not.toContain(BEARER_CANARY);
    expect(serialized).not.toContain("paperclipSecretRedactions");
    expect(serialized).toContain(REDACTED_EVENT_VALUE);

    const event = records.find((record) => record.kind === "run_event");
    expect(event?.data).toMatchObject({ seq: 1, payload: { apiKey: REDACTED_EVENT_VALUE, note: "kept" } });
    const transcript = records.filter((record) => record.kind === "transcript");
    expect(transcript[0]?.data).toMatchObject({ line: 1, chunk: `tool printed ${REDACTED_EVENT_VALUE} and café 漢字` });
    expect(transcript[2]?.data).toMatchObject({ line: 3, raw: expect.stringContaining("torn") });
    expect(records.find((record) => record.kind === "cost_event")?.data).toMatchObject({ model: "gpt-test" });
    expect(records.find((record) => record.kind === "activity")?.data).toMatchObject({
      details: { token: REDACTED_EVENT_VALUE },
    });
    expect(records.find((record) => record.kind === "run.end")?.data).toMatchObject({
      counts: { run: 1, events: 2, transcript: 3, costs: 1, activity: 1 },
      marks: { eventMaxSeq: 2, costCount: 1, activityCount: 1, logBytes: null },
    });
  });

  it("pages by microsecond settle keys without skipping or repeating runs", async () => {
    const company = await seedCompany("keyset");
    const base = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 23);
    const ids = [
      await seedRun(company, { finishedAt: `${base}100Z` }),
      await seedRun(company, { finishedAt: `${base}900Z` }),
      await seedRun(company, { finishedAt: `${base}500Z` }),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const records = await collect({
        companyId: company.companyId,
        cursor: cursor ? decodeCompanyArchiveCursor(cursor) : null,
        limit: 1,
        include: ["run"],
      });
      seen.push(...records.filter((record) => record.kind === "run").map((record) => record.runId!));
      const end = records.at(-1)!.data as { next: string | null };
      if (!end.next) break;
      cursor = end.next;
    }
    expect(seen).toEqual([ids[0], ids[2], ids[1]]);
  });

  it("follows pages server-side when asked, with one header and one end", async () => {
    const company = await seedCompany("follow");
    const ids = [
      await seedRun(company, { finishedAt: minutesAgo(50) }),
      await seedRun(company, { finishedAt: minutesAgo(40) }),
      await seedRun(company, { finishedAt: minutesAgo(30) }),
    ];
    const records = await collect({ companyId: company.companyId, limit: 1, follow: true, include: ["run"] });
    expect(records.filter((record) => record.kind === "run").map((record) => record.runId)).toEqual(ids);
    expect(records.filter((record) => record.kind === "export.header")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "export.end")).toHaveLength(1);
    expect(records.at(-1)?.data).toMatchObject({ runs: 3, next: null });
  });

  it("advances the cursor past runs deleted while a page is exported", async () => {
    const company = await seedCompany("deleted");
    const first = await seedRun(company, { finishedAt: minutesAgo(50) });
    const second = await seedRun(company, { finishedAt: minutesAgo(40) });
    const exporter = companyArchiveExportService(db, { runLogStore });
    // The first page is queried before the header is yielded.
    const records = exporter.stream({ companyId: company.companyId, cursor: null, limit: 1, include: ["run"] });
    const header = await records.next();
    expect(header.value?.kind).toBe("export.header");
    await db.delete(heartbeatRuns).where(sql`${heartbeatRuns.id} = ${first}`);
    const rest: CompanyArchiveRecord[] = [];
    for await (const record of records) rest.push(record);
    expect(rest.map((record) => record.kind)).toEqual(["export.end"]);
    const next = (rest[0]?.data as { next: string | null }).next;
    // A page of deleted runs must not end the export early.
    expect(next).not.toBeNull();
    const page2 = await collect({ companyId: company.companyId, cursor: decodeCompanyArchiveCursor(next!), limit: 1, include: ["run"] });
    expect(page2.filter((record) => record.kind === "run").map((record) => record.runId)).toEqual([second]);
  });

  it("keeps exporting after a run whose log cannot be opened", async () => {
    const company = await seedCompany("bad-log");
    const broken = await seedRun(company, { finishedAt: minutesAgo(50) });
    await db.update(heartbeatRuns)
      .set({ logStore: "local_file", logRef: "../../outside.ndjson" })
      .where(sql`${heartbeatRuns.id} = ${broken}`);
    const healthy = await seedRun(company, { finishedAt: minutesAgo(40), logLines: [JSON.stringify({ stream: "stdout", chunk: "ok" })] });
    const records = await collect({ companyId: company.companyId, include: ["transcript"] });
    expect(records.filter((record) => record.kind === "run.omission")).toEqual([
      expect.objectContaining({ runId: broken, data: { reason: "transcript_unreadable", include: "transcript" } }),
    ]);
    expect(records.filter((record) => record.kind === "transcript").map((record) => record.runId)).toEqual([healthy]);
    expect(records.at(-1)?.kind).toBe("export.end");
  });

  it("marks a missing transcript as an omission instead of failing", async () => {
    const company = await seedCompany("omission");
    const runId = await seedRun(company, { finishedAt: minutesAgo(45), logLines: ["{}"] });
    rmSync(path.join(logBase, company.companyId, company.agentId, `${runId}.ndjson`));
    const records = await collect({ companyId: company.companyId, include: ["transcript"] });
    expect(records.find((record) => record.kind === "run.omission")?.data).toEqual({
      reason: "transcript_unavailable",
      include: "transcript",
    });
  });

  describe("route", () => {
    function createApp(actor: Express.Request["actor"]) {
      const app = express();
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      app.use("/api", companyArchiveRoutes(db));
      app.use(errorHandler);
      return app;
    }

    function board(companyId: string): Express.Request["actor"] {
      return {
        type: "board",
        source: "session",
        userId: "board-user-1",
        userName: null,
        userEmail: null,
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
    }

    it("streams NDJSON to a board member and audits the export", async () => {
      const company = await seedCompany("route");
      const runId = await seedRun(company, { finishedAt: minutesAgo(30) });
      const response = await request(createApp(board(company.companyId)))
        .get(`/api/companies/${company.companyId}/archive/export?include=run,events`)
        .expect(200);
      expect(response.headers["content-type"]).toContain("application/x-ndjson");
      const lines = response.text.trim().split("\n").map((line) => JSON.parse(line) as CompanyArchiveRecord);
      expect(lines.map((line) => line.kind)).toEqual(["export.header", "run", "run.end", "export.end"]);
      expect(lines[1]?.runId).toBe(runId);
      const audit = await db.select().from(activityLog);
      expect(audit).toEqual([expect.objectContaining({
        companyId: company.companyId,
        action: "company.data_exported",
        details: expect.objectContaining({ include: ["run", "events"], resumed: false }),
      })]);
    });

    it("refuses agents, other companies and malformed cursors", async () => {
      const company = await seedCompany("route-authz");
      const other = await seedCompany("route-other");
      await request(createApp({ type: "agent", source: "agent_key", agentId: company.agentId, companyId: company.companyId }))
        .get(`/api/companies/${company.companyId}/archive/export`)
        .expect(403);
      await request(createApp(board(company.companyId)))
        .get(`/api/companies/${other.companyId}/archive/export`)
        .expect(403);
      await request(createApp(board(company.companyId)))
        .get(`/api/companies/${company.companyId}/archive/export?cursor=bad`)
        .expect(400);
      // Calendar-invalid settle key: rejected before the stream starts.
      const invalidDate = Buffer.from(JSON.stringify({ v: 1, t: "2026-02-30T00:00:00.000000Z", id: company.agentId }))
        .toString("base64url");
      await request(createApp(board(company.companyId)))
        .get(`/api/companies/${company.companyId}/archive/export?cursor=${invalidDate}`)
        .expect(400);
      expect(await db.select().from(activityLog)).toEqual([]);
    });
  });
});
