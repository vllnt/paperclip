import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222";
const TASK_KEY = "custom:session-checkpoint";
const WORKSPACE_CWD = "/workspace/session-checkpoint";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn<(ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>>(),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function sessionParams(sessionId: string) {
  return { sessionId, cwd: WORKSPACE_CWD, promptBundleKey: "bundle-1", mcpServerIdentity: "mcp-1" };
}

function succeeded(sessionId: string | null): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Session checkpoint test run.",
    provider: "test",
    model: "test-model",
    ...(sessionId
      ? { sessionId, sessionParams: sessionParams(sessionId), sessionDisplayId: sessionId }
      : {}),
  };
}

describeEmbeddedPostgres("early adapter session checkpoint", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-session-checkpoint-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    await Promise.all(runs.map(({ id }) => heartbeat.waitForRunExecutionDrain(id)));
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function wake(agentId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "custom_wake",
      payload: { taskKey: TASK_KEY },
      requestedByActorType: "system",
      contextSnapshot: { taskKey: TASK_KEY },
    });
    expect(run).not.toBeNull();
    return run!;
  }

  async function waitFor<T>(read: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  async function waitForFinished(runId: string) {
    await waitFor(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return run && run.status !== "queued" && run.status !== "running";
    }, "the run to finish");
    await heartbeat.waitForRunExecutionDrain(runId);
  }

  const readRun = (runId: string) =>
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  const readTaskSessions = () =>
    db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, TASK_KEY));

  it("stores the session on the run and on its task while the adapter is still running", async () => {
    const { agentId } = await seedAgent();
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockAdapterExecute.mockImplementation(async (ctx) => {
      await ctx.onSessionCheckpoint?.({ sessionParams: sessionParams(FIRST_SESSION), sessionDisplayId: FIRST_SESSION });
      await mayFinish;
      return succeeded(FIRST_SESSION);
    });

    const run = await wake(agentId);
    try {
      const [stored] = await waitFor(async () => {
        const rows = await readTaskSessions();
        return rows.length > 0 ? rows : null;
      }, "the early task session");

      const midRun = await readRun(run.id);
      expect(midRun.status).toBe("running");
      expect(midRun.sessionIdAfter).toBe(FIRST_SESSION);
      expect(stored).toMatchObject({
        agentId,
        adapterType: "claude_local",
        sessionDisplayId: FIRST_SESSION,
        lastRunId: run.id,
        lastError: null,
      });
      expect(stored!.sessionParamsJson).toMatchObject(sessionParams(FIRST_SESSION));
    } finally {
      release();
    }
    await waitForFinished(run.id);
    const finished = await readRun(run.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.sessionIdAfter).toBe(FIRST_SESSION);
    const sessions = await readTaskSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionDisplayId: FIRST_SESSION, lastRunId: run.id });
  });

  it("keeps the checkpoint when the run ends without a result", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementation(async (ctx) => {
      await ctx.onSessionCheckpoint?.({ sessionParams: sessionParams(FIRST_SESSION), sessionDisplayId: FIRST_SESSION });
      throw new Error("adapter process lost");
    });

    const run = await wake(agentId);
    await waitForFinished(run.id);

    const finished = await readRun(run.id);
    expect(finished.status).toBe("failed");
    expect(finished.sessionIdAfter).toBe(FIRST_SESSION);
    const sessions = await readTaskSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionDisplayId: FIRST_SESSION, lastRunId: run.id });
  });

  it("lets the final result replace the checkpoint", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementation(async (ctx) => {
      await ctx.onSessionCheckpoint?.({ sessionParams: sessionParams(FIRST_SESSION), sessionDisplayId: FIRST_SESSION });
      return succeeded(SECOND_SESSION);
    });

    const run = await wake(agentId);
    await waitForFinished(run.id);

    const finished = await readRun(run.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.sessionIdAfter).toBe(SECOND_SESSION);
    const sessions = await readTaskSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionDisplayId: SECOND_SESSION, lastRunId: run.id });
    expect(sessions[0]!.sessionParamsJson).toMatchObject(sessionParams(SECOND_SESSION));
  });

  it("restores the earlier task session when the final result names no session", async () => {
    const { agentId } = await seedAgent();
    // The first run finishes normally and leaves the earlier session.
    mockAdapterExecute.mockImplementationOnce(async () => succeeded(SECOND_SESSION));
    const earlier = await wake(agentId);
    await waitForFinished(earlier.id);
    expect((await readTaskSessions())[0]).toMatchObject({ sessionDisplayId: SECOND_SESSION });

    let duringRun: string | null = null;
    mockAdapterExecute.mockImplementationOnce(async (ctx) => {
      await ctx.onSessionCheckpoint?.({ sessionParams: sessionParams(FIRST_SESSION), sessionDisplayId: FIRST_SESSION });
      duringRun = (await readTaskSessions())[0]?.sessionDisplayId ?? null;
      return succeeded(null);
    });
    const run = await wake(agentId);
    await waitForFinished(run.id);

    // The checkpoint was stored during the run; the final write put back the state the run started with.
    expect(duringRun).toBe(FIRST_SESSION);
    const sessions = await readTaskSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionDisplayId: SECOND_SESSION, lastRunId: run.id });
    expect((await readRun(run.id)).sessionIdAfter).toBe(SECOND_SESSION);
  });

  it("ignores a checkpoint that arrives after the run finished", async () => {
    const { agentId } = await seedAgent();
    let lateCheckpoint: AdapterExecutionContext["onSessionCheckpoint"];
    mockAdapterExecute.mockImplementation(async (ctx) => {
      lateCheckpoint = ctx.onSessionCheckpoint;
      return succeeded(FIRST_SESSION);
    });

    const run = await wake(agentId);
    await waitForFinished(run.id);
    await lateCheckpoint?.({ sessionParams: sessionParams(SECOND_SESSION), sessionDisplayId: SECOND_SESSION });

    expect((await readRun(run.id)).sessionIdAfter).toBe(FIRST_SESSION);
    const sessions = await readTaskSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionDisplayId: FIRST_SESSION });
  });

  it("stores nothing for a checkpoint that names no session, and never throws", async () => {
    const { agentId } = await seedAgent();
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checkpointed = false;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      await ctx.onSessionCheckpoint?.({ sessionParams: {} });
      checkpointed = true;
      await mayFinish;
      return succeeded(null);
    });

    const run = await wake(agentId);
    try {
      await waitFor(async () => checkpointed, "the empty checkpoint");

      expect((await readRun(run.id)).sessionIdAfter).toBeNull();
      expect(await readTaskSessions()).toEqual([]);
    } finally {
      release();
    }
    await waitForFinished(run.id);
  });
});
