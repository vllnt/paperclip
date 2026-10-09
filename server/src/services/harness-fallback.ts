import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentHarnessCooldowns, heartbeatRuns } from "@paperclipai/db";
import {
  ADAPTER_AGNOSTIC_KEYS,
  agentFallbacksSchema,
  checkHarnessModelCompatibility,
  fallbackEffortConfigKey,
  harnessTargetKey,
  type AgentFallbackTarget,
  type AgentHarnessFallbackState,
  type HarnessModelCompatibilityResult,
} from "@paperclipai/shared";
import { isProviderQuotaMessage, parseProviderQuotaResetAt } from "@paperclipai/adapter-utils/provider-quota";
import { fallbackEnvBindingPrefix } from "./agent-secret-bindings.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { isAiAuthenticationFailure } from "./ai-auth-failure.js";

/** Retry reason of the single re-dispatch a quota failure gets on a fallback target. */
export const HARNESS_FALLBACK_RETRY_REASON = "harness_fallback";
export const HARNESS_FALLBACK_WAKE_REASON = "harness_fallback_retry";
/** First backoff when a quota failure names no reset time; it doubles while failures repeat. */
export const QUOTA_BACKOFF_BASE_MINUTES = 5;
export const DEFAULT_QUOTA_BACKOFF_MAX_MINUTES = 60;
export const MAX_QUOTA_BACKOFF_MAX_MINUTES = 1440;
export const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** First wait after the cooldown table cannot be read; it doubles up to the maximum. */
export const COOLDOWN_READ_FAILURE_BASE_MS = 15_000;
export const COOLDOWN_READ_FAILURE_MAX_MS = 5 * 60_000;

const CAPACITY_RE = /at capacity|capacity limit|overloaded|\b529\b|high demand|server is busy/i;
const TRANSIENT_UPSTREAM_CODES = new Set([
  "claude_transient_upstream",
  "codex_transient_upstream",
]);
const RECLASSIFIABLE_QUOTA_CODES = new Set([
  ...TRANSIENT_UPSTREAM_CODES,
  "adapter_failed",
  "provider_quota",
]);

export type QuotaFailureKind = "usage_limit" | "capacity";

export type QuotaFailureDecision =
  | { trigger: false; reason: "not_failed" | "auth" | "useful_work" | "not_quota" }
  | {
      trigger: true;
      kind: QuotaFailureKind;
      resetAt: Date | null;
      requiresRetryExhaustion: boolean;
    };

export interface QuotaFailureInput {
  status: string;
  errorCode: string | null;
  errorFamily: string | null;
  errorMessage: string | null;
  retryNotBefore: Date | null;
  usefulWork: boolean;
}

/**
 * Decides whether a finished run hit a provider quota or capacity limit
 * before useful work. A usage limit cools the harness/model down at once; a
 * capacity failure only after its bounded retries are spent. Auth failures,
 * task failures and runs with useful work never qualify.
 *
 * @param input - The finished run's status, error and useful-work evidence.
 * @param now - Reference time for relative reset durations.
 * @returns The failure kind and reset time, or why the run does not qualify.
 */
export function classifyQuotaFailure(input: QuotaFailureInput, now: Date = new Date()): QuotaFailureDecision {
  if (input.status !== "failed") return { trigger: false, reason: "not_failed" };
  if (isAiAuthenticationFailure(input.errorCode) || isAiAuthenticationFailure(input.errorFamily)) {
    return { trigger: false, reason: "auth" };
  }
  if (input.usefulWork) return { trigger: false, reason: "useful_work" };
  const message = input.errorMessage ?? "";
  const usageLimit = isProviderQuotaMessage(message);
  const capacity = CAPACITY_RE.test(message);
  const quotaFamily = input.errorFamily === "provider_quota" || input.errorCode === "provider_quota";
  const transientFamily =
    input.errorFamily === "transient_upstream" || TRANSIENT_UPSTREAM_CODES.has(input.errorCode ?? "");
  let kind: QuotaFailureKind | null = null;
  if (quotaFamily) {
    kind = capacity && !usageLimit ? "capacity" : "usage_limit";
  } else if (transientFamily) {
    kind = usageLimit ? "usage_limit" : capacity ? "capacity" : null;
  } else if (usageLimit && (input.errorCode === null || input.errorCode === "adapter_failed")) {
    kind = "usage_limit";
  }
  if (!kind) return { trigger: false, reason: "not_quota" };
  return {
    trigger: true,
    kind,
    resetAt: input.retryNotBefore ?? parseProviderQuotaResetAt(message, now),
    requiresRetryExhaustion: kind === "capacity",
  };
}

