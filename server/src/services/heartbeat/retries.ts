import { deriveTaskKeyWithHeartbeatFallback } from "./run-state.js";
import {
  WORKSPACE_VALIDATION_FAILURE_CODE,
  isWorkspaceValidationFailedRun,
  readWorkspaceValidationPayloadFromRun,
} from "./workspaces.js";
import { admitExplicitContinuationRetry } from "../explicit-native-continuation.js";
import {
  CONVERSATION_CONTINUATION_POLICY,
  hasConversationContinuationPolicy,
} from "../conversation-continuation.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../legacy-execution-recovery.js";
import {
  executionFailureRetryCount,
  executionRetryAttemptCount,
  accountingForScheduledRetry,
} from "../execution-recovery-attempt.js";
import { WORKSPACE_GIT_SCAN_ERROR_CODES } from "../workspace-git-operation-scheduler.js";
import { CONTROLLER_LEASE_LOST_FAILURE_CODE } from "../legacy-controller-lease.js";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  routines,
} from "@paperclipai/db";
import {
  resolveTransientRetryPolicy,
  type ResolvedTransientRetryPolicy,
} from "@paperclipai/shared";
import { REMOTE_PREFLIGHT_UNAVAILABLE_CODE } from "@paperclipai/adapter-utils/execution-target";
import {
  HttpError,
  notFound,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { asBoolean, asNumber, parseObject } from "../../adapters/utils.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
  type LogActivityInput,
} from "../activity-log.js";
import {
  executeIssuePostCommitActions,
  type IssuePostCommitAction,
  type issueService,
} from "../issues.js";
import { issueIdEqualsText } from "../issue-id-match.js";
import {
  COOLDOWN_READ_FAILURE_BASE_MS,
  HARNESS_FALLBACK_RETRY_REASON,
  HARNESS_FALLBACK_WAKE_REASON,
  classifyQuotaFailure,
  isLlmHarnessAdapterType,
  primaryHarnessDispatch,
  readAgentFallbacks,
  readClaimedHarnessDispatch,
  type harnessFallbackService,
  type ProfileTargetInput,
} from "../harness-fallback.js";
import type { NativeRuntimeResolution } from "../native-runtime/runtime-mode.js";
import { readContinuationAttempt } from "../recovery/index.js";
import { PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS } from "../recovery/service.js";
import { withRecoveryContext } from "../recovery/status-only-context.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON,
  AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
} from "../../modules/run-dispatch/index.js";

import type { AppendHeartbeatRunEventInput } from "../heartbeat-run-events.js";
import type { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import type { createHeartbeatRunState, DailyRunUsage } from "./run-state.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import type { CancelRunOptions } from "./run-control.js";
import type {
  createRunDispatch,
  PostCommitEffect,
  RetryAdmissionPolicy,
} from "../../modules/run-dispatch/index.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type HeartbeatRunState = ReturnType<typeof createHeartbeatRunState>;
type PlanApprovalResumeFailure = {
  run: HeartbeatRun;
  issueId: string | null;
  attempt: number;
  maxAttempts: number;
};

/** The retry module owns scheduling writes; the service owns lifecycle effects. */
export interface HeartbeatRetryDependencies {
  runDispatch: Pick<ReturnType<typeof createRunDispatch>,
    "evaluateScheduledRetryGate" | "promoteDueScheduledRetries" | "promoteScheduledRetry">;
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null | undefined>;
  getRun: (
    runId: string,
    options?: Parameters<HeartbeatRunState["getRun"]>[1],
  ) => Promise<Awaited<ReturnType<HeartbeatRunState["getRun"]>> | null | undefined>;
  resolveSessionBeforeForWakeup: HeartbeatRunState["resolveSessionBeforeForWakeup"];
  resolveResponsibleUserIdForRunContext: ReturnType<typeof createHeartbeatRunPreparation>["resolveResponsibleUserIdForRunContext"];
  getAgentInvokability: (agent: typeof agents.$inferSelect | null | undefined) => ReturnType<typeof evaluateAgentInvokabilityFromDb>;
  appendRunEvent: (run: HeartbeatRun, event: {
    eventType: string;
    stream?: "system" | "stdout" | "stderr";
    level?: "info" | "warn" | "error";
    color?: string;
    message?: string;
    payload?: Record<string, unknown>;
    retryExhaustion?: AppendHeartbeatRunEventInput["retryExhaustion"];
  }) => Promise<unknown>;
  escalatePlanApprovalResumeFailureNeedsAttention: (input: PlanApprovalResumeFailure) => Promise<string | null>;
  recordPlanApprovalResumeFailureRetry: (input: PlanApprovalResumeFailure & { retryRunId: string | null }) => Promise<string | null>;
  setRunStatusIfRunning: (runId: string, status: string, patch?: Partial<typeof heartbeatRuns.$inferInsert>) => Promise<{
    updated: boolean;
    run: HeartbeatRun | null;
  }>;
  setWakeupStatus: (wakeupRequestId: string | null | undefined, status: string, patch?: Partial<typeof agentWakeupRequests.$inferInsert>) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: Pick<HeartbeatRun, "id" | "companyId">) => Promise<unknown>;
  finalizeAgentStatus: (
    agentId: string,
    outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ) => Promise<void>;
  getWorktreeExecutionCutoff: () => Promise<Date | null>;
  applyRunDispatchPostCommitEffects: (effects: PostCommitEffect[]) => void;
  // The provider-quota and harness-fallback retry paths.
  issuesSvc: Pick<ReturnType<typeof issueService>, "update" | "addComment">;
  harnessFallback: Pick<ReturnType<typeof harnessFallbackService>, "heldUntil" | "coolDown">;
  cancelRunInternal: (runId: string, reason?: string, options?: CancelRunOptions) => Promise<unknown>;
  /** Run-state: the agent's runs in one UTC day, as `maxDailyRuns` counts them. */
  computeDailyRunUsage: (
    companyId: string,
    options?: { agentId?: string; excludeRunId?: string | null; window?: { start: Date; end: Date } },
  ) => Promise<Map<string, DailyRunUsage>>;
  /** Run-preparation: the run profile an issue gives its assignee's run. */
  resolveRunProfileForRun: (
    run: HeartbeatRun,
    agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType">,
  ) => Promise<ProfileTargetInput | null>;
  buildRunLivenessInput: ReturnType<typeof createHeartbeatLifecycle>["buildRunLivenessInput"];
  /** Queue: holds an automation wake while the agent's coalescing window is open. */
  admitThroughAutomationWindow: (
    txDb: Db,
    input: {
      companyId: string;
      agentId: string;
      reason: string | null;
      issueId: string | null;
      now: Date;
      excludeRunId?: string;
      nonblocking?: boolean;
    },
  ) => Promise<{ hold: true; holdUntil: Date } | { hold: false; admittedAt?: Date }>;
}

export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS = [
  30_000, 30_000,
] as const;

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO = 0;

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON = "transient_failure";

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON = "transient_failure_retry";

export function isTransientWorkspaceGitScanCode(code: string | null | undefined): boolean {
  return code === WORKSPACE_GIT_SCAN_ERROR_CODES.timeout || code === WORKSPACE_GIT_SCAN_ERROR_CODES.saturated;
}

// Pre-dispatch failures that a bounded retry can clear. The issue keeps its
// status while the scheduled retry is pending; after the budget it is handled
// like any other non-retryable setup failure.
export function isTransientSetupFailureCode(code: string | null | undefined): boolean {
  return isTransientWorkspaceGitScanCode(code) || code === REMOTE_PREFLIGHT_UNAVAILABLE_CODE;
}

// A workspace restore or agent directory lock that no queue progress released
// in time. Contention clears on its own, so the run is retried under the
// bounded transient budget instead of ending as a plain `adapter_failed`.
export const WORKSPACE_RESTORE_LOCK_TIMEOUT_FAILURE_CODE = "workspace_restore_lock_timeout";

export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS =
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length;

const INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS = 2;

const MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES = [
  "scheduled_retry",
  "queued",
  "running",
] as const;

export const WORKSPACE_BUSY_RETRY_WAKE_REASON = "workspace_busy_retry";

export const WORKSPACE_BUSY_ERROR_CODE = "workspace_busy";

export const WORKSPACE_BUSY_RETRY_BASE_DELAY_MS = 60 * 1000;

export const WORKSPACE_BUSY_RETRY_JITTER_MS = 60 * 1000;

// Preserve the one-hour shared-workspace holder cutoff independently of the
// informational output-silence warnings. Warning sooner must not let another
// run overtake a quiet holder and mutate its shared workspace.
export const WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS = 60 * 60 * 1000;

// Issue-level executionWorkspaceSettings.mode values that unambiguously opt an
// issue's runs out of the shared project workspace, and therefore out of
// shared-workspace serialization ("isolated" is the legacy alias
// parseIssueExecutionWorkspaceSettings normalizes to isolated_workspace). Any
// other value — including agent_default and an absent mode — may still resolve
// to the shared workspace and counts as a holder.
const ISOLATED_EXECUTION_WORKSPACE_MODES = [
  "isolated_workspace",
  "operator_branch",
  "isolated",
] as const;

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

export interface SharedWorkspaceHolder {
  runId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string | null;
}

export interface ExecutionWorkspaceHolder extends SharedWorkspaceHolder {
  // Silent past WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS but still running.
  stale: boolean;
}

// Pre-dispatch gate outcome: another running run currently holds the issue's
// shared project workspace, or the shared execution workspace it reuses. Not a
// failure — the run is parked as a bounded scheduled retry and re-attempted
// once the holder finishes, so two agents never mutate the same working tree
// concurrently.
export class WorkspaceBusyDeferral extends Error {
  code = WORKSPACE_BUSY_ERROR_CODE;
  holder: SharedWorkspaceHolder;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  deferralAttempt: number;
  wasIssueAssignee: boolean;

  constructor(input: {
    holder: SharedWorkspaceHolder;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
    deferralAttempt: number;
    wasIssueAssignee: boolean;
  }) {
    super(
      `Shared ${input.executionWorkspaceId ? "execution" : "project"} workspace is busy: run ${input.holder.runId} (issue ${
        input.holder.issueIdentifier ?? input.holder.issueId
      }) is still running`,
    );
    this.name = "WorkspaceBusyDeferral";
    this.holder = input.holder;
    this.projectWorkspaceId = input.projectWorkspaceId ?? null;
    this.executionWorkspaceId = input.executionWorkspaceId ?? null;
    this.deferralAttempt = input.deferralAttempt;
    this.wasIssueAssignee = input.wasIssueAssignee;
  }
}

export function isWorkspaceBusyDeferral(
  error: unknown,
): error is WorkspaceBusyDeferral {
  return error instanceof WorkspaceBusyDeferral;
}

export function computeWorkspaceBusyRetryDelayMs(
  random: () => number = Math.random,
) {
  const jitter = Math.min(Math.max(random(), 0), 1);
  return (
    WORKSPACE_BUSY_RETRY_BASE_DELAY_MS +
    Math.floor(jitter * WORKSPACE_BUSY_RETRY_JITTER_MS)
  );
}

function resolveCodexTransientFallbackMode(
  attempt: number,
): CodexTransientFallbackMode {
  if (attempt <= 1) return "same_session";
  if (attempt === 2) return "safer_invocation";
  if (attempt === 3) return "fresh_session";
  return "fresh_session_safer_invocation";
}

/**
 * The persisted, adapter-set errorCode wins over a family carried in the run
 * result. Only that errorCode can claim provider_quota, because the family
 * unlocks the provider-quota retry lane and its cap exemption.
 */
export function readHeartbeatRunErrorFamily(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  if (run.errorCode === "provider_quota") {
    return "provider_quota";
  }
  if (
    run.errorCode === "codex_transient_upstream" ||
    run.errorCode === "claude_transient_upstream" ||
    run.errorCode === "grok_transient_upstream" ||
    run.errorCode === "codex_harness_crash"
  ) {
    return "transient_upstream";
  }
  const persistedFamily = readNonEmptyString(
    parseObject(run.resultJson).errorFamily,
  );
  return persistedFamily === "provider_quota" ? null : persistedFamily;
}

function readTransientRetryNotBeforeFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const value = resultJson.retryNotBefore ?? resultJson.transientRetryNotBefore;
  if (!(
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Date
  )) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readTransientRecoveryContractFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const errorFamily = readHeartbeatRunErrorFamily(run);
  return errorFamily === "transient_upstream" ||
    errorFamily === "provider_quota"
    ? {
        errorFamily,
        retryNotBefore: readTransientRetryNotBeforeFromRun(run),
      }
    : null;
}

