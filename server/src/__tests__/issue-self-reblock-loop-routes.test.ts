import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

/**
 * ANT-3260 through the real `PATCH /issues/:id` route: an agent re-blocks its
 * own issue on a blocker that is already done, with itself as the unblock
 * owner, from every run on that issue. The route then emits the unblock
 * request (awaited, while the run still holds the issue) and the restored
 * dependency wake (after the response). Nothing in these tests builds a wake
 * by hand: both come from the route.
 */

type MockRunContext = { runId: string; agent: { id: string; companyId: string }; context: Record<string, unknown> };
const mockAdapterExecute = vi.hoisted(() => vi.fn(async (_ctx: MockRunContext) => ({})));

/**
 * When enabled, the route's post-response dependency wake reaches admission
 * only after the run that sent the PATCH has finished. That is the production
 * race that escapes owner suppression (the run ends right after its last API
 * call), so the self-reblock limit alone must bound the loop.
 */
const dependencyWakeGate = vi.hoisted(() => ({
  enabled: false,
  runEnded: null as null | ((agentId: string) => Promise<void>),
}));

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

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const service = actual.heartbeatService(...args);
      return {
        ...service,
        wakeup: async (...wakeArgs: Parameters<typeof service.wakeup>) => {
          const [agentId, opts] = wakeArgs;
          if (
            dependencyWakeGate.enabled &&
            opts?.reason === "issue_blockers_resolved" &&
            (opts.payload as Record<string, unknown> | undefined)?.mutation === "blocked_dependency_restored"
          ) {
            await dependencyWakeGate.runEnded?.(agentId);
          }
          return service.wakeup(...wakeArgs);
        },
      };
    },
  };
});

const SUCCESS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Re-blocked the issue on its blocker.",
  provider: "test",
  model: "test-model",
};

