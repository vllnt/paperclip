import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "../adapters/index.ts";
import {
  heartbeatService,
  ROUTINE_TASK_SESSION_CLAIM_KEY,
  ROUTINE_TASK_SESSION_CLAIM_RUN_KEY,
} from "../services/heartbeat.ts";
import { routineService } from "../services/routines.ts";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe.sequential : describe.skip;
if (!support.supported) {
  console.warn(`Skipping routine session reuse tests: ${support.reason ?? "unsupported environment"}`);
}

const ADAPTER_TYPE = "codex_local";
const TOKEN_THRESHOLD = 100_000;
/**
 * Stand-in for the agent instructions a local adapter adds to a FRESH session
 * only (claude_local's --append-system-prompt-file; its own comment puts that at
 * 5-10K tokens). The simulation uses the low end and reports it separately.
 */
const FRESH_INSTRUCTIONS_TOKENS = 5_000;

interface Invocation {
  runId: string;
  agentId: string;
  issueId: string | null;
  sessionId: string | null;
  returnedSessionId: string;
  wake: Record<string, unknown>;
  handoff: string;
  prompt: string;
  promptTokens: number;
}

/**
 * A fake local adapter. It records the session it is handed, builds the prompt
 * a local adapter would send with the shared Paperclip prompt selectors, and
 * reports input tokens proportional to that prompt.
 */
