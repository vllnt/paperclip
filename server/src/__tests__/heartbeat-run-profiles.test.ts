import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentHarnessCooldowns,
  agents,
  companies,
  companySecretBindings,
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
import { instanceSettingsService } from "../services/instance-settings.js";
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

describeEmbeddedPostgres("run profiles", () => {
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


  async function secretNamed(companyId: string, name: string, value: string) {
    return secretService(db).create(companyId, { name, provider: "local_encrypted", value });
  }

  async function coolDownTargets(companyId: string, agentId: string, keys: string[]) {
    await db.insert(agentHarnessCooldowns).values(keys.map((targetKey) => {
      const [adapterType, model] = targetKey.split(":");
      return { companyId, agentId, targetKey, adapterType, model, reason: "provider_usage_limit", cooldownUntil: new Date(Date.now() + 30 * 60_000) };
    }));
  }

  /** Makes every read of the cooldown table throw, like a database error during an outage. */

  const FAST_TIER = { adapterType: "codex_local" as const, model: "grok-4.7", effort: "low" };

  async function setTiers(companyId: string) {
    await instanceSettingsService(db).updateGeneral({
      companyRunTiers: {
        [companyId]: { tiers: { fast: FAST_TIER, standard: { adapterType: "claude_local", model: "claude-sonnet-5-5" } }, agentAllowlist: ["fast"] },
      },
    });
  }

  async function setOverrides(issueId: string, overrides: Record<string, unknown>) {
    await db.update(issues).set({ assigneeAdapterOverrides: overrides }).where(eq(issues.id, issueId));
  }

  async function dispatchOf(runId: string) {
    const [row] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return (row?.profile as { adapterDispatch?: Record<string, unknown> } | null)?.adapterDispatch ?? null;
  }

  afterEach(async () => {
    await instanceSettingsService(db).updateGeneral({ companyRunTiers: {} });
  });

  it("runs an issue's model-only profile on the agent's own harness and records the source", async () => {
    const { companyId, agentId, issueId } = await seed();
    await setOverrides(issueId, { runProfile: { model: "claude-sonnet-5-5", effort: "low" } });

    await assign(agentId, issueId);

    const [run] = await runs(companyId);
    expect(run).toMatchObject({ status: "succeeded", executedAdapterType: "claude_local", executedModel: "claude-sonnet-5-5", fallbackReason: null });
    expect(await dispatchOf(run.id)).toMatchObject({ source: "issue_profile", target: "profile" });
    expect(invocations[0]).toMatchObject({ adapterType: "claude_local", model: "claude-sonnet-5-5" });
    expect(invocations[0].env).toMatchObject({ ANTHROPIC_BASE_URL: "http://proxy.invalid" });
  });

  it("records agent_default when the issue has no profile", async () => {
    const { companyId, agentId, issueId } = await seed();
    await assign(agentId, issueId);
    const [run] = await runs(companyId);
    expect(await dispatchOf(run.id)).toMatchObject({ source: "agent_default", target: "primary" });
    expect(invocations[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("switches harness for a company tier with the agent's own credentials for that harness, never the primary's env", async () => {
    const { companyId, agentId, issueId } = await seed({ fallbacks: [] });
    const key = await secretNamed(companyId, "openai-profile-key", "sk-profile-value");
    await agentService(db).update(agentId, {
      fallbacks: [{ adapterType: "codex_local", model: "gpt-5.5", env: { OPENAI_API_KEY: { type: "secret_ref", secretId: key.id }, CODEX_HOME: "/srv/codex-home" } }],
    });
    await setTiers(companyId);
    await setOverrides(issueId, { runProfile: { tier: "fast" } });

    await assign(agentId, issueId);

    const [run] = await runs(companyId);
    expect(run).toMatchObject({ status: "succeeded", executedAdapterType: "codex_local", executedModel: "grok-4.7" });
    expect(await dispatchOf(run.id)).toMatchObject({ source: "issue_profile", target: "profile", crossHarness: true });
    expect(invocations[0]).toMatchObject({ adapterType: "codex_local", model: "grok-4.7", env: { OPENAI_API_KEY: "sk-profile-value", CODEX_HOME: "/srv/codex-home" } });
    expect(invocations[0].envKeys).not.toContain("ANTHROPIC_BASE_URL");
  });

  it("runs on the agent default when a tier is unknown or the agent lacks credentials for the harness", async () => {
    const { companyId, agentId, issueId } = await seed({ fallbacks: [] });
    await setTiers(companyId);
    await setOverrides(issueId, { runProfile: { tier: "turbo" } });
    await assign(agentId, issueId);
    expect(invocations.at(-1)).toMatchObject({ adapterType: "claude_local", model: "claude-opus-5-5" });

    await setOverrides(issueId, { runProfile: { tier: "fast" } });
    await comment(agentId, issueId);
    // codex_local has no fallback entry on this agent, so there are no credentials to switch to.
    expect(invocations.at(-1)).toMatchObject({ adapterType: "claude_local", model: "claude-opus-5-5" });
    const latest = (await runs(companyId)).at(-1)!;
    expect(await dispatchOf(latest.id)).toMatchObject({ source: "agent_default" });
  });

  it("keeps a legacy adapterConfig model override working and reads it as an issue profile", async () => {
    const { companyId, agentId, issueId } = await seed();
    await setOverrides(issueId, { adapterConfig: { model: "claude-sonnet-5-5" } });
    await assign(agentId, issueId);
    const [run] = await runs(companyId);
    expect(invocations[0]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(run).toMatchObject({ executedModel: "claude-sonnet-5-5" });
    expect(await dispatchOf(run.id)).toMatchObject({ source: "issue_profile" });
  });

  it("falls through the chain on a quota error: cools the profile target down, re-dispatches once, and does not retry it at once", async () => {
    const { companyId, agentId, issueId } = await seed({ fallbacks: [{ adapterType: "codex_local", model: "gpt-5.5", env: { CODEX_HOME: "/srv/codex-home" } }] });
    await setOverrides(issueId, { runProfile: { model: "claude-sonnet-5-5" } });
    scripts.claude_local = [{ kind: "usage_limit" }];

    await assign(agentId, issueId);

    const [failed] = await runs(companyId);
    expect(failed).toMatchObject({ status: "failed", executedModel: "claude-sonnet-5-5", errorCode: "provider_quota" });
    expect(await pending(companyId, "transient_failure")).toBeNull();
    const [cooldown] = await db.select().from(agentHarnessCooldowns).where(eq(agentHarnessCooldowns.agentId, agentId));
    expect(cooldown).toMatchObject({ targetKey: "claude_local:claude-sonnet-5-5" });

    // The next target in the chain is the agent's own primary, not the exhausted profile target.
    const redispatched = await runPending(companyId, "harness_fallback");
    expect(redispatched).toMatchObject({ status: "succeeded", executedModel: "claude-opus-5-5" });
    expect(await dispatchOf(redispatched!.id)).toMatchObject({ source: "fallback", target: "primary" });
    expect(invocations.map((call) => call.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);

    // Later wakes skip the cooled-down profile target until its cooldown ends, then use it again.
    await comment(agentId, issueId);
    expect(invocations.at(-1)).toMatchObject({ model: "claude-opus-5-5" });
    await db.update(agentHarnessCooldowns).set({ cooldownUntil: new Date(Date.now() - 1_000) });
    await comment(agentId, issueId);
    expect(invocations.at(-1)).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("runs a Grok model on a codex_local task through the legacy override as before", async () => {
    const { companyId, agentId, issueId } = await seed({ adapterType: "codex_local", model: "gpt-5.5", fallbacks: [] });
    await setOverrides(issueId, { adapterConfig: { model: "grok-4.7" } });
    await assign(agentId, issueId);
    const [run] = await runs(companyId);
    expect(run).toMatchObject({ status: "succeeded", executedAdapterType: "codex_local", executedModel: "grok-4.7" });
    expect(invocations[0]).toMatchObject({ adapterType: "codex_local", model: "grok-4.7" });
  });
});