/** A regression must stop here instead of looping forever. */
const CYCLE_BOUND = 8;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping self re-block loop route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("ANT-3260 self re-block loop through PATCH /issues/:id", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-reblock-loop-routes-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  beforeEach(() => {
    dependencyWakeGate.enabled = false;
    dependencyWakeGate.runEnded = async (agentId) => {
      // Wait for the agent's run that sent the PATCH, not for later runs.
      const running = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
      const runIds = new Set(running.map((run) => run.id));
      await waitForCondition(async () => {
        const rows = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        return rows.every((run) => !runIds.has(run.id) || (run.status !== "running" && run.status !== "queued"));
      });
    };
  });

  afterEach(async () => {
    dependencyWakeGate.enabled = false;
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const blockerId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Anthm",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "Jarvis",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker that is already done",
        status: "done",
        priority: "medium",
        responsibleUserId: "responsible-user",
      },
      {
        id: issueId,
        companyId,
        title: "ANT-3260",
        status: "todo",
        priority: "medium",
        assigneeAgentId: ceoId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    return { companyId, ceoId, blockerId, issueId };
  }

  function agentApp(input: { companyId: string; agentId: string; runId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: input.agentId,
        companyId: input.companyId,
        runId: input.runId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  /** Every run on the issue re-blocks it exactly as the ANT-3260 CEO did. */
  function reblockFromEveryRun(input: Awaited<ReturnType<typeof seed>>) {
    const patches: Array<{ cycle: number; status: number; body: unknown }> = [];
    let cycle = 0;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      if (ctx.context.issueId !== input.issueId) return { ...SUCCESS };
      cycle += 1;
      await db.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorAgentId: input.ceoId,
        createdByRunId: ctx.runId,
        body: "Still blocked on the blocker.",
      });
      if (cycle <= CYCLE_BOUND) {
        const res = await request(agentApp({ companyId: input.companyId, agentId: input.ceoId, runId: ctx.runId }))
          .patch(`/api/issues/${input.issueId}`)
          .send({
            status: "blocked",
            blockedByIssueIds: [input.blockerId],
            unblockDescriptor: { owner: { agentId: input.ceoId }, action: "Confirm the blocker is done" },
          });
        patches.push({ cycle, status: res.status, body: res.body });
      }
      return { ...SUCCESS };
    });
    return { patches, cycles: () => cycle };
  }

  async function startLoop(input: Awaited<ReturnType<typeof seed>>) {
    const firstRun = await heartbeat.wakeup(input.ceoId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: { issueId: input.issueId, source: "issue.update" },
    });
    expect(firstRun).not.toBeNull();
    return firstRun!;
  }

  /** Let the loop run until nothing is queued, then tick the periodic paths. */
  async function settle(cycles: () => number) {
    let last = -1;
    for (let round = 0; round < 40 && cycles() !== last; round += 1) {
      last = cycles();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    for (let tick = 0; tick < 3; tick += 1) {
      await heartbeat.reconcileResolvedDependencyWakes();
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  async function selfReblockWakes(agentId: string, issueId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        sql`${agentWakeupRequests.payload} -> '_paperclipSelfReblockWake' is not null`,
      ));
  }

  it("admits at most 3 self re-block wakes in 10 minutes and parks the rest when each run ends before its dependency wake lands", async () => {
    const input = await seed();
    dependencyWakeGate.enabled = true;
    const loop = reblockFromEveryRun(input);
    await startLoop(input);
    await settle(loop.cycles);

    // Every re-block went through the real route.
    expect(loop.patches.length).toBeGreaterThan(0);
    expect(loop.patches.every((patch) => patch.status === 200), JSON.stringify(loop.patches)).toBe(true);
    // The assignment run, then at most three self-caused restarts.
    expect(loop.cycles()).toBeLessThanOrEqual(4);

    const wakes = await selfReblockWakes(input.ceoId, input.issueId);
    const admitted = wakes.filter((wake) => wake.runId !== null && wake.status !== "skipped");
    const windowStart = Date.now() - 10 * 60 * 1000;
    expect(admitted.filter((wake) => wake.requestedAt.getTime() >= windowStart).length).toBeLessThanOrEqual(3);
    // The dependency wake the route built carries the server provenance.
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.every((wake) => (wake.payload as Record<string, unknown>).mutation === "blocked_dependency_restored"))
      .toBe(true);

    // The next self-caused wake is held back as a durable parked receipt,
    // neither run nor dropped.
    const parked = wakes.filter((wake) => wake.status === "deferred_issue_execution");
    expect(parked).toEqual([
      expect.objectContaining({
        reason: "issue_wake_rate_limited",
        runId: null,
        payload: expect.objectContaining({
          _paperclipSelfReblockWakeParked: expect.objectContaining({ limit: 3, windowMs: 600_000 }),
        }),
      }),
    ]);
    // The unblock requests landed while the run still held the issue.
    const suppressed = wakes.filter((wake) => wake.reason === "issue_self_reblock_wake_suppressed");
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed.every((wake) => wake.status === "skipped")).toBe(true);

    // The periodic paths did not restart it either.
    const runsOnIssue = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, input.ceoId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
    ));
    expect(runsOnIssue.length).toBe(loop.cycles());
  });

  it("stays bounded with the route's natural timing", async () => {
    const input = await seed();
    const loop = reblockFromEveryRun(input);
    await startLoop(input);
    await settle(loop.cycles);

    expect(loop.patches.length).toBeGreaterThan(0);
    expect(loop.patches.every((patch) => patch.status === 200), JSON.stringify(loop.patches)).toBe(true);
    // Whether each dependency wake lands while the run still holds the issue
    // (suppressed) or after it ended (limited), the loop stops.
    expect(loop.cycles()).toBeLessThanOrEqual(4);
    const admitted = (await selfReblockWakes(input.ceoId, input.issueId))
      .filter((wake) => wake.runId !== null && wake.status !== "skipped");
    expect(admitted.length).toBeLessThanOrEqual(3);
  });
});