describeEmbeddedPostgres("routine-execution issues reuse one session per (routine, agent)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let routines!: ReturnType<typeof routineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const invocations: Invocation[] = [];
  /** Input tokens the next invocations report instead of the prompt size. */
  const reportedInputTokens: number[] = [];
  /** Holds an invocation until the test releases it. */
  let gate: ((invocation: Invocation) => Promise<void>) | null = null;

  async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const sessionId = ctx.runtime.sessionId ?? null;
    const resumedSession = sessionId !== null;
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(ctx.context, {
      resumedSession,
      includeCommunicationGuidance: false,
    });
    const handoff = typeof ctx.context.paperclipSessionHandoffMarkdown === "string"
      ? ctx.context.paperclipSessionHandoffMarkdown
      : "";
    // The same sections, in the same order, as the claude_local adapter's prompt.
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(ctx.context, { resumedSession }),
      wakePrompt,
      handoff,
      taskContextNote,
      resumedSession && wakePrompt.length > 0
        ? ""
        : renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, { agent: ctx.agent, context: ctx.context }),
    ]);
    const issueId = typeof ctx.context.issueId === "string" ? ctx.context.issueId : null;
    const invocation: Invocation = {
      runId: ctx.runId,
      agentId: ctx.agent.id,
      issueId,
      sessionId,
      returnedSessionId: sessionId ?? randomUUID(),
      wake: (ctx.context.paperclipWake ?? {}) as Record<string, unknown>,
      handoff,
      prompt,
      promptTokens: Math.ceil(prompt.length / 4),
    };
    invocations.push(invocation);
    if (gate) await gate(invocation);
    if (issueId) await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const inputTokens = reportedInputTokens.shift() ?? invocation.promptTokens;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "test-provider",
      model: "test-model",
      summary: "Done.",
      usage: { inputTokens, outputTokens: 5 },
      sessionId: invocation.returnedSessionId,
      sessionParams: { sessionId: invocation.returnedSessionId },
      sessionDisplayId: invocation.returnedSessionId,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-session-reuse-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    routines = routineService(db, { heartbeat });
    registerServerAdapter({
      type: ADAPTER_TYPE,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({ adapterType: ADAPTER_TYPE, status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
  }, 30_000);

  afterEach(async () => {
    gate = null;
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    invocations.length = 0;
    reportedInputTokens.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "heartbeat_run_events", "issue_comments", "issues", "routine_runs",
        "routine_triggers", "routine_revisions", "routines", "agent_task_sessions", "heartbeat_runs",
        "agent_wakeup_requests", "agent_runtime_state", "environment_leases", "agents", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  async function seed(options: { concurrencyPolicy?: "coalesce_if_active" | "always_enqueue" } = {}) {
    const companyId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Routine sessions", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    const [agentId, otherAgentId] = [randomUUID(), randomUUID()];
    await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
      id, companyId, name: `Agent ${index + 1}`, role: "engineer", status: "idle",
      adapterType: ADAPTER_TYPE, adapterConfig: { model: "test-model" }, permissions: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 4,
          // Rotation by a token threshold on the session's raw input.
          sessionCompaction: { enabled: true, maxRawInputTokens: TOKEN_THRESHOLD },
        },
      },
    })));
    const routine = await routines.create(companyId, {
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title: "Daily inbox sweep",
      description: "Sweep the inbox and report anything new.",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: options.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }, {});
    return { companyId, agentId, otherAgentId, routine };
  }

  /** One routine tick through the real dispatch: a new issue and its assignment wake. */
  async function tick(
    routineId: string,
    options: { assigneeAgentId?: string; drain?: boolean; payload?: Record<string, unknown> } = {},
  ) {
    const run = await routines.runRoutine(routineId, {
      source: "manual",
      ...(options.assigneeAgentId ? { assigneeAgentId: options.assigneeAgentId } : {}),
      ...(options.payload ? { payload: options.payload } : {}),
    });
    expect(run.status, `routine run ${run.id} did not create an issue (${run.failureReason ?? "no reason"})`)
      .toBe("issue_created");
    if (options.drain !== false) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [issue] = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
    return issue!;
  }

  async function routineSessionRows(companyId: string, routineId: string) {
    return db.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.taskKey, `routine:${routineId}`),
    ));
  }

  it("ticks 2..N resume tick 1's session and are told the issue is new and separate", async () => {
    const { companyId, agentId, routine } = await seed();
    const ticks = [];
    for (let index = 0; index < 10; index += 1) ticks.push(await tick(routine.id));

    expect(invocations).toHaveLength(10);
    const firstSession = invocations[0]!.returnedSessionId;
    const fresh = invocations.filter((invocation) => invocation.sessionId === null).length;
    const instructionTokens = fresh * FRESH_INSTRUCTIONS_TOKENS;
    const promptTokens = invocations.reduce((sum, invocation) => sum + invocation.promptTokens, 0);
    // Local simulation numbers. Set ROUTINE_SESSION_SIM_OUT to a file path and
    // run this file before and after the change to compare.
    if (process.env.ROUTINE_SESSION_SIM_OUT) {
      appendFileSync(process.env.ROUTINE_SESSION_SIM_OUT, `${JSON.stringify({
        ticks: invocations.length,
        freshSessions: fresh,
        resumedSessions: invocations.length - fresh,
        promptTokens,
        freshInstructionTokens: instructionTokens,
        inputTokenProxy: promptTokens + instructionTokens,
      })}\n`);
    }

    expect(invocations[0]!.sessionId).toBeNull();
    expect(invocations.slice(1).map((invocation) => invocation.sessionId))
      .toEqual(Array.from({ length: 9 }, () => firstSession));
    for (let index = 1; index < ticks.length; index += 1) {
      const invocation = invocations[index]!;
      expect(invocation.issueId).toBe(ticks[index]!.id);
      expect(invocation.wake.routineSession).toEqual({
        previousIssue: { id: ticks[index - 1]!.id, identifier: ticks[index - 1]!.identifier, title: ticks[index - 1]!.title },
      });
      expect(invocation.prompt).toContain(
        `This wake is for a NEW issue, ${ticks[index]!.identifier} \`${ticks[index]!.title}\`, created by a new run of the same routine.`,
      );
      expect(invocation.prompt).toContain(
        `Earlier in this session you worked on ${ticks[index - 1]!.identifier} \`${ticks[index - 1]!.title}\`, another run of this routine. That is a separate issue`,
      );
    }
    expect(invocations[0]!.prompt).not.toContain("NEW issue");
    const rows = await routineSessionRows(companyId, routine.id);
    expect(rows.map((row) => [row.agentId, row.sessionDisplayId])).toEqual([[agentId, firstSession]]);
    // The issue-keyed rows the old behavior wrote do not exist.
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, ticks[0]!.id))).toEqual([]);
  });

  it("a different agent gets its own session for the same routine", async () => {
    const { companyId, agentId, otherAgentId, routine } = await seed();
    await tick(routine.id);
    await tick(routine.id, { assigneeAgentId: otherAgentId });
    await tick(routine.id);
    await tick(routine.id, { assigneeAgentId: otherAgentId });

    const [a1, b1, a2, b2] = invocations;
    expect([a1!.agentId, b1!.agentId, a2!.agentId, b2!.agentId]).toEqual([agentId, otherAgentId, agentId, otherAgentId]);
    expect(a1!.sessionId).toBeNull();
    expect(b1!.sessionId).toBeNull();
    expect(b1!.returnedSessionId).not.toBe(a1!.returnedSessionId);
    expect(a2!.sessionId).toBe(a1!.returnedSessionId);
    expect(b2!.sessionId).toBe(b1!.returnedSessionId);
    const rows = await routineSessionRows(companyId, routine.id);
    expect(rows.map((row) => [row.agentId, row.sessionDisplayId]).sort()).toEqual(
      [[agentId, a1!.returnedSessionId], [otherAgentId, b1!.returnedSessionId]].sort(),
    );
  });

  it("two overlapping live ticks never share the session: the second starts fresh", async () => {
    const { companyId, routine } = await seed({ concurrencyPolicy: "always_enqueue" });
    await tick(routine.id);
    const session = invocations[0]!.returnedSessionId;

    // Hold the first of the two overlapping invocations until the second arrives.
    let releaseFirst!: () => void;
    const secondArrived = new Promise<void>((resolve) => { releaseFirst = resolve; });
    gate = async () => {
      if (invocations.length === 3) releaseFirst();
      else await Promise.race([secondArrived, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    };
    // Distinct payloads give distinct dispatch fingerprints, so both copies may
    // hold execution at once (identical copies are already serialized by the
    // open-routine-execution unique index).
    const [first, second] = await Promise.all([
      tick(routine.id, { drain: false, payload: { batch: 1 } }),
      tick(routine.id, { drain: false, payload: { batch: 2 } }),
    ]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const overlapping = invocations.slice(1);
    expect(overlapping.map((invocation) => invocation.issueId).sort()).toEqual([first.id, second.id].sort());
    // Both were live at once: the second started while the first was held.
    expect(overlapping).toHaveLength(2);
    expect(overlapping.map((invocation) => invocation.sessionId).sort()).toEqual([null, session].sort());
    const holder = overlapping.find((invocation) => invocation.sessionId === session)!;
    const overlap = overlapping.find((invocation) => invocation.sessionId === null)!;
    // The overlapping run kept its own issue-keyed session; the routine session stays the holder's.
    const rows = await routineSessionRows(companyId, routine.id);
    expect(rows.map((row) => row.sessionDisplayId)).toEqual([holder.returnedSessionId]);
    const [overlapRow] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, overlap.issueId!));
    expect(overlapRow?.sessionDisplayId).toBe(overlap.returnedSessionId);
  }, 30_000);

  it.each(["failed", "cancelled"] as const)(
    "a live claim forces a fresh session, and the claim lapses when its run becomes %s",
    async (endStatus) => {
      const { companyId, agentId, routine } = await seed();
      await tick(routine.id);
      const session = invocations[0]!.returnedSessionId;
      // A run of the same routine that is still running (for example, a crashed
      // process the reaper has not yet reached) holds the routine session.
      const holderId = randomUUID();
      const [holder] = await db.insert(heartbeatRuns).values({
        id: holderId, companyId, agentId, invocationSource: "assignment", status: "running", startedAt: new Date(),
        contextSnapshot: {
          [ROUTINE_TASK_SESSION_CLAIM_KEY]: `routine:${routine.id}`,
          [ROUTINE_TASK_SESSION_CLAIM_RUN_KEY]: holderId,
        },
      }).returning();

      const second = await tick(routine.id);
      expect(invocations[1]!.issueId).toBe(second.id);
      expect(invocations[1]!.sessionId).toBeNull();
      expect((await routineSessionRows(companyId, routine.id)).map((row) => row.sessionDisplayId)).toEqual([session]);

      await db.update(heartbeatRuns).set({ status: endStatus, finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder!.id));
      await tick(routine.id);
      expect(invocations[2]!.sessionId).toBe(session);
    },
  );

  it("a claim copied into another run's context (for example a retry) does not hold the session", async () => {
    const { companyId, agentId, routine } = await seed();
    await tick(routine.id);
    const session = invocations[0]!.returnedSessionId;
    await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "automation", status: "running", startedAt: new Date(),
      contextSnapshot: {
        [ROUTINE_TASK_SESSION_CLAIM_KEY]: `routine:${routine.id}`,
        [ROUTINE_TASK_SESSION_CLAIM_RUN_KEY]: randomUUID(),
      },
    });

    await tick(routine.id);
    expect(invocations[1]!.sessionId).toBe(session);
  });

  it("rotation still happens once the session passes the token threshold", async () => {
    const { routine } = await seed();
    await tick(routine.id);
    const firstSession = invocations[0]!.returnedSessionId;
    reportedInputTokens.push(TOKEN_THRESHOLD + 1);
    await tick(routine.id);
    await tick(routine.id);
    await tick(routine.id);

    const [, overThreshold, rotated, afterRotation] = invocations;
    expect(overThreshold!.sessionId).toBe(firstSession);
    expect(rotated!.sessionId).toBeNull();
    expect(rotated!.handoff).toContain(`Previous session: ${firstSession}`);
    expect(rotated!.handoff).toContain("Rotation reason: session raw input reached");
    expect(rotated!.prompt).not.toContain("NEW issue");
    expect(afterRotation!.sessionId).toBe(rotated!.returnedSessionId);
  });

  it("an operator reset of a routine issue's session clears the routine session", async () => {
    const { companyId, agentId, routine } = await seed();
    const first = await tick(routine.id);
    expect(await routineSessionRows(companyId, routine.id)).toHaveLength(1);

    const reset = await heartbeat.resetRuntimeSession(agentId, { taskKey: first.identifier });
    expect(reset?.clearedTaskSessions).toBe(1);
    expect(await routineSessionRows(companyId, routine.id)).toEqual([]);
    await tick(routine.id);
    expect(invocations[1]!.sessionId).toBeNull();
  });

  it("non-routine issues keep one fresh session per issue", async () => {
    const { companyId, agentId } = await seed();
    const issuePrefix = (await db.select().from(companies).where(eq(companies.id, companyId)))[0]!.issuePrefix;
    for (let index = 0; index < 2; index += 1) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId, companyId, title: `Manual task ${index}`, status: "todo", priority: "medium",
        responsibleUserId: "responsible-user", assigneeAgentId: agentId,
        issueNumber: 100 + index, identifier: `${issuePrefix}-${100 + index}`,
      });
      await heartbeat.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "system",
      });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
    expect(invocations.map((invocation) => invocation.sessionId)).toEqual([null, null]);
    expect(invocations.every((invocation) => invocation.wake.routineSession === undefined)).toBe(true);
    const keys = (await db.select().from(agentTaskSessions)).map((row) => row.taskKey).sort();
    expect(keys).toEqual(invocations.map((invocation) => invocation.issueId).sort());
  });
});