function isSpawnLikeFailureMessage(value: unknown) {
  if (typeof value !== "string") return false;
  return /failed to start command|spawn\b|\bENOENT\b/i.test(value);
}

// A sandbox provider plugin's worker can be briefly down during its own
// restart window (e.g. a rolling deploy of the plugin worker process). Lease
// acquisition fails immediately in that window, but the condition is
// transient and self-healing, so it must be treated as retryable
// infrastructure rather than a terminal setup failure. See
// resolveSandboxProviderPlugin's "worker_unavailable" message in
// environment-runtime.ts (":808"), e.g. 'Sandbox provider "kubernetes" is
// installed via plugin "acme.kubernetes-sandbox-provider", but its worker is
// not running.'
//
// This is anchored on both "is installed via plugin" and "but its worker is
// not running" so it does not also match plugin-environment-driver.ts's
// unrelated, permanent "provider not installed" message ('Sandbox provider
// "X" is not installed or its plugin worker is not running.'), which
// coincidentally contains the same "worker is not running" substring but
// describes a terminal condition that must not be retried.
function isSandboxProviderWorkerUnavailableFailureMessage(value: unknown) {
  if (typeof value !== "string") return false;
  return /sandbox provider .* is installed via plugin .* but its worker is not running/i.test(
    value,
  );
}

function isRetryableInteractionContinuationInfrastructureFailure(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "error" | "errorCode" | "resultJson"
  >,
) {
  // `controller_lease_lost` is only recorded before provider dispatch, so the
  // retry cannot repeat started work.
  if (
    run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE ||
    run.errorCode === "process_lost" ||
    run.errorCode === CONTROLLER_LEASE_LOST_FAILURE_CODE
  ) {
    return true;
  }

  if (run.errorCode !== "adapter_failed" && run.errorCode !== "setup_failed")
    return false;

  const resultJson = parseObject(run.resultJson);
  return (
    isSpawnLikeFailureMessage(run.error) ||
    isSpawnLikeFailureMessage(resultJson.errorMessage) ||
    isSpawnLikeFailureMessage(resultJson.message) ||
    isSandboxProviderWorkerUnavailableFailureMessage(run.error) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.errorMessage) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.message)
  );
}

export function computeBoundedTransientHeartbeatRetrySchedule(
  attempt: number,
  now = new Date(),
  random: () => number = Math.random,
) {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const baseDelayMs = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[attempt - 1];
  if (typeof baseDelayMs !== "number") return null;
  const sample = Math.min(1, Math.max(0, random()));
  const jitterMultiplier =
    1 + (sample * 2 - 1) * BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO;
  const delayMs = Math.max(1_000, Math.round(baseDelayMs * jitterMultiplier));
  return {
    attempt,
    baseDelayMs,
    delayMs,
    dueAt: new Date(now.getTime() + delayMs),
    maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  };
}

// A provider that rejects a turn for capacity (for example Codex "Selected
// model is at capacity") stays unavailable for minutes to hours. Two 30-second
// retries land inside the same burst, so a failure before any useful action
// gets its own backoff and does not spend heartbeat.maxDailyRuns.
const PROVIDER_QUOTA_RETRY_BASE_DELAY_MS = 60 * 1000;
const PROVIDER_QUOTA_RETRY_MAX_BACKOFF_DELAY_MS = 30 * 60 * 1000;
const PROVIDER_QUOTA_RETRY_JITTER_RATIO = 0.2;
const PROVIDER_QUOTA_CAP_EXEMPTION_EXHAUSTED_ACTION =
  "heartbeat.provider_quota_cap_exemption_exhausted";
const PROVIDER_QUOTA_EXHAUSTED_ACTION = "heartbeat.provider_quota_exhausted";

export interface ProviderQuotaRetryPolicy {
  /** False restores the default transient retry budget and charges every quota failure. */
  enabled: boolean;
  /** Backoff attempts before the chain drops to the hourly recovery cadence. */
  maxAttempts: number;
  /** Backoff window measured from the chain's first quota failure. */
  windowMs: number;
  /** Hard ceiling: retries in the chain, backoff and hourly phases together. */
  maxTotalAttempts: number;
  /** Hard ceiling: no retry is scheduled later than this after the chain's first failure. */
  maxRetryMs: number;
  /** Per agent and UTC day: quota failures exempt from maxDailyRuns. Later ones count. */
  maxDailyUncountedRuns: number;
}

/**
 * An agent with a harness fallback chain is gated by its per-target harness
 * cooldowns, which end at the provider's reset and let one run probe the
 * primary. The shared provider-quota lane would hold that probe a second time
 * on its own backoff, and would stretch a capacity failure's retries to its
 * hours-long ceiling before the chain could take over. The lane applies to
 * agents without a chain.
 */
export function usesHarnessFallbackChain(agent: Pick<typeof agents.$inferSelect, "fallbacks">) {
  return readAgentFallbacks(agent.fallbacks).length > 0;
}

/**
 * Groups provider-quota probes: the adapter and its configured model, so a
 * model at capacity does not hold back agents on another model.
 */
export function providerQuotaKeyForAgent(
  agent: Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">,
) {
  const model = readNonEmptyString(parseObject(agent.adapterConfig).model);
  return model ? `${agent.adapterType}:${model}` : agent.adapterType;
}

/** Reads `runtimeConfig.heartbeat.providerQuotaRetry`. */
export function parseProviderQuotaRetryPolicy(value: unknown): ProviderQuotaRetryPolicy {
  const configured = parseObject(value);
  const bounded = (raw: unknown, fallback: number, max: number) =>
    Math.max(0, Math.min(max, Math.floor(asNumber(raw, fallback))));
  return {
    enabled: asBoolean(configured.enabled, true),
    maxAttempts: bounded(configured.maxAttempts, 8, 50),
    windowMs: bounded(configured.windowMinutes, 120, 24 * 60) * 60 * 1000,
    maxTotalAttempts: bounded(configured.maxTotalAttempts, 24, 500),
    maxRetryMs: bounded(configured.maxRetryHours, 24, 7 * 24) * 60 * 60 * 1000,
    maxDailyUncountedRuns: bounded(configured.maxDailyUncountedRuns, 48, 1000),
  };
}

/** The agent's provider-quota retry policy, as its heartbeat policy reads it. */
export function readAgentProviderQuotaRetryPolicy(
  agent: Pick<typeof agents.$inferSelect, "runtimeConfig">,
): ProviderQuotaRetryPolicy {
  const heartbeat = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  return parseProviderQuotaRetryPolicy(heartbeat.providerQuotaRetry);
}

/**
 * Schedules the next retry after a provider-quota failure that happened
 * before any useful action. Delays double from one minute up to thirty, with
 * ±20% jitter, while both the attempt budget and the window that started with
 * the chain's first failure hold. After that the chain probes at the hourly
 * quota-recovery cadence until a hard ceiling: `maxTotalAttempts` retries or
 * `maxRetryMs` after the first failure, whichever comes first.
 *
 * @returns The schedule, or null for an invalid attempt number or once the
 *   next retry would pass either ceiling.
 */
export function computeProviderQuotaRetrySchedule(input: {
  attempt: number;
  now: Date;
  chainStartedAt: Date;
  policy: ProviderQuotaRetryPolicy;
  random?: () => number;
}) {
  const { attempt, now, policy } = input;
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const backoffDelayMs = Math.min(
    PROVIDER_QUOTA_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    PROVIDER_QUOTA_RETRY_MAX_BACKOFF_DELAY_MS,
  );
  const phase: "backoff" | "slow" =
    attempt <= policy.maxAttempts &&
    now.getTime() + backoffDelayMs <=
      input.chainStartedAt.getTime() + policy.windowMs
      ? "backoff"
      : "slow";
  const baseDelayMs =
    phase === "backoff" ? backoffDelayMs : PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS;
  const sample = Math.min(1, Math.max(0, (input.random ?? Math.random)()));
  const delayMs = Math.round(
    baseDelayMs * (1 + (sample * 2 - 1) * PROVIDER_QUOTA_RETRY_JITTER_RATIO),
  );
  const dueAt = new Date(now.getTime() + delayMs);
  if (
    attempt > policy.maxTotalAttempts ||
    dueAt.getTime() > input.chainStartedAt.getTime() + policy.maxRetryMs
  ) {
    return null;
  }
  return {
    attempt,
    baseDelayMs,
    delayMs,
    dueAt,
    maxAttempts: policy.maxTotalAttempts,
    phase,
  };
}

/**
 * How long a provider lane in quota state waits after its latest quota failure
 * before the next probe: the chain backoff (1, 2, 4 … minutes up to 30, then
 * the hourly cadence past the backoff window) for probe number
 * `failedProbes + 1`, without jitter. The per-chain ceilings do not apply: the
 * lane keeps probing, one run at a time, until the provider answers.
 *
 * @returns The delay in milliseconds.
 */
export function computeProviderQuotaLaneProbeDelayMs(input: {
  failedProbes: number;
  lastFailureAt: Date;
  stateStartedAt: Date;
  policy: ProviderQuotaRetryPolicy;
}) {
  return (
    computeProviderQuotaRetrySchedule({
      attempt: Math.max(0, Math.floor(input.failedProbes)) + 1,
      now: input.lastFailureAt,
      chainStartedAt: input.stateStartedAt,
      policy: {
        ...input.policy,
        maxTotalAttempts: Number.MAX_SAFE_INTEGER,
        maxRetryMs: Number.MAX_SAFE_INTEGER,
      },
      random: () => 0.5,
    })?.baseDelayMs ?? PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS
  );
}

/**
 * The checks that need no database: a failed legacy run in the
 * provider_quota family whose model returned no output. Native runs are
 * excluded because native recovery owns their retries.
 *
 * @returns True when the run still needs the durable-evidence check.
 */
export function isProviderQuotaUsefulActionCandidate(input: {
  outcome: string;
  runtimeKind: NativeRuntimeResolution["kind"];
  outputTokens: number;
  errorCode: string | null;
  resultJson: Record<string, unknown> | null;
}) {
  return (
    input.outcome === "failed" &&
    input.runtimeKind !== "native" &&
    input.outputTokens === 0 &&
    readHeartbeatRunErrorFamily({
      errorCode: input.errorCode,
      resultJson: input.resultJson,
    }) === "provider_quota"
  );
}

