import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { RemotePreflightUnavailableError } from "@paperclipai/adapter-utils/execution-target";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, provider: "test", model: "test-model" })),
);
const mockPrepareLaunchers = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

// Managed GitHub launchers are prepared only when GitHub is configured for the
// company; the PATH probe on the remote target is what fails in production.
vi.mock("../services/github-write-identity.js", async () => ({
  ...(await vi.importActual<typeof import("../services/github-write-identity.js")>("../services/github-write-identity.js")),
  loadGitHubIdentityPolicy: vi.fn(async () => ({ userSource: "app" })),
}));
vi.mock("../services/heartbeat-github-launchers.js", () => ({
  prepareHeartbeatGitHubLaunchers: mockPrepareLaunchers,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat transient remote preflight failure", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-remote-preflight-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
    mockPrepareLaunchers.mockReset();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) {
      await heartbeat.cancelRun(run.id, "Remote preflight fixture teardown", { suppressImmediateRecovery: true });
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueRecoveryActions);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Anthm PM",
      role: "pm",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plan the release",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  it("keeps the issue in_progress and schedules a bounded retry when the remote PATH probe cannot reach the target", async () => {
    const { agentId, issueId } = await seed();
    mockPrepareLaunchers.mockRejectedValue(
      new RemotePreflightUnavailableError("Could not resolve remote PATH for managed GitHub launchers"),
    );

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toBe("failed"), { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();

    expect(mockPrepareLaunchers).toHaveBeenCalled();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect((await heartbeat.getRun(run!.id))?.errorCode).toBe("remote_preflight_unavailable");
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: agentId });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);

    // The target is reachable again: the retry runs the agent.
    mockPrepareLaunchers.mockReset();
    mockPrepareLaunchers.mockImplementation(async (input: { env: Record<string, string> }) => ({
      env: input.env,
      cleanupLocation: null,
    }));
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, retries[0]!.id));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => expect((await heartbeat.getRun(retries[0]!.id))?.status).toBe("succeeded"), { timeout: 15_000 });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  }, 40_000);

  it("keeps today's terminal handling for a permanent PATH probe failure", async () => {
    const { issueId, agentId } = await seed();
    mockPrepareLaunchers.mockRejectedValue(new Error("Could not resolve remote PATH for managed GitHub launchers"));

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toBe("failed"), { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();

    expect((await heartbeat.getRun(run!.id))?.errorCode).toBe("setup_failed");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
  }, 40_000);
});
