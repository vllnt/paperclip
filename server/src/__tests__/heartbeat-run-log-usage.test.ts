import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS } from "../services/recovery/service.js";
import { getRunLogStore } from "../services/run-log-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run log usage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MODEL = "claude-sonnet-5-5";

/** One stream-json line, the way the Claude CLI prints it. */
function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

function assistantEvent(messageId: string, usage: Record<string, number>) {
  return line({
    type: "assistant",
    session_id: "session-1",
    message: { id: messageId, model: MODEL, content: [{ type: "text", text: "working" }], usage },
  });
}

const initEvent = line({ type: "system", subtype: "init", session_id: "session-1", model: MODEL });

/** What a run streams before a stop cuts it: two assistant messages, the first one seen twice. */
const KILLED_RUN_STDOUT = [
  initEvent,
  assistantEvent("msg-1", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 5 }),
  assistantEvent("msg-1", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 40 }),
  assistantEvent("msg-2", { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_100, output_tokens: 60 }),
];

/** What a run streams when the CLI finished: the final result line carries the totals and the cost. */
const FINISHED_RUN_STDOUT = [
  initEvent,
  assistantEvent("msg-1", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 40 }),
  line({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    result: "done",
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, cache_read_input_tokens: 1_000, output_tokens: 40 },
    modelUsage: {
      [MODEL]: { inputTokens: 1_000, cacheCreationInputTokens: 200, cacheReadInputTokens: 5_000, outputTokens: 800 },
    },
  }),
];

