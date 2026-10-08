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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { heartbeatService } from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { notifySecretProposalResolution } from "../services/secret-proposal-notifications.js";
import { runningProcesses } from "../adapters/index.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

/**
 * Regression tests for the scope of the reserved `issue-assignment:` wake key.
 * Only an assignment event may carry it. Any other wake on an issue whose
 * assignment did not change (plugin, secret resolution, tree resume) is new
 * work and must be delivered, not replayed onto the old assignment receipt.
 */

type MockRunContext = { runId: string; agent: { id: string; companyId: string }; context: Record<string, unknown> };
const mockAdapterExecute = vi.hoisted(() => vi.fn(async (_ctx: MockRunContext) => ({})));

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

const SUCCESS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Assignment wake scope test run.",
  provider: "test",
  model: "test-model",
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping assignment wake scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("issue assignment wake scope", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignment-wake-scope-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  beforeEach(() => {
    // A real agent leaves a comment; without one the comment policy queues a follow-up run.
    mockAdapterExecute.mockImplementation(async (ctx) => {
      const issueId = typeof ctx.context.issueId === "string" ? ctx.context.issueId : null;
      if (issueId) {
        await db.insert(issueComments).values({
          companyId: ctx.agent.companyId,
          issueId,
          authorAgentId: ctx.agent.id,
          createdByRunId: ctx.runId,
          body: "Run summary.",
        });
      }
      return { ...SUCCESS };
    });
  });

  async function waitForIdle() {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    });
  }

  afterEach(async () => {
    await waitForIdle();
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(status: "todo" | "in_progress") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Scope",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Scoped wake issue",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  /** The issue's assignment wake, admitted and run to completion. */
  async function runAssignmentWake(input: { agentId: string; issueId: string }) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const run = await heartbeat.wakeup(input.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      idempotencyKey: `issue-assignment:${input.issueId}:${input.agentId}:${issue!.statusVersion}`,
      payload: { issueId: input.issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: { issueId: input.issueId, source: "issue.update" },
    });
    expect(run).not.toBeNull();
    expect(await waitForIdle()).toBe(true);
    await heartbeat.waitForRunExecutionDrain(run!.id);
    return run!;
  }

  const receiptsFor = (agentId: string, reason: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, reason)));
  /**
   * Receipts of one wake, by the payload it was sent with. A wake that joins a
   * queued run (here the disposition-repair successor of the previous run)
   * keeps its payload on a coalesced receipt, so this finds it either way.
   */
  const receiptsWithPayload = (agentId: string, field: string, value: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), sql`${agentWakeupRequests.payload} ->> ${field} = ${value}`));

  it("R3-P: a second plugin wake on an in_progress issue starts new work, not the first run", async () => {
    const { companyId, agentId, issueId } = await seed("in_progress");
    const services = buildHostServices(db, "plugin-record-id", "acme.github", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);

    const first = await services.issues.requestWakeup({ issueId, companyId, reason: "GitHub automation", idempotencyKey: "wake-1" });
    expect(first.runId).toBeTruthy();
    expect(await waitForIdle()).toBe(true);
    await heartbeat.waitForRunExecutionDrain(first.runId!);

    const second = await services.issues.requestWakeup({ issueId, companyId, reason: "GitHub automation", idempotencyKey: "wake-2" });
    expect(second.runId).toBeTruthy();
    expect(second.runId).not.toBe(first.runId);
    expect(await waitForIdle()).toBe(true);

    // Each plugin wake wrote its own receipt, under the plugin's own key,
    // namespaced so it can never name a server key.
    const wakes = await receiptsWithPayload(agentId, "pluginKey", "acme.github");
    expect(wakes.map((wake) => wake.idempotencyKey).sort()).toEqual([
      "plugin:acme.github:wake-1",
      "plugin:acme.github:wake-2",
    ]);
    expect(wakes.find((wake) => wake.idempotencyKey === "plugin:acme.github:wake-2")!.runId).toBe(second.runId);
  });

  it("R3-P: a plugin key in the reserved assignment namespace is namespaced, not trusted", async () => {
    const { companyId, agentId, issueId } = await seed("in_progress");
    await runAssignmentWake({ agentId, issueId });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const forged = `issue-assignment:${issueId}:${agentId}:${issue!.statusVersion}`;
    const services = buildHostServices(db, "plugin-record-id", "acme.github", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);

    const woken = await services.issues.requestWakeup({ issueId, companyId, reason: "GitHub automation", idempotencyKey: forged });
    expect(woken.runId).toBeTruthy();
    expect(await waitForIdle()).toBe(true);
    const wakes = await receiptsWithPayload(agentId, "pluginKey", "acme.github");
    expect(wakes).toEqual([
      expect.objectContaining({ idempotencyKey: `plugin:acme.github:${forged}`, runId: woken.runId }),
    ]);
    // Nothing the plugin sent became an assignment receipt or a refusal.
    expect(await receiptsFor(agentId, "issue_assignment_wake_refused")).toEqual([]);
  });

  it("R3-S: every secret proposal resolution writes its own wake receipt", async () => {
    const { agentId, issueId } = await seed("in_progress");
    await runAssignmentWake({ agentId, issueId });
    const issuesSvc = issueService(db);

    for (const proposedName of ["GITHUB_TOKEN", "NPM_TOKEN"]) {
      await notifySecretProposalResolution({
        proposal: { originIssueId: issueId, kind: "secret", proposedName, configPath: null },
        status: "approved",
        userId: "board-user",
        issues: issuesSvc,
        heartbeat,
      });
      expect(await waitForIdle()).toBe(true);
    }

    const resolutions = await receiptsWithPayload(agentId, "mutation", "secret_proposal_approved");
    expect(resolutions).toHaveLength(2);
    expect(resolutions.every((wake) => wake.idempotencyKey === null)).toBe(true);
    expect(resolutions.every((wake) => wake.runId !== null)).toBe(true);
  });

  it("R3-T: resuming a paused tree wakes the assignee after its in_progress assignment run", async () => {
    const { companyId, agentId, issueId } = await seed("in_progress");
    const assignmentRun = await runAssignmentWake({ agentId, issueId });
    const { hold } = await issueTreeControlService(db).createHold(companyId, issueId, {
      mode: "pause",
      reason: "Pause for review",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueTreeControlRoutes(db));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/issues/${issueId}/tree-holds/${hold.id}/release`)
      .send({ reason: "Resume", metadata: { wakeAgents: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.wakeFailures).toBeUndefined();
    expect(await waitForIdle()).toBe(true);

    const resumes = await receiptsWithPayload(agentId, "holdId", hold.id);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.idempotencyKey).toBeNull();
    expect(resumes[0]!.runId).not.toBeNull();
    expect(resumes[0]!.runId).not.toBe(assignmentRun.id);
  });

  it("R3-R: a status-only change between the assignment commit and its wake does not drop the wake", async () => {
    const { agentId, issueId } = await seed("todo");
    // The assignment committed at this generation ...
    const [assigned] = await db.select().from(issues).where(eq(issues.id, issueId));
    // ... then a status-only change advanced the status version (DB trigger)
    // before the route's asynchronous wake reached admission.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const [moved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(moved!.statusVersion).toBeGreaterThan(assigned!.statusVersion);

    const run = await queueIssueAssignmentWakeup({
      heartbeat,
      assignmentEvent: true,
      issue: { id: issueId, assigneeAgentId: agentId, status: assigned!.status, statusVersion: assigned!.statusVersion },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      rethrowOnError: true,
    });
    expect(run).toMatchObject({ agentId });
    expect(await waitForIdle()).toBe(true);

    expect(await receiptsFor(agentId, "issue_assignment_wake_refused")).toEqual([]);
    const [receipt] = await receiptsFor(agentId, "issue_assigned");
    expect(receipt).toMatchObject({
      idempotencyKey: `issue-assignment:${issueId}:${agentId}:${assigned!.statusVersion}`,
      runId: (run as { id: string }).id,
    });
    const [assignmentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, receipt!.id));
    expect(assignmentRun).toMatchObject({ agentId, status: "succeeded" });
  });
});
