import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  routineRuns,
} from "@paperclipai/db";
import { readRoutineStepsRunPayload, type RoutineStep } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { attentionService } from "../services/attention.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { sendBackRoutineStep } from "../services/routine-step-send-back.js";
import { routineService } from "../services/routines.ts";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

vi.setConfig({ testTimeout: 90_000 });

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe.sequential : describe.skip;
if (!support.supported) {
  console.warn(`Skipping routine step send-back tests: ${support.reason ?? "unsupported environment"}`);
}

const ADAPTER_TYPE = "codex_local";
const BOARD_USER_ID = "board-user";

interface Invocation {
  runId: string;
  agentId: string;
  issueId: string | null;
  /** The session the run was handed; null for a fresh session. */
  sessionId: string | null;
  returnedSessionId: string;
  wakeReason: string | null;
}

type Behavior = (invocation: Invocation) => Promise<void>;

function step(key: string, after: string[], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Step ${key}`, after, ...extra };
}

describeEmbeddedPostgres("routine step send-back", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  const invocations: Invocation[] = [];
  /** What each agent does in its run; the default finishes the run's issue. */
  const behaviors = new Map<string, Behavior>();

  async function finishIssue(issueId: string | null) {
    if (issueId) await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
  }

  async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const sessionId = ctx.runtime.sessionId ?? null;
    const invocation: Invocation = {
      runId: ctx.runId,
      agentId: ctx.agent.id,
      issueId: typeof ctx.context.issueId === "string" ? ctx.context.issueId : null,
      sessionId,
      returnedSessionId: sessionId ?? randomUUID(),
      wakeReason: typeof ctx.context.wakeReason === "string" ? ctx.context.wakeReason : null,
    };
    invocations.push(invocation);
    const behavior = behaviors.get(ctx.agent.id) ?? ((run: Invocation) => finishIssue(run.issueId));
    await behavior(invocation);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "test-provider",
      model: "test-model",
      summary: "Done.",
      usage: { inputTokens: 10, outputTokens: 5 },
      sessionId: invocation.returnedSessionId,
      sessionParams: { sessionId: invocation.returnedSessionId },
      sessionDisplayId: invocation.returnedSessionId,
    };
  }

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-step-send-back-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const now = new Date();
    // The responsible user that agent comments on a step are written for.
    await db.insert(authUsers).values({ id: BOARD_USER_ID, name: "Board", email: "board@example.test", createdAt: now, updatedAt: now });
    registerServerAdapter({
      type: ADAPTER_TYPE,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({ adapterType: ADAPTER_TYPE, status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const agentId = req.header("x-test-agent-id");
      const companyId = req.header("x-test-company-id") ?? "";
      Object.assign(req, {
        actor: agentId
          ? { type: "agent", agentId, companyId, runId: req.header("x-test-run-id") ?? null, source: "agent_key" }
          : {
              type: "board",
              source: "session",
              userId: BOARD_USER_ID,
              companyIds: [companyId],
              memberships: [{ companyId, status: "active", membershipRole: "owner" }],
              isInstanceAdmin: false,
            },
      });
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    invocations.length = 0;
    behaviors.clear();
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "heartbeat_run_events", "issue_comments", "issue_relations", "issues",
        "routine_runs", "routine_triggers", "routine_revisions", "routines", "agent_task_sessions", "heartbeat_runs",
        "agent_wakeup_requests", "agent_runtime_state", "environment_leases", "company_memberships", "agents", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  /**
   * A run of `implement → [qa, docs]` (or the steps given), each step on its own agent, started
   * through the real dispatch. Nothing runs until the test drains.
   */
  async function seed(makeSteps?: (ids: Record<string, string>) => RoutineStep[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Send back",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: BOARD_USER_ID,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    const ids: Record<string, string> = {};
    for (const name of ["lead", "builder", "reviewer", "tester", "writer"]) {
      ids[name] = randomUUID();
      await db.insert(agents).values({
        id: ids[name],
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: ADAPTER_TYPE,
        adapterConfig: { model: "test-model" },
        permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      });
    }
    const steps = makeSteps?.(ids) ?? [
      step("implement", [], { assigneeAgentId: ids.builder }),
      step("qa", ["implement"], { assigneeAgentId: ids.tester, sendBackTo: ["implement"], maxSendBacks: 2 }),
      step("docs", ["implement"], { assigneeAgentId: ids.writer }),
    ];
    const routines = routineService(db, { heartbeat });
    const routine = await routines.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Ship a change",
        description: "Lead brief",
        assigneeAgentId: ids.lead,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
        steps,
      },
      {},
    );
    const run = await routines.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    const stepRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_step")));
    const issueOf = (key: string) => stepRows.find((row) => row.title === `Step ${key}`)!.id;
    return { companyId, ids, routineRunId: run.id, rootId: run.linkedIssueId!, issueOf };
  }

  const status = async (issueId: string) =>
    (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status;

  function sendBack(
    companyId: string,
    issueId: string,
    body: Record<string, unknown>,
    actor: { agentId: string; runId?: string } | null = null,
  ) {
    const call = request(app).post(`/api/issues/${issueId}/routine-step/send-back`).set("x-test-company-id", companyId);
    if (actor) {
      call.set("x-test-agent-id", actor.agentId);
      if (actor.runId) call.set("x-test-run-id", actor.runId);
    }
    return call.send(body);
  }

  function patchIssue(companyId: string, issueId: string, body: Record<string, unknown>, actor: { agentId: string; runId: string }) {
    return request(app)
      .patch(`/api/issues/${issueId}`)
      .set("x-test-company-id", companyId)
      .set("x-test-agent-id", actor.agentId)
      .set("x-test-run-id", actor.runId)
      .send(body);
  }

  /** Runs every queued wake, then wakes the steps whose blockers are done, until nothing moves. */
  async function settle(companyId: string) {
    for (let pass = 0; pass < 8; pass += 1) {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const woken = await heartbeat.reconcileResolvedDependencyWakes({ companyId });
      if (woken.issueIds.length === 0) {
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        return;
      }
    }
  }

  const runsOf = (agentId: string) => invocations.filter((invocation) => invocation.agentId === agentId);

  it("loops qa back to implement: the agents resume their sessions, docs is left alone, and the run ends once", async () => {
    const fx = await seed();
    const responses: Array<{ label: string; status: number; body: unknown }> = [];
    let testerRuns = 0;
    behaviors.set(fx.ids.tester, async (run) => {
      testerRuns += 1;
      if (testerRuns > 1) return finishIssue(run.issueId);
      const sent = await sendBack(
        fx.companyId,
        run.issueId!,
        { toStepKey: "implement", comment: "The retry test fails; handle the empty response." },
        { agentId: fx.ids.tester, runId: run.runId },
      );
      responses.push({ label: "send-back", status: sent.status, body: sent.body });
      // The same run tries to finish its step after sending the work back.
      const lateDone = await patchIssue(fx.companyId, run.issueId!, { status: "done" }, {
        agentId: fx.ids.tester,
        runId: run.runId,
      });
      responses.push({ label: "late-done", status: lateDone.status, body: lateDone.body });
    });

    await settle(fx.companyId);

    expect(responses[0]).toMatchObject({
      label: "send-back",
      status: 200,
      body: {
        outcome: "sent_back",
        fromStepKey: "qa",
        toStepKey: "implement",
        rounds: 1,
        maxSendBacks: 2,
        reblockedIssueIds: [fx.issueOf("qa")],
      },
    });
    expect(responses[1]?.label).toBe("late-done");
    // The sender waits on the reopened target, so its late "done" is refused, not applied.
    expect(responses[1]).toMatchObject({
      status: 409,
      body: {
        error: "Issue follow-up blocked by unresolved blockers",
        details: { unresolvedBlockerIssueIds: [fx.issueOf("implement")] },
      },
    });

    const builderRuns = runsOf(fx.ids.builder);
    expect(builderRuns.map((run) => run.wakeReason)).toEqual(["issue_assigned", "issue_reopened_via_comment"]);
    expect(builderRuns[0]!.sessionId).toBeNull();
    expect(builderRuns[1]!.sessionId).toBe(builderRuns[0]!.returnedSessionId);

    const tester = runsOf(fx.ids.tester);
    expect(tester).toHaveLength(2);
    expect(tester[1]!.wakeReason).toBe("issue_blockers_resolved");
    expect(tester[1]!.sessionId).toBe(tester[0]!.returnedSessionId);

    // docs waits for implement too, but it is not on the way to qa, so it ran once.
    expect(runsOf(fx.ids.writer)).toHaveLength(1);
    expect(runsOf(fx.ids.lead)).toHaveLength(1);
    for (const key of ["implement", "qa", "docs"]) expect(await status(fx.issueOf(key))).toBe("done");

    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, fx.routineRunId));
    const recorded = readRoutineStepsRunPayload(run!.triggerPayload);
    expect(recorded?.sendBacks).toEqual([
      expect.objectContaining({ fromStepKey: "qa", toStepKey: "implement", actorType: "agent", actorId: fx.ids.tester, outcome: "sent_back" }),
    ]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fx.issueOf("implement")));
    expect(comments.find((comment) => comment.authorAgentId === fx.ids.tester)?.body).toBe(
      "The retry test fails; handle the empty response.",
    );
    const actions = (await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, fx.companyId))).map(
      (row) => row.action,
    );
    expect(actions).toContain("issue.routine_step_sent_back");
  });

  it("re-blocks every step between the target and the sender, and refuses a step that is not finished", async () => {
    const fx = await seed((ids) => [
      step("implement", [], { assigneeAgentId: ids.builder }),
      step("review", ["implement"], { assigneeAgentId: ids.reviewer }),
      step("qa", ["review"], { assigneeAgentId: ids.tester, sendBackTo: ["implement", "review"] }),
    ]);
    behaviors.set(fx.ids.tester, async () => {});
    await settle(fx.companyId);
    expect(await status(fx.issueOf("review"))).toBe("done");

    const sent = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "implement", comment: "Redo it" });
    expect(sent.status).toBe(200);
    expect([...sent.body.reblockedIssueIds].sort()).toEqual([fx.issueOf("review"), fx.issueOf("qa")].sort());
    expect(await status(fx.issueOf("implement"))).toBe("todo");
    expect(await status(fx.issueOf("review"))).toBe("blocked");
    expect(await status(fx.issueOf("qa"))).toBe("blocked");

    // implement is open again, so neither it nor review can take work back now.
    const again = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "review", comment: "Again" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('Step "review" is blocked');
  });

  it("stops an agent at the cap, hands the step to the board, and lets a board send-back reset the edge", async () => {
    const fx = await seed((ids) => [
      step("implement", [], { assigneeAgentId: ids.builder }),
      step("qa", ["implement"], { assigneeAgentId: ids.tester, sendBackTo: ["implement"], maxSendBacks: 1 }),
    ]);
    const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
    behaviors.set(fx.ids.tester, async (run) => {
      if (responses.length >= 2) return finishIssue(run.issueId);
      const sent = await sendBack(
        fx.companyId,
        run.issueId!,
        { toStepKey: "implement", comment: `Round ${responses.length + 1}: still failing` },
        { agentId: fx.ids.tester, runId: run.runId },
      );
      responses.push({ status: sent.status, body: sent.body });
    });
    await settle(fx.companyId);

    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    expect(responses[1]!.body).toMatchObject({
      details: { code: "send_back_cap_reached", escalated: true, outcome: "cap_reached", rounds: 1, maxSendBacks: 1 },
    });
    const [qa] = await db.select().from(issues).where(eq(issues.id, fx.issueOf("qa")));
    expect(qa).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board" } });
    expect(qa!.unblockDescriptor?.action).toContain('limit of 1 send-backs to "implement"');
    expect(await status(fx.issueOf("implement"))).toBe("done");
    expect(runsOf(fx.ids.builder)).toHaveLength(2);

    const feed = await attentionService(db).list(fx.companyId, { userId: BOARD_USER_ID });
    expect(
      feed.items.some((item) => item.sourceKind === "blocker_attention" && item.subject.id === fx.issueOf("qa")),
    ).toBe(true);

    // The agent cannot lift the board's block, and cannot send back again.
    const agentRetry = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "implement", comment: "Once more" }, {
      agentId: fx.ids.tester,
    });
    expect(agentRetry.status).toBe(409);

    const board = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "implement", comment: "One more try" });
    expect(board.status).toBe(200);
    expect(board.body).toMatchObject({ outcome: "sent_back", rounds: 0 });
    const [qaAfter] = await db.select().from(issues).where(eq(issues.id, fx.issueOf("qa")));
    expect(qaAfter).toMatchObject({ status: "blocked", unblockDescriptor: null });
    await settle(fx.companyId);
    expect(runsOf(fx.ids.builder)).toHaveLength(3);
    expect(await status(fx.issueOf("qa"))).toBe("done");
    expect(await status(fx.rootId)).not.toBe("blocked");
  });

  it("refuses a send-back that its step does not allow, from another agent, or on a closed run", async () => {
    const fx = await seed();
    behaviors.set(fx.ids.tester, async () => {});
    behaviors.set(fx.ids.writer, async () => {});
    await settle(fx.companyId);

    const notAllowed = await sendBack(fx.companyId, fx.issueOf("docs"), { toStepKey: "implement", comment: "x" });
    expect(notAllowed.status).toBe(422);
    expect(notAllowed.body.error).toContain('Step "docs" cannot send work back');

    const unknownTarget = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "docs", comment: "x" });
    expect(unknownTarget.status).toBe(422);

    const notAStep = await sendBack(fx.companyId, fx.rootId, { toStepKey: "implement", comment: "x" });
    expect(notAStep.status).toBe(422);

    const noComment = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "implement", comment: " " });
    expect(noComment.status).toBe(400);

    // While the tester's run holds qa, the run lock refuses other agents first; release it to reach the step rule.
    await db
      .update(issues)
      .set({ checkoutRunId: null, executionRunId: null, status: "todo" })
      .where(eq(issues.id, fx.issueOf("qa")));
    const otherAgent = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "implement", comment: "x" }, {
      agentId: fx.ids.writer,
    });
    expect(otherAgent.status).toBe(403);
    // The service holds the same rule for any caller that reaches it.
    await expect(
      sendBackRoutineStep(db, {
        companyId: fx.companyId,
        issueId: fx.issueOf("qa"),
        toStepKey: "implement",
        comment: "x",
        actor: { actorType: "agent", agentId: fx.ids.writer, runId: null },
      }),
    ).rejects.toMatchObject({ status: 403, message: "Only the agent of this step can send its work back" });

    const otherCompany = await sendBack(randomUUID(), fx.issueOf("qa"), { toStepKey: "implement", comment: "x" });
    expect([403, 404]).toContain(otherCompany.status);

    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, fx.rootId));
    const closed = await sendBack(fx.companyId, fx.issueOf("qa"), { toStepKey: "implement", comment: "x" });
    expect(closed.status).toBe(409);
    expect(await status(fx.issueOf("implement"))).toBe("done");
  });
});