interface QuotaReclassifiableResult {
  exitCode: number | null;
  timedOut: boolean;
  errorCode?: string | null;
  errorFamily?: string | null;
  errorMessage?: string | null;
  retryNotBefore?: string | null;
  resultJson?: Record<string, unknown> | null;
}

/**
 * Server-side safety net for adapters that report a provider quota as a
 * transient or unclassified failure (for example a credential proxy's
 * "All credentials … are cooling down" 429). Such a result becomes
 * `provider_quota`, with the reset time when the error names one.
 *
 * @param result - The adapter's execution result.
 * @param now - Reference time for relative reset values.
 * @param adapterType - The executing adapter; non-LLM adapters are left alone.
 * @returns The result, reclassified when its error text reports a quota.
 */
export function reclassifyProviderQuotaResult<T extends QuotaReclassifiableResult>(
  result: T,
  now: Date = new Date(),
  adapterType?: string,
): T {
  if (result.timedOut || (result.exitCode ?? 0) === 0 && !result.errorMessage) return result;
  if (adapterType !== undefined && !isLlmHarnessAdapterType(adapterType)) return result;
  if (isAiAuthenticationFailure(result.errorCode) || isAiAuthenticationFailure(result.errorFamily)) return result;
  if (result.errorCode && !RECLASSIFIABLE_QUOTA_CODES.has(result.errorCode)) return result;
  const resultJson = result.resultJson ?? {};
  const text = [result.errorMessage, resultJson.errorMessage, resultJson.stderr]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  if (!isProviderQuotaMessage(text)) return result;
  const retryNotBefore = result.retryNotBefore ?? parseProviderQuotaResetAt(text, now)?.toISOString() ?? null;
  return { ...result, errorCode: "provider_quota", errorFamily: "provider_quota", retryNotBefore };
}

/**
 * The longest backoff used when a quota failure names no reset time.
 *
 * @param runtimeConfig - The agent's runtime config.
 * @returns `heartbeat.quotaBackoffMaxMinutes`, clamped to 1..1440, default 60.
 */
export function readQuotaBackoffMaxMinutes(runtimeConfig: unknown): number {
  const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat);
  const raw = heartbeat?.quotaBackoffMaxMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return DEFAULT_QUOTA_BACKOFF_MAX_MINUTES;
  return Math.min(Math.floor(raw), MAX_QUOTA_BACKOFF_MAX_MINUTES);
}

/**
 * When a cooled-down harness/model may be tried again. A known provider reset
 * wins. Otherwise the backoff starts at five minutes and doubles each time the
 * target fails again soon after its last cooldown ended, up to the maximum. A
 * failure while the target is still cooling down (a run already in flight)
 * keeps the current cooldown.
 *
 * @param input - Current time, provider reset, maximum backoff and the target's previous cooldown.
 * @returns The cooldown end, at most seven days ahead.
 */
export function resolveCooldownUntil(input: {
  now: Date;
  resetAt: Date | null;
  maxBackoffMinutes: number;
  previous: { setAt: Date; until: Date } | null;
}): Date {
  const now = input.now.getTime();
  const limit = now + MAX_COOLDOWN_MS;
  const reset = input.resetAt?.getTime();
  if (reset && reset > now) return new Date(Math.min(reset, limit));
  const previous = input.previous;
  if (previous && previous.until.getTime() > now) return previous.until;
  const maxMs = input.maxBackoffMinutes * 60_000;
  const baseMs = Math.min(QUOTA_BACKOFF_BASE_MINUTES * 60_000, maxMs);
  const recentlyCooled = previous !== null && now - previous.until.getTime() <= maxMs;
  const previousMs = previous ? previous.until.getTime() - previous.setAt.getTime() : 0;
  const backoffMs = recentlyCooled ? Math.min(Math.max(previousMs * 2, baseMs), maxMs) : baseMs;
  return new Date(Math.min(now + backoffMs, limit));
}