/** Start of the current UTC day, the window `maxDailyRuns` and its alarms use. */
function currentUtcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dateValue(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Retry persistence uses the service database and explicit lifecycle callbacks. */
export function createHeartbeatRetries(db: Db, dependencies: HeartbeatRetryDependencies) {
  const {
    appendRunEvent,
    escalatePlanApprovalResumeFailureNeedsAttention,
    getAgentInvokability,
    runDispatch,
    resolveSessionBeforeForWakeup,
    resolveResponsibleUserIdForRunContext,
    recordPlanApprovalResumeFailureRetry,
    setRunStatusIfRunning,
    setWakeupStatus,
    getRun,
    getAgent,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    getWorktreeExecutionCutoff,
    applyRunDispatchPostCommitEffects,
    issuesSvc,
    harnessFallback,
    cancelRunInternal,
    computeDailyRunUsage,
    resolveRunProfileForRun,
    buildRunLivenessInput,
    admitThroughAutomationWindow,
  } = dependencies;

  /**
   * The provider-quota retry lane applies to a run that failed before any
   * useful action. Past the backoff window it keeps one retry per hour until
   * the chain's hard ceiling (`maxTotalAttempts` or `maxRetryMs`), then stops
   * and blocks the issue. It does not depend on maxDailyRuns being set.
   */
  function resolveProviderQuotaRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    const policy = readAgentProviderQuotaRetryPolicy(agent);
    if (
      !policy.enabled ||
      usesHarnessFallbackChain(agent) ||
      run.status !== "failed" ||
      readHeartbeatRunErrorFamily(run) !== "provider_quota" ||
      parseObject(run.resultJson).providerQuotaBeforeUsefulAction !== true
    ) {
      return null;
    }
    const chainStartedAt =
      dateValue(parseObject(run.contextSnapshot).providerQuotaRetryStartedAt) ??
      run.startedAt ??
      run.createdAt;
    return { policy, chainStartedAt };
  }

  /**
   * Quota state of the agent's provider lane (company, adapter and model). The
   * lane is in quota state while its latest provider outcome (a succeeded,
   * failed or timed-out legacy run of any agent on the lane) is a
   * provider_quota failure. Any other outcome means the provider answered and
   * ends the state. `nextProbeAt` follows the lane backoff over the failed
   * probes since the state began; `probeInFlight` is a running lane run or a
   * queued run already chosen as the probe; `laneRetryWaiting` is a scheduled
   * retry of a lane chain, whose promotion the coalescing sweep paces.
   */
  async function readProviderQuotaLaneState(
    agent: typeof agents.$inferSelect,
    excludeRunId: string,
    client: Db = db,
  ) {
    const laneKey = providerQuotaKeyForAgent(agent);
    const laneAgentIds = (
      await client
        .select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(eq(agents.companyId, agent.companyId))
    )
      .filter((candidate) => providerQuotaKeyForAgent(candidate) === laneKey)
      .map((candidate) => candidate.id);
    const laneRuns = and(
      eq(heartbeatRuns.companyId, agent.companyId),
      inArray(heartbeatRuns.agentId, laneAgentIds),
      eq(heartbeatRuns.runtimeMode, "legacy"),
      // The lane is the agent's primary harness and model. A run that a
      // harness fallback sent elsewhere says nothing about this provider.
      isNull(heartbeatRuns.fallbackReason),
    );
    const providerOutcome = and(
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
      isNotNull(heartbeatRuns.finishedAt),
    );
    const [latest] = await client
      .select({ errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(and(laneRuns, providerOutcome))
      .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id))
      .limit(1);
    if (!latest?.finishedAt || latest.errorCode !== "provider_quota") {
      return { laneKey, inQuotaState: false as const };
    }
    const [boundary] = await client
      .select({ finishedAt: sql<Date | null>`max(${heartbeatRuns.finishedAt})` })
      .from(heartbeatRuns)
      .where(and(
        laneRuns,
        providerOutcome,
        sql`${heartbeatRuns.errorCode} is distinct from 'provider_quota'`,
      ));
    const boundaryAt = boundary?.finishedAt ? new Date(boundary.finishedAt) : null;
    const [stats] = await client
      .select({
        failedProbes: sql<number>`count(*) filter (where ${heartbeatRuns.contextSnapshot} ->> 'providerQuotaProbe' = 'true')::integer`,
        stateStartedAt: sql<Date | null>`min(${heartbeatRuns.finishedAt})`,
      })
      .from(heartbeatRuns)
      .where(and(
        laneRuns,
        eq(heartbeatRuns.status, "failed"),
        eq(heartbeatRuns.errorCode, "provider_quota"),
        boundaryAt ? gt(heartbeatRuns.finishedAt, boundaryAt) : undefined,
      ));
    const lastFailureAt = new Date(latest.finishedAt);
    const delayMs = computeProviderQuotaLaneProbeDelayMs({
      failedProbes: Number(stats?.failedProbes ?? 0),
      lastFailureAt,
      stateStartedAt: stats?.stateStartedAt ? new Date(stats.stateStartedAt) : lastFailureAt,
      policy: readAgentProviderQuotaRetryPolicy(agent),
    });
    const [inFlight] = await client
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        laneRuns,
        sql`${heartbeatRuns.id} <> ${excludeRunId}`,
        or(
          eq(heartbeatRuns.status, "running"),
          and(
            eq(heartbeatRuns.status, "queued"),
            sql`${heartbeatRuns.contextSnapshot} ->> 'providerQuotaProbe' = 'true'`,
          ),
        ),
      ))
      .limit(1);
    const [laneRetry] = await client
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'providerQuotaKey' = ${laneKey}`,
      ))
      .limit(1);
    return {
      laneKey,
      inQuotaState: true as const,
      nextProbeAt: new Date(lastFailureAt.getTime() + delayMs),
      probeInFlight: Boolean(inFlight),
      laneRetryWaiting: Boolean(laneRetry),
    };
  }

  /**
   * Coalesces every run of a provider lane in quota state behind one probe per
   * backoff interval: new assignments, comments and first retries alike. Only
   * one run probes at a time. A lane chain's retry may probe when nothing else
   * is in flight, because the coalescing sweep already promotes one retry per
   * interval. Any other run may probe only when no lane retry is waiting and
   * the lane backoff has passed. The probe is marked `providerQuotaProbe`
   * under a lane advisory lock and proceeds; any other run stays queued without
   * spending a retry and gets one "Waiting on provider capacity" run event.
   * When a probe succeeds the lane leaves quota state and the queued runs start
   * through the normal per-agent concurrency limit. An operator "retry now" is
   * not held back.
   *
   * @returns True when the run must stay queued.
   */
  async function waitForProviderQuotaLane(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    if (agent.adapterType === "paperclip_runner") return false;
    if (!readAgentProviderQuotaRetryPolicy(agent).enabled) return false;
    if (usesHarnessFallbackChain(agent)) return false;
    if (operatorRequestedRetryNow(run)) return false;
    if (!(await readProviderQuotaLaneState(agent, run.id)).inQuotaState) return false;
    const now = new Date();
    const waiting = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`provider-quota-lane:${agent.companyId}:${providerQuotaKeyForAgent(agent)}`}, 0))`,
      );
      const locked = await readProviderQuotaLaneState(agent, run.id, txDb);
      if (!locked.inQuotaState) return null;
      const laneRetry =
        run.retryOfRunId !== null &&
        parseObject(run.contextSnapshot).providerQuotaKey === locked.laneKey;
      const mayProbe =
        !locked.probeInFlight &&
        (laneRetry ||
          (!locked.laneRetryWaiting && now.getTime() >= locked.nextProbeAt.getTime()));
      if (mayProbe) {
        await txDb
          .update(heartbeatRuns)
          .set({
            contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({
              providerQuotaProbe: true,
              providerQuotaKey: locked.laneKey,
            })}::jsonb`,
          })
          .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")));
        return null;
      }
      const [flagged] = await txDb
        .update(heartbeatRuns)
        .set({
          // No provider key here: the coalescing sweep reads a keyed queued
          // run as a probe in flight.
          contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({
            providerQuotaWaitingSince: now.toISOString(),
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.status, "queued"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'providerQuotaWaitingSince' is null`,
        ))
        .returning();
      return { locked, newlyWaiting: flagged ?? null };
    });
    if (!waiting) return false;
    if (waiting.newlyWaiting) {
      await appendRunEvent(waiting.newlyWaiting, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          "Waiting on provider capacity: the provider is at capacity, so one run of it probes at a time; " +
          "this run starts when a probe succeeds",
        payload: {
          providerQuotaKey: waiting.locked.laneKey,
          nextProbeAt: waiting.locked.nextProbeAt.toISOString(),
          probeInFlight: waiting.locked.probeInFlight,
          laneRetryWaiting: waiting.locked.laneRetryWaiting,
        },
      });
    }
    return true;
  }

  /**
   * Records, once per agent and UTC day, that quota failures before useful
   * action passed the uncounted allowance and now count toward maxDailyRuns.
   * Best effort: finalization continues if the alarm cannot be written.
   */
  async function recordProviderQuotaCapExemptionExhausted(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    const policy = readAgentProviderQuotaRetryPolicy(agent);
    if (!policy.enabled) return;
    try {
      const observed =
        (await computeDailyRunUsage(agent.companyId, { agentId: agent.id })).get(agent.id)
          ?.providerQuotaBeforeUsefulAction ?? 0;
      if (observed <= policy.maxDailyUncountedRuns) {
        return;
      }
      const start = currentUtcDayStart();
      await logActivityOnce({
        lockKey: `provider-quota-cap-alarm:${agent.id}:${start.toISOString()}`,
        alreadyRecorded: and(
          eq(activityLog.entityType, "agent"),
          eq(activityLog.entityId, agent.id),
          gte(activityLog.createdAt, start),
        ),
        companyId: agent.companyId,
        actorType: "system",
        actorId: "heartbeat",
        agentId: agent.id,
        action: PROVIDER_QUOTA_CAP_EXEMPTION_EXHAUSTED_ACTION,
        entityType: "agent",
        entityId: agent.id,
        details: {
          observed,
          limit: policy.maxDailyUncountedRuns,
          runId: run.id,
          issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
        },
      });
    } catch (err) {
      logger.warn(
        { err, runId: run.id, agentId: agent.id },
        "failed to record the provider quota cap exemption alarm",
      );
    }
  }

  /**
   * Writes an activity entry unless one with the same action and
   * `alreadyRecorded` condition exists. The advisory lock on `lockKey`
   * serializes writers, so the check and the insert cannot race. `andThen`
   * runs in the same transaction, after the insert; its issue updates publish
   * only after the commit.
   *
   * @returns True when this call wrote the entry.
   */
  async function logActivityOnce(
    input: LogActivityInput & {
      lockKey: string;
      alreadyRecorded: SQL | undefined;
    },
    andThen?: (
      tx: Db,
      postCommit: {
        publications: ActivityPublication[];
        actions: IssuePostCommitAction[];
      },
    ) => Promise<void>,
  ) {
    const { lockKey, alreadyRecorded, ...entry } = input;
    const postCommit = {
      publications: [] as ActivityPublication[],
      actions: [] as IssuePostCommitAction[],
    };
    const recorded = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      const [existing] = await txDb
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, entry.companyId),
            eq(activityLog.action, entry.action),
            alreadyRecorded,
          ),
        )
        .limit(1);
      if (existing) return false;
      await logActivity(txDb, entry, postCommit.publications);
      await andThen?.(txDb, postCommit);
      return true;
    });
    for (const publication of postCommit.publications) publishActivity(publication);
    await executeIssuePostCommitActions(db, postCommit.actions);
    return recorded;
  }

  /**
   * Stops a provider-quota retry chain at its ceiling. In one transaction it
   * writes one `heartbeat.provider_quota_exhausted` activity per chain and
   * blocks an open issue with an unblock reason, so the stop is visible and a
   * failed block is retried on the next call instead of being skipped. Best
   * effort: the caller continues if this fails.
   *
   * @returns False when the stop could not be recorded.
   */
  async function recordProviderQuotaExhausted(input: {
    run: typeof heartbeatRuns.$inferSelect;
    agent: typeof agents.$inferSelect;
    chainStartedAt: Date;
    attempts: number;
  }) {
    const { run, agent } = input;
    const issueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
    if (!issueId) return true;
    const chainStartedAt = input.chainStartedAt.toISOString();
    const hours = Math.round(
      (Date.now() - input.chainStartedAt.getTime()) / (60 * 60 * 1000),
    );
    const reason =
      `The provider (${agent.adapterType}) stayed at capacity for about ${hours} h ` +
      `across ${input.attempts} automatic retries, so automatic retries stopped. ` +
      "Unblock the issue once the provider is available.";
    let blocked = false;
    try {
      await logActivityOnce(
        {
          lockKey: `provider-quota-exhausted:${run.companyId}:${issueId}:${chainStartedAt}`,
          alreadyRecorded: and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
            sql`${activityLog.details} ->> 'chainStartedAt' = ${chainStartedAt}`,
          ),
          companyId: run.companyId,
          actorType: "system",
          actorId: "heartbeat",
          agentId: agent.id,
          runId: run.id,
          action: PROVIDER_QUOTA_EXHAUSTED_ACTION,
          entityType: "issue",
          entityId: issueId,
          details: {
            chainStartedAt,
            attempts: input.attempts,
            provider: agent.adapterType,
            runId: run.id,
          },
        },
        async (tx, postCommit) => {
          const [issue] = await tx
            .select({ status: issues.status })
            .from(issues)
            .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
            .for("update");
          if (
            issue?.status !== "todo" &&
            issue?.status !== "in_progress" &&
            issue?.status !== "in_review"
          ) {
            return;
          }
          await issuesSvc.update(
            issueId,
            {
              status: "blocked",
              unblockDescriptor: { owner: "board", action: reason },
              companyGuard: run.companyId,
            },
            tx,
            postCommit.publications,
            postCommit.actions,
          );
          blocked = true;
        },
      );
    } catch (err) {
      logger.warn(
        { err, runId: run.id, issueId },
        "failed to record provider quota retry exhaustion",
      );
      return false;
    }
    if (blocked) {
      await issuesSvc
        .addComment(
          issueId,
          `Provider capacity retries stopped. ${reason}`,
          { runId: run.id },
          { authorType: "system" },
        )
        .catch((err) => {
          logger.warn({ err, runId: run.id, issueId }, "failed to comment on provider quota retry exhaustion");
        });
    }
    return true;
  }

  /**
   * Resolves the transient-retry tunables for a run: company < agent < routine,
   * with wake-type overrides on top. With nothing configured this returns the
   * pre-setting behavior (no rate limit, no blocked-issue suppression).
   */
  async function resolveTransientRetryPolicyForRun(input: {
    companyId: string;
    agent: typeof agents.$inferSelect;
    issueId: string | null;
    wakeReason: string | null;
  }): Promise<ResolvedTransientRetryPolicy> {
    const company = await db
      .select({ policy: companies.transientRetryPolicy })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .then((rows) => rows[0] ?? null);
    const routinePolicy = input.issueId
      ? await db
          .select({ policy: routines.transientRetryPolicy })
          .from(issues)
          .innerJoin(
            routines,
            and(eq(routines.companyId, issues.companyId), sql`${routines.id}::text = ${issues.originId}`),
          )
          .where(
            and(
              eq(issues.id, input.issueId),
              eq(issues.companyId, input.companyId),
              eq(issues.originKind, "routine_execution"),
            ),
          )
          .then((rows) => rows[0]?.policy ?? null)
      : null;
    return resolveTransientRetryPolicy(
      {
        company: company?.policy,
        agent: parseObject(input.agent.runtimeConfig).transientRetryPolicy,
        routine: routinePolicy,
      },
      input.wakeReason,
    );
  }

  /**
   * Defers (never drops) a transient retry so that at most `limit` retries are
   * scheduled per (issue, agent) in any rolling hour.
   */
  async function resolveTransientRetryRateLimitedDueAt(reader: Pick<typeof db, "select">, input: {
    companyId: string;
    agentId: string;
    issueId: string;
    retryReason: string;
    limit: number;
    dueAt: Date;
  }): Promise<Date> {
    const { limit } = input;
    const windowStart = new Date(input.dueAt.getTime() - 60 * 60 * 1000);
    const slots = await reader
      .select({ scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          eq(heartbeatRuns.scheduledRetryReason, input.retryReason),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
          gt(heartbeatRuns.scheduledRetryAt, windowStart),
        ),
      )
      .orderBy(desc(heartbeatRuns.scheduledRetryAt))
      .limit(limit);
    const oldestSlot = slots[limit - 1]?.scheduledRetryAt;
    if (!oldestSlot) return input.dueAt;
    const nextSlot = new Date(oldestSlot.getTime() + 60 * 60 * 1000);
    return nextSlot.getTime() > input.dueAt.getTime() ? nextSlot : input.dueAt;
  }

  async function scheduleBoundedRetryForRun(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    opts?: {
      now?: Date;
      random?: () => number;
      retryReason?: string;
      wakeReason?: string;
      maxAttempts?: number;
      delayMs?: number;
      contextPatch?: Record<string, unknown>;
      /** The retry is due no earlier than this time. */
      notBefore?: Date;
    },
  ) {
    if (["openai_dot", "muse"].includes(String(parseObject(agent.adapterConfig).provider))
        || ["openai_dot", "muse"].includes(String(parseObject(parseObject(parseObject(run.runnerProfileJson).nativeExecutionInput).provider).kind))) {
      return { outcome: "not_scheduled" as const, reason: "Dot external execution must be reconciled before a new assignment; Paperclip cannot confirm its external stop.", issueId: readNonEmptyString(run.contextSnapshot?.issueId) };
    }
    if (run.errorCode === "provider_tool_definition_invalid") {
      return { outcome: "not_scheduled" as const,
        reason: "Repair the invalid tool definitions before starting a new attempt.",
        issueId: readNonEmptyString(run.contextSnapshot?.issueId) };
    }
    if (Array.isArray(run.contextSnapshot?.chatCompletionDeliveryIds) &&
        run.contextSnapshot.chatCompletionDeliveryIds.some(id => typeof id === "string")) {
      return { outcome: "not_scheduled" as const, reason: "The completion outbox owns this reply's retry budget and publication identity.",
        errorCode: "chat_completion_outbox_owns_retry" as const, issueId: readNonEmptyString(run.contextSnapshot.issueId) };
    }
    const now = opts?.now ?? new Date();
    const retryReason =
      opts?.retryReason ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON;
    const wakeReason =
      opts?.wakeReason ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON;
    const providerQuotaRetry =
      retryReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON &&
      opts?.maxAttempts == null &&
      opts?.delayMs == null
        ? resolveProviderQuotaRetry(run, agent)
        : null;
    const maxAttempts = Math.max(
      0,
      Math.floor(
        opts?.maxAttempts ??
          providerQuotaRetry?.policy.maxTotalAttempts ??
          BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
      ),
    );
    const consumedAttempts = executionRetryAttemptCount(run, retryReason);
    const nextAttempt = consumedAttempts + 1;
    const providerQuotaSchedule = providerQuotaRetry
      ? computeProviderQuotaRetrySchedule({
          attempt: nextAttempt,
          now,
          chainStartedAt: providerQuotaRetry.chainStartedAt,
          policy: providerQuotaRetry.policy,
          random: opts?.random,
        })
      : null;
    const computedBaseSchedule = providerQuotaRetry
      ? providerQuotaSchedule
      : (opts?.delayMs != null
        ? nextAttempt <= maxAttempts
          ? {
              attempt: nextAttempt,
              baseDelayMs: Math.max(0, Math.floor(opts.delayMs)),
              delayMs: Math.max(0, Math.floor(opts.delayMs)),
              dueAt: new Date(
                now.getTime() + Math.max(0, Math.floor(opts.delayMs)),
              ),
              maxAttempts,
            }
          : null
        : nextAttempt <= maxAttempts
          ? computeBoundedTransientHeartbeatRetrySchedule(
              nextAttempt,
              now,
              opts?.random,
            )
          : null);
    const baseSchedule = computedBaseSchedule
      ? { ...computedBaseSchedule, maxAttempts }
      : null;
    const transientRecovery =
      retryReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON
        ? readTransientRecoveryContractFromRun(run)
        : null;
    const codexTransientFallbackMode =
      agent.adapterType === "codex_local" &&
      transientRecovery?.errorFamily === "transient_upstream"
        ? resolveCodexTransientFallbackMode(nextAttempt)
        : null;
    const transientRetryNotBefore = transientRecovery?.retryNotBefore ?? null;
    const contextSnapshot = parseObject(run.contextSnapshot);
    // A retry inherits the durable authorization scope of its source run. Do
    // not promote an untrusted or legacy contextSnapshot.issueId into a new
    // issue binding: that could either violate the FK or misclassify history.
    const issueId = run.scopeKind === "issue" ? run.issueId : null;

    if (!baseSchedule) {
      const exhaustion = {
        retryReason,
        scheduledRetryAttempt: consumedAttempts,
        maxAttempts,
      };
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: `Bounded retry exhausted after ${consumedAttempts} scheduled attempts; no further automatic retry will be queued`,
        payload: exhaustion,
        retryExhaustion: exhaustion,
      });
      if (providerQuotaRetry) {
        await recordProviderQuotaExhausted({
          run,
          agent,
          chainStartedAt: providerQuotaRetry.chainStartedAt,
          attempts: consumedAttempts,
        });
      }
      if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
        await escalatePlanApprovalResumeFailureNeedsAttention({
          run,
          issueId,
          attempt: Math.min(
            consumedAttempts,
            maxAttempts,
          ),
          maxAttempts,
        }).catch((error) => {
          logger.warn(
            { err: error, runId: run.id, issueId },
            "failed to escalate exhausted plan-approval resume failure",
          );
        });
      }
      return {
        outcome: "retry_exhausted" as const,
        attempt: nextAttempt,
        maxAttempts,
      };
    }

    if (await legacyExecutionNeedsReconciliationWithEvidence(db, run)) {
      return {
        outcome: "not_scheduled" as const,
        reason:
          "Reconcile the previous execution before retrying; safe provider recovery is unavailable.",
        errorCode: "legacy_execution_requires_reconciliation" as const,
        issueId: readNonEmptyString(run.contextSnapshot?.issueId),
      };
    }
    if (retryReason !== MAX_TURN_CONTINUATION_RETRY_REASON) {
      const invokability = await getAgentInvokability(agent);
      if (!invokability.invokable) {
        await appendRunEvent(run, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message:
            "Scheduled retry suppressed because the agent is not invokable",
          payload: {
            retryReason,
            scheduledRetryAttempt: nextAttempt,
            maxAttempts,
            reason: invokability.reason,
            invalidOrgChain: invokability.invalidOrgChain,
            ...invokability.details,
          },
        });
        return {
          outcome: "not_scheduled" as const,
          reason:
            "Scheduled retry suppressed because the agent is not invokable",
          errorCode: "agent_not_invokable" as const,
          issueId,
        };
      }
    }

    // A retry never lands before the provider reset, nor while every
    // harness/model of the agent is cooling down from a quota failure.
    const storedAgentForQuota = run.runtimeMode === "native" ? null : await getAgent(run.agentId).catch(() => null);
    const quotaHeldUntil = storedAgentForQuota
      ? await harnessFallback.heldUntil(storedAgentForQuota, now, await resolveRunProfileForRun(run, storedAgentForQuota))
      : null;
    const notBefore = [transientRetryNotBefore, quotaHeldUntil, opts?.notBefore ?? null]
      .filter((value): value is Date => value !== null)
      .reduce<Date | null>((latest, value) => (!latest || value > latest ? value : latest), null);
    const notBeforeSchedule =
      notBefore && notBefore.getTime() > baseSchedule.dueAt.getTime()
        ? {
            ...baseSchedule,
            dueAt: notBefore,
            delayMs: Math.max(0, notBefore.getTime() - now.getTime()),
          }
        : baseSchedule;
    const isTransientRetryWake =
      retryReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON &&
      wakeReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON;
    const retryPolicy = isTransientRetryWake
      ? await resolveTransientRetryPolicyForRun({ companyId: run.companyId, agent, issueId, wakeReason })
      : null;
    // The per-issue hourly slot is reserved inside the transaction, after the
    // issue row lock, so concurrent predecessors cannot claim the same slot.
    let schedule = notBeforeSchedule;

    const requiresIssueGate =
      isTransientSetupFailureCode(run.errorCode) ||
      run.errorCode === WORKSPACE_RESTORE_LOCK_TIMEOUT_FAILURE_CODE ||
      hasConversationContinuationPolicy(run.resultJson) ||
      (retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) ||
      retryReason === MAX_TURN_CONTINUATION_RETRY_REASON ||
      retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON;
    if (requiresIssueGate) {
      const gate = await runDispatch.evaluateScheduledRetryGate({
        runId: run.id,
        companyId: run.companyId,
        retryReasonOverride: retryReason,
        now,
      });
      if (!gate.allowed) {
        await appendRunEvent(run, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: gate.reason,
          payload: {
            retryReason,
            scheduledRetryAttempt: nextAttempt,
            maxAttempts,
            ...gate.details,
          },
        });
        return {
          outcome: "not_scheduled" as const,
          reason: gate.reason,
          errorCode: gate.errorCode,
          issueId: gate.issueId,
        };
      }
    }
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const interactionContinuationPayload =
      retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
        ? {
            mutation: "interaction",
            interactionId: readNonEmptyString(contextSnapshot.interactionId),
            interactionKind: readNonEmptyString(
              contextSnapshot.interactionKind,
            ),
            interactionStatus: readNonEmptyString(
              contextSnapshot.interactionStatus,
            ),
            continuationPolicy: readNonEmptyString(
              contextSnapshot.continuationPolicy,
            ),
          }
        : {};
    const workspaceValidationRetryPayload =
      retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON &&
      isWorkspaceValidationFailedRun(run)
        ? readWorkspaceValidationPayloadFromRun(run)
        : null;
    const shouldQuarantineWorkspaceForRetry =
      workspaceValidationRetryPayload !== null &&
      Object.keys(workspaceValidationRetryPayload).length > 0;
    const retryContextSnapshot: Record<string, unknown> = withRecoveryContext(
      {
        ...contextSnapshot,
        executionRetryAccounting: accountingForScheduledRetry(run, retryReason, schedule.attempt),
        retryOfRunId: run.id,
        wakeReason,
        retryReason,
        ...(retryReason === WORKSPACE_BUSY_RETRY_REASON
          ? {
              failureRetriesBeforeWorkspaceWait:
                executionFailureRetryCount(run),
            }
          : {}),
        ...((retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON)
          ? { failureRetriesBeforeAiConnectionWait: executionFailureRetryCount(run) }
          : {}),
        ...(shouldQuarantineWorkspaceForRetry
          ? {
              workspaceValidationRecovery: {
                strategy: "quarantine_failed_workspace_and_retry_clean",
                sourceRunId: run.id,
                reason:
                  readNonEmptyString(workspaceValidationRetryPayload?.reason) ??
                  WORKSPACE_VALIDATION_FAILURE_CODE,
                fingerprint: readNonEmptyString(
                  workspaceValidationRetryPayload?.fingerprint,
                ),
                failedExecutionWorkspaceId: readNonEmptyString(
                  workspaceValidationRetryPayload?.executionWorkspaceId,
                ),
              },
            }
          : {}),
        ...(transientRecovery
          ? { errorFamily: transientRecovery.errorFamily }
          : {}),
        scheduledRetryAttempt: schedule.attempt,
        scheduledRetryAt: schedule.dueAt.toISOString(),
        ...(transientRetryNotBefore
          ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(transientRecovery?.errorFamily === "provider_quota" &&
        transientRetryNotBefore
          ? {
              providerQuotaRetryNotBefore:
                transientRetryNotBefore.toISOString(),
            }
          : {}),
        ...(codexTransientFallbackMode ? { codexTransientFallbackMode } : {}),
        // Only a quota-lane retry carries the chain start; any other retry
        // drops it so a later quota failure starts a fresh chain. Every retry
        // of a provider_quota failure carries the provider key, so the
        // coalescing sweep paces it with the other chains of the lane.
        providerQuotaRetryStartedAt:
          providerQuotaRetry?.chainStartedAt.toISOString(),
        providerQuotaKey:
          providerQuotaRetry ||
          (transientRecovery?.errorFamily === "provider_quota" &&
            readAgentProviderQuotaRetryPolicy(agent).enabled &&
            !usesHarnessFallbackChain(agent))
            ? providerQuotaKeyForAgent(agent)
            : undefined,
        ...(opts?.contextPatch ?? {}),
      },
      "normal_model",
    );
    const responsibleUserId = await resolveResponsibleUserIdForRunContext(
      run,
      retryContextSnapshot,
    );
    const continuationRetryIdempotencyKey =
      retryReason === MAX_TURN_CONTINUATION_RETRY_REASON
        ? `max-turn-continuation:${run.companyId}:${issueId ?? "no-issue"}:${run.id}:${schedule.attempt}`
        : retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
          ? `interaction-continuation:${run.companyId}:${issueId ?? "no-issue"}:${run.id}:${schedule.attempt}`
          : null;

    type ScheduledRetryTransactionResult =
      | {
          outcome: "scheduled";
          run: typeof heartbeatRuns.$inferSelect;
          reusedExisting: boolean;
        }
      | {
          outcome: "not_scheduled";
          reason: string;
          errorCode:
            | "issue_not_found"
            | "issue_reassigned"
            | "issue_cancelled"
            | "issue_terminal_status"
            | "issue_not_in_progress"
            | "issue_blocked"
            | "continuation_user_authorization_missing"
            | "issue_execution_lock_changed";
          issueId: string | null;
          details: Record<string, unknown>;
        };

    const scheduleResult = await db.transaction(
      async (tx): Promise<ScheduledRetryTransactionResult> => {
        // All automatic failure paths share the same predecessor claim. A
        // duplicate monitor, restart sweep or wake must reuse its successor.
        if (
          retryReason !== MAX_TURN_CONTINUATION_RETRY_REASON &&
          retryReason !== INTERACTION_CONTINUATION_INFRA_RETRY_REASON
        ) {
          if (issueId)
            await tx.execute(
              sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`,
            );
          await tx.execute(
            sql`select id from heartbeat_runs where company_id = ${run.companyId} and id = ${run.id} for update`,
          );
          const [existing] = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.retryOfRunId, run.id),
              ),
            )
            .limit(1);
          if (existing)
            return {
              outcome: "scheduled",
              run: existing,
              reusedExisting: true,
            };
        }
        if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
          if (issueId) {
            await tx.execute(
              sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`,
            );
          } else {
            await tx.execute(
              sql`select id from heartbeat_runs where company_id = ${run.companyId} and id = ${run.id} for update`,
            );
          }

          const existingContinuation = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.retryOfRunId, run.id),
                eq(heartbeatRuns.scheduledRetryReason, retryReason),
                eq(heartbeatRuns.scheduledRetryAttempt, schedule.attempt),
                inArray(heartbeatRuns.status, [
                  ...MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES,
                ]),
                issueId
                  ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
                  : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
              ),
            )
            .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingContinuation) {
            if (existingContinuation.wakeupRequestId) {
              const existingWakeup = await tx
                .select({ coalescedCount: agentWakeupRequests.coalescedCount })
                .from(agentWakeupRequests)
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                )
                .then((rows) => rows[0] ?? null);

              await tx
                .update(agentWakeupRequests)
                .set({
                  coalescedCount: (existingWakeup?.coalescedCount ?? 0) + 1,
                  updatedAt: now,
                })
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                );
            }

            return {
              outcome: "scheduled",
              run: existingContinuation,
              reusedExisting: true,
            };
          }
        }

        if (retryReason === MAX_TURN_CONTINUATION_RETRY_REASON) {
          if (issueId) {
            await tx.execute(
              sql`select id from issues where company_id = ${run.companyId} and id = ${issueId} for update`,
            );
          } else {
            await tx.execute(
              sql`select id from heartbeat_runs where company_id = ${run.companyId} and id = ${run.id} for update`,
            );
          }

          const existingContinuation = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.retryOfRunId, run.id),
                eq(heartbeatRuns.scheduledRetryReason, retryReason),
                eq(heartbeatRuns.scheduledRetryAttempt, schedule.attempt),
                inArray(heartbeatRuns.status, [
                  ...MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES,
                ]),
                issueId
                  ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
                  : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
              ),
            )
            .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingContinuation) {
            if (existingContinuation.wakeupRequestId) {
              const existingWakeup = await tx
                .select({ coalescedCount: agentWakeupRequests.coalescedCount })
                .from(agentWakeupRequests)
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                )
                .then((rows) => rows[0] ?? null);

              await tx
                .update(agentWakeupRequests)
                .set({
                  coalescedCount: (existingWakeup?.coalescedCount ?? 0) + 1,
                  updatedAt: now,
                })
                .where(
                  eq(
                    agentWakeupRequests.id,
                    existingContinuation.wakeupRequestId,
                  ),
                );
            }

            return {
              outcome: "scheduled",
              run: existingContinuation,
              reusedExisting: true,
            };
          }

          if (issueId) {
            const lockedIssue = await tx
              .select({
                id: issues.id,
                status: issues.status,
                assigneeAgentId: issues.assigneeAgentId,
                executionRunId: issues.executionRunId,
              })
              .from(issues)
              .where(
                and(
                  eq(issues.id, issueId),
                  eq(issues.companyId, run.companyId),
                ),
              )
              .then((rows) => rows[0] ?? null);

            if (!lockedIssue) {
              return {
                outcome: "not_scheduled",
                reason:
                  "Scheduled max-turn continuation suppressed because the target issue no longer exists",
                errorCode: "issue_not_found",
                issueId,
                details: { issueId },
              };
            }

            if (lockedIssue.assigneeAgentId !== run.agentId) {
              return {
                outcome: "not_scheduled",
                reason:
                  "Scheduled max-turn continuation suppressed because issue ownership changed",
                errorCode: "issue_reassigned",
                issueId,
                details: {
                  issueId,
                  previousAssigneeAgentId: run.agentId,
                  currentAssigneeAgentId: lockedIssue.assigneeAgentId,
                },
              };
            }

            if (
              lockedIssue.status === "cancelled" ||
              lockedIssue.status === "done"
            ) {
              return {
                outcome: "not_scheduled",
                reason: `Scheduled max-turn continuation suppressed because issue reached terminal status (${lockedIssue.status})`,
                errorCode:
                  lockedIssue.status === "cancelled"
                    ? "issue_cancelled"
                    : "issue_terminal_status",
                issueId,
                details: { issueId, currentStatus: lockedIssue.status },
              };
            }

            if (lockedIssue.status !== "in_progress") {
              return {
                outcome: "not_scheduled",
                reason: `Scheduled max-turn continuation suppressed because issue is no longer in_progress (current status: ${lockedIssue.status})`,
                errorCode: "issue_not_in_progress",
                issueId,
                details: {
                  issueId,
                  currentStatus: lockedIssue.status,
                  requiredStatus: "in_progress",
                },
              };
            }

            if (lockedIssue.executionRunId !== run.id) {
              return {
                outcome: "not_scheduled",
                reason:
                  "Scheduled max-turn continuation suppressed because the issue execution lock belongs to a different run",
                errorCode: "issue_execution_lock_changed",
                issueId,
                details: {
                  issueId,
                  expectedExecutionRunId: run.id,
                  currentExecutionRunId: lockedIssue.executionRunId,
                },
              };
            }
          }
        }

        if (
          (retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) && issueId &&
          !isNonAssigneeWorkspaceBusyRetry(retryReason, contextSnapshot)
        ) {
          // The issue row is locked above. Recheck after the preflight gate so
          // cancellation or recovery cannot leave a successor without its lock.
          const [lockedIssue] = await tx.select({ executionRunId: issues.executionRunId })
            .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
          if (lockedIssue?.executionRunId !== run.id) {
            return {
              outcome: "not_scheduled", issueId, errorCode: "issue_execution_lock_changed",
              reason: "Subscription retry suppressed because the task execution lock changed",
              details: { issueId, expectedExecutionRunId: run.id, currentExecutionRunId: lockedIssue?.executionRunId ?? null },
            };
          }
        }

        if (issueId && retryPolicy?.suppressWhenBlocked) {
          const [blockedCheck] = await tx
            .select({ status: issues.status })
            .from(issues)
            .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
          if (blockedCheck?.status === "blocked") {
            return {
              outcome: "not_scheduled",
              reason: "Transient retry suppressed because the issue is blocked",
              errorCode: "issue_blocked",
              issueId,
              details: { issueId, currentStatus: "blocked" },
            };
          }
        }

        if (issueId && retryPolicy && retryPolicy.perIssuePerHour > 0) {
          const rateLimitedDueAt = await resolveTransientRetryRateLimitedDueAt(tx, {
            companyId: run.companyId,
            agentId: run.agentId,
            issueId,
            retryReason,
            limit: retryPolicy.perIssuePerHour,
            dueAt: notBeforeSchedule.dueAt,
          });
          if (rateLimitedDueAt.getTime() > notBeforeSchedule.dueAt.getTime()) {
            schedule = {
              ...notBeforeSchedule,
              dueAt: rateLimitedDueAt,
              delayMs: Math.max(0, rateLimitedDueAt.getTime() - now.getTime()),
            };
            retryContextSnapshot.scheduledRetryAt = rateLimitedDueAt.toISOString();
          }
        }

        const scheduledRunId = randomUUID();
        if (contextSnapshot.explicitUserContinuation) {
          const continuation = issueId && retryReason === "transient_failure" ? await admitExplicitContinuationRetry({
            db: tx as unknown as Db, companyId: run.companyId, issueId, agentId: run.agentId,
            parentRunId: run.id, successorRunId: scheduledRunId, now,
          }) : null;
          if (!continuation) return {
            outcome: "not_scheduled", issueId,
            errorCode: "continuation_user_authorization_missing",
            reason: "The automatic retry could not revalidate the original user continuation.",
            details: {},
          };
          retryContextSnapshot.explicitUserContinuation = continuation;
          retryContextSnapshot.previousRunId = continuation.previousRunId;
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: run.companyId,
            agentId: run.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: wakeReason,
            payload: withRecoveryContext(
              {
                ...(issueId ? { issueId } : {}),
                retryOfRunId: run.id,
                ...interactionContinuationPayload,
                retryReason,
                ...(transientRecovery
                  ? { errorFamily: transientRecovery.errorFamily }
                  : {}),
                scheduledRetryAttempt: schedule.attempt,
                scheduledRetryAt: schedule.dueAt.toISOString(),
                ...(transientRetryNotBefore
                  ? {
                      transientRetryNotBefore:
                        transientRetryNotBefore.toISOString(),
                    }
                  : {}),
                ...(transientRecovery?.errorFamily === "provider_quota" &&
                transientRetryNotBefore
                  ? {
                      providerQuotaRetryNotBefore:
                        transientRetryNotBefore.toISOString(),
                    }
                  : {}),
                ...(codexTransientFallbackMode
                  ? { codexTransientFallbackMode }
                  : {}),
              },
              "normal_model",
            ),
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: null,
            idempotencyKey: continuationRetryIdempotencyKey,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);

        const scheduledRun = await tx
          .insert(heartbeatRuns)
          .values({
            id: scheduledRunId,
            companyId: run.companyId,
            agentId: run.agentId,
          scopeKind: run.scopeKind,
          issueId,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "scheduled_retry",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: retryContextSnapshot,
            ...(hasConversationContinuationPolicy(run.resultJson)
              ? { resultJson: { conversationContinuation: CONVERSATION_CONTINUATION_POLICY } } : {}),
            responsibleUserId,
            sessionIdBefore: sessionBefore,
            retryOfRunId: run.id,
            scheduledRetryAt: schedule.dueAt,
            scheduledRetryAttempt: schedule.attempt,
            scheduledRetryReason: retryReason,
            continuationAttempt: readContinuationAttempt(
              retryContextSnapshot.livenessContinuationAttempt,
            ),
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: scheduledRun.id,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        let detachWorkspaceFromIssue = false;
        if (issueId && shouldQuarantineWorkspaceForRetry) {
          const issueWorkspace = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              executionWorkspaceId: issues.executionWorkspaceId,
            })
            .from(issues)
            .where(
              and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          const failedExecutionWorkspaceId =
            readNonEmptyString(
              workspaceValidationRetryPayload?.executionWorkspaceId,
            ) ?? readNonEmptyString(issueWorkspace?.executionWorkspaceId);

          if (issueWorkspace && failedExecutionWorkspaceId) {
            const failedWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                companyId: executionWorkspaces.companyId,
                sourceIssueId: executionWorkspaces.sourceIssueId,
                status: executionWorkspaces.status,
                metadata: executionWorkspaces.metadata,
              })
              .from(executionWorkspaces)
              .where(
                and(
                  eq(executionWorkspaces.id, failedExecutionWorkspaceId),
                  eq(executionWorkspaces.companyId, run.companyId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null);

            const workspaceBelongsToIssue = failedWorkspace
              ? failedWorkspace.sourceIssueId === issueId
              : false;

            if (
              failedWorkspace &&
              workspaceBelongsToIssue &&
              issueWorkspace.executionWorkspaceId === failedExecutionWorkspaceId
            ) {
              const existingMetadata = parseObject(failedWorkspace.metadata);
              const quarantine = {
                reason: WORKSPACE_VALIDATION_FAILURE_CODE,
                retryReason,
                sourceRunId: run.id,
                retryRunId: scheduledRun.id,
                issueId,
                sourceIssueId: failedWorkspace.sourceIssueId ?? null,
                quarantinedAt: now.toISOString(),
                workspaceValidation: workspaceValidationRetryPayload ?? {},
              };
              await tx
                .update(executionWorkspaces)
                .set({
                  status: "archived",
                  closedAt: now,
                  cleanupEligibleAt: null,
                  cleanupReason: WORKSPACE_VALIDATION_FAILURE_CODE,
                  metadata: {
                    ...existingMetadata,
                    workspaceValidationQuarantine: quarantine,
                  },
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(executionWorkspaces.id, failedWorkspace.id),
                    eq(executionWorkspaces.companyId, run.companyId),
                  ),
                );

              await logActivity(tx as unknown as Db, {
                companyId: run.companyId,
                actorType: "system",
                actorId: "heartbeat",
                agentId: run.agentId,
                runId: run.id,
                action: "execution_workspace.workspace_validation_quarantined",
                entityType: "execution_workspace",
                entityId: failedWorkspace.id,
                details: quarantine,
              });
              detachWorkspaceFromIssue =
                issueWorkspace.executionWorkspaceId ===
                failedExecutionWorkspaceId;
            }
          }
        }

        if (issueId) {
          await tx
            .update(issues)
            .set({
              executionRunId: scheduledRun.id,
              checkoutRunId: sql`case when ${issues.checkoutRunId} = ${run.id} then null else ${issues.checkoutRunId} end`,
              executionAgentNameKey: normalizeAgentNameKey(agent.name),
              executionLockedAt: now,
              ...(detachWorkspaceFromIssue
                ? {
                    executionWorkspaceId: null,
                    executionWorkspacePreference: null,
                  }
                : {}),
              updatedAt: now,
            })
            .where(
              and(
                eq(issues.id, issueId),
                eq(issues.companyId, run.companyId),
                eq(issues.executionRunId, run.id),
              ),
            );
        }

        return {
          outcome: "scheduled",
          run: scheduledRun,
          reusedExisting: false,
        };
      },
    );

    if (scheduleResult.outcome === "not_scheduled") {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: scheduleResult.reason,
        payload: {
          retryReason,
          scheduledRetryAttempt: nextAttempt,
          maxAttempts,
          ...scheduleResult.details,
        },
      });
      return {
        outcome: "not_scheduled" as const,
        reason: scheduleResult.reason,
        errorCode: scheduleResult.errorCode,
        issueId: scheduleResult.issueId,
      };
    }

    const retryRun = scheduleResult.run;
    const dueAt = retryRun.scheduledRetryAt
      ? new Date(retryRun.scheduledRetryAt)
      : schedule.dueAt;

    if (scheduleResult.reusedExisting) {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: `Reused existing continuation retry ${retryRun.scheduledRetryAttempt}/${schedule.maxAttempts}`,
        payload: {
          retryRunId: retryRun.id,
          retryReason,
          idempotencyKey: continuationRetryIdempotencyKey,
          scheduledRetryAttempt: retryRun.scheduledRetryAttempt,
          scheduledRetryAt: dueAt.toISOString(),
        },
      });

      return {
        outcome: "scheduled" as const,
        run: retryRun,
        dueAt,
        attempt: retryRun.scheduledRetryAttempt,
        maxAttempts: schedule.maxAttempts,
        reusedExisting: true,
      };
    }

    await appendRunEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message:
        providerQuotaSchedule?.phase === "slow"
          ? `Scheduled provider quota retry ${schedule.attempt} at the hourly recovery cadence for ${schedule.dueAt.toISOString()}`
          : `Scheduled bounded retry ${schedule.attempt}/${schedule.maxAttempts} for ${schedule.dueAt.toISOString()}`,
      payload: {
        retryRunId: retryRun.id,
        retryReason,
        ...(providerQuotaSchedule
          ? { providerQuotaRetryPhase: providerQuotaSchedule.phase }
          : {}),
        ...(transientRecovery
          ? { errorFamily: transientRecovery.errorFamily }
          : {}),
        scheduledRetryAttempt: schedule.attempt,
        scheduledRetryAt: schedule.dueAt.toISOString(),
        baseDelayMs: schedule.baseDelayMs,
        delayMs: schedule.delayMs,
        ...(transientRetryNotBefore
          ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(transientRecovery?.errorFamily === "provider_quota" &&
        transientRetryNotBefore
          ? {
              providerQuotaRetryNotBefore:
                transientRetryNotBefore.toISOString(),
            }
          : {}),
        ...(codexTransientFallbackMode ? { codexTransientFallbackMode } : {}),
      },
    });

    if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
      await recordPlanApprovalResumeFailureRetry({
        run,
        issueId,
        retryRunId: retryRun.id,
        attempt: schedule.attempt,
        maxAttempts: schedule.maxAttempts,
      }).catch((error) => {
        logger.warn(
          { err: error, runId: run.id, issueId, retryRunId: retryRun.id },
          "failed to record plan-approval resume retry failure",
        );
      });
    }

    return {
      outcome: "scheduled" as const,
      run: retryRun,
      dueAt,
      attempt: schedule.attempt,
      maxAttempts: schedule.maxAttempts,
    };
  }

  // Finds a running heartbeat run (other than the caller's) whose context
  // issue shares the same project workspace, i.e. the run that currently
  // "holds" the shared working tree. Runs that have been silent past
  // WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS do not count — a zombie holder must
  // not park other work forever. This cutoff is independent of informational
  // silence warnings. When isolated workspaces are enabled, holders whose
  // issue explicitly opted into an isolated workspace never touch the shared
  // tree, so they are excluded; a NULL/agent_default mode may resolve to the
  // shared tree and counts as a holder (over-serializing is the safe
  // direction). When the isolated-workspaces experiment is off, every run
  // resolves to the shared tree, so no holder is excluded.
  async function findSharedWorkspaceHolder(input: {
    companyId: string;
    projectWorkspaceId: string;
    excludeIssueId: string;
    excludeRunId: string;
    honorIsolatedWorkspaceModes: boolean;
    now?: Date;
  }): Promise<SharedWorkspaceHolder | null> {
    const staleCutoff = new Date(
      (input.now ?? new Date()).getTime() -
        WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
    );
    return await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: sql<string>`${issues.id}::text`,
        issueIdentifier: issues.identifier,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, heartbeatRuns.companyId),
          issueIdEqualsText(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId'`),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.id, input.excludeRunId),
          // Last observed activity: output beats start beats creation. A run
          // that started recently but has not written output yet is live.
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${staleCutoff.toISOString()}::timestamptz`,
          eq(issues.projectWorkspaceId, input.projectWorkspaceId),
          ne(sql`${issues.id}::text`, input.excludeIssueId),
          ...(input.honorIsolatedWorkspaceModes
            ? [
                or(
                  // Covers both a NULL settings blob and a blob without a mode
                  // key; either may still resolve to the shared workspace.
                  sql`${issues.executionWorkspaceSettings} ->> 'mode' is null`,
                  notInArray(
                    sql`${issues.executionWorkspaceSettings} ->> 'mode'`,
                    [...ISOLATED_EXECUTION_WORKSPACE_MODES],
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Finds a running run (other than the caller's) on an issue bound to the
  // same reused execution workspace, typically a parent run that is still
  // active after delegating a child that inherited its workspace. Unlike
  // findSharedWorkspaceHolder, a holder silent past
  // WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS is still returned (flagged stale):
  // silence does not prove the holder stopped, so the caller must not treat
  // the folder as free. A live holder is preferred over a stale one.
  async function findExecutionWorkspaceHolder(input: {
    companyId: string;
    executionWorkspaceId: string;
    excludeRunId: string;
    now?: Date;
  }): Promise<ExecutionWorkspaceHolder | null> {
    const staleCutoff = new Date(
      (input.now ?? new Date()).getTime() -
        WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
    );
    const lastActivityBefore = sql<boolean>`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) < ${staleCutoff.toISOString()}::timestamptz`;
    return await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: sql<string>`${issues.id}::text`,
        issueIdentifier: issues.identifier,
        stale: lastActivityBefore,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, heartbeatRuns.companyId),
          eq(issues.executionWorkspaceId, input.executionWorkspaceId),
          or(
            eq(issues.executionRunId, heartbeatRuns.id),
            sql`${issues.id}::text = coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`,
          ),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.id, input.excludeRunId),
        ),
      )
      .orderBy(asc(lastActivityBefore), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Credential rotation can briefly contend with a fresh runtime read. Keep
  // the task on its automatic pre-provider retry path while the lock clears.
  async function finalizeAiConnectionBusyDeferral(
    run: typeof heartbeatRuns.$inferSelect,
    error: HttpError,
    wasIssueAssignee: boolean,
  ) {
    const now = new Date();
    const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
      error: error.message, errorCode: AI_CONNECTION_BUSY_RETRY_REASON, finishedAt: now,
      resultJson: {
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: "Waiting for shared AI credentials",
          recordedAt: now.toISOString(),
        },
      },
      contextSnapshot: {
        ...parseObject(run.contextSnapshot),
        aiConnectionBusyDeferredWhileAssignee: wasIssueAssignee,
      },
    });
    if (!cancelled.updated) return;
    await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: error.message }).catch(() => undefined);
    const cancelledRun = cancelled.run ?? await getRun(run.id);
    const agent = await getAgent(run.agentId);
    let scheduled = false;
    try {
      if (cancelledRun && agent) {
        const retry = await scheduleBoundedRetryForRun(cancelledRun, agent, {
          now, retryReason: AI_CONNECTION_BUSY_RETRY_REASON, wakeReason: "ai_connection_busy_retry",
          maxAttempts: (cancelledRun.scheduledRetryAttempt ?? 0) + 1,
          delayMs: computeWorkspaceBusyRetryDelayMs(),
        });
        scheduled = retry.outcome === "scheduled";
        await appendRunEvent(cancelledRun, {
          eventType: "lifecycle", stream: "system", level: "info",
          message: scheduled ? "Waiting for the shared AI subscription. This task will retry automatically." : "The AI subscription is busy; this task can no longer retry automatically.",
          payload: { retryScheduled: scheduled },
        });
      }
    } finally {
      try {
        if (cancelledRun && !scheduled) await releaseIssueExecutionAndPromote(cancelledRun);
      } finally {
        await finalizeAgentStatus(run.agentId, "cancelled", null, { wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run) });
      }
    }
  }

  // Terminal handling for a WorkspaceBusyDeferral thrown by the pre-dispatch
  // gate: cancel the run (contention is not a failure), schedule a
  // workspace_busy retry, and leave the agent idle. The issue execution lock
  // transfers to the scheduled retry run inside scheduleBoundedRetryForRun, so
  // the issue keeps an active execution path and recovery leaves it alone.
  // Deferral has no attempt ceiling — the retry keeps rescheduling while a
  // live holder exists, and holder staleness (not a counter) is what prevents
  // waiting on a zombie. If no retry could be scheduled (agent no longer
  // invokable), the lock is released so the issue does not strand on a
  // cancelled run.
  async function finalizeWorkspaceBusyDeferral(
    run: typeof heartbeatRuns.$inferSelect,
    deferral: WorkspaceBusyDeferral,
  ) {
    const now = new Date();
    const cancelWrite = await setRunStatusIfRunning(run.id, "cancelled", {
      error: deferral.message,
      errorCode: WORKSPACE_BUSY_ERROR_CODE,
      finishedAt: now,
      resultJson: {
        executionRecovery: {
          kind: "workspace_wait",
          providerWorkStarted: false,
        },
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: `Waiting for the shared ${deferral.executionWorkspaceId ? "execution" : "project"} workspace`,
          recordedAt: now.toISOString(),
        },
        workspaceBusy: {
          projectWorkspaceId: deferral.projectWorkspaceId,
          executionWorkspaceId: deferral.executionWorkspaceId,
          holderRunId: deferral.holder.runId,
          holderIssueId: deferral.holder.issueId,
          deferralAttempt: deferral.deferralAttempt,
        },
      },
      // Recorded on the run (and inherited by the scheduled retry's context)
      // so the retry promotion gate can tell a non-assignee wake — where an
      // assignee mismatch is the expected state — from a reassignment race.
      contextSnapshot: {
        ...parseObject(run.contextSnapshot),
        workspaceBusyDeferredWhileAssignee: deferral.wasIssueAssignee,
      },
    });
    if (!cancelWrite.updated) {
      logger.info(
        { runId: run.id, currentStatus: cancelWrite.run?.status ?? null },
        "skipping workspace-busy deferral finalization because the run already left running state",
      );
      return;
    }
    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: now,
      error: deferral.message,
    }).catch(() => undefined);

    const cancelledRun =
      cancelWrite.run ?? (await getRun(run.id).catch(() => null));
    const agentRow = await getAgent(run.agentId).catch(() => null);
    let scheduleOutcome: string | null = null;
    if (cancelledRun && agentRow) {
      const scheduleResult = await scheduleBoundedRetryForRun(
        cancelledRun,
        agentRow,
        {
          now,
          retryReason: WORKSPACE_BUSY_RETRY_REASON,
          wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
          // Always admit the next attempt: workspace-busy deferral is bounded by
          // holder liveness, not by an attempt counter.
          maxAttempts: (cancelledRun.scheduledRetryAttempt ?? 0) + 1,
          delayMs: computeWorkspaceBusyRetryDelayMs(),
        },
      ).catch((scheduleErr) => {
        logger.error(
          { err: scheduleErr, runId: run.id },
          "failed to schedule workspace-busy retry after deferral",
        );
        return null;
      });
      scheduleOutcome = scheduleResult?.outcome ?? null;
    }

    if (cancelledRun) {
      await appendRunEvent(cancelledRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message:
          scheduleOutcome === "scheduled"
            ? `Deferred: ${deferral.message}. Retry ${deferral.deferralAttempt + 1} scheduled; the run waits for the workspace to free.`
            : `Deferred: ${deferral.message}. No retry could be scheduled; releasing the issue for other runs.`,
        payload: {
          projectWorkspaceId: deferral.projectWorkspaceId,
          executionWorkspaceId: deferral.executionWorkspaceId,
          holderRunId: deferral.holder.runId,
          holderIssueId: deferral.holder.issueId,
          deferralAttempt: deferral.deferralAttempt,
          retryScheduled: scheduleOutcome === "scheduled",
        },
      }).catch(() => undefined);
    }

    if (cancelledRun && scheduleOutcome !== "scheduled") {
      await releaseIssueExecutionAndPromote(cancelledRun).catch(
        (releaseErr) => {
          logger.error(
            { err: releaseErr, runId: run.id },
            "failed to release issue execution after workspace-busy deferral",
          );
        },
      );
    }

    await finalizeAgentStatus(run.agentId, "cancelled", null, {
      wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
    }).catch(() => undefined);
  }

  async function scheduleInteractionContinuationInfrastructureRetryIfEligible(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    if (!run.wakeupRequestId) return null;
    if (!isResolvedInteractionContinuationWakeContext(run.contextSnapshot))
      return null;
    if (!isRetryableInteractionContinuationInfrastructureFailure(run)) {
      const context = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      await escalatePlanApprovalResumeFailureNeedsAttention({
        run,
        issueId,
        attempt: Math.min(
          run.scheduledRetryAttempt ??
            INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
          INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
        ),
        maxAttempts: INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
      }).catch((error) => {
        logger.warn(
          { err: error, runId: run.id, issueId },
          "failed to escalate non-retryable plan-approval resume failure",
        );
      });
      return null;
    }

    return scheduleBoundedRetryForRun(run, agent, {
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
    });
  }

  /**
   * Coalesces provider-quota retries per company and provider (the agent's
   * adapter type and model). While the provider is in quota state, one retry probes at
   * a time: the retry of the oldest chain. Other due retries wait one base
   * delay past the probe's next attempt, or past a probe that is running, so
   * at most one probe runs per backoff interval. Once a probe succeeds, every
   * waiting retry is released. A waiting retry that would pass its chain's
   * ceiling is cancelled and its issue blocked. An operator "retry now" is
   * not held back; it exempts only the retry it was requested for.
   */
  async function coalesceProviderQuotaRetries(now: Date) {
    const providerKey = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'providerQuotaKey'`;
    const groups = await db
      .selectDistinct({ companyId: heartbeatRuns.companyId, key: providerKey })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "scheduled_retry"),
          sql`${providerKey} is not null`,
        ),
      );
    for (const group of groups) {
      try {
        await coalesceProviderQuotaGroup(group.companyId, group.key, now);
      } catch (err) {
        logger.warn(
          { err, companyId: group.companyId, provider: group.key },
          "failed to coalesce provider quota retries",
        );
      }
    }
  }

  /**
   * True when an operator asked to retry this scheduled row now. Successor
   * retries copy the context, so a request older than the row belongs to an
   * earlier retry in the chain and does not exempt this one.
   */
  function operatorRequestedRetryNow(run: typeof heartbeatRuns.$inferSelect) {
    const requestedAt = dateValue(parseObject(run.contextSnapshot).retryNowRequestedAt);
    return requestedAt !== null && requestedAt.getTime() >= run.createdAt.getTime();
  }

  async function coalesceProviderQuotaGroup(
    companyId: string,
    key: string,
    now: Date,
  ) {
    const inGroup = and(
      eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'providerQuotaKey' = ${key}`,
    );
    const chainStartOf = (run: typeof heartbeatRuns.$inferSelect) =>
      dateValue(parseObject(run.contextSnapshot).providerQuotaRetryStartedAt) ??
      run.createdAt;
    const expired = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`provider-quota-probe:${companyId}:${key}`}, 0))`,
      );
      const waiting = await tx
        .select()
        .from(heartbeatRuns)
        .where(and(inGroup, eq(heartbeatRuns.status, "scheduled_retry")))
        .for("update");
      if (waiting.length === 0) return [];

      const newestWaitingAt = new Date(
        Math.max(...waiting.map((run) => run.createdAt.getTime())),
      );
      const [recovered] = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            inGroup,
            eq(heartbeatRuns.status, "succeeded"),
            gt(heartbeatRuns.finishedAt, newestWaitingAt),
          ),
        )
        .limit(1);
      if (recovered) {
        await tx
          .update(heartbeatRuns)
          .set({ scheduledRetryAt: now, updatedAt: now })
          .where(
            and(
              inGroup,
              eq(heartbeatRuns.status, "scheduled_retry"),
              gt(heartbeatRuns.scheduledRetryAt, now),
            ),
          );
        return [];
      }

      const [inFlight] = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(inGroup, inArray(heartbeatRuns.status, ["queued", "running"])))
        .limit(1);
      const leader = inFlight
        ? null
        : [...waiting].sort(
            (a, b) =>
              chainStartOf(a).getTime() - chainStartOf(b).getTime() ||
              (a.scheduledRetryAt?.getTime() ?? 0) -
                (b.scheduledRetryAt?.getTime() ?? 0) ||
              a.id.localeCompare(b.id),
          )[0];
      // Hold until just after the probe's next attempt, but re-check at
      // least at the hourly cadence: a probe that waits for a provider reset
      // days away must not push followers past their ceilings at once.
      const holdUntil = new Date(
        Math.min(
          Math.max(now.getTime(), leader?.scheduledRetryAt?.getTime() ?? 0),
          now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
        ) + PROVIDER_QUOTA_RETRY_BASE_DELAY_MS,
      );
      const held = waiting.filter(
        (run) =>
          run.id !== leader?.id &&
          run.scheduledRetryAt !== null &&
          run.scheduledRetryAt.getTime() <= now.getTime() &&
          !operatorRequestedRetryNow(run),
      );
      if (held.length === 0) return [];
      await tx
        .update(heartbeatRuns)
        .set({ scheduledRetryAt: holdUntil, updatedAt: now })
        .where(
          and(
            inArray(heartbeatRuns.id, held.map((run) => run.id)),
            eq(heartbeatRuns.status, "scheduled_retry"),
            lte(heartbeatRuns.scheduledRetryAt, now),
          ),
        );
      const heldAgents = await tx
        .select()
        .from(agents)
        .where(inArray(agents.id, [...new Set(held.map((run) => run.agentId))]));
      return held.flatMap((run) => {
        const agent = heldAgents.find((row) => row.id === run.agentId);
        if (!agent) return [];
        const { maxRetryMs } = readAgentProviderQuotaRetryPolicy(agent);
        return holdUntil.getTime() > chainStartOf(run).getTime() + maxRetryMs
          ? [{ run, agent }]
          : [];
      });
    });

    for (const { run, agent } of expired) {
      try {
        // Stop and block first: if that fails, the row is still a scheduled
        // retry and the next sweep tries again. Recording is idempotent.
        const source = run.retryOfRunId ? await getRun(run.retryOfRunId) : null;
        const stopped = await recordProviderQuotaExhausted({
          run: source ?? run,
          agent,
          chainStartedAt: chainStartOf(run),
          attempts: Math.max(0, (run.scheduledRetryAttempt ?? 1) - 1),
        });
        if (!stopped) continue;
        // No immediate recovery: a continuation run would be another probe.
        await cancelRunInternal(
          run.id,
          "Provider capacity retries stopped: the chain reached its retry ceiling while waiting for the provider.",
          { errorCode: "provider_quota_exhausted", suppressImmediateRecovery: true },
        );
      } catch (err) {
        logger.warn(
          { err, runId: run.id },
          "failed to stop a provider quota retry past its ceiling",
        );
      }
    }
  }

  /** Notes on a held queued run when it can start; written once per cooldown end. */
  async function recordProviderQuotaWait(run: typeof heartbeatRuns.$inferSelect, heldUntil: Date) {
    const waitUntil = heldUntil.toISOString();
    // A merge in SQL: a comment wake can coalesce into this queued run while
    // we hold it, and a read-modify-write of the snapshot would drop it.
    const [held] = await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ providerQuotaWaitUntil: waitUntil })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.status, "queued"),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'providerQuotaWaitUntil', '') <> ${waitUntil}`,
      ))
      .returning();
    if (!held) return;
    await appendRunEvent(held, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: `Waiting for the provider quota to reset; this run starts at or after ${waitUntil}`,
      payload: { providerQuotaWaitUntil: waitUntil },
    }).catch(() => undefined);
  }

  /**
   * After a failed legacy run that hit a provider usage limit before useful
   * work (or a capacity limit whose bounded retries are spent), cools the
   * harness/model that ran down until the provider's reset, or a bounded
   * backoff when none is known. With a healthy fallback the same wake is
   * re-dispatched there once; otherwise every retry and new wake waits for
   * the cooldown (see scheduleBoundedRetryForRun and claimQueuedRun).
   */
  async function handleProviderQuotaFailure(input: {
    run: typeof heartbeatRuns.$inferSelect;
    executedAgent: typeof agents.$inferSelect;
    storedAgent: typeof agents.$inferSelect;
    phase: "failure" | "retry_exhausted";
  }): Promise<{ redispatched: boolean; awaitingRetryExhaustion: boolean; deferUntil: Date | null }> {
    const none = { redispatched: false, awaitingRetryExhaustion: false, deferUntil: null };
    const { run, executedAgent, storedAgent } = input;
    if (run.runtimeMode === "native") return none;
    const dispatch = readClaimedHarnessDispatch(run.runnerProfileJson) ?? primaryHarnessDispatch(storedAgent);
    if (!isLlmHarnessAdapterType(dispatch.adapterType)) return none;
    const outputTokens = asNumber(parseObject(run.usageJson).outputTokens, 0);
    let usefulWork = outputTokens > 0;
    if (!usefulWork) {
      const evidence = await buildRunLivenessInput(run, parseObject(run.resultJson))
        .then((liveness) => liveness.evidence)
        .catch(() => null);
      // An unreadable evidence lookup fails closed: the failure still has to
      // read as a provider quota error, and cooling down is the safe side.
      usefulWork = !!evidence && (
        (evidence.issueCommentsCreated ?? 0) > 0 ||
        (evidence.documentRevisionsCreated ?? 0) > 0 ||
        (evidence.workProductsCreated ?? 0) > 0 ||
        (evidence.activityEventsCreated ?? 0) > 0);
    }
    const decision = classifyQuotaFailure({
      status: run.status,
      errorCode: run.errorCode,
      errorFamily: readHeartbeatRunErrorFamily(run),
      errorMessage: run.error,
      retryNotBefore: readTransientRetryNotBeforeFromRun(run),
      usefulWork,
    });
    if (!decision.trigger) return none;
    if (decision.requiresRetryExhaustion && input.phase !== "retry_exhausted") {
      return { ...none, awaitingRetryExhaustion: true };
    }
    const reason = `provider_${decision.kind}`;
    const cooled = await harnessFallback.coolDown({
      agent: storedAgent,
      targetKey: dispatch.targetKey,
      reason,
      resetAt: decision.resetAt,
      sourceRunId: run.id,
      profile: dispatch.profile ?? null,
    }).catch((err) => {
      // Fail closed: without a recorded cooldown the normal 30 second retry
      // would send this wake straight back at the exhausted target.
      logger.warn({ err, runId: run.id, target: dispatch.targetKey }, "quota cooldown could not be recorded; deferring this wake");
      return null;
    });
    if (!cooled) {
      return { ...none, deferUntil: new Date(Date.now() + COOLDOWN_READ_FAILURE_BASE_MS) };
    }
    const { until, nextTarget } = cooled;
    if (!until) return none;
    const context = parseObject(run.contextSnapshot);
    const alreadyRedispatched = readNonEmptyString(parseObject(context.harnessFallbackRedispatch).fromRunId) !== null;
    await appendRunEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: `Harness ${dispatch.targetKey} cooled down until ${until.toISOString()} (${reason})`,
      payload: {
        harnessTarget: dispatch.targetKey,
        reason,
        cooldownUntil: until.toISOString(),
        resetKnown: decision.resetAt !== null,
        nextTarget: nextTarget?.key ?? null,
        alreadyRedispatched,
      },
    });
    // A wake gets one re-dispatch. A failed fallback run defers the wake to its
    // own cooldown end instead of hopping to the next target a moment later.
    if (alreadyRedispatched) return { ...none, deferUntil: until };
    if (!nextTarget) return none;
    const scheduled = await scheduleBoundedRetryForRun(run, executedAgent, {
      retryReason: HARNESS_FALLBACK_RETRY_REASON,
      wakeReason: HARNESS_FALLBACK_WAKE_REASON,
      maxAttempts: executionRetryAttemptCount(run, HARNESS_FALLBACK_RETRY_REASON) + 1,
      delayMs: 0,
      contextPatch: {
        harnessFallbackRedispatch: {
          fromRunId: run.id,
          fromTarget: dispatch.targetKey,
          toTarget: nextTarget.key,
          reason,
        },
      },
    });
    return { ...none, redispatched: scheduled.outcome === "scheduled" };
  }

  const admitScheduledRetryThroughAutomationWindow: RetryAdmissionPolicy = ({ tx, run, now }) =>
    admitThroughAutomationWindow(tx as Db, {
      companyId: run.companyId,
      agentId: run.agentId,
      reason: readNonEmptyString(run.contextSnapshot.wakeReason),
      issueId: readNonEmptyString(run.contextSnapshot.issueId),
      now,
      excludeRunId: run.id,
    });

  async function promoteDueScheduledRetries(now = new Date()) {
    await coalesceProviderQuotaRetries(now).catch((err) => {
      logger.warn({ err }, "failed to coalesce provider quota retries");
    });
    const cutoff = await getWorktreeExecutionCutoff();
    const result = await runDispatch.promoteDueScheduledRetries({
      now,
      cutoff,
      admission: admitScheduledRetryThroughAutomationWindow,
    });
    applyRunDispatchPostCommitEffects(result.postCommitEffects);
    return { promoted: result.promoted, runIds: result.runIds };
  }

  async function getIssueRetryRun(
    companyId: string,
    issueId: string,
    statuses: Array<"scheduled_retry" | "queued" | "running" | "cancelled">,
  ) {
    if (statuses.length === 0) return null;
    return db
      .select({
        run: heartbeatRuns,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, statuses),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.retryOfRunId} is not null`,
        ),
      )
      .orderBy(
        desc(heartbeatRuns.updatedAt),
        desc(heartbeatRuns.createdAt),
        desc(heartbeatRuns.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function summarizeIssueScheduledRetryRun(row: {
    run: typeof heartbeatRuns.$inferSelect;
    agentName: string | null;
  }) {
    return {
      runId: row.run.id,
      status: row.run.status as
        "scheduled_retry" | "queued" | "running" | "cancelled",
      agentId: row.run.agentId,
      agentName: row.agentName,
      retryOfRunId: row.run.retryOfRunId,
      scheduledRetryAt: row.run.scheduledRetryAt,
      scheduledRetryAttempt: row.run.scheduledRetryAttempt,
      scheduledRetryReason: row.run.scheduledRetryReason,
      error: row.run.error,
      errorCode: row.run.errorCode,
    };
  }

  async function retryScheduledRetryNow(input: {
    issueId: string;
    actor?: {
      actorType?: "user" | "agent" | "system";
      actorId?: string | null;
    };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const scheduled = await getIssueRetryRun(issue.companyId, issue.id, [
      "scheduled_retry",
    ]);
    if (!scheduled) {
      const alreadyPromoted = await getIssueRetryRun(
        issue.companyId,
        issue.id,
        ["queued", "running"],
      );
      if (alreadyPromoted) {
        return {
          outcome: "already_promoted" as const,
          message: "Scheduled retry was already promoted",
          scheduledRetry: summarizeIssueScheduledRetryRun(alreadyPromoted),
        };
      }
      return {
        outcome: "no_scheduled_retry" as const,
        message: "No live scheduled retry exists for this issue",
        scheduledRetry: null,
      };
    }

    const contextSnapshot = {
      ...parseObject(scheduled.run.contextSnapshot),
      scheduledRetryAt: now.toISOString(),
      retryNowRequestedAt: now.toISOString(),
      retryNowRequestedByActorType: input.actor?.actorType ?? null,
      retryNowRequestedByActorId: input.actor?.actorId ?? null,
    };

    const updated = await db.transaction(async (tx) => {
      const row = await tx
        .update(heartbeatRuns)
        .set({
          scheduledRetryAt: now,
          contextSnapshot,
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, scheduled.run.id),
            eq(heartbeatRuns.status, "scheduled_retry"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (row.wakeupRequestId) {
        const wakeupPayload = {
          ...parseObject(
            await tx
              .select({ payload: agentWakeupRequests.payload })
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.id, row.wakeupRequestId))
              .then((rows) => rows[0]?.payload ?? null),
          ),
          scheduledRetryAt: now.toISOString(),
          retryNowRequestedAt: now.toISOString(),
        };
        await tx
          .update(agentWakeupRequests)
          .set({
            payload: wakeupPayload,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, row.wakeupRequestId));
      }

      return row;
    });

    if (!updated) {
      const alreadyPromoted = await getIssueRetryRun(
        issue.companyId,
        issue.id,
        ["queued", "running"],
      );
      if (alreadyPromoted) {
        return {
          outcome: "already_promoted" as const,
          message: "Scheduled retry was already promoted",
          scheduledRetry: summarizeIssueScheduledRetryRun(alreadyPromoted),
        };
      }
      return {
        outcome: "no_scheduled_retry" as const,
        message: "No live scheduled retry exists for this issue",
        scheduledRetry: null,
      };
    }

    await appendRunEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Scheduled retry was requested to run now",
      payload: {
        issueId: issue.id,
        scheduledRetryAttempt: updated.scheduledRetryAttempt,
        scheduledRetryAt: updated.scheduledRetryAt
          ? new Date(updated.scheduledRetryAt).toISOString()
          : null,
        scheduledRetryReason: updated.scheduledRetryReason,
        requestedByActorType: input.actor?.actorType ?? null,
        requestedByActorId: input.actor?.actorId ?? null,
      },
    });

    const promotion = await runDispatch.promoteScheduledRetry({
      runId: updated.id,
      companyId: updated.companyId,
      now,
    });
    if (promotion.outcome === "promoted") {
      applyRunDispatchPostCommitEffects(promotion.postCommitEffects);
    }
    // Promotion can preserve this row as a cleanup wait. Read that exact run,
    // not an older cancelled retry or the pre-promotion schedule.
    const currentRun = await getRun(updated.id);
    const scheduledRetry = currentRun
      ? summarizeIssueScheduledRetryRun({
          run: currentRun,
          agentName: scheduled.agentName,
        })
      : null;

    if (currentRun?.status === "scheduled_retry") {
      return {
        outcome: "waiting" as const,
        message: parseObject(currentRun.resultJson?.executionWait).cause === "execution_owner_active"
          ? "Waiting for execution cleanup. Paperclip will retry automatically once cleanup finishes."
          : "The retry remains scheduled. Paperclip will check again at the scheduled time.",
        scheduledRetry,
      };
    }

    if (promotion.outcome === "promoted") {
      return {
        outcome: "promoted" as const,
        message: "Scheduled retry was promoted to the queued run pool",
        scheduledRetry,
      };
    }
    if (promotion.outcome === "gate_suppressed") {
      return {
        outcome: "gate_suppressed" as const,
        message: promotion.reason,
        scheduledRetry,
      };
    }
    if (currentRun && ["queued", "running"].includes(currentRun.status)) {
      return {
        outcome: "already_promoted" as const,
        message: "Scheduled retry was already promoted",
        scheduledRetry,
      };
    }
    return {
      outcome: "no_scheduled_retry" as const,
      message: "No live scheduled retry exists for this issue",
      scheduledRetry: null,
    };
  }

  function timerClaimWasFirstHeartbeat(
    run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot">,
  ): true | undefined {
    return parseObject(run.contextSnapshot).timerClaimWasFirstHeartbeat === true
      ? true
      : undefined;
  }

  return {
    scheduleBoundedRetryForRun,
    timerClaimWasFirstHeartbeat,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    findSharedWorkspaceHolder,
    findExecutionWorkspaceHolder,
    finalizeAiConnectionBusyDeferral,
    finalizeWorkspaceBusyDeferral,
    promoteDueScheduledRetries,
    retryScheduledRetryNow,
    waitForProviderQuotaLane,
    recordProviderQuotaWait,
    recordProviderQuotaCapExemptionExhausted,
    handleProviderQuotaFailure,

    scheduleBoundedRetry: async (
      runId: string,
      opts?: {
        now?: Date;
        random?: () => number;
        retryReason?: string;
        wakeReason?: string;
        maxAttempts?: number;
        delayMs?: number;
      },
    ) => {
      const run = await getRun(runId, { unsafeFullResultJson: true });
      if (!run) return { outcome: "missing_run" as const };
      const agent = await getAgent(run.agentId);
      if (!agent) return { outcome: "missing_agent" as const };
      return scheduleBoundedRetryForRun(run, agent, opts);
    },
  };
}
