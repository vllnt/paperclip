import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { QUEUED_RUN_PRIORITY_AGING_STEP_MS } from "../services/queued-run-claim-order.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: { runId: string }) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Queued-run priority order test run.",
    provider: "test",
    model: "test-model",
  })),
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-run priority order tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE = 60_000;

describeEmbeddedPostgres("heartbeat queued-run priority order", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-queued-run-priority-order-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Priority Order Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priority Order Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  // A queued run for a new issue assigned to the agent. The run's comment is
  // seeded up front so a finished run needs no follow-up.
  async function insertIssueRun(
    ids: { companyId: string; agentId: string },
    issue: {
      priority: string;
      status: "todo" | "in_progress";
      /** A routine's execution or step issue, as the routine's dispatch creates it. */
      origin?: { kind: "routine_execution" | "routine_step"; routineId: string };
    },
    createdAt: Date,
  ) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: ids.companyId,
      title: `${issue.priority} ${issue.status} issue`,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: ids.agentId,
      responsibleUserId: "responsible-user",
      ...(issue.origin ? { originKind: issue.origin.kind, originId: issue.origin.routineId } : {}),
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt,
    });
    await db.insert(issueComments).values({
      companyId: ids.companyId,
      issueId,
      authorAgentId: ids.agentId,
      authorType: "agent",
      createdByRunId: runId,
      body: "Done.",
    });
    return { runId, issueId };
  }

  async function insertRoutine(ids: { companyId: string; agentId: string }, slotPriority: "normal" | "first") {
    const [routine] = await db
      .insert(routines)
      .values({
        companyId: ids.companyId,
        title: "Hourly maintenance",
        assigneeAgentId: ids.agentId,
        responsibleUserId: "responsible-user",
        slotPriority,
      })
      .returning();
    return routine!.id;
  }

  // A manual wake with no issue, like a timer heartbeat or a routine run.
  async function insertNoIssueRun(ids: { companyId: string; agentId: string }, createdAt: Date) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      createdAt,
    });
    return { runId };
  }

  // Drains the agent's queue one run at a time and returns run ids in the order
  // the adapter executed them.
  async function drainStartOrder(runIds: string[]) {
    await heartbeat.resumeQueuedRuns();
    const deadline = Date.now() + 60_000;
    for (;;) {
      await heartbeat.drainActiveRunExecutions();
      const rows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, runIds));
      if (rows.every((row) => row.startedAt !== null && row.status !== "running")) {
        return mockAdapterExecute.mock.calls
          .map(([ctx]) => ctx.runId)
          .filter((runId) => runIds.includes(runId));
      }
      if (Date.now() > deadline) throw new Error(`queue did not drain: ${JSON.stringify(rows)}`);
      await heartbeat.resumeQueuedRuns();
    }
  }

  it("starts a critical issue run before ten earlier low-priority runs of in-progress issues", async () => {
    const ids = await insertAgent();
    const now = Date.now();
    const lowRuns = [];
    for (let i = 0; i < 10; i += 1) {
      lowRuns.push(await insertIssueRun(ids, { priority: "low", status: "in_progress" }, new Date(now - 10 * MINUTE + i * 1_000)));
    }
    const critical = await insertIssueRun(ids, { priority: "critical", status: "todo" }, new Date(now - MINUTE));

    const order = await drainStartOrder([...lowRuns.map((run) => run.runId), critical.runId]);
    const position = order.indexOf(critical.runId) + 1;
    console.log(`QUEUE_POSITION critical=${position} of ${order.length}`);

    expect(position).toBe(1);
    // The low runs keep their age order behind it.
    expect(order.slice(1)).toEqual(lowRuns.map((run) => run.runId));
  }, 90_000);

  it("reads the issue's current priority, not the one it had when the run was queued", async () => {
    const ids = await insertAgent();
    const now = Date.now();
    const first = await insertIssueRun(ids, { priority: "high", status: "todo" }, new Date(now - 5 * MINUTE));
    const second = await insertIssueRun(ids, { priority: "low", status: "todo" }, new Date(now - 4 * MINUTE));
    await db.update(issues).set({ priority: "critical" }).where(eq(issues.id, second.issueId));

    expect(await drainStartOrder([first.runId, second.runId])).toEqual([second.runId, first.runId]);
  }, 90_000);

  it("starts a low run that waited three aging steps before a fresh critical run", async () => {
    const ids = await insertAgent();
    const now = Date.now();
    const aged = await insertIssueRun(
      ids,
      { priority: "low", status: "todo" },
      new Date(now - 3 * QUEUED_RUN_PRIORITY_AGING_STEP_MS - MINUTE),
    );
    const fresh = await insertIssueRun(ids, { priority: "critical", status: "todo" }, new Date(now - MINUTE));

    expect(await drainStartOrder([aged.runId, fresh.runId])).toEqual([aged.runId, fresh.runId]);
  }, 90_000);

  it("places a run without an issue between high and low issue runs", async () => {
    const ids = await insertAgent();
    const now = Date.now();
    const noIssue = await insertNoIssueRun(ids, new Date(now - 6 * MINUTE));
    const low = await insertIssueRun(ids, { priority: "low", status: "in_progress" }, new Date(now - 5 * MINUTE));
    const high = await insertIssueRun(ids, { priority: "high", status: "todo" }, new Date(now - 4 * MINUTE));

    expect(await drainStartOrder([noIssue.runId, low.runId, high.runId])).toEqual([
      high.runId,
      noIssue.runId,
      low.runId,
    ]);
  }, 90_000);

  describe("routine slot priority", () => {
    async function busyAgentWithRoutineTick(slotPriority: "normal" | "first") {
      const ids = await insertAgent();
      const routineId = await insertRoutine(ids, slotPriority);
      const now = Date.now();
      const agedHigh = await insertIssueRun(
        ids,
        { priority: "high", status: "todo" },
        new Date(now - 2 * QUEUED_RUN_PRIORITY_AGING_STEP_MS),
      );
      const inProgress = await insertIssueRun(ids, { priority: "medium", status: "in_progress" }, new Date(now - 10 * MINUTE));
      const tick = await insertIssueRun(
        ids,
        { priority: "medium", status: "todo", origin: { kind: "routine_execution", routineId } },
        new Date(now - MINUTE),
      );
      const step = await insertIssueRun(
        ids,
        { priority: "low", status: "todo", origin: { kind: "routine_step", routineId } },
        new Date(now - MINUTE / 2),
      );
      return { agedHigh, inProgress, tick, step };
    }

    it("starts a routine's runs at the next free slot when its slot priority is first", async () => {
      const { agedHigh, inProgress, tick, step } = await busyAgentWithRoutineTick("first");

      const order = await drainStartOrder([agedHigh.runId, inProgress.runId, tick.runId, step.runId]);

      expect(order).toEqual([tick.runId, step.runId, agedHigh.runId, inProgress.runId]);
    }, 90_000);

    it("keeps today's order for a routine at the default slot priority", async () => {
      const { agedHigh, inProgress, tick, step } = await busyAgentWithRoutineTick("normal");

      const order = await drainStartOrder([agedHigh.runId, inProgress.runId, tick.runId, step.runId]);

      expect(order).toEqual([agedHigh.runId, inProgress.runId, tick.runId, step.runId]);
    }, 90_000);
  });
});
