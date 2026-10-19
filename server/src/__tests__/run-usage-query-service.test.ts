import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, projects, routines, runUsageRecords } from "@paperclipai/db";
import { runUsageQueryService } from "../services/run-usage-query.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-09T12:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describeEmbeddedPostgres.sequential("run usage query service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const service = () => runUsageQueryService(db);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-usage-query-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(runUsageRecords);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedRecord(
    companyId: string,
    agentId: string,
    values: Partial<typeof runUsageRecords.$inferInsert> = {},
  ): Promise<void> {
    const finishedAt = values.finishedAt ?? ago(HOUR);
    await db.insert(runUsageRecords).values({
      runId: randomUUID(),
      companyId,
      agentId,
      adapterType: "claude_local",
      runtimeMode: "cli",
      invocationSource: "timer",
      status: "succeeded",
      usageQuality: "measured",
      runCreatedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      day: finishedAt.toISOString().slice(0, 10),
      schemaVersion: 1,
      source: "derived",
      ...values,
    });
  }

  describe("usage", () => {
    it("groups by agent, sums token classes, keeps unreported classes null, and labels the agent", async () => {
      const companyId = await seedCompany();
      const busy = await seedAgent(companyId, "Busy");
      const quiet = await seedAgent(companyId, "Quiet");
      await seedRecord(companyId, busy, { inputTokens: 100, outputTokens: 40, costMicros: 500, durationMs: 1000 });
      await seedRecord(companyId, busy, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 7, costMicros: 250, durationMs: 3000 });
      await seedRecord(companyId, quiet, { inputTokens: 5, outputTokens: 1, usageQuality: "declared" });

      const result = await service().usage(companyId, { groupBy: "agent" }, NOW);

      expect(result.groupBy).toBe("agent");
      expect(result.rows.map((row) => row.label)).toEqual(["Busy", "Quiet"]);
      const [first, second] = result.rows;
      expect(first).toMatchObject({
        key: busy,
        runs: 2,
        inputTokens: 150,
        outputTokens: 50,
        cacheReadTokens: 7,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costMicros: 750,
        apiEquivalentMicros: null,
        durationMs: 4000,
        quality: { measured: 2, declared: 0, derived: 0, missing: 0 },
      });
      expect(second?.quality).toEqual({ measured: 0, declared: 1, derived: 0, missing: 0 });
      expect(result.totals).toMatchObject({ key: null, label: null, runs: 3, inputTokens: 155, outputTokens: 51 });
      expect(result.truncated).toBe(false);
    });

    it("uses the last 7 days by default and treats since as inclusive and until as exclusive", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "A");
      await seedRecord(companyId, agentId, { finishedAt: ago(8 * DAY), inputTokens: 1 });
      await seedRecord(companyId, agentId, { finishedAt: ago(6 * DAY), inputTokens: 10 });
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-05T00:00:00.000Z"), inputTokens: 100 });
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-06T00:00:00.000Z"), inputTokens: 1000 });

      const byDefault = await service().usage(companyId, { groupBy: "agent" }, NOW);
      expect(byDefault.totals.inputTokens).toBe(1110);
      expect(byDefault.until).toBe(NOW.toISOString());
      expect(byDefault.since).toBe(ago(7 * DAY).toISOString());

      const bounded = await service().usage(
        companyId,
        { groupBy: "agent", since: "2026-10-05", until: "2026-10-06" },
        NOW,
      );
      expect(bounded.totals.inputTokens).toBe(100);
      expect(bounded.since).toBe("2026-10-05T00:00:00.000Z");
      expect(bounded.until).toBe("2026-10-06T00:00:00.000Z");
    });

    it("groups by day and by hour in ascending order and does not cut them with the limit", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "A");
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-07T23:30:00.000Z"), inputTokens: 1 });
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-08T00:10:00.000Z"), inputTokens: 2 });
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-08T00:50:00.000Z"), inputTokens: 4 });

      const days = await service().usage(companyId, { groupBy: "day", limit: 1 }, NOW);
      expect(days.rows.map((row) => [row.key, row.inputTokens])).toEqual([
        ["2026-10-07", 1],
        ["2026-10-08", 6],
      ]);
      expect(days.truncated).toBe(false);

      const hours = await service().usage(companyId, { groupBy: "hour" }, NOW);
      expect(hours.rows.map((row) => [row.key, row.inputTokens])).toEqual([
        ["2026-10-07T23:00:00Z", 1],
        ["2026-10-08T00:00:00Z", 6],
      ]);
    });

    it("filters by agent, adapter, model and status, and keeps a no-routine group with a null key", async () => {
      const companyId = await seedCompany();
      const one = await seedAgent(companyId, "One");
      const two = await seedAgent(companyId, "Two");
      const routineId = randomUUID();
      await db.insert(routines).values({ id: routineId, companyId, title: "Nightly" });
      await seedRecord(companyId, one, { routineId, adapterType: "codex_local", model: "gpt-x", inputTokens: 3 });
      await seedRecord(companyId, one, { adapterType: "claude_local", model: "claude-y", status: "failed", inputTokens: 5 });
      await seedRecord(companyId, two, { adapterType: "claude_local", model: "claude-y", inputTokens: 7 });

      expect((await service().usage(companyId, { groupBy: "agent", agentId: two }, NOW)).totals.inputTokens).toBe(7);
      expect((await service().usage(companyId, { groupBy: "agent", adapterType: "codex_local" }, NOW)).totals.inputTokens).toBe(3);
      expect((await service().usage(companyId, { groupBy: "agent", model: "claude-y" }, NOW)).totals.runs).toBe(2);
      expect((await service().usage(companyId, { groupBy: "agent", status: "failed" }, NOW)).totals.inputTokens).toBe(5);

      const byRoutine = await service().usage(companyId, { groupBy: "routine" }, NOW);
      expect(byRoutine.rows.map((row) => [row.key, row.label])).toEqual([
        [null, null],
        [routineId, "Nightly"],
      ]);
    });

    it("returns the label as null for an agent that no longer exists", async () => {
      const companyId = await seedCompany();
      await seedRecord(companyId, randomUUID(), { inputTokens: 1 });

      const result = await service().usage(companyId, { groupBy: "agent" }, NOW);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.label).toBeNull();
    });

    it("never returns another company's records, in rows or in totals", async () => {
      const mine = await seedCompany();
      const theirs = await seedCompany();
      const myAgent = await seedAgent(mine, "Mine");
      const theirAgent = await seedAgent(theirs, "Theirs");
      await seedRecord(mine, myAgent, { inputTokens: 1 });
      await seedRecord(theirs, theirAgent, { inputTokens: 1000 });

      const result = await service().usage(mine, { groupBy: "agent" }, NOW);

      expect(result.rows.map((row) => row.key)).toEqual([myAgent]);
      expect(result.totals.inputTokens).toBe(1);
      const filtered = await service().usage(mine, { groupBy: "agent", agentId: theirAgent }, NOW);
      expect(filtered.rows).toEqual([]);
      expect(filtered.totals.runs).toBe(0);
    });

    it("cuts the rows at the limit, reports truncated, and keeps totals for the whole window", async () => {
      const companyId = await seedCompany();
      const a = await seedAgent(companyId, "A");
      const b = await seedAgent(companyId, "B");
      await seedRecord(companyId, a, { inputTokens: 10 });
      await seedRecord(companyId, b, { inputTokens: 20 });

      const result = await service().usage(companyId, { groupBy: "agent", limit: 1 }, NOW);

      expect(result.rows.map((row) => row.key)).toEqual([b]);
      expect(result.truncated).toBe(true);
      expect(result.totals.inputTokens).toBe(30);
    });

    it("returns zero runs and null sums for an empty window", async () => {
      const companyId = await seedCompany();

      const result = await service().usage(companyId, { groupBy: "model" }, NOW);

      expect(result.rows).toEqual([]);
      expect(result.totals).toMatchObject({ runs: 0, inputTokens: null, costMicros: null });
    });

    it("rejects a window that is empty, reversed, too long, or too long for hours", async () => {
      const companyId = await seedCompany();
      const call = (query: Parameters<ReturnType<typeof runUsageQueryService>["usage"]>[1]) =>
        service().usage(companyId, query, NOW);

      await expect(call({ groupBy: "agent", since: "2026-10-05", until: "2026-10-05" })).rejects.toMatchObject({ status: 400 });
      await expect(call({ groupBy: "agent", since: "2026-10-06", until: "2026-10-05" })).rejects.toMatchObject({ status: 400 });
      await expect(call({ groupBy: "agent", since: "2025-01-01" })).rejects.toMatchObject({ status: 400 });
      await expect(call({ groupBy: "hour", since: "2026-08-01" })).rejects.toMatchObject({ status: 400 });
      await expect(call({ groupBy: "day", since: "2025-10-10" })).resolves.toBeDefined();
    });
  });

  describe("failures", () => {
    it("groups failed runs by cause and leaves allRuns null", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "A");
      await seedRecord(companyId, agentId, { inputTokens: 100 });
      await seedRecord(companyId, agentId, { status: "failed", causeFamily: "timeout", inputTokens: 10, costMicros: 5 });
      await seedRecord(companyId, agentId, { status: "timed_out", causeFamily: "timeout", inputTokens: 20, costMicros: 7 });
      await seedRecord(companyId, agentId, { status: "failed", causeFamily: "provider_quota", inputTokens: 1 });

      const result = await service().failures(companyId, { groupBy: "cause" }, NOW);

      expect(result.rows.map((row) => [row.key, row.runs, row.allRuns, row.inputTokens, row.costMicros])).toEqual([
        ["timeout", 2, null, 30, 12],
        ["provider_quota", 1, null, 1, null],
      ]);
      expect(result.totals).toMatchObject({ runs: 3, allRuns: 4, inputTokens: 31 });
    });

    it("groups by agent with the count of all runs, so a rate can be computed, and counts only failed spend", async () => {
      const companyId = await seedCompany();
      const flaky = await seedAgent(companyId, "Flaky");
      const steady = await seedAgent(companyId, "Steady");
      await seedRecord(companyId, flaky, { inputTokens: 100 });
      await seedRecord(companyId, flaky, { status: "failed", causeFamily: "adapter_failure", inputTokens: 9 });
      await seedRecord(companyId, steady, { inputTokens: 100 });

      const result = await service().failures(companyId, { groupBy: "agent" }, NOW);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ key: flaky, label: "Flaky", runs: 1, allRuns: 2, inputTokens: 9 });
    });

    it("filters by cause and stays inside the company", async () => {
      const mine = await seedCompany();
      const theirs = await seedCompany();
      const myAgent = await seedAgent(mine, "Mine");
      const theirAgent = await seedAgent(theirs, "Theirs");
      await seedRecord(mine, myAgent, { status: "failed", causeFamily: "timeout" });
      await seedRecord(mine, myAgent, { status: "failed", causeFamily: "unknown" });
      await seedRecord(theirs, theirAgent, { status: "failed", causeFamily: "timeout" });

      const result = await service().failures(mine, { groupBy: "cause", cause: "timeout" }, NOW);

      expect(result.rows.map((row) => [row.key, row.runs])).toEqual([["timeout", 1]]);
    });

    it("groups by day", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "A");
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-08T01:00:00.000Z"), status: "failed", causeFamily: "timeout" });
      await seedRecord(companyId, agentId, { finishedAt: new Date("2026-10-08T01:00:00.000Z") });

      const result = await service().failures(companyId, { groupBy: "day" }, NOW);

      expect(result.rows.map((row) => [row.key, row.runs, row.allRuns])).toEqual([["2026-10-08", 1, 2]]);
    });
  });
});
