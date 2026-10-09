import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runTargetStatsService } from "../services/run-target-stats.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("run target stats", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-target-stats-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(
    companyId: string,
    agentId: string,
    input: {
      status: string; adapterType: string | null; model: string | null; source?: string; tier?: string;
      seconds?: number; ageHours?: number;
    },
  ) {
    const finishedAt = new Date(Date.now() - (input.ageHours ?? 1) * 3_600_000);
    const startedAt = new Date(finishedAt.getTime() - (input.seconds ?? 60) * 1000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId, agentId, invocationSource: "automation", status: input.status,
      startedAt, finishedAt: ["running", "queued"].includes(input.status) ? null : finishedAt,
      executedAdapterType: input.adapterType, executedModel: input.model, createdAt: startedAt,
      runnerProfileJson: input.source
        ? { adapterDispatch: { adapterType: input.adapterType, source: input.source, ...(input.tier ? { profile: { tier: input.tier, source: input.source } } : {}) } }
        : null,
    });
  }

  it("counts in-flight runs per provider pool and groups finished runs by source and tier", async () => {
    const [company] = await db.insert(companies).values({ name: "Stats", issuePrefix: `ST${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: `OT${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "A", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: other!.id, name: "B", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const agentId = agent!.id;

    await seedRun(companyId, agentId, { status: "running", adapterType: "claude_local", model: "claude-opus-5-5", source: "agent_default" });
    await seedRun(companyId, agentId, { status: "running", adapterType: "codex_local", model: "gpt-5.5", source: "fallback" });
    await seedRun(companyId, agentId, { status: "running", adapterType: "codex_local", model: "grok-4.7", source: "issue_profile", tier: "fast" });
    await seedRun(companyId, agentId, { status: "running", adapterType: "codex_local", model: "grok-4.7", source: "issue_profile", tier: "fast" });
    await seedRun(companyId, agentId, { status: "queued", adapterType: null, model: null });
    await seedRun(companyId, agentId, { status: "succeeded", adapterType: "codex_local", model: "grok-4.7", source: "issue_profile", tier: "fast", seconds: 30 });
    await seedRun(companyId, agentId, { status: "succeeded", adapterType: "codex_local", model: "grok-4.7", source: "issue_profile", tier: "fast", seconds: 90 });
    await seedRun(companyId, agentId, { status: "failed", adapterType: "codex_local", model: "grok-4.7", source: "issue_profile", tier: "fast", seconds: 10 });
    await seedRun(companyId, agentId, { status: "succeeded", adapterType: "claude_local", model: "claude-opus-5-5", source: "agent_default", seconds: 300 });
    await seedRun(companyId, agentId, { status: "succeeded", adapterType: "claude_local", model: "claude-opus-5-5", seconds: 120, ageHours: 48 });
    await seedRun(other!.id, otherAgent!.id, { status: "running", adapterType: "claude_local", model: "claude-opus-5-5", source: "agent_default" });

    const stats = await runTargetStatsService(db).report(companyId, { hours: 24 });

    expect(stats.inFlight).toEqual({
      total: 5,
      byPool: { anthropic: 1, openai: 1, xai: 2, unassigned: 1 },
    });
    const fast = stats.groups.find((group) => group.source === "issue_profile" && group.tier === "fast");
    expect(fast).toMatchObject({
      adapterType: "codex_local", model: "grok-4.7", pool: "xai", runs: 3, succeeded: 2, failed: 1, successRate: 2 / 3, avgDurationSeconds: 43,
    });
    expect(stats.groups.find((group) => group.source === "agent_default")).toMatchObject({ runs: 1, succeeded: 1, avgDurationSeconds: 300 });
    expect(stats.groups.some((group) => group.runs > 0 && group.source === "agent_default" && group.avgDurationSeconds === 120)).toBe(false);
    expect(stats.windowHours).toBe(24);
  });
});