export interface HarnessTarget {
  kind: "primary" | "fallback";
  index: number | null;
  adapterType: string;
  model: string | null;
  key: string;
  entry: AgentFallbackTarget | null;
}

export interface HarnessTargetSelection extends HarnessTarget {
  allCoolingDown: boolean;
  /** When every target is cooling down: the earliest time one recovers. */
  heldUntil: Date | null;
}

interface HarnessAgentLike {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  runtimeConfig: Record<string, unknown> | null | undefined;
  fallbacks?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPrimaryModel(agent: HarnessAgentLike): string | null {
  const model = asRecord(agent.adapterConfig)?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

/**
 * Parses stored fallbacks, dropping the list when it no longer validates.
 *
 * @param value - The stored `agents.fallbacks` value.
 * @returns Valid fallback entries, or none.
 */
export function readAgentFallbacks(value: unknown): AgentFallbackTarget[] {
  const parsed = agentFallbacksSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * The agent's harness targets: the primary, then each fallback in order.
 *
 * @param agent - Stored agent configuration.
 * @returns The ordered target list.
 */
export function listHarnessTargets(agent: HarnessAgentLike): HarnessTarget[] {
  const primaryModel = readPrimaryModel(agent);
  const primary: HarnessTarget = {
    kind: "primary",
    index: null,
    adapterType: agent.adapterType,
    model: primaryModel,
    key: harnessTargetKey({ adapterType: agent.adapterType, model: primaryModel }),
    entry: null,
  };
  return [
    primary,
    ...readAgentFallbacks(agent.fallbacks).map((entry, index): HarnessTarget => ({
      kind: "fallback",
      index,
      adapterType: entry.adapterType,
      model: entry.model,
      key: harnessTargetKey(entry),
      entry,
    })),
  ];
}

/**
 * Picks the target a new run should execute on: the first target in order
 * that is not cooling down. When every target is cooling down it returns the
 * primary with the earliest recovery time, and the run must wait.
 *
 * @param agent - Stored agent configuration.
 * @param cooldowns - Cooldown end per target key.
 * @param now - Selection time.
 * @returns The selected target.
 */
export function selectHarnessTarget(
  agent: HarnessAgentLike,
  cooldowns: ReadonlyMap<string, Date>,
  now: Date,
): HarnessTargetSelection {
  const targets = listHarnessTargets(agent);
  const healthy = targets.find((target) => {
    const until = cooldowns.get(target.key);
    return !until || until.getTime() <= now.getTime();
  });
  if (healthy) return { ...healthy, allCoolingDown: false, heldUntil: null };
  const recoveries = targets.map((target) => cooldowns.get(target.key)?.getTime() ?? now.getTime());
  return { ...targets[0], allCoolingDown: true, heldUntil: new Date(Math.min(...recoveries)) };
}

const CARRIED_ENGINE_ADAPTERS = new Set(["claude_local", "codex_local"]);

/** Keys that select a run's model, command line or environment. */
const RUN_TARGET_OVERRIDE_KEYS = new Set([
  "model", "effort", "modelReasoningEffort", "reasoningEffort", "thinking", "variant",
  "env", "extraArgs", "args", "command", "provider",
]);

/**
 * An issue's per-assignee adapter overrides, without the keys that choose the
 * model or environment, when the run executes on a fallback target. Those
 * overrides were written for the primary harness: a per-issue Anthropic model
 * would be refused on Codex, and an env override would replace the fallback's
 * own credentials.
 *
 * @param overrides - The issue's adapterConfig overrides, if any.
 * @param dispatch - The dispatch the run was claimed with.
 * @returns The overrides to merge into the run config.
 */
export function overridesForHarnessTarget(
  overrides: Record<string, unknown> | null | undefined,
  dispatch: { target: "primary" | "fallback" } | null,
): Record<string, unknown> {
  if (!overrides) return {};
  if (dispatch?.target !== "fallback") return overrides;
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => !RUN_TARGET_OVERRIDE_KEYS.has(key)));
}

/**
 * The agent as a fallback target runs it. A fallback keeps the agent's
 * harness-agnostic keys (instructions, prompt, cwd, timeouts, skills) and the
 * CLI engine choice, and replaces harness, model, effort and env. It never
 * inherits the primary's env or AI connection.
 *
 * @param agent - Stored agent.
 * @param target - The selected target.
 * @returns The stored agent for the primary; otherwise a run-only view.
 */
export function buildHarnessTargetAgentView<T extends HarnessAgentLike>(agent: T, target: HarnessTarget): T {
  if (target.kind === "primary" || !target.entry) return agent;
  const entry = target.entry;
  const primaryConfig = asRecord(agent.adapterConfig) ?? {};
  const carried: Record<string, unknown> = {};
  for (const key of ADAPTER_AGNOSTIC_KEYS) {
    if (key !== "env" && primaryConfig[key] !== undefined) carried[key] = primaryConfig[key];
  }
  if (CARRIED_ENGINE_ADAPTERS.has(entry.adapterType) && typeof primaryConfig.engine === "string") {
    carried.engine = primaryConfig.engine;
  }
  const { aiConnection: _aiConnection, ...runtimeConfig } = asRecord(agent.runtimeConfig) ?? {};
  return {
    ...agent,
    adapterType: entry.adapterType,
    adapterConfig: {
      ...carried,
      ...(entry.adapterConfig ?? {}),
      model: entry.model,
      ...(entry.effort ? { [fallbackEffortConfigKey(entry.adapterType)]: entry.effort } : {}),
      env: entry.env ?? {},
    },
    runtimeConfig,
  };
}

/**
 * The binding path prefix for the agent's own env on a claimed dispatch: empty
 * for the primary, `fallbacks[<index>].` for a fallback target.
 *
 * @param agent - The stored agent.
 * @param dispatch - The dispatch the run was claimed with.
 * @returns The prefix to resolve the agent env under.
 */
export function agentEnvBindingPrefix(
  agent: HarnessAgentLike,
  dispatch: { target: "primary" | "fallback"; targetKey: string } | null,
): string | undefined {
  if (!dispatch || dispatch.target !== "fallback") return undefined;
  const target = listHarnessTargets(agent).find((candidate) => candidate.kind === "fallback" && candidate.key === dispatch.targetKey);
  return target?.index != null ? fallbackEnvBindingPrefix(target.index) : undefined;
}

export interface HarnessDispatch {
  adapterType: string;
  model: string | null;
  target: "primary" | "fallback";
  targetKey: string;
  fallbackIndex: number | null;
  fallbackReason: string | null;
}

/**
 * The dispatch record for a run on the agent's primary harness.
 *
 * @param agent - Stored agent.
 * @returns A primary dispatch with no fallback reason.
 */
export function primaryHarnessDispatch(agent: HarnessAgentLike): HarnessDispatch {
  const model = readPrimaryModel(agent);
  return {
    adapterType: agent.adapterType,
    model,
    target: "primary",
    targetKey: harnessTargetKey({ adapterType: agent.adapterType, model }),
    fallbackIndex: null,
    fallbackReason: null,
  };
}

/**
 * Reads the harness target recorded on a run at claim time.
 *
 * @param runnerProfileJson - The run's runner profile.
 * @returns The claimed dispatch, or null for runs claimed before fallbacks existed.
 */
export function readClaimedHarnessDispatch(runnerProfileJson: unknown): HarnessDispatch | null {
  const dispatch = asRecord(asRecord(runnerProfileJson)?.adapterDispatch);
  if (!dispatch || typeof dispatch.adapterType !== "string") return null;
  const target = dispatch.target === "fallback" ? "fallback" : "primary";
  return {
    adapterType: dispatch.adapterType,
    model: typeof dispatch.model === "string" ? dispatch.model : null,
    target,
    targetKey: typeof dispatch.targetKey === "string" ? dispatch.targetKey : harnessTargetKey({
      adapterType: dispatch.adapterType,
      model: typeof dispatch.model === "string" ? dispatch.model : null,
    }),
    fallbackIndex: typeof dispatch.fallbackIndex === "number" ? dispatch.fallbackIndex : null,
    fallbackReason: typeof dispatch.fallbackReason === "string" ? dispatch.fallbackReason : null,
  };
}

/**
 * Rebuilds the run-time agent view from a claimed dispatch.
 *
 * @param agent - The stored agent at execution time.
 * @param dispatch - The dispatch recorded at claim.
 * @returns The agent view to execute, or null when the claimed fallback no longer exists.
 */
export function applyClaimedHarnessDispatch<T extends HarnessAgentLike>(agent: T, dispatch: HarnessDispatch | null): T | null {
  if (!dispatch || dispatch.target === "primary") return agent;
  const target = listHarnessTargets(agent).find(
    (candidate) => candidate.kind === "fallback" && candidate.key === dispatch.targetKey,
  );
  return target ? buildHarnessTargetAgentView(agent, target) : null;
}

/** Local coding harnesses whose `model`, `extraArgs` and `args` select a provider model. */
const LLM_HARNESS_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "grok_local",
  "gemini_local",
  "opencode_local",
  "cursor",
  "pi_local",
  "kimi_local",
  "hermes_local",
]);

