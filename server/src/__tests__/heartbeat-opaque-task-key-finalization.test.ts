import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const SUCCESS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Opaque task key finalization test run.",
  provider: "test",
  model: "test-model",
};

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({ ...SUCCESS })));

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

describeEmbeddedPostgres("run finalization with non-issue task keys", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-opaque-task-key-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    await Promise.all(runs.map(({ id }) => heartbeat.waitForRunExecutionDrain(id)));
    mockAdapterExecute.mockClear();
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
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function waitForFinished(runId: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run && run.status !== "queued" && run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await heartbeat.waitForRunExecutionDrain(runId);
  }

  async function expectFinalized(agentId: string, taskKey: string, run: { id: string }) {
    await waitForFinished(run.id);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(finished?.status).toBe("succeeded");
    // finalizeAgentStatus runs after the task-session cleanup that used to throw 22P02.
    const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
    const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, taskKey));
    expect(sessions).toEqual([]);
  }

  it("finalizes a timer run keyed __heartbeat__ and clears its stale task session", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(agentTaskSessions).values({
      companyId, agentId, adapterType: "codex_local", taskKey: "__heartbeat__", sessionParamsJson: { sessionId: "stale" },
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: {},
      requestedByActorType: "system",
    });
    expect(run).not.toBeNull();
    await expectFinalized(agentId, "__heartbeat__", run!);
  });

  it("finalizes a run keyed by a custom opaque task key", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(agentTaskSessions).values({
      companyId, agentId, adapterType: "codex_local", taskKey: "custom:opaque-task", sessionParamsJson: { sessionId: "stale" },
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "custom_wake",
      payload: { taskKey: "custom:opaque-task" },
      requestedByActorType: "system",
      contextSnapshot: { taskKey: "custom:opaque-task" },
    });
    expect(run).not.toBeNull();
    await expectFinalized(agentId, "custom:opaque-task", run!);
  });
});
