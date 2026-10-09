import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentHarnessCooldowns,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
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
import { buildIssueAssignmentIdempotencyKey } from "../services/issue-assignment-wakeup.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentService } from "../services/agents.js";
import { harnessFallbackService } from "../services/harness-fallback.js";
import { secretService } from "../services/secrets.js";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping harness fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CLAUDE_LIMIT = "Claude AI usage limit reached|4102444800";
const CAPACITY = "Selected model is at capacity. Please try a different model.";
/** What the Claude CLI printed in production (2026-10-08 23:52–00:08 UTC) when every proxy credential was exhausted. */
const PROXY_COOLDOWN_LINE =
  "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: 429 rate_limit_error)";
const PROXY_COOLDOWN_BODY = JSON.stringify({
  error: { code: "model_cooldown", message: "All credentials for model claude-opus-5-5 are cooling down", reset_time: "30m0s", reset_seconds: 1800 },
});

type Outcome =
  | { kind: "success"; sessionId?: string }
  | { kind: "usage_limit"; noReset?: boolean }
  | { kind: "capacity" }
  | { kind: "auth" }
  | { kind: "task_failure" }
  | { kind: "usage_limit_after_comment" }
  | { kind: "proxy_cooldown_as_transient"; withResetBody?: boolean };

interface Invocation {
  runId: string;
  adapterType: string;
  model: unknown;
  envKeys: string[];
  env: Record<string, unknown>;
  sessionId: string | null;
}