/**
 * Whether an adapter runs an LLM coding harness. Quota cooldowns apply to
 * these only: a `process` or `http` agent that prints "usage limit reached"
 * is not out of provider quota.
 *
 * @param adapterType - The adapter type.
 * @returns True for the local LLM harnesses.
 */
export function isLlmHarnessAdapterType(adapterType: string): boolean {
  return LLM_HARNESS_ADAPTER_TYPES.has(adapterType);
}

/**
 * The run-time harness/model check. Fallback targets must use a recognised
 * model for their harness; a primary may keep an unrecognised model id, but
 * no run may pair a harness with a known-incompatible model.
 *
 * @param input - Executing harness, final run config and dispatch kind.
 * @returns The compatibility result.
 */
export function checkRunHarnessCompatibility(input: {
  adapterType: string;
  config: Record<string, unknown>;
  fallback: boolean;
}): HarnessModelCompatibilityResult {
  if (!isLlmHarnessAdapterType(input.adapterType)) return { ok: true };
  return checkHarnessModelCompatibility(
    {
      adapterType: input.adapterType,
      model: typeof input.config.model === "string" ? input.config.model : null,
      extraArgs: input.config.extraArgs,
      args: input.config.args,
    },
    { requireKnownVendor: input.fallback },
  );
}

