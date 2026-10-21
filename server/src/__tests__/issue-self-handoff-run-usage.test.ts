import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());
const mockTerminateLocalService = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../services/local-service-supervisor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
    "../services/local-service-supervisor.js",
  );
  return { ...actual, terminateLocalService: mockTerminateLocalService };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping self-handoff run usage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const FINAL_USAGE = { inputTokens: 1_200, cachedInputTokens: 800, outputTokens: 300 };
const FINAL_COST_USD = 0.42;

/**
 * Models the Claude CLI: it writes its final result event, with usage and cost,
 * only when it is interrupted with SIGINT. SIGTERM ends it with no result.
 */
function claudeCliStoppedBy(signal: NodeJS.Signals | undefined) {
  if (signal === "SIGINT") {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "anthropic",
      biller: "anthropic",
      model: "claude-sonnet-5-5",
      billingType: "metered_api" as const,
      usage: FINAL_USAGE,
      usageBasis: "per_run" as const,
      costUsd: FINAL_COST_USD,
    };
  }
  return {
    exitCode: null,
    signal: "SIGTERM" as const,
    timedOut: false,
    errorMessage: "Claude was stopped before it wrote its final result.",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  };
}

describeEmbeddedPostgres("issue self-handoff run usage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-handoff-usage-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    vi.clearAllMocks();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReviewRun(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const issuePrefix = `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(authUsers).values({
      id: userId,
      name: "Board",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Review Company",
      issuePrefix,
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
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
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      runtimeMode: "legacy",
      wakeupRequestId,
      contextSnapshot: { issueId },
      nextEventSeq: 2,
      startedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review the change",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      createdByUserId: userId,
      responsibleUserId: userId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId, runId, userId };
  }

  /**
   * Starts the queued run on the mocked adapter and holds it open like a live
   * CLI. It ends only when the server stops its process, and the signal the
   * server sends decides what the CLI reports.
   */
  async function startRunUntilStopped(runId: string) {
    let signalSeen!: (signal: NodeJS.Signals | undefined) => void;
    const stopSignal = new Promise<NodeJS.Signals | undefined>((resolve) => {
      signalSeen = resolve;
    });
    let adapterStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      adapterStarted = resolve;
    });
    mockTerminateLocalService.mockImplementation(async (_target: unknown, opts?: { signal?: NodeJS.Signals }) => {
      signalSeen(opts?.signal);
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      runningProcesses.set(runId, {
        child: { pid: 424_242 } as ChildProcess,
        graceSec: 20,
        processGroupId: null,
      });
      adapterStarted();
      return claudeCliStoppedBy(await stopSignal);
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await started;
    return heartbeat;
  }

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    return app;
  }

  function agentActor(fixture: { companyId: string; agentId: string; runId: string }) {
    return {
      type: "agent",
      agentId: fixture.agentId,
      companyId: fixture.companyId,
      runId: fixture.runId,
      source: "agent_jwt",
    };
  }

  function boardActor(fixture: { companyId: string; userId: string }) {
    return {
      type: "board",
      userId: fixture.userId,
      companyIds: [fixture.companyId],
      memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  async function runCostEvents(runId: string) {
    return db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
  }

  it("records the usage and cost of a claude_local run whose own request hands the issue off", async () => {
    const fixture = await seedReviewRun("claude_local");
    const heartbeat = await startRunUntilStopped(fixture.runId);

    const handoff = await request(appFor(agentActor(fixture)))
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: fixture.userId,
        comment: "VERDICT correctness APPROVE",
      });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    await heartbeat.drainActiveRunExecutions();

    expect(mockTerminateLocalService).toHaveBeenCalledTimes(1);
    expect(mockTerminateLocalService).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 424_242 }),
      expect.objectContaining({ signal: "SIGINT" }),
    );
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(run?.usageJson).toMatchObject({
      inputTokens: FINAL_USAGE.inputTokens,
      outputTokens: FINAL_USAGE.outputTokens,
      costUsd: FINAL_COST_USD,
    });
    const costs = await runCostEvents(fixture.runId);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      agentId: fixture.agentId,
      issueId: fixture.issueId,
      inputTokens: FINAL_USAGE.inputTokens,
      outputTokens: FINAL_USAGE.outputTokens,
      costCents: 42,
    });
    const [handedOff] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(handedOff).toMatchObject({ status: "in_review", assigneeAgentId: null, assigneeUserId: fixture.userId });
  });

  it("still stops the run of an agent that is reassigned by someone else, as before", async () => {
    const fixture = await seedReviewRun("claude_local");
    const heartbeat = await startRunUntilStopped(fixture.runId);

    const reassigned = await request(appFor(boardActor(fixture)))
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ assigneeAgentId: null, assigneeUserId: fixture.userId });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
    await heartbeat.drainActiveRunExecutions();

    expect(mockTerminateLocalService).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 424_242 }),
      expect.objectContaining({ signal: undefined }),
    );
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(await runCostEvents(fixture.runId)).toHaveLength(0);
  });
});