describeEmbeddedPostgres("heartbeat run log usage recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logDir: string;

  beforeAll(async () => {
    // The run log store reads its base path once, when the first heartbeat service asks for it.
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-log-usage-logs-"));
    process.env.RUN_LOG_BASE_PATH = logDir;
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-log-usage-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(logDir, { recursive: true, force: true });
    delete process.env.RUN_LOG_BASE_PATH;
  });

  async function seedAgent(input: { adapterType?: string; billingType?: string; maxDailyCostCents?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Usage Agent",
      role: "engineer",
      status: "running",
      adapterType: input.adapterType ?? "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          ...(input.maxDailyCostCents !== undefined ? { maxDailyCostCents: input.maxDailyCostCents } : {}),
        },
      },
      permissions: {},
    });
    // An earlier run tells the server how this agent is billed: the log does not say.
    if (input.billingType) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: new Date(Date.now() - 3_600_000),
        finishedAt: new Date(Date.now() - 3_500_000),
        contextSnapshot: {},
        usageJson: {
          inputTokens: 1,
          outputTokens: 1,
          provider: "anthropic",
          biller: "anthropic",
          model: MODEL,
          billingType: input.billingType,
        },
      });
    }
    return { companyId, agentId };
  }

  /** A run that is `running`, holds its issue's execution lock, and has streamed `stdout` into its log. */
  async function seedRunningRun(
    agent: { companyId: string; agentId: string },
    input: { stdout: string[]; startedAgoMs?: number; sourceStatus?: "in_progress" | "done"; chunkSplit?: boolean },
  ) {
    const { companyId, agentId } = agent;
    const runId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const startedAt = new Date(Date.now() - (input.startedAgoMs ?? 60_000));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const sourceStatus = input.sourceStatus ?? "in_progress";

    const store = getRunLogStore();
    const handle = await store.begin({ companyId, agentId, runId });
    for (const text of input.stdout) {
      // A chunk is not a line: cut each line in two, so the reader has to join them.
      const cut = input.chunkSplit === false ? text.length : Math.floor(text.length / 2);
      for (const chunk of [text.slice(0, cut), text.slice(cut)]) {
        if (chunk) await store.append(handle, { stream: "stdout", chunk, ts: new Date().toISOString() });
      }
    }

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      logStore: handle.store,
      logRef: handle.logRef,
      nextEventSeq: 2,
      startedAt,
      processStartedAt: startedAt,
      updatedAt: startedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: { adapterType: "claude_local" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work that ends without an adapter result",
      status: sourceStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      completedAt: sourceStatus === "done" ? new Date(startedAt.getTime() + 10_000) : null,
    });
    if (sourceStatus === "done") {
      // The agent closed the issue from inside this run: the evidence that lets the watchdog fold it.
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { identifier: `${issuePrefix}-1`, status: "done", _previous: { status: "in_progress" } },
        createdAt: new Date(startedAt.getTime() + 10_000),
      });
    }
    return { ...agent, runId, issueId, startedAt };
  }

  async function readRun(runId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (!run) throw new Error(`Missing run ${runId}`);
    return run;
  }

  /** The cancel and the terminal-status hooks record in the background: wait for the write. */
  async function waitForUsage(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await readRun(runId);
      if (run.usageJson) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readRun(runId);
  }

  async function costEventsOf(runId: string) {
    return db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
  }

  describe("a restart that ends the run", () => {
    it("records the tokens the run streamed, marked partial, and one cost event", async () => {
      const seeded = await seedRunningRun(await seedAgent({ billingType: "subscription_included" }), {
        stdout: KILLED_RUN_STDOUT,
      });
      const heartbeat = heartbeatService(db);

      const drain = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date());

      expect(drain.interruptedRunIds).toEqual([seeded.runId]);
      const run = await readRun(seeded.runId);
      expect(run).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted" });
      // msg-1 counts once, at its last snapshot; cache-creation tokens are billed input.
      expect(run.usageJson).toMatchObject({
        inputTokens: 10 + 100 + 20,
        cachedInputTokens: 1_000 + 1_100,
        outputTokens: 40 + 60,
        usageSource: "run_log",
        partial: true,
        provider: "anthropic",
        biller: "anthropic",
        model: MODEL,
        billingType: "subscription_included",
        costStatus: "unpriced",
      });
      const events = await costEventsOf(seeded.runId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        agentId: seeded.agentId,
        issueId: seeded.issueId,
        inputTokens: 130,
        cachedInputTokens: 2_100,
        outputTokens: 100,
        costCents: 0,
        costStatus: "unpriced",
        billingType: "subscription_included",
      });

      // A second drain (the next start repeats a cut one) finds nothing to add.
      await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date());
      expect(await costEventsOf(seeded.runId)).toHaveLength(1);
    });
  });

  describe("a stop that cancels the run", () => {
    it("records the tokens the run streamed, marked partial, and one cost event", async () => {
      const seeded = await seedRunningRun(await seedAgent({ billingType: "subscription_included" }), {
        stdout: KILLED_RUN_STDOUT,
      });
      const heartbeat = heartbeatService(db);

      const cancelled = await heartbeat.cancelRun(seeded.runId, "Stopped by the board");

      expect(cancelled?.status).toBe("cancelled");
      const run = await waitForUsage(seeded.runId);
      expect(run.status).toBe("cancelled");
      expect(run.usageJson).toMatchObject({
        inputTokens: 130,
        cachedInputTokens: 2_100,
        outputTokens: 100,
        usageSource: "run_log",
        partial: true,
      });
      expect(await costEventsOf(seeded.runId)).toHaveLength(1);
    });
  });

  describe("the source-resolved watchdog fold", () => {
    it("records the exact usage and cost of a run that finished before the fold, and the daily cost cap counts it", async () => {
      const agent = await seedAgent({ billingType: "metered_api", maxDailyCostCents: 40 });
      const seeded = await seedRunningRun(agent, {
        stdout: FINISHED_RUN_STDOUT,
        sourceStatus: "done",
        startedAgoMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      });
      const heartbeat = heartbeatService(db);

      const scan = await heartbeat.scanSilentActiveRuns({ now: new Date(), companyId: seeded.companyId });

      expect(scan.folded).toBe(1);
      const run = await readRun(seeded.runId);
      expect(run.status).toBe("succeeded");
      expect(run.usageJson).toMatchObject({
        // The final result line wins: modelUsage totals, cache-creation tokens counted as input.
        inputTokens: 1_200,
        cachedInputTokens: 5_000,
        outputTokens: 800,
        costUsd: 0.42,
        usageSource: "run_log",
        partial: false,
        billingType: "metered_api",
        costStatus: "reported",
      });
      const events = await costEventsOf(seeded.runId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ costCents: 42, costStatus: "reported", billingType: "metered_api" });

      // 42 cents of a 40 cent daily cap: the next on-demand wake is held back.
      const wake = await heartbeat.wakeup(seeded.agentId, { source: "on_demand", triggerDetail: "manual" });
      expect(wake).toBeNull();
      const [wakeup] = await db
        .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, seeded.agentId), eq(agentWakeupRequests.status, "skipped")));
      expect(wakeup).toMatchObject({ status: "skipped", reason: "heartbeat.daily_cost_limit" });
    });
  });

  describe("runs that have nothing to record", () => {
    it("keeps the usage a run already holds", async () => {
      const seeded = await seedRunningRun(await seedAgent({ billingType: "subscription_included" }), {
        stdout: KILLED_RUN_STDOUT,
      });
      await db
        .update(heartbeatRuns)
        .set({ usageJson: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 } })
        .where(eq(heartbeatRuns.id, seeded.runId));

      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date());

      expect((await readRun(seeded.runId)).usageJson).toEqual({ inputTokens: 7, outputTokens: 3, costUsd: 0.01 });
      expect(await costEventsOf(seeded.runId)).toHaveLength(0);
    });

    it("records nothing for an adapter that does not stream usage in a form the server can read", async () => {
      const seeded = await seedRunningRun(await seedAgent({ adapterType: "process" }), { stdout: KILLED_RUN_STDOUT });

      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date());

      expect((await readRun(seeded.runId)).usageJson).toBeNull();
      expect(await costEventsOf(seeded.runId)).toHaveLength(0);
    });

    it("records nothing for a run whose log holds no usage", async () => {
      const seeded = await seedRunningRun(await seedAgent(), { stdout: [initEvent] });

      await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date());

      expect((await readRun(seeded.runId)).usageJson).toBeNull();
      expect(await costEventsOf(seeded.runId)).toHaveLength(0);
    });
  });
});