type CooldownRow = typeof agentHarnessCooldowns.$inferSelect;

interface HarnessFallbackAgent extends HarnessAgentLike {
  id: string;
  companyId: string;
}

function describeTarget(target: { adapterType: string; model: string | null }): string {
  return target.model ? `${target.adapterType}/${target.model}` : target.adapterType;
}

/**
 * Cooldown state and activity for agent harness fallbacks.
 *
 * @param db - Database handle.
 * @returns Operations used by the heartbeat and agent routes.
 */
export function harnessFallbackService(db: Db) {
  const readFailures = new Map<string, { count: number; until: number }>();

  async function listCooldowns(companyId: string, agentId: string): Promise<CooldownRow[]> {
    return db
      .select()
      .from(agentHarnessCooldowns)
      .where(and(eq(agentHarnessCooldowns.companyId, companyId), eq(agentHarnessCooldowns.agentId, agentId)));
  }

  function cooldownMap(rows: CooldownRow[]): Map<string, Date> {
    return new Map(rows.map((row) => [row.targetKey, row.cooldownUntil]));
  }

  /**
   * Chooses the target for a run about to be claimed. `heldUntil` is set when
   * every target is cooling down: the run must wait instead of starting.
   */
  async function resolveDispatch(
    agent: HarnessFallbackAgent,
    now: Date = new Date(),
  ): Promise<{ dispatch: HarnessDispatch; heldUntil: Date | null }> {
    // Fail closed. An unreadable cooldown table during a quota outage must not
    // send runs back at the exhausted target, so every target waits for a
    // bounded, growing window. The table is not read again inside the window,
    // which also keeps the failure to one log line per window.
    const failure = readFailures.get(agent.id);
    if (failure && failure.until > now.getTime()) {
      return { dispatch: primaryHarnessDispatch(agent), heldUntil: new Date(failure.until) };
    }
    let rows: CooldownRow[];
    try {
      rows = await listCooldowns(agent.companyId, agent.id);
    } catch (err) {
      const count = (failure?.count ?? 0) + 1;
      const waitMs = Math.min(COOLDOWN_READ_FAILURE_BASE_MS * 2 ** (count - 1), COOLDOWN_READ_FAILURE_MAX_MS);
      const until = now.getTime() + waitMs;
      readFailures.set(agent.id, { count, until });
      logger.warn(
        { err, agentId: agent.id, consecutiveFailures: count, retryAt: new Date(until).toISOString() },
        "quota cooldowns could not be read; holding this agent's runs until the retry time",
      );
      return { dispatch: primaryHarnessDispatch(agent), heldUntil: new Date(until) };
    }
    readFailures.delete(agent.id);
    if (rows.length === 0) return { dispatch: primaryHarnessDispatch(agent), heldUntil: null };
    const targets = listHarnessTargets(agent);
    const selected = selectHarnessTarget(agent, cooldownMap(rows), now);
    const primaryCooldown = rows.find((row) => row.targetKey === targets[0].key);
    return {
      dispatch: {
        adapterType: selected.adapterType,
        model: selected.model,
        target: selected.kind,
        targetKey: selected.key,
        fallbackIndex: selected.index,
        fallbackReason: selected.kind === "fallback" ? primaryCooldown?.reason ?? "primary_cooling_down" : null,
      },
      heldUntil: selected.heldUntil,
    };
  }

  /** The earliest time any of the agent's targets can run, or null when one can run now. */
  async function heldUntil(agent: HarnessFallbackAgent, now: Date = new Date()): Promise<Date | null> {
    return (await resolveDispatch(agent, now)).heldUntil;
  }

  /**
   * Cools a target down. When the primary newly cools down and a fallback is
   * available, records the switch as `agent.harness_fallback_activated`.
   */
  async function coolDown(input: {
    agent: HarnessFallbackAgent;
    targetKey: string;
    reason: string;
    resetAt: Date | null;
    sourceRunId: string;
    now?: Date;
  }): Promise<{ until: Date | null; nextTarget: HarnessTargetSelection | null }> {
    const now = input.now ?? new Date();
    const targets = listHarnessTargets(input.agent);
    const target = targets.find((candidate) => candidate.key === input.targetKey);
    if (!target) return { until: null, nextTarget: null };
    const { wasActive, until } = await db.transaction(async (tx) => {
      // FOR UPDATE locks nothing when the row does not exist yet, so two
      // concurrent failures of one target would both read "no cooldown".
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.agent.id}:${target.key}`}, 0))`);
      const [existing] = await tx
        .select()
        .from(agentHarnessCooldowns)
        .where(and(eq(agentHarnessCooldowns.agentId, input.agent.id), eq(agentHarnessCooldowns.targetKey, target.key)))
        .for("update");
      const active = Boolean(existing && !existing.returnedAt && existing.cooldownUntil.getTime() > now.getTime());
      const nextUntil = resolveCooldownUntil({
        now,
        resetAt: input.resetAt,
        maxBackoffMinutes: readQuotaBackoffMaxMinutes(input.agent.runtimeConfig),
        previous: existing ? { setAt: existing.updatedAt, until: existing.cooldownUntil } : null,
      });
      const nextCooldownUntil = active && existing && existing.cooldownUntil > nextUntil ? existing.cooldownUntil : nextUntil;
      await tx
        .insert(agentHarnessCooldowns)
        .values({
          companyId: input.agent.companyId,
          agentId: input.agent.id,
          targetKey: target.key,
          adapterType: target.adapterType,
          model: target.model,
          reason: input.reason,
          cooldownUntil: nextCooldownUntil,
          sourceRunId: input.sourceRunId,
          returnedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentHarnessCooldowns.agentId, agentHarnessCooldowns.targetKey],
          set: {
            reason: input.reason,
            cooldownUntil: sql`greatest(${agentHarnessCooldowns.cooldownUntil}, ${nextCooldownUntil.toISOString()}::timestamptz)`,
            sourceRunId: input.sourceRunId,
            returnedAt: null,
            updatedAt: active && existing ? existing.updatedAt : now,
          },
        });
      return { wasActive: active, until: nextCooldownUntil };
    });
    const rows = await listCooldowns(input.agent.companyId, input.agent.id);
    const next = selectHarnessTarget(input.agent, cooldownMap(rows), now);
    const nextTarget = next.kind === "fallback" ? next : null;
    if (target.kind === "primary" && !wasActive && nextTarget) {
      await logActivity(db, {
        companyId: input.agent.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.agent.id,
        runId: input.sourceRunId,
        action: "agent.harness_fallback_activated",
        entityType: "agent",
        entityId: input.agent.id,
        details: {
          from: describeTarget(target),
          to: describeTarget(nextTarget),
          reason: input.reason,
          until: until.toISOString(),
        },
      });
    }
    return { until, nextTarget };
  }

  /**
   * Closes an expired primary cooldown once a run is dispatched on the
   * primary again, logging `agent.harness_fallback_returned` exactly once.
   */
  async function notePrimaryDispatched(agent: HarnessFallbackAgent, runId: string, now: Date = new Date()): Promise<void> {
    const targets = listHarnessTargets(agent);
    if (targets.length === 1) return;
    const primary = targets[0];
    const closed = await db
      .update(agentHarnessCooldowns)
      .set({ returnedAt: now })
      .where(
        and(
          eq(agentHarnessCooldowns.agentId, agent.id),
          eq(agentHarnessCooldowns.targetKey, primary.key),
          sql`${agentHarnessCooldowns.returnedAt} is null`,
          sql`${agentHarnessCooldowns.cooldownUntil} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning();
    if (closed.length === 0) return;
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "system",
      agentId: agent.id,
      runId,
      action: "agent.harness_fallback_returned",
      entityType: "agent",
      entityId: agent.id,
      details: { to: describeTarget(primary), cooledDownSince: closed[0].createdAt.toISOString() },
    });
  }

  /** Deletes every cooldown of an agent so its next run can use any target. */
  async function clearCooldowns(agent: { id: string; companyId: string }): Promise<string[]> {
    const removed = await db
      .delete(agentHarnessCooldowns)
      .where(and(eq(agentHarnessCooldowns.companyId, agent.companyId), eq(agentHarnessCooldowns.agentId, agent.id)))
      .returning({ targetKey: agentHarnessCooldowns.targetKey });
    return removed.map((row) => row.targetKey);
  }

  /** The "on fallback until …" state shown on the agent. */
  async function getAgentState(agent: HarnessFallbackAgent, now: Date = new Date()): Promise<AgentHarnessFallbackState | null> {
    const targets = listHarnessTargets(agent);
    const rows = await listCooldowns(agent.companyId, agent.id);
    const primaryCooldown = rows.find((row) => row.targetKey === targets[0].key);
    if (!primaryCooldown || primaryCooldown.cooldownUntil.getTime() <= now.getTime()) return null;
    const selected = selectHarnessTarget(agent, cooldownMap(rows), now);
    return {
      active: selected.kind === "fallback",
      adapterType: selected.adapterType,
      model: selected.model,
      reason: primaryCooldown.reason,
      primaryCooldownUntil: primaryCooldown.cooldownUntil.toISOString(),
      heldUntil: selected.heldUntil?.toISOString() ?? null,
    };
  }

  /** The harness of the agent's latest earlier run on an issue, if it was recorded. */
  async function previousIssueHarness(agent: HarnessFallbackAgent, issueId: string, excludeRunId: string): Promise<string | null> {
    const [previous] = await db
      .select({ adapterType: heartbeatRuns.executedAdapterType })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          ne(heartbeatRuns.id, excludeRunId),
          isNotNull(heartbeatRuns.executedAdapterType),
          isNotNull(heartbeatRuns.startedAt),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(1);
    return previous?.adapterType ?? null;
  }

  return { listCooldowns, clearCooldowns, resolveDispatch, heldUntil, coolDown, notePrimaryDispatched, getAgentState, previousIssueHarness };
}