describeEmbeddedPostgres("agent harness fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const scripts: Record<string, Outcome[]> = { claude_local: [], codex_local: [] };
  const invocations: Invocation[] = [];

  async function postProgressComment(ctx: AdapterExecutionContext) {
    const issueId = typeof ctx.context.issueId === "string" ? ctx.context.issueId : null;
    if (!issueId) return;
    const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    await db.insert(issueComments).values({
      companyId: issue!.companyId, issueId, authorAgentId: ctx.agent.id, authorType: "agent",
      createdByRunId: ctx.runId, body: "Progress: drafted the plan.",
    });
  }

  function scripted(adapterType: "claude_local" | "codex_local") {
    return async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      invocations.push({
        runId: ctx.runId,
        adapterType,
        model: ctx.config.model,
        envKeys: Object.keys((ctx.config.env ?? {}) as Record<string, unknown>).sort(),
        env: (ctx.config.env ?? {}) as Record<string, unknown>,
        sessionId: ctx.runtime.sessionId ?? null,
      });
      const outcome = scripts[adapterType].shift() ?? { kind: "success" };
      const provider = adapterType === "claude_local" ? "anthropic" : "openai";
      const model = String(ctx.config.model ?? "default");
      if (outcome.kind === "success") {
        await postProgressComment(ctx);
        if (typeof ctx.context.issueId === "string") {
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, ctx.context.issueId));
        }
        return {
          exitCode: 0, signal: null, timedOut: false, provider, model, summary: "Done.",
          usage: { inputTokens: 10, outputTokens: 5 },
          ...(outcome.sessionId
            ? { sessionId: outcome.sessionId, sessionParams: { sessionId: outcome.sessionId }, sessionDisplayId: outcome.sessionId }
            : {}),
        };
      }
      if (outcome.kind === "auth") {
        return {
          exitCode: 1, signal: null, timedOut: false, provider, model,
          errorMessage: "Not logged in. Please run /login (usage limit unknown).",
          errorCode: "claude_auth_required",
        };
      }
      if (outcome.kind === "task_failure") {
        return {
          exitCode: 1, signal: null, timedOut: false, provider, model,
          errorMessage: "Tests failed: 3 assertions",
          errorCode: "adapter_failed",
        };
      }
      if (outcome.kind === "proxy_cooldown_as_transient") {
        // The adapter classification seen in production: transient, not quota.
        const stderr = outcome.withResetBody ? `${PROXY_COOLDOWN_LINE}\n${PROXY_COOLDOWN_BODY}` : PROXY_COOLDOWN_LINE;
        return {
          exitCode: 1, signal: null, timedOut: false, provider, model,
          errorMessage: PROXY_COOLDOWN_LINE, errorCode: "claude_transient_upstream", errorFamily: "transient_upstream",
          resultJson: { stderr, errorFamily: "transient_upstream" },
        };
      }
      if (outcome.kind === "usage_limit_after_comment") await postProgressComment(ctx);
      const message = outcome.kind === "capacity"
        ? CAPACITY
        : outcome.kind === "usage_limit" && outcome.noReset ? "You've hit your usage limit." : CLAUDE_LIMIT;
      return {
        exitCode: 1, signal: null, timedOut: false, provider, model,
        errorMessage: message, errorCode: "provider_quota", errorFamily: "provider_quota",
        resultJson: { stderr: message, errorFamily: "provider_quota" },
      };
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-harness-fallback-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    for (const type of ["claude_local", "codex_local"] as const) {
      registerServerAdapter({
        type,
        supportsLocalAgentJwt: false,
        execute: scripted(type),
        testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
      });
    }
  }, 20_000);

  beforeEach(async () => {
    const msToUtcMidnight = 86_400_000 - (Date.now() % 86_400_000);
    if (msToUtcMidnight < 30_000) await new Promise((resolve) => setTimeout(resolve, msToUtcMidnight + 1_000));
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.restoreAllMocks();
    scripts.claude_local = [];
    scripts.codex_local = [];
    invocations.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "heartbeat_run_events", "issue_comments", "issues",
        "agent_harness_cooldowns", "agent_task_sessions", "heartbeat_runs", "agent_wakeup_requests",
        "agent_runtime_state", "environment_leases", "agents", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter("claude_local");
    unregisterServerAdapter("codex_local");
    await tempDb?.cleanup();
  });

  async function seed(options: { heartbeat?: Record<string, unknown>; fallbacks?: unknown[]; adapterType?: string; model?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Fallback", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Implementer", role: "engineer", status: "idle",
      adapterType: options.adapterType ?? "claude_local",
      adapterConfig: { model: options.model ?? "claude-opus-5-5", env: { ANTHROPIC_BASE_URL: "http://proxy.invalid" } },
      permissions: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, ...options.heartbeat },
      },
      fallbacks: options.fallbacks ?? [
        { adapterType: "codex_local", model: "gpt-5.5", effort: "high", env: { CODEX_HOME: "/srv/codex-home" } },
      ],
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Ship the feature", status: "todo", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId,
      issueNumber: 1, identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  async function assign(agentId: string, issueId: string) {
    const [issue] = await db.select({ statusVersion: issues.statusVersion }).from(issues).where(eq(issues.id, issueId));
    await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      idempotencyKey: buildIssueAssignmentIdempotencyKey({
        issueId, assigneeAgentId: agentId, assignmentGeneration: issue!.statusVersion,
      }),
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  /** A board comment reopens the issue and wakes its assignee. */
  async function comment(agentId: string, issueId: string) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    await heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  async function runs(companyId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(asc(heartbeatRuns.createdAt));
  }

  async function pending(companyId: string, reason: string) {
    return db.select().from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        eq(heartbeatRuns.scheduledRetryReason, reason),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function runPending(companyId: string, reason: string) {
    const retry = await pending(companyId, reason);
    if (!retry?.scheduledRetryAt) throw new Error(`expected a scheduled ${reason} retry`);
    const promotion = await heartbeat.promoteDueScheduledRetries(retry.scheduledRetryAt);
    expect(promotion.runIds).toContain(retry.id);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return heartbeat.getRun(retry.id);
  }

  async function activities(companyId: string, action: string) {
    return db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  }

  it("re-dispatches a usage-limit failure once on the first fallback, with its own harness, model and env", async () => {
    const { companyId, agentId, issueId } = await seed();
    scripts.claude_local = [{ kind: "usage_limit" }];

    await assign(agentId, issueId);
    const [primaryRun] = await runs(companyId);
    expect(primaryRun).toMatchObject({
      status: "failed", errorCode: "provider_quota",
      executedAdapterType: "claude_local", executedModel: "claude-opus-5-5", fallbackReason: null,
    });

    const redispatch = await pending(companyId, "harness_fallback");
    expect(redispatch).toMatchObject({ retryOfRunId: primaryRun.id });
    // A usage-limit fallback is immediate; it does not wait for the provider reset.
    expect(redispatch!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await pending(companyId, "transient_failure")).toBeNull();

    const fallbackRun = await runPending(companyId, "harness_fallback");
    expect(fallbackRun).toMatchObject({
      status: "succeeded",
      executedAdapterType: "codex_local", executedModel: "gpt-5.5", fallbackReason: "provider_usage_limit",
    });
    expect(invocations).toHaveLength(2);
    const [primaryCall, fallbackCall] = invocations;
    expect(primaryCall).toMatchObject({ adapterType: "claude_local", model: "claude-opus-5-5", runId: primaryRun.id });
    expect(primaryCall.envKeys).toContain("ANTHROPIC_BASE_URL");
    expect(fallbackCall).toMatchObject({ adapterType: "codex_local", model: "gpt-5.5", runId: fallbackRun!.id });
    // The fallback runs with its own env only, never the primary's provider routing.
    expect(fallbackCall.envKeys).toContain("CODEX_HOME");
    expect(fallbackCall.envKeys).not.toContain("ANTHROPIC_BASE_URL");

    const [cooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.agentId, agentId));
    expect(cooldown).toMatchObject({ targetKey: "claude_local:claude-opus-5-5", reason: "provider_usage_limit" });
    // The reset time comes from the provider error (epoch suffix), capped at seven days.
    expect(cooldown.cooldownUntil.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const [activated] = await activities(companyId, "agent.harness_fallback_activated");
    expect(activated?.details).toMatchObject({
      from: "claude_local/claude-opus-5-5", to: "codex_local/gpt-5.5", reason: "provider_usage_limit",
    });
    const detail = await db.select({ fallbacks: agents.fallbacks, adapterType: agents.adapterType })
      .from(agents).where(eq(agents.id, agentId));
    expect(detail[0].adapterType).toBe("claude_local");
  });

  it("cools the primary down again when the probe run after a cooldown hits the limit, without a 30 second retry", async () => {
    const { companyId, agentId, issueId } = await seed();
    scripts.claude_local = [{ kind: "usage_limit" }, { kind: "usage_limit" }];
    await assign(agentId, issueId);
    await runPending(companyId, "harness_fallback");
    await db.update(agentHarnessCooldowns).set({ cooldownUntil: new Date(Date.now() - 1_000) });

    await comment(agentId, issueId);

    const probe = (await runs(companyId)).filter((run) => run.executedAdapterType === "claude_local").at(-1)!;
    expect(probe).toMatchObject({ status: "failed", errorCode: "provider_quota" });
    // The return-to-primary activity row is bookkeeping, not useful work.
    expect(await pending(companyId, "transient_failure")).toBeNull();
    const [cooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.targetKey, "claude_local:claude-opus-5-5"));
    expect(cooldown.cooldownUntil.getTime()).toBeGreaterThan(Date.now());
    expect(await pending(companyId, "harness_fallback")).not.toBeNull();
  });

  it("holds a queued wake while every target cools down, keeping its context", async () => {
    const { companyId, agentId, issueId } = await seed();
    const future = new Date(Date.now() + 30 * 60_000);
    await db.insert(agentHarnessCooldowns).values([
      { companyId, agentId, targetKey: "claude_local:claude-opus-5-5", adapterType: "claude_local", model: "claude-opus-5-5", reason: "provider_usage_limit", cooldownUntil: future },
      { companyId, agentId, targetKey: "codex_local:gpt-5.5", adapterType: "codex_local", model: "gpt-5.5", reason: "provider_usage_limit", cooldownUntil: future },
    ]);

    await comment(agentId, issueId);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();

    expect(invocations).toHaveLength(0);
    const [held] = await runs(companyId);
    expect(held).toMatchObject({ status: "queued" });
    expect(held.contextSnapshot).toMatchObject({ issueId, wakeReason: "issue_commented", providerQuotaWaitUntil: future.toISOString() });
    const waitEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, held.id));
    expect(waitEvents.filter((event) => String(event.message).startsWith("Waiting for the provider quota"))).toHaveLength(1);

    await db.update(agentHarnessCooldowns).set({ cooldownUntil: new Date(Date.now() - 1_000) });
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(invocations).toHaveLength(1);
  });

  it("serializes concurrent failures of one target: one activation, one cooldown row", async () => {
    const { companyId, agentId } = await seed();
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    const service = harnessFallbackService(db);
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, status: "failed", invocationSource: "automation" });

    await Promise.all(Array.from({ length: 12 }, () => service.coolDown({
      agent: agentRow, targetKey: "claude_local:claude-opus-5-5", reason: "provider_usage_limit", resetAt: null, sourceRunId,
    })));

    expect(await db.select().from(agentHarnessCooldowns)).toHaveLength(1);
    expect(await activities(companyId, "agent.harness_fallback_activated")).toHaveLength(1);
    const [cooldown] = await db.select().from(agentHarnessCooldowns);
    // Concurrent failures of one outage do not double the backoff.
    expect(Math.round((cooldown.cooldownUntil.getTime() - Date.now()) / 60_000)).toBeLessThanOrEqual(5);
  });

  it("does not apply an issue's primary model override to a fallback run", async () => {
    const { companyId, agentId, issueId } = await seed();
    await db.update(issues).set({ assigneeAdapterOverrides: { adapterConfig: { model: "claude-sonnet-5" } } }).where(eq(issues.id, issueId));
    scripts.claude_local = [{ kind: "usage_limit" }];

    await assign(agentId, issueId);
    const fallbackRun = await runPending(companyId, "harness_fallback");

    expect(invocations[0]).toMatchObject({ adapterType: "claude_local", model: "claude-sonnet-5" });
    expect(fallbackRun).toMatchObject({ status: "succeeded", executedModel: "gpt-5.5" });
    expect(invocations.at(-1)).toMatchObject({ adapterType: "codex_local", model: "gpt-5.5" });
  });

  it("starts a fallback whose credential is a secret reference, binding it to the agent", async () => {
    const { companyId, agentId, issueId } = await seed({ fallbacks: [] });
    const secret = await secretService(db).create(companyId, {
      name: "openai-fallback-key", provider: "local_encrypted", value: "sk-fallback-test-value",
    });
    await agentService(db).update(agentId, {
      fallbacks: [{
        adapterType: "codex_local", model: "gpt-5.5",
        env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      }],
    });
    scripts.claude_local = [{ kind: "usage_limit" }];

    await assign(agentId, issueId);
    const fallbackRun = await runPending(companyId, "harness_fallback");

    expect(fallbackRun).toMatchObject({ status: "succeeded", executedAdapterType: "codex_local" });
    expect(invocations.at(-1)).toMatchObject({ adapterType: "codex_local", env: { OPENAI_API_KEY: "sk-fallback-test-value" } });
  });

  it("re-dispatches only once per wake: a fallback that also hits its limit gets no second fallback", async () => {
    const { companyId, agentId, issueId } = await seed({
      fallbacks: [
        { adapterType: "codex_local", model: "gpt-5.5" },
        { adapterType: "codex_local", model: "gpt-5.4" },
      ],
    });
    scripts.claude_local = [{ kind: "usage_limit" }];
    scripts.codex_local = [{ kind: "usage_limit", noReset: true }];

    await assign(agentId, issueId);
    const fallbackRun = await runPending(companyId, "harness_fallback");
    expect(fallbackRun).toMatchObject({ status: "failed", executedModel: "gpt-5.5" });
    expect(await pending(companyId, "harness_fallback")).toBeNull();
    expect((await runs(companyId)).filter((run) => run.scheduledRetryReason === "harness_fallback")).toHaveLength(1);
    // The failed fallback defers the wake to its cooldown end. It does not hop to the next target 30 seconds later.
    const deferred = await pending(companyId, "transient_failure");
    const [fallbackCooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.targetKey, "codex_local:gpt-5.5"));
    expect(deferred!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(fallbackCooldown.cooldownUntil.getTime());
    expect(invocations.map((call) => call.model)).toEqual(["claude-opus-5-5", "gpt-5.5"]);
    // The failed fallback is cooled down too, so the next wake skips it.
    const keys = (await db.select({ key: agentHarnessCooldowns.targetKey }).from(agentHarnessCooldowns)).map((row) => row.key).sort();
    expect(keys).toEqual(["claude_local:claude-opus-5-5", "codex_local:gpt-5.5"]);
  });

  it("keeps later wakes on the fallback until the cooldown ends, then returns to the primary", async () => {
    const { companyId, agentId, issueId } = await seed();
    scripts.claude_local = [{ kind: "usage_limit" }];
    await assign(agentId, issueId);
    await runPending(companyId, "harness_fallback");

    await comment(agentId, issueId);
    expect(invocations.at(-1)).toMatchObject({ adapterType: "codex_local", model: "gpt-5.5" });

    await db.update(agentHarnessCooldowns).set({ cooldownUntil: new Date(Date.now() - 1_000) });
    await comment(agentId, issueId);
    expect(invocations.at(-1)).toMatchObject({ adapterType: "claude_local", model: "claude-opus-5-5" });
    const latest = (await runs(companyId)).at(-1)!;
    expect(latest).toMatchObject({ executedAdapterType: "claude_local", fallbackReason: null });
    expect(await activities(companyId, "agent.harness_fallback_returned")).toHaveLength(1);

    await comment(agentId, issueId);
    expect(await activities(companyId, "agent.harness_fallback_returned")).toHaveLength(1);
  });

  it("starts a fresh session whenever the harness changes for the issue", async () => {
    const { companyId, agentId, issueId } = await seed();
    scripts.claude_local = [{ kind: "success", sessionId: "claude-session-1" }, { kind: "usage_limit" }];
    await assign(agentId, issueId);
    await comment(agentId, issueId);
    expect(invocations.at(-1)).toMatchObject({ adapterType: "claude_local", sessionId: "claude-session-1" });

    await runPending(companyId, "harness_fallback");
    expect(invocations.at(-1)).toMatchObject({ adapterType: "codex_local", sessionId: null });

    await db.update(agentHarnessCooldowns).set({ cooldownUntil: new Date(Date.now() - 1_000) });
    await comment(agentId, issueId);
    // Back on Claude, the stale pre-fallback session is not resumed.
    expect(invocations.at(-1)).toMatchObject({ adapterType: "claude_local", sessionId: null });
  });

  it.each([
    ["an auth failure", { kind: "auth" } as const, "claude_auth_required"],
    ["a task failure", { kind: "task_failure" } as const, "adapter_failed"],
    ["a usage limit after useful work", { kind: "usage_limit_after_comment" } as const, "provider_quota"],
  ])("does not fall back on %s", async (_label, outcome, errorCode) => {
    const { companyId, agentId, issueId } = await seed();
    scripts.claude_local = [outcome];
    await assign(agentId, issueId);
    expect((await runs(companyId))[0]).toMatchObject({ status: "failed", errorCode });
    expect(await pending(companyId, "harness_fallback")).toBeNull();
    expect(await db.select().from(agentHarnessCooldowns)).toHaveLength(0);
    expect(invocations.map((call) => call.adapterType)).toEqual(["claude_local"]);
  });

  it("falls back on a capacity failure only after the existing bounded retries", async () => {
    const { companyId, agentId, issueId } = await seed();
    scripts.claude_local = [{ kind: "capacity" }, { kind: "capacity" }, { kind: "capacity" }];
    await assign(agentId, issueId);
    expect(await pending(companyId, "harness_fallback")).toBeNull();
    expect((await runPending(companyId, "transient_failure"))?.status).toBe("failed");
    expect(await pending(companyId, "harness_fallback")).toBeNull();
    expect((await runPending(companyId, "transient_failure"))?.status).toBe("failed");

    const fallbackRun = await runPending(companyId, "harness_fallback");
    expect(fallbackRun).toMatchObject({ status: "succeeded", executedAdapterType: "codex_local", fallbackReason: "provider_capacity" });
    expect(invocations.map((call) => call.adapterType)).toEqual(["claude_local", "claude_local", "claude_local", "codex_local"]);
  });

  it("counts the failed primary and its fallback re-dispatch as one run toward maxDailyRuns", async () => {
    const { companyId, agentId, issueId } = await seed({ heartbeat: { maxDailyRuns: 1 } });
    scripts.claude_local = [{ kind: "usage_limit" }];
    await assign(agentId, issueId);
    expect(await runPending(companyId, "harness_fallback")).toMatchObject({ status: "succeeded" });

    // The fallback run spent the one daily run; the next wake is refused.
    const blocked = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual_check", payload: {}, requestedByActorType: "system",
    });
    expect(blocked).toBeNull();
    expect(invocations).toHaveLength(2);
  });

  it("retries an agent without fallbacks on the same harness only after the cooldown", async () => {
    const { companyId, agentId, issueId } = await seed({ fallbacks: [] });
    scripts.claude_local = [{ kind: "usage_limit" }];
    await assign(agentId, issueId);
    expect(await pending(companyId, "harness_fallback")).toBeNull();
    const retry = await pending(companyId, "transient_failure");
    const [cooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.agentId, agentId));
    expect(retry!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(cooldown.cooldownUntil.getTime());
    expect((await runs(companyId))[0]).toMatchObject({ executedAdapterType: "claude_local", executedModel: "claude-opus-5-5" });
  });

  /** Drives the scheduler the way the server tick does, over `minutes` of retry due times. */
  async function tickScheduler(minutes: number) {
    for (let second = 30; second <= minutes * 60; second += 30) {
      await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + second * 1000));
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
  }

  it("does not storm on a proxy quota cooldown: one run per wake, the rest deferred to the reset", async () => {
    const { companyId, agentId, issueId } = await seed({ fallbacks: [], heartbeat: { maxDailyRuns: 5 } });
    scripts.claude_local = Array.from({ length: 40 }, () => ({ kind: "proxy_cooldown_as_transient" as const, withResetBody: true }));

    await assign(agentId, issueId);
    // Production saw 18 runs for one agent in 16 minutes: comment wakes plus 30-second retries.
    for (let wake = 0; wake < 5; wake += 1) await comment(agentId, issueId);
    await tickScheduler(16);

    expect(invocations).toHaveLength(1);
    const all = await runs(companyId);
    const [failed] = all.filter((run) => run.status === "failed");
    expect(failed).toMatchObject({ errorCode: "provider_quota" });
    expect(all.filter((run) => run.status === "failed")).toHaveLength(1);
    // The quota failure cools the harness/model down until the proxy's reset (30 minutes).
    const [cooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.agentId, agentId));
    expect(cooldown).toMatchObject({ targetKey: "claude_local:claude-opus-5-5", reason: "provider_usage_limit" });
    expect(cooldown.cooldownUntil.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    // The wake is deferred, not dropped: one pending run is due at or after the reset.
    const deferred = all.filter((run) => run.status === "scheduled_retry" || run.status === "queued");
    expect(deferred).toHaveLength(1);
    if (deferred[0].status === "scheduled_retry") {
      expect(deferred[0].scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(cooldown.cooldownUntil.getTime());
    }

    // After the reset the deferred wake runs once, and the daily cap was not burned.
    scripts.claude_local = [{ kind: "success" }];
    await db.update(agentHarnessCooldowns).set({ cooldownUntil: new Date(Date.now() - 1_000) });
    await tickScheduler(40);
    expect(invocations).toHaveLength(2);
    expect((await runs(companyId)).filter((run) => run.status === "succeeded")).toHaveLength(1);
  });

  it("defers with a bounded backoff when the provider gives no reset time", async () => {
    const { agentId, issueId } = await seed({ fallbacks: [] });
    scripts.claude_local = [{ kind: "proxy_cooldown_as_transient" }];
    await assign(agentId, issueId);
    const [cooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.agentId, agentId));
    const minutes = (cooldown.cooldownUntil.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4);
    expect(minutes).toBeLessThanOrEqual(5);
  });

  it("refuses to run an Anthropic model through Codex, before the adapter starts", async () => {
    const { companyId, agentId, issueId } = await seed({ adapterType: "codex_local", model: "claude-opus-5-5", fallbacks: [] });
    await assign(agentId, issueId);
    expect((await runs(companyId))[0]).toMatchObject({ status: "failed", errorCode: "harness_model_incompatible" });
    expect(invocations).toHaveLength(0);
    expect(await pending(companyId, "transient_failure")).toBeNull();
  });
});
