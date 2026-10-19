import { withExternalAdmissionGuard, assertNoExternalOverlap } from "../../modules/external-agents/index.js";
import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";
import { normalizeAgentNameKey } from "./retries.js";
import { publishActiveDotComment } from "../dot-assignment-follow-up.js";
import { publishActiveMuseComment } from "../muse-assignment-follow-up.js";
import {
  type WakeupOptions,
  mergeCoalescedContextSnapshot,
  enrichWakeContextSnapshot,
  hasInteractionContinuationWakeContext,
  isInteractionResolutionWakePayload,
} from "./run-preparation.js";
import { resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import {
  CHAT_COMPLETION_WAKE_REASON,
  isCompletedOnboardingHandoffWake,
} from "../chat-completion-delivery.js";
import {
  compareCents,
  hasWorkspaceRestoreFailure,
} from "@paperclipai/shared";
import { nonIdleSlackIssueCondition } from "../slack-conversation-state.js";
import { readQueuedInteractionResponse } from "../queued-interaction-response.js";
import {
  isConversation,
  isConversationExecutionWake,
  isWaitingConversation,
} from "../agent-conversations.js";
import { legacyControllerClaim } from "../legacy-controller-lease.js";
import {
  admitExplicitNativeContinuation,
  undeliveredLegacyUserCommentIds,
} from "../explicit-native-continuation.js";
import { canRetryStoppedRun } from "../cancelled-native-startup.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "../execution-blocker.js";
import { validateNativeWorkspaceReconstruction } from "../native-runtime/native-workspace-reconstruction.js";
import { isConversationAdapter } from "../conversation-continuation.js";
import { recordExecutionWait } from "../execution-wait.js";
import {
  getNativeReviewAssignment,
  readNativeReviewAssignmentContext,
} from "../native-runtime/native-review-participant.js";
import { claimQueuedNativeReviewRun } from "../native-runtime/native-review-dispatch.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { executionFailureRetryCount } from "../execution-recovery-attempt.js";
import {
  slackMentionAllowsRunStart,
  assertDurableChatWakeupReceipt,
  assertDurableChatWakeupRequest,
  authorizeFailedChatRunRetryWake,
  FailedChatRunRetryAuthorizationError,
  unadmittedChatWakeupCondition,
} from "../durable-chat-wakeup.js";
import { agentService } from "../agents.js";
import { normalizeLegacyRunnerProvider } from "@paperclipai/adapter-utils";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  type DeferredWakeSweepCounters,
  type ExecutionBlocker,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  chatConversations,
  chatEndpoints,
  companies,
  costEvents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  issueTreeHolds,
  routines,
} from "@paperclipai/db";
import {
  conflict,
  HttpError,
  notFound,
} from "../../errors.js";
import { isUniqueViolation } from "../../db-errors.js";
import {
  decideIssueAssignmentWakeRefusal,
  ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX,
  ISSUE_ASSIGNMENT_WAKE_REFUSAL_LOG_LEVEL,
  ISSUE_ASSIGNMENT_WAKE_REFUSED_REASON,
  type IssueAssignmentWakeRefusal,
  parseIssueAssignmentIdempotencyKey,
} from "../issue-assignment-wakeup.js";
import { issueIdEqualsText } from "../issue-id-match.js";
import { selectInCommentBatches } from "../comment-id-batches.js";
import {
  isAcknowledgedNativeReassignmentStop,
  isAcknowledgedNativeStop,
} from "../acknowledged-native-stop.js";
import {
  profileUnavailableReason,
  type HarnessDispatch,
  type harnessFallbackService,
  type ProfileTargetInput,
} from "../harness-fallback.js";
import { parseProviderQuotaRetryPolicy } from "./retries.js";
import { countedDailyRuns, NO_DAILY_RUNS } from "./run-state.js";
import {
  AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY,
  AUTOMATION_WAKE_REASON_SET,
  buildAutomationWakeCoalescedState,
  buildSelfReblockWakeParkedState,
  DEFERRED_WAKE_SWEEP_MIN_AGE_MS,
  DEFERRED_WAKE_SWEEP_RECHECK_MS,
  decideSelfReblockWakeLimit,
  deriveSelfReblockWakeMarker,
  isSelfReblockWakeOwner,
  readSelfReblockWakeMarker,
  resolveMinSecondsBetweenAutomationWakes,
  SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY,
  SELF_REBLOCK_WAKE_PAYLOAD_KEY,
  SELF_REBLOCK_WAKE_WINDOW_MS,
  selectDeferredWakesToPromote,
  selfReblockWakeWindowStart,
  sweepPromotionBudget,
  type OrphanedDeferredWakeRow,
} from "../../modules/wake-queue/index.js";
import { logger } from "../../middleware/logger.js";
import { publishLiveEvent } from "../live-events.js";
import { allocateHeartbeatRunEventSeq } from "../heartbeat-run-events.js";
import {
  queuedCommentIdsFromWakePayload,
  queuedCommentIdsFromRunContext,
  withQueuedCommentIdsInWakePayload,
  withQueuedCommentIdsInRunContext,
} from "../issue-queued-comment-queue.js";
import {
  parseObject,
  asBoolean,
  asNumber,
} from "../../adapters/utils.js";
import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";
import {
  CHAT_CONTROL_RECOVERY_ADMISSION_KEY,
  CHAT_CONTROL_RECOVERY_STOP_CODE,
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
  chatControlRecoveryAdmission,
  readChatControlRecoveryAdmission,
  readChatControlNativeParent,
  readChatControlRecoveryStop,
} from "../chat-control-recovery-stop.js";
import {
  ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
  ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  ISSUE_REWAKE_LOOKBACK_MS,
  ISSUE_REWAKE_RUN_SAMPLE_LIMIT,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "../issue-rewake-throttle.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  ISSUE_SELF_REBLOCK_WAKE_SUPPRESSED_REASON,
} from "../issue-dependency-wakeups.js";
import {
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
  isVerifiedIssueTreeControlInteractionWake,
} from "../issue-tree-control.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  isUnrunnableWorktreeCombo,
  parseIssueExecutionWorkspaceSettings,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
} from "../execution-workspace-policy.js";
import { readContinuationAttempt } from "../recovery/index.js";
import { allowsIssueInteractionWake } from "../../modules/run-dispatch/index.js";
import { withAgentStartLock } from "../agent-start-lock.js";
import {
  evaluateAgentInvokability,
  shouldCancelRunsForNonInvokableAgent,
  type AgentOrgRow,
} from "../agent-invokability.js";
import {
  isHeartbeatWakeOnDemandEnabled,
  readAgentAutomationWakeSettings,
} from "../heartbeat-policy.js";
import { isUuidLike } from "@paperclipai/shared";
import { retryChatControlAdmission } from "../chat-control-admission-retry.js";

import type { HeartbeatServiceOptions } from "../heartbeat.js";
import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { HeartbeatRetryDependencies } from "./retries.js";
import type { HeartbeatRecoveryDependencies, createHeartbeatRecovery } from "./recovery.js";
import type { issueService } from "../issues.js";
import type { issueTreeControlService } from "../issue-tree-control.js";
import type { budgetService } from "../budgets.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { createRunDispatch } from "../../modules/run-dispatch/index.js";
import type { PostCommitEffect as WakeQueuePostCommitEffect, createWakeQueue } from "../../modules/wake-queue/index.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type HeartbeatRunState = ReturnType<typeof createHeartbeatRunState>;
type RunPreparation = ReturnType<typeof createHeartbeatRunPreparation>;

/** Queue policy uses the service's lifecycle effects and process-wide ownership sets. */
export interface HeartbeatQueueDependencies extends Pick<HeartbeatRetryDependencies,
  "setWakeupStatus" | "appendRunEvent" | "finalizeAgentStatus" |
  "getAgentInvokability" | "getWorktreeExecutionCutoff" | "applyRunDispatchPostCommitEffects">,
  Pick<RunPreparation, "toAgentOrgRow" | "listCompanyAgentOrgRows" |
    "resolveResponsibleUserIdForRun" | "getIssueExecutionContext" |
    "getRoutineEnvForExecutionIssue" | "resolveResponsibleUserIdForRunSeed">,
  Pick<HeartbeatRunState, "getAgent" | "getRun" | "resolveExplicitResumeSessionOverride" |
    "resolveSessionBeforeForWakeup" | "hasResolvablePriorSessionWorkspaceForWake">,
  Pick<HeartbeatRecoveryDependencies, "setRunStatus"> {
  sweepPendingCleanupLeases: ReturnType<typeof createHeartbeatRecovery>["sweepPendingCleanupLeases"];
  options: Pick<HeartbeatServiceOptions, "beforeChatControlRecoveryCheck">;
  issuesSvc: Pick<ReturnType<typeof issueService>, "getDependencyReadiness" | "listDependencyReadiness">;
  treeControlSvc: Pick<ReturnType<typeof issueTreeControlService>, "getActivePauseHoldGate">;
  budgets: Pick<ReturnType<typeof budgetService>, "getInvocationBlock">;
  instanceSettings: Pick<ReturnType<typeof instanceSettingsService>, "getExperimental">;
  runDispatch: Pick<ReturnType<typeof createRunDispatch>, "cancelStaleQueuedRun">;
  wakeQueue: Pick<ReturnType<typeof createWakeQueue>,
    "createAdmissionTransactionScope" | "admitWakeBehindIssueExecution" |
    "countRecentSelfReblockWakeRuns" | "findParkedWakeAnchorRun" |
    "retireClosedIssueDeferredWakes" | "listOrphanedDeferredWakes" | "claimDeferredWakeExamination" |
    "getDeferredWakeAgentStats" | "getDeferredWakeParkedBreakdown">;
  /** Per-agent harness/model fallback state; the service builds it once. */
  harnessFallback: Pick<ReturnType<typeof harnessFallbackService>, "resolveDispatch" | "notePrimaryDispatched">;
  /** Started-run usage per agent for the daily run cap (run-state). */
  computeDailyRunUsage: (
    companyId: string,
    options?: { agentId?: string; excludeRunId?: string | null; window?: { start: Date; end: Date } },
    client?: Pick<Db, "select">,
  ) => Promise<Map<string, { total: number; providerQuotaBeforeUsefulAction: number }>>;
  /** The issue's run profile for a legacy run of a fallback-capable harness (run-preparation). */
  resolveRunProfileForRun: (
    run: HeartbeatRun,
    agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType">,
  ) => Promise<ProfileTargetInput | null>;
  /** True when the run must wait for its provider quota lane (retries). */
  waitForProviderQuotaLane: (run: HeartbeatRun, agent: typeof agents.$inferSelect) => Promise<boolean>;
  /** Notes a queued run held for provider quota (retries). */
  recordProviderQuotaWait: (run: HeartbeatRun, heldUntil: Date) => Promise<unknown>;
  activeRunExecutions: Set<string>;
  activeRunExecutionPromises: Set<Promise<void>>;
  activeWakeupPromises: Set<Promise<unknown>>;
  liveRunExecutions: { has(id: string): boolean };
  isHeartbeatRunTerminalStatus: (status: string | null | undefined) => boolean;
  isSameTaskScope: (left: string | null, right: string | null) => boolean;
  runTaskKey: (run: HeartbeatRun) => string | null;
  filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null, live: { has(id: string): boolean }) => T | null;
  getSchedulingSuppression: () => Promise<{ suppressed: boolean; reason: "worktree_instance" | "database_restore_in_progress" | "task_drain" | null }>;
  canStartNewExternalBotWork: (agent: typeof agents.$inferSelect) => Promise<boolean>;
  executeRun: (runId: string) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: Pick<HeartbeatRun, "id" | "companyId">, options?: { suppressImmediateRecovery?: boolean; resumeStrandedQueue?: boolean; anchorRunOnly?: boolean; deferredPostCommitEffects?: WakeQueuePostCommitEffect[] }) => Promise<unknown>;
  applyWakeQueuePostCommitEffects: (effects: WakeQueuePostCommitEffect[]) => Promise<void>;
  publishRunLifecyclePluginEvent: (run: HeartbeatRun) => void;
  cancelRunInternal: (runId: string, reason?: string, options?: { errorCode?: string }) => Promise<unknown>;
  cancelActiveForAgentInternal: (agentId: string, reason: string) => Promise<unknown>;
  resumeExecutionWaitComments: () => Promise<unknown>;
  resumeQueuedCommentInterrupt: (companyId: string, queueId: string) => Promise<unknown>;
  resumeSavedLegacyComments: (companyId: string, queueId: string) => Promise<unknown>;
  formatIssueIdentifierLink: (identifier: string | null, fallback: string) => string;
}

const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;

const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;

const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

export const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

export const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

const TIMER_ACTIONABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;

/** Backs one live receipt per `issue-assignment:<issue>:<assignee>:<generation>` key. */
const ISSUE_ASSIGNMENT_IDEMPOTENCY_UNIQUE_INDEX = "agent_wakeup_requests_issue_assignment_idempotency_uq";
/**
 * The unique index's WHERE clause, spelled as literal SQL so the planner can
 * prove a lookup matches the partial index (a bound parameter cannot).
 */
const ISSUE_ASSIGNMENT_LIVE_RECEIPT_PREDICATE = sql`${agentWakeupRequests.idempotencyKey} LIKE 'issue-assignment:%:%:%' AND ${agentWakeupRequests.status} NOT IN ('skipped', 'failed', 'cancelled')`;

const ROUTINE_EXECUTION_SLOT_INDEX = "issues_open_routine_execution_uq";

/** True when taking an issue's execution slot lost to another open copy of the same routine execution. */
function isRoutineExecutionSlotConflict(error: unknown) {
  return isUniqueViolation(error, ROUTINE_EXECUTION_SLOT_INDEX);
}

function logRoutineExecutionSlotConflict(
  runId: string,
  issueId: string | null,
  site: "claimQueuedRun" | "enqueueWakeup" = "claimQueuedRun",
) {
  logger.warn(
    { runId, issueId, index: ROUTINE_EXECUTION_SLOT_INDEX },
    `${site}: another open copy of this routine execution holds the execution slot; this run cannot take it`,
  );
}

const DEFERRED_WAKE_HELD_ACTION = "heartbeat.deferred_wake_held";
/** A wake the sweep keeps parked this long after it was requested gets one held activity entry. */
const DEFERRED_WAKE_HELD_NOTICE_MS = 10 * 60 * 1000;
type DeferredWakeHeldReason =
  /** The agent has no free run slot. */
  | "no_free_run_slot"
  /** The pass budget ran out, or an older wake of the same issue went first. */
  | "waiting_for_turn"
  | "agent_not_invokable"
  | "budget_stop"
  | "pause_hold"
  | "execution_blocker"
  | "operator_stop"
  | "admission_deferred";

// Counters for deferred-wake redelivery, one set per company so a reader of one
// company never sees another company's activity. They live at module scope on
// purpose: the scheduler and each route module build their own
// `heartbeatService`, and a counter kept inside one instance is invisible to the
// others (the endpoint read an idle copy). They reset on restart;
// `getDeferredWakeStats` pairs them with durable counts read from the queue.
const deferredWakeSweepCounters = new Map<string, DeferredWakeSweepCounters>();
export function deferredWakeCountersForCompany(companyId: string): DeferredWakeSweepCounters {
  let counters = deferredWakeSweepCounters.get(companyId);
  if (!counters) {
    counters = {
      examined: 0,
      promoted: 0,
      retired: 0,
      stillDeferred: 0,
      skippedHeld: 0,
      skippedPauseHold: 0,
      skippedExecutionBlocker: 0,
      skippedOperatorStop: 0,
      skippedBudget: 0,
      skippedNotInvokable: 0,
      skippedCapacity: 0,
      executionBlockerCauses: {},
      failed: 0,
      lastExaminedAt: null,
    };
    deferredWakeSweepCounters.set(companyId, counters);
  }
  return counters;
}

export class ChatControlRecoveryUnresolvedError extends Error {
  constructor() {
    super(
      "Run admission could not acquire its database locks after bounded retries. No provider work started. Review database contention and send a fresh request; this attempt will not automatically retry.",
    );
  }
}

const RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP = new Set([
  CHAT_COMPLETION_WAKE_REASON,
  "approval_approved",
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  "issue_recovery_action_restored",
]);

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(
    asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT),
  );
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(
    HEARTBEAT_MAX_CONCURRENT_RUNS_MIN,
    Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
  );
}

export function shouldRequireIssueCommentForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.skipIssueComment === true) return false;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  return (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  );
}

async function listUnresolvedBlockerSummaries(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  unresolvedBlockerIssueIds: string[],
) {
  const ids = [...new Set(unresolvedBlockerIssueIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
        inArray(issues.id, ids),
      ),
    )
    .orderBy(asc(issues.title));
}

export function shouldDeferFollowupWakeForSameIssue(input: {
  activeRunStatus: string | null | undefined;
  isSameExecutionAgent: boolean;
  wakeCommentId: string | null | undefined;
  forceFreshSession: boolean;
}) {
  // A comment follow-up or explicit fresh-session wake needs a new run boundary.
  if (!input.isSameExecutionAgent) return false;
  if (input.activeRunStatus !== "running") return false;
  if (input.wakeCommentId) return true;
  if (input.forceFreshSession) return true;
  return false;
}

export function shouldQueueFollowupForRunningIssueWake(input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  wakeCommentId: string | null;
}) {
  if (input.wakeCommentId) return true;
  // A structured interaction response is new input just like a comment. It
  // must run after the turn that created the interaction instead of being
  // merged into that still-running turn.
  if (
    readNonEmptyString(input.contextSnapshot?.interactionId) &&
    readNonEmptyString(input.contextSnapshot?.interactionStatus)
  ) {
    return true;
  }
  const wakeReason = readNonEmptyString(input.contextSnapshot?.wakeReason);
  if (wakeReason === "issue_children_completed" && (
    input.contextSnapshot?.onboardingCompletion === true ||
    (input.contextSnapshot?.statusDecisionSource === "native_status_decision" &&
      readNonEmptyString(input.contextSnapshot?.nativeChildCompletionDecisionId))
  )) return true;
  return Boolean(
    wakeReason && RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP.has(wakeReason),
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Queue admission and dispatch share the service lifecycle callbacks and execution ownership. */
export function createHeartbeatQueue(db: Db, dependencies: HeartbeatQueueDependencies) {
  const {
    setRunStatus,
    setWakeupStatus,
    appendRunEvent,
    releaseIssueExecutionAndPromote,
    applyWakeQueuePostCommitEffects,
    issuesSvc,
    options,
    publishRunLifecyclePluginEvent,
    finalizeAgentStatus,
    getAgent,
    cancelRunInternal,
    toAgentOrgRow,
    getAgentInvokability,
    budgets,
    activeRunExecutions,
    treeControlSvc,
    runDispatch,
    applyRunDispatchPostCommitEffects,
    resolveResponsibleUserIdForRun,
    getIssueExecutionContext,
    isHeartbeatRunTerminalStatus,
    liveRunExecutions,
    getSchedulingSuppression,
    resumeExecutionWaitComments,
    getWorktreeExecutionCutoff,
    resumeQueuedCommentInterrupt,
    resumeSavedLegacyComments,
    cancelActiveForAgentInternal,
    listCompanyAgentOrgRows,
    executeRun,
    canStartNewExternalBotWork,
    activeRunExecutionPromises,
    activeWakeupPromises,
    instanceSettings,
    getRun,
    sweepPendingCleanupLeases,
    resolveExplicitResumeSessionOverride,
    resolveSessionBeforeForWakeup,
    hasResolvablePriorSessionWorkspaceForWake,
    getRoutineEnvForExecutionIssue,
    resolveResponsibleUserIdForRunSeed,
    formatIssueIdentifierLink,
    wakeQueue,
    isSameTaskScope,
    runTaskKey,
    filterZombieCoalesceTarget,
    harnessFallback,
    computeDailyRunUsage,
    resolveRunProfileForRun,
    waitForProviderQuotaLane,
    recordProviderQuotaWait,
  } = dependencies;

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, false),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent),
      // A Dot binding has one external turn. Competing assignments must retain
      // their queue position instead of claiming a second run that cannot bind.
      maxConcurrentRuns: agent.adapterType === "paperclip_runner" &&
        ["openai_dot", "grok_bot", "muse"].includes(String(parseObject(agent.adapterConfig).provider))
        ? 1 : normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      automationWakeSettings: readAgentAutomationWakeSettings(heartbeat),
      skipTimerWhenNoActionableWork: asBoolean(
        heartbeat.skipTimerWhenNoActionableWork ??
          heartbeat.requireActionableTimerWork ??
          heartbeat.issueOnlyTimer,
        false,
      ),
      maxDailyRuns: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyRuns ??
          heartbeat.dailyRunLimit ??
          heartbeat.dailyRunCap ??
          heartbeat.maxRunsPerDay,
      ),
      maxDailyCostCents: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyCostCents ??
          heartbeat.dailyCostCentsLimit ??
          heartbeat.dailySpendCentsLimit ??
          heartbeat.dailyBudgetCents,
      ),
      providerQuotaRetry: parseProviderQuotaRetryPolicy(
        heartbeat.providerQuotaRetry,
      ),
    };
  }

  function normalizeOptionalNonNegativeInteger(value: unknown) {
    if (value === null || value === undefined || value === "") return null;
    const normalized = Math.floor(asNumber(value, 0));
    return normalized >= 0 ? normalized : null;
  }

  function currentUtcDayWindow(now = new Date()) {
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
    return { start, end };
  }

  async function getHeartbeatDailyCapBlock(
    agent: typeof agents.$inferSelect,
    policy: ReturnType<typeof parseHeartbeatPolicy>,
    options: {
      checkRunCap?: boolean;
      checkCostCap?: boolean;
      excludeRunId?: string | null;
    } = {},
    client: Pick<Db, "select"> = db,
  ) {
    const checkRunCap = options.checkRunCap ?? true;
    const checkCostCap = options.checkCostCap ?? true;
    const { start, end } = currentUtcDayWindow();
    if (checkRunCap && policy.maxDailyRuns !== null) {
      const usage = await computeDailyRunUsage(
        agent.companyId,
        { agentId: agent.id, excludeRunId: options.excludeRunId, window: { start, end } },
        client,
      );
      const observed = countedDailyRuns(usage.get(agent.id) ?? NO_DAILY_RUNS, policy);
      if (observed >= policy.maxDailyRuns) {
        return {
          reason: "heartbeat.daily_run_limit",
          observed,
          limit: policy.maxDailyRuns,
        };
      }
    }

    if (checkCostCap && policy.maxDailyCostCents !== null) {
      const [row] = await client
        .select({
          total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, agent.companyId),
            eq(costEvents.agentId, agent.id),
            gte(costEvents.occurredAt, start),
            lt(costEvents.occurredAt, end),
          ),
        );
      const observed = Number(row?.total ?? 0);
      if (compareCents(String(row?.total ?? 0), policy.maxDailyCostCents) >= 0) {
        return {
          reason: "heartbeat.daily_cost_limit",
          observed,
          limit: policy.maxDailyCostCents,
        };
      }
    }

    return null;
  }

  async function resolveAutomationWakeWindowSec(
    dbOrTx: Db,
    input: {
      agent: { companyId: string; runtimeConfig: unknown };
      reason: string;
      issue: { originKind: string | null; originId: string | null } | null;
    },
  ): Promise<number> {
    if (!AUTOMATION_WAKE_REASON_SET.has(input.reason)) return 0;
    const { agent, issue } = input;
    return resolveMinSecondsBetweenAutomationWakes({
      reason: input.reason,
      agent: parseHeartbeatPolicy(agent as typeof agents.$inferSelect).automationWakeSettings,
      company: await dbOrTx
        .select({ settings: companies.automationWakeSettings })
        .from(companies)
        .where(eq(companies.id, agent.companyId))
        .then((rows) => rows[0]?.settings ?? null),
      routine:
        issue?.originKind === "routine_execution" && issue.originId
          ? await dbOrTx
              .select({ settings: routines.automationWakeSettings })
              .from(routines)
              .where(and(eq(routines.id, issue.originId), eq(routines.companyId, agent.companyId)))
              .then((rows) => rows[0]?.settings ?? null)
          : null,
    });
  }

  async function lockAutomationWakeWindow(tx: Db, companyId: string, agentId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`automation-wake-window:${companyId}:${agentId}`}, 0))`,
    );
  }

  async function tryLockAutomationWakeWindow(tx: Db, companyId: string, agentId: string): Promise<boolean> {
    const rows = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`automation-wake-window:${companyId}:${agentId}`}, 0)) as acquired`,
    );
    return Boolean(rows[0]?.acquired);
  }

  async function findLastAutomationRun(
    dbOrTx: Db,
    input: { companyId: string; agentId: string; since: Date; excludeRunId?: string },
  ) {
    const [row] = await dbOrTx
      .select({ createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          gte(heartbeatRuns.createdAt, input.since),
          inArray(sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`, [...AUTOMATION_WAKE_REASON_SET]),
          input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : undefined,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Admits an automation wake that is about to start a run outside the fresh-wake path: a
   * scheduled retry or a deferred wake promoted on release. Inside the caller's transaction,
   * under the same per-agent lock as fresh wakes, it is held while the agent's window is open;
   * otherwise its admission time opens a new window.
   */
  async function admitThroughAutomationWindow(
    txDb: Db,
    input: {
      companyId: string;
      agentId: string;
      reason: string | null;
      issueId: string | null;
      now: Date;
      excludeRunId?: string;
      /** Hold, rather than wait, when another transaction owns the window lock. */
      nonblocking?: boolean;
    },
  ): Promise<{ hold: true; holdUntil: Date } | { hold: false; admittedAt?: Date }> {
    const proceed = { hold: false as const };
    if (!input.reason) return proceed;
    const [agent] = await txDb.select().from(agents).where(eq(agents.id, input.agentId));
    if (!agent) return proceed;
    const issue = input.issueId
      ? await txDb
          .select({ originKind: issues.originKind, originId: issues.originId })
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const windowSec = await resolveAutomationWakeWindowSec(txDb, { agent, reason: input.reason, issue });
    if (windowSec <= 0) return proceed;
    if (input.nonblocking) {
      if (!(await tryLockAutomationWakeWindow(txDb, input.companyId, input.agentId))) {
        return { hold: true as const, holdUntil: input.now };
      }
    } else {
      await lockAutomationWakeWindow(txDb, input.companyId, input.agentId);
    }
    // The caller's clock predates any wait for the issue and window locks; admit on a fresh one.
    const admittedAt = new Date(Math.max(input.now.getTime(), Date.now()));
    const last = await findLastAutomationRun(txDb, {
      companyId: input.companyId,
      agentId: input.agentId,
      since: new Date(admittedAt.getTime() - windowSec * 1000),
      excludeRunId: input.excludeRunId,
    });
    return last
      ? { hold: true as const, holdUntil: new Date(last.createdAt.getTime() + windowSec * 1000 + 1) }
      : { hold: false as const, admittedAt };
  }

  async function cancelQueuedRunForHeartbeatDailyCap(
    run: typeof heartbeatRuns.$inferSelect,
    dailyCapBlock: NonNullable<
      Awaited<ReturnType<typeof getHeartbeatDailyCapBlock>>
    >,
  ) {
    const now = new Date();
    const reason =
      "Cancelled because the agent reached a per-day heartbeat budget cap before adapter invocation";
    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: now,
      error: reason,
      errorCode: dailyCapBlock.reason,
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: dailyCapBlock.reason,
        observed: dailyCapBlock.observed,
        limit: dailyCapBlock.limit,
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "heartbeat_daily_cap_gate",
        timeoutFired: false,
      },
    });
    if (!cancelled) return null;

    await setWakeupStatus(run.wakeupRequestId, "skipped", {
      finishedAt: now,
      error: reason,
    });

    await appendRunEvent(cancelled, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason,
      payload: {
        reason: dailyCapBlock.reason,
        observed: dailyCapBlock.observed,
        limit: dailyCapBlock.limit,
      },
    });

    await releaseIssueExecutionAndPromote(cancelled, {
      suppressImmediateRecovery: true,
    });

    return cancelled;
  }

  async function hasActionableTimerWork(agent: typeof agents.$inferSelect) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          eq(issues.assigneeAgentId, agent.id),
          isNull(issues.assigneeUserId),
          isNull(issues.hiddenAt),
          inArray(issues.status, [...TIMER_ACTIONABLE_ISSUE_STATUSES]),
          isNull(issues.conversationAgentId),
          nonIdleSlackIssueCondition(),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function markTimerHeartbeatChecked(
    agentId: string,
    source: WakeupOptions["source"],
  ) {
    if (source !== "timer") return;
    await db
      .update(agents)
      .set({
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  async function claimDueTimerHeartbeat(
    agent: typeof agents.$inferSelect,
    now: Date,
    intervalSec: number,
  ) {
    const dueBefore = new Date(now.getTime() - intervalSec * 1000);
    const claimed = await db
      .update(agents)
      .set({
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.id, agent.id),
          eq(agents.companyId, agent.companyId),
          or(
            lte(agents.lastHeartbeatAt, dueBefore),
            and(
              isNull(agents.lastHeartbeatAt),
              lte(agents.createdAt, dueBefore),
            ),
          ),
        ),
      )
      .returning({ id: agents.id })
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;
    return { wasFirstHeartbeat: !agent.lastHeartbeatAt };
  }

  function issueRunPriorityRank(priority: string | null | undefined) {
    switch (priority) {
      case "critical":
        return 0;
      case "high":
        return 1;
      case "medium":
        return 2;
      case "low":
        return 3;
      default:
        return 4;
    }
  }

  async function listQueuedRunDependencyReadiness(
    companyId: string,
    queuedRuns: Array<typeof heartbeatRuns.$inferSelect>,
  ) {
    const issueIds = [
      ...new Set(
        queuedRuns
          .map((run) =>
            readNonEmptyString(parseObject(run.contextSnapshot).issueId),
          )
          .filter((issueId): issueId is string => Boolean(issueId)),
      ),
    ];
    if (issueIds.length === 0) {
      return new Map<
        string,
        Awaited<ReturnType<typeof issuesSvc.getDependencyReadiness>>
      >();
    }
    return issuesSvc.listDependencyReadiness(companyId, issueIds);
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    return Number(count ?? 0);
  }

  async function withChatControlRecoveryGate(
    run: typeof heartbeatRuns.$inferSelect,
    stage: "claim" | "dispatch",
    onClear: (tx: Db) => Promise<typeof heartbeatRuns.$inferSelect | null>,
    nativeRecovery = false,
  ) {
    const issueId = readNonEmptyString(
      parseObject(run.contextSnapshot).issueId,
    );
    if (!issueId || run.invocationSource !== "automation") return onClear(db);
    await options.beforeChatControlRecoveryCheck?.({
      runId: run.id,
      issueId,
      stage,
    });
    if (stage === "dispatch" && nativeRecovery) {
      // Protected historical/already-admitted owners did not previously take
      // this fence's locks. A fresh exact read keeps unrelated Board contention
      // from turning their recovery into a new admission failure.
      const [current] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.agentId, run.agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .limit(1);
      if (
        current &&
        current.wakeupRequestId === run.wakeupRequestId &&
        parseObject(current.contextSnapshot).issueId === issueId
      ) {
        const admission = readChatControlRecoveryAdmission(current);
        const expected = readChatControlRecoveryAdmission(run);
        if (
          expected !== "invalid" &&
          (admission === "admitted" ||
            (admission === "historical" && expected === "historical"))
        )
          return onClear(db);
      }
    }
    let terminal: typeof heartbeatRuns.$inferSelect | null = null;
    try {
      const attempt = () => db.transaction(async (tx) => {
        terminal = null;
        // Same queue-edit lock order, then the close committer's conversation
        // row. NOWAIT releases partial locks on contention. Claim defers to the
        // queue; dispatch retries this transaction before considering failure.
        const [issue] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (!issue) return null;
        if (run.wakeupRequestId)
          await tx
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.id, run.wakeupRequestId),
                eq(agentWakeupRequests.companyId, run.companyId),
                eq(agentWakeupRequests.agentId, run.agentId),
              ),
            )
            .for("update", { noWait: true })
            .limit(1);
        const [current] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.agentId, run.agentId),
            ),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (
          !current ||
          current.status !== (stage === "claim" ? "queued" : "running")
        )
          return null;
        const admission = readChatControlRecoveryAdmission(current);
        const expectedAdmission = readChatControlRecoveryAdmission(run);
        const admissionLost =
          expectedAdmission !== "historical" && admission === "historical";
        if (
          stage === "dispatch" &&
          nativeRecovery &&
          !admissionLost &&
          (admission === "historical" || admission === "admitted")
        )
          return onClear(tx as unknown as Db);
        // A new warm child can inherit a prior runner's PID during preparation.
        // Those fields do not prove this run's turn was dispatched.
        // Exact admitted/historical recovery retains its existing ownership;
        // a marked, unadmitted bootstrap must earn admission even after crash.
        const proof =
          admission === "invalid" || admissionLost
            ? { kind: "unresolved" as const }
            : await readChatControlRecoveryStop(
                tx as unknown as Db,
                {
                  companyId: run.companyId,
                  issueId,
                  agentId: run.agentId,
                  sourceRunId: run.id,
                },
                true,
              );
        if (proof.kind === "clear") {
          if (stage === "claim" || admission === "required")
            await tx
              .update(heartbeatRuns)
              .set({
                runnerProfileJson: {
                  ...parseObject(current.runnerProfileJson),
                  [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]:
                    chatControlRecoveryAdmission(
                      current,
                      stage === "dispatch"
                        ? "admitted"
                        : admission === "admitted"
                          ? "admitted"
                          : "required",
                    ),
                },
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, current.id));
          return onClear(tx as unknown as Db);
        }
        if (proof.kind === "unresolved" && stage === "claim") return null;
        const now = new Date();
        const stopped = proof.kind === "stopped";
        const code = stopped
          ? CHAT_CONTROL_RECOVERY_STOP_CODE
          : CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE;
        const error = stopped
          ? "Automatic continuation stopped by the committed chat conversation close. Send a new request in chat or on the Board to start fresh work."
          : "Automatic continuation source could not be verified before provider admission. Review the task and send a fresh request; this attempt will not automatically retry.";
        [terminal] = await tx
          .update(heartbeatRuns)
          .set({
            status: stopped ? "cancelled" : "failed",
            errorCode: code,
            error,
            finishedAt: now,
            resultJson: {
              ...parseObject(current.resultJson),
              automaticRecovery: {
                code,
                providerDispatched: false,
                ...(stopped
                  ? {
                      sourceRunId: proof.sourceRunId,
                      conversationId: proof.conversationId,
                      publicationId: proof.publicationId,
                    }
                  : {}),
              },
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(heartbeatRuns.id, current.id),
              eq(heartbeatRuns.status, current.status),
            ),
          )
          .returning();
        if (!terminal) return null;
        if (current.wakeupRequestId)
          await tx
            .update(agentWakeupRequests)
            .set({
              status: stopped ? "skipped" : "failed",
              error,
              finishedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(agentWakeupRequests.id, current.wakeupRequestId),
                eq(agentWakeupRequests.companyId, current.companyId),
                eq(agentWakeupRequests.agentId, current.agentId),
                eq(agentWakeupRequests.runId, current.id),
                ne(agentWakeupRequests.status, "cancelled"),
              ),
            );
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, current.companyId),
              eq(issues.id, issueId),
              eq(issues.executionRunId, current.id),
            ),
          );
        return null;
      });
      const result = stage === "dispatch"
        ? await retryChatControlAdmission(attempt)
        : await attempt();
      if (terminal) {
        const settled = terminal as typeof heartbeatRuns.$inferSelect;
        publishLiveEvent({
          companyId: settled.companyId,
          type: "heartbeat.run.status",
          payload: {
            runId: settled.id,
            agentId: settled.agentId,
            status: settled.status,
            errorCode: settled.errorCode,
            error: settled.error,
          },
        });
        publishRunLifecyclePluginEvent(settled);
        if (stage === "dispatch")
          await finalizeAgentStatus(settled.agentId, "cancelled");
      }
      return result;
    } catch (error) {
      if (!isExternalChatWaitAuthorizationContention(error)) throw error;
      if (stage === "dispatch") {
        // No effect was admitted. Let the existing setup-failure path settle
        // this attempt distinctly; it must not become a successful close.
        throw new ChatControlRecoveryUnresolvedError();
      }
      return null;
    }
  }

  async function claimQueuedRun(
    run: typeof heartbeatRuns.$inferSelect,
    companyAgents?: AgentOrgRow[],
    deferredPostCommitEffects?: WakeQueuePostCommitEffect[],
  ) {
    if (run.status !== "queued") return run;
    // Claim is the first execution boundary. startedAt survives same-run
    // retries; restart recovery may also enter executeRun already running.
    // Neither may reinterpret an admitted, already-started message as new work.
    if (!run.startedAt && !(await slackMentionAllowsRunStart(db, run))) {
      const now = new Date();
      const reason = "Message did not @mention the bot";
      // This runs under the agent start lock. Do not use cancelRunInternal,
      // which recursively starts the next run and reacquires that lock.
      const cancelled = await setRunStatus(run.id, "cancelled", {
        finishedAt: now,
        error: reason,
        errorCode: "chat_mention_required",
      });
      if (cancelled) {
        await setWakeupStatus(run.wakeupRequestId, "skipped", { finishedAt: now, error: reason });
        await appendRunEvent(cancelled, {
          eventType: "lifecycle", stream: "system", level: "warn", message: reason,
        });
        await releaseIssueExecutionAndPromote(cancelled, {
          suppressImmediateRecovery: true, deferredPostCommitEffects,
        });
      }
      return null;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(
        run.id,
        "Cancelled because the agent no longer exists",
      );
      return null;
    }
    // Keep accepted work in the durable queue until setup completes.
    if (isAgentAwaitingSetup(agent)) return null;
    const invokability = companyAgents
      ? evaluateAgentInvokability(toAgentOrgRow(agent), companyAgents)
      : await getAgentInvokability(agent);
    if (!invokability.invokable) {
      await cancelRunInternal(
        run.id,
        `Cancelled because the agent is not invokable: ${invokability.reason}`,
      );
      return null;
    }
    if (!run.startedAt && !await canStartNewExternalBotWork(agent)) return null;

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(
      run.companyId,
      run.agentId,
      {
        issueId: readNonEmptyString(context.issueId),
        projectId: readNonEmptyString(context.projectId),
      },
    );
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    const dailyCapBlock = await getHeartbeatDailyCapBlock(
      agent,
      parseHeartbeatPolicy(agent),
      {
        excludeRunId: run.id,
        checkRunCap: true,
        checkCostCap: true,
      },
    );
    if (dailyCapBlock) {
      await cancelQueuedRunForHeartbeatDailyCap(run, dailyCapBlock);
      return null;
    }
    if (await waitForProviderQuotaLane(run, agent)) return null;

    const runProfile = await resolveRunProfileForRun(run, agent);
    const harnessDecision = await harnessFallback.resolveDispatch(agent, new Date(), runProfile);
    if (runProfile && profileUnavailableReason(agent, runProfile)) {
      logger.warn(
        { runId: run.id, agentId: agent.id, profile: runProfile },
        "run profile needs credentials this agent does not have for that harness; running on the agent default",
      );
    }
    if (harnessDecision.heldUntil && run.runtimeMode !== "native") {
      // Every harness/model of this agent is out of provider quota. Leave the
      // run queued: the scheduler tick claims it once a target recovers, and
      // the daily run cap is not charged for the wait.
      await recordProviderQuotaWait(run, harnessDecision.heldUntil);
      return null;
    }
    const harnessDispatch: HarnessDispatch = harnessDecision.dispatch;
    const adapterDispatchPatch = JSON.stringify({ adapterDispatch: harnessDispatch });
    const harnessDispatchColumns = {
      executedAdapterType: harnessDispatch.adapterType,
      executedModel: harnessDispatch.model,
      fallbackReason: harnessDispatch.fallbackReason,
    };

    const issueId = readNonEmptyString(context.issueId);
    if (issueId && activeRunExecutions.size > 0) {
      // Native finalization publishes success before workspace synchronization,
      // provider suspension, and lease release finish. A queued comment must
      // not acquire a fresh sandbox while its predecessor still owns that work.
      // The executor's finally block retries this agent after removing its owner.
      const [settlingOwner] = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.runtimeMode, "native"),
          inArray(heartbeatRuns.id, [...activeRunExecutions]),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        ))
        .limit(1);
      if (settlingOwner) return null;
    }
    if (issueId) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
        run.companyId,
        issueId,
      );
      const treeHoldInteractionWake =
        activePauseHold &&
        (await isVerifiedIssueTreeControlInteractionWake(db, {
          companyId: run.companyId,
          issueId,
          agentId: run.agentId,
          runId: run.id,
          wakeupRequestId: run.wakeupRequestId,
          contextSnapshot: context,
        }));
      if (activePauseHold && !treeHoldInteractionWake) {
        await cancelRunInternal(
          run.id,
          "Cancelled because issue is held by an active subtree pause hold",
        );
        await logActivity(db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "system",
          agentId: run.agentId,
          runId: run.id,
          action: "issue.tree_hold_run_interrupted",
          entityType: "heartbeat_run",
          entityId: run.id,
          issueId: issueId,
          details: {
            issueId,
            holdId: activePauseHold.holdId,
            rootIssueId: activePauseHold.rootIssueId,
            source: "heartbeat.claim_queued_run",
            securityPrinciples: [
              "Complete Mediation",
              "Fail Securely",
              "Secure Defaults",
            ],
          },
        });
        return null;
      }

      const dependencyReadiness = await issuesSvc.listDependencyReadiness(
        run.companyId,
        [issueId],
      );
      const readiness = dependencyReadiness.get(issueId);
      const unresolvedBlockerCount = readiness?.unresolvedBlockerCount ?? 0;
      if (
        unresolvedBlockerCount > 0 &&
        !allowsIssueInteractionWake(
          context,
          ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
        )
      ) {
        await cancelQueuedRunForBlockedDependencies(
          run,
          issueId,
          readiness?.unresolvedBlockerIssueIds ?? [],
        );
        logger.info(
          { runId: run.id, issueId, unresolvedBlockerCount },
          "claimQueuedRun: cancelled blocked queued run",
        );
        return null;
      }

      const staleness = await runDispatch.cancelStaleQueuedRun({
        runId: run.id,
        companyId: run.companyId,
        expectedStatus: "queued",
      });
      if (staleness.outcome === "cancelled" || staleness.outcome === "deferred") {
        applyRunDispatchPostCommitEffects(staleness.postCommitEffects);
        logger.info(
          {
            runId: run.id,
            issueId,
            outcome: staleness.outcome,
            errorCode: staleness.outcome === "cancelled" ? staleness.errorCode : undefined,
          },
          "claimQueuedRun: withheld queued run at the execution gate",
        );
        return null;
      }
    }

    const claimedAt = new Date();
    const responsibleUserId = await resolveResponsibleUserIdForRun({
      run,
      contextSnapshot: context,
      issueContext: issueId
        ? await getIssueExecutionContext(run.companyId, issueId)
        : null,
      routineEnvContext: {
        routineId: null,
        env: null,
        responsibleUserId: null,
      },
    });
    // All ordinary and comment claims use the same company-scoped issue
    // lock. A batch may claim several runs before executeRun tracks any owner.
    async function lockIssueExecutionClaim(tx: Db) {
      const [owner] = issueId ? await tx.select({
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      }).from(issues).where(and(
        eq(issues.id, issueId), eq(issues.companyId, run.companyId),
      )).for("update") : [];
      const ownsIssue = owner?.assigneeAgentId === run.agentId &&
        context.wakeReason !== "source_scoped_recovery_action";
      if (ownsIssue && ["native_safe_replacement", "native_provider_overloaded"].includes(run.scheduledRetryReason ?? "") &&
          owner.checkoutRunId && owner.checkoutRunId !== run.id) {
        return { ownsIssue, blocked: true };
      }
      if (run.scheduledRetryReason === "native_provider_overloaded" && owner?.executionRunId &&
          owner.executionRunId !== run.id && owner.executionRunId !== run.retryOfRunId) {
        return { ownsIssue, blocked: true };
      }
      const previousRunId = run.scheduledRetryReason === "native_provider_overloaded"
        ? run.retryOfRunId : ownsIssue ? owner?.executionRunId : null;
      if (previousRunId && previousRunId !== run.id) {
        const [previous] = await tx.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, previousRunId),
            eq(heartbeatRuns.companyId, run.companyId),
          ));
        // A terminal result can precede workspace/lease cleanup on this or
        // another controller. Local absence alone is not a release receipt.
        if (!isHeartbeatRunTerminalStatus(previous?.status) ||
            liveRunExecutions.has(previousRunId)) {
          return { ownsIssue, blocked: true };
        }
        if (await hasPendingRunCleanup(tx, run.companyId, previousRunId)) {
          return { ownsIssue, blocked: true };
        }
      }
      return { ownsIssue, blocked: false };
    }
    async function bindClaimedIssueExecution(tx: Db, ownsIssue: boolean, claimedRun: typeof heartbeatRuns.$inferSelect | null | undefined) {
      if (!claimedRun || !issueId || !ownsIssue) return;
      await tx.update(issues).set({
        executionRunId: claimedRun.id,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: claimedAt,
        updatedAt: claimedAt,
      }).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
    }
    const nativeReviewContext = readNativeReviewAssignmentContext(context);
    const queuedCommentIds = queuedCommentIdsFromRunContext(context);
    if (
      issueId &&
      run.invocationSource === "automation" &&
      queuedCommentIds.length > 0
    )
      await options.beforeChatControlRecoveryCheck?.({
        runId: run.id,
        issueId,
        stage: "claim",
      });
    let routineSlotConflict = false;
    const queuedCommentClaim =
      !nativeReviewContext && issueId && run.wakeupRequestId && queuedCommentIds.length > 0
        ? await db
            .transaction(async (tx) => {
              // Match the queue-edit lock order: issue, wake, then run. Once the
              // run becomes running, a concurrent discard must observe the
              // claimed wake and return an explicit conflict; if discard wins,
              // this claim observes the cancelled queue and does no work.
              const issueClaim = await lockIssueExecutionClaim(tx as unknown as Db);
              if (issueClaim.blocked) return { kind: "stale" as const, run: null };
              const wake = await tx
                .select()
                .from(agentWakeupRequests)
                .where(
                  and(
                    eq(agentWakeupRequests.id, run.wakeupRequestId!),
                    eq(agentWakeupRequests.companyId, run.companyId),
                    eq(agentWakeupRequests.agentId, run.agentId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null);
              const lockedRun = await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, run.id),
                    eq(heartbeatRuns.companyId, run.companyId),
                    eq(heartbeatRuns.agentId, run.agentId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null);
              if (
                !wake ||
                wake.status !== "queued" ||
                wake.runId !== run.id ||
                !lockedRun ||
                lockedRun.status !== "queued" ||
                lockedRun.wakeupRequestId !== wake.id
              ) {
                return { kind: "stale" as const, run: null };
              }

              if (lockedRun.invocationSource === "automation") {
                const admission = readChatControlRecoveryAdmission(lockedRun);
                if (admission === "invalid")
                  return { kind: "stale" as const, run: null };
                const proof = await readChatControlRecoveryStop(
                  tx as unknown as Db,
                  {
                    companyId: lockedRun.companyId,
                    issueId,
                    agentId: lockedRun.agentId,
                    sourceRunId: lockedRun.id,
                  },
                  true,
                );
                if (proof.kind === "unresolved")
                  return { kind: "stale" as const, run: null };
                if (proof.kind === "stopped") {
                  const error =
                    "Automatic continuation stopped by the committed chat conversation close. Send a fresh request in chat or on the Board.";
                  const [cancelled] = await tx
                    .update(heartbeatRuns)
                    .set({
                      status: "cancelled",
                      errorCode: CHAT_CONTROL_RECOVERY_STOP_CODE,
                      error,
                      finishedAt: claimedAt,
                      resultJson: {
                        ...parseObject(lockedRun.resultJson),
                        automaticRecovery: {
                          code: CHAT_CONTROL_RECOVERY_STOP_CODE,
                          providerDispatched: false,
                          sourceRunId: proof.sourceRunId,
                          conversationId: proof.conversationId,
                          publicationId: proof.publicationId,
                        },
                      },
                      updatedAt: claimedAt,
                    })
                    .where(
                      and(
                        eq(heartbeatRuns.id, lockedRun.id),
                        eq(heartbeatRuns.status, "queued"),
                      ),
                    )
                    .returning();
                  if (!cancelled) return { kind: "stale" as const, run: null };
                  await tx
                    .update(agentWakeupRequests)
                    .set({
                      status: "skipped",
                      error,
                      finishedAt: claimedAt,
                      updatedAt: claimedAt,
                    })
                    .where(eq(agentWakeupRequests.id, wake.id));
                  await tx
                    .update(issues)
                    .set({
                      executionRunId: null,
                      executionAgentNameKey: null,
                      executionLockedAt: null,
                      updatedAt: claimedAt,
                    })
                    .where(
                      and(
                        eq(issues.id, issueId),
                        eq(issues.companyId, run.companyId),
                        eq(issues.executionRunId, run.id),
                      ),
                    );
                  return { kind: "cancelled" as const, run: cancelled };
                }
                await tx
                  .update(heartbeatRuns)
                  .set({
                    runnerProfileJson: {
                      ...parseObject(lockedRun.runnerProfileJson),
                      [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]:
                        chatControlRecoveryAdmission(
                          lockedRun,
                          admission === "admitted" ? "admitted" : "required",
                        ),
                    },
                    updatedAt: claimedAt,
                  })
                  .where(eq(heartbeatRuns.id, lockedRun.id));
              }
              const authoritativeIds = queuedCommentIdsFromWakePayload(
                wake.payload,
              );
              if (authoritativeIds.length === 0) {
                // Legacy/direct comment wakes carry comment ids in their ordinary
                // payload and context, not in the authoritative queued-message
                // envelope. Preserve their established claim path; only an
                // explicitly bound queued-message envelope is subject to the
                // live-comment discard gate below.
                await withExternalAdmissionGuard(tx, run.companyId, run.agentId, () => assertNoExternalOverlap(tx, run.companyId, run.agentId));
                const [claimedRun] = await tx
                  .update(heartbeatRuns)
                  .set({
                    status: "running",
                    runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${adapterDispatchPatch}::jsonb`,
                    ...harnessDispatchColumns,
                    ...legacyControllerClaim(run.runtimeMode),
                    responsibleUserId,
                    startedAt: lockedRun.startedAt ?? claimedAt,
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(heartbeatRuns.id, lockedRun.id),
                      eq(heartbeatRuns.status, "queued"),
                    ),
                  )
                  .returning();
                await bindClaimedIssueExecution(tx as unknown as Db, issueClaim.ownsIssue, claimedRun);
                return claimedRun
                  ? { kind: "claimed" as const, run: claimedRun }
                  : { kind: "stale" as const, run: null };
              }
              const commentRows = await selectInCommentBatches(authoritativeIds, (batch) =>
                tx
                  .select({
                    id: issueComments.id,
                    deletedAt: issueComments.deletedAt,
                  })
                  .from(issueComments)
                  .where(
                    and(
                      eq(issueComments.companyId, run.companyId),
                      eq(issueComments.issueId, issueId),
                      inArray(issueComments.id, batch),
                    ),
                  ),
              );
              const commentsById = new Map(commentRows.map((row) => [row.id, row]));
              const liveIds = authoritativeIds.filter((commentId) => {
                const comment = commentsById.get(commentId);
                return Boolean(comment && !comment.deletedAt);
              });
              if (liveIds.length === 0) {
                const reason = "Queued messages were discarded before dispatch";
                const [cancelled] = await tx
                  .update(heartbeatRuns)
                  .set({
                    status: "cancelled",
                    finishedAt: claimedAt,
                    error: reason,
                    errorCode: "queued_comment_discarded",
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(heartbeatRuns.id, lockedRun.id),
                      eq(heartbeatRuns.status, "queued"),
                    ),
                  )
                  .returning();
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    status: "cancelled",
                    finishedAt: claimedAt,
                    error: reason,
                    updatedAt: claimedAt,
                  })
                  .where(eq(agentWakeupRequests.id, wake.id));
                await tx
                  .update(issues)
                  .set({
                    executionRunId: null,
                    executionAgentNameKey: null,
                    executionLockedAt: null,
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(issues.id, issueId),
                      eq(issues.companyId, run.companyId),
                      eq(issues.executionRunId, run.id),
                    ),
                  );
                return {
                  kind: "cancelled" as const,
                  run: cancelled ?? lockedRun,
                };
              }

              await withExternalAdmissionGuard(tx, run.companyId, run.agentId, () => assertNoExternalOverlap(tx, run.companyId, run.agentId));
              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "claimed",
                  claimedAt,
                  payload: withQueuedCommentIdsInWakePayload(
                    wake.payload,
                    liveIds,
                  ),
                  updatedAt: claimedAt,
                })
                .where(eq(agentWakeupRequests.id, wake.id));
              const [claimedRun] = await tx
                .update(heartbeatRuns)
                .set({
                  status: "running",
                  runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${adapterDispatchPatch}::jsonb`,
                  ...harnessDispatchColumns,
                    ...legacyControllerClaim(run.runtimeMode),
                  responsibleUserId,
                  startedAt: lockedRun.startedAt ?? claimedAt,
                  contextSnapshot: withQueuedCommentIdsInRunContext(
                    lockedRun.contextSnapshot,
                    liveIds,
                  ),
                  updatedAt: claimedAt,
                })
                .where(
                  and(
                    eq(heartbeatRuns.id, lockedRun.id),
                    eq(heartbeatRuns.status, "queued"),
                  ),
                )
                .returning();
              await bindClaimedIssueExecution(tx as unknown as Db, issueClaim.ownsIssue, claimedRun);
              return claimedRun
                ? { kind: "claimed" as const, run: claimedRun }
                : { kind: "stale" as const, run: null };
            })
            .catch((error) => {
              if (isExternalChatWaitAuthorizationContention(error))
                return { kind: "stale" as const, run: null };
              if (isRoutineExecutionSlotConflict(error)) {
                routineSlotConflict = true;
                logRoutineExecutionSlotConflict(run.id, issueId);
                return { kind: "stale" as const, run: null };
              }
              throw error;
            })
        : null;
    if (queuedCommentClaim?.kind === "cancelled") {
      await appendRunEvent(queuedCommentClaim.run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          queuedCommentClaim.run.error ??
          "Queued messages were discarded before dispatch",
      });
      publishLiveEvent({
        companyId: queuedCommentClaim.run.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: queuedCommentClaim.run.id,
          agentId: queuedCommentClaim.run.agentId,
          status: queuedCommentClaim.run.status,
          invocationSource: queuedCommentClaim.run.invocationSource,
          triggerDetail: queuedCommentClaim.run.triggerDetail,
          error: queuedCommentClaim.run.error ?? null,
          errorCode: queuedCommentClaim.run.errorCode ?? null,
          startedAt: queuedCommentClaim.run.startedAt
            ? new Date(queuedCommentClaim.run.startedAt).toISOString()
            : null,
          finishedAt: queuedCommentClaim.run.finishedAt
            ? new Date(queuedCommentClaim.run.finishedAt).toISOString()
            : null,
        },
      });
      publishRunLifecyclePluginEvent(queuedCommentClaim.run);
      // Fire-and-forget: nothing else in this path depends on the emission,
      // so it must not delay the return.
      void emitAgentTaskRun(db, queuedCommentClaim.run);
      return null;
    }
    const claimed = queuedCommentClaim
      ? queuedCommentClaim.run
      : await withChatControlRecoveryGate(run, "claim", async (tx) => {
          const claimValues = {
            status: "running",
            runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${adapterDispatchPatch}::jsonb`,
            ...harnessDispatchColumns,
            ...legacyControllerClaim(run.runtimeMode),
            responsibleUserId,
            startedAt: run.startedAt ?? claimedAt,
            updatedAt: claimedAt,
          };
          if (nativeReviewContext) {
            if (run.scheduledRetryReason === "native_provider_overloaded") {
              const predecessor = await lockIssueExecutionClaim(tx);
              if (predecessor.blocked) return null;
            }
            return claimQueuedNativeReviewRun(tx, {
              run, claimedAt, claimValues,
              agentNameKey: normalizeAgentNameKey(agent.name),
            });
          }
          try {
            return await tx.transaction(async (claimTx) => {
              const issueClaim = await lockIssueExecutionClaim(claimTx as unknown as Db);
              if (issueClaim.blocked) return null;
              if (run.wakeupRequestId) await claimTx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
                eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
              )).for("update");
              const [lockedRun] = await claimTx.select().from(heartbeatRuns).where(and(
                eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
              )).for("update");
              if (!lockedRun || lockedRun.status !== "queued") return null;
              await withExternalAdmissionGuard(claimTx, run.companyId, run.agentId, () => assertNoExternalOverlap(claimTx, run.companyId, run.agentId));
              const claimedRun = await claimTx.update(heartbeatRuns).set(claimValues).where(and(
                eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued"),
              )).returning().then((rows) => rows[0] ?? null);
              await bindClaimedIssueExecution(claimTx as unknown as Db, issueClaim.ownsIssue, claimedRun);
              return claimedRun;
            });
          } catch (error) {
            // The claim savepoint is rolled back, so the run is still queued. Taking
            // the slot lost a race with another open copy of the same routine
            // execution. The next pass cancels the run if that copy is live, or claims
            // it once a stale lock is cleared. Never surface the index as an error.
            if (!isRoutineExecutionSlotConflict(error)) throw error;
            routineSlotConflict = true;
            logRoutineExecutionSlotConflict(run.id, issueId);
            return null;
          }
        });
    if (!claimed) {
      if (routineSlotConflict) {
        // Re-decide now that the other copy holds the slot: the staleness check
        // cancels this run if that copy is live, and leaves it queued if the
        // holder is a stale lock that the sweep is about to clear.
        const staleness = await runDispatch.cancelStaleQueuedRun({
          runId: run.id,
          companyId: run.companyId,
          expectedStatus: "queued",
        });
        if (staleness.outcome === "cancelled") {
          applyRunDispatchPostCommitEffects(staleness.postCommitEffects);
          logger.info(
            { runId: run.id, issueId, errorCode: staleness.errorCode },
            "claimQueuedRun: cancelled queued run after losing the routine execution slot",
          );
        }
      }
      return null;
    }
    if (harnessDispatch.target === "primary") {
      await harnessFallback.notePrimaryDispatched(agent, claimed.id).catch((err) => {
        logger.warn({ err, runId: claimed.id }, "failed to record the return to the primary harness");
      });
    }

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt
          ? new Date(claimed.startedAt).toISOString()
          : null,
        finishedAt: claimed.finishedAt
          ? new Date(claimed.finishedAt).toISOString()
          : null,
      },
    });
    publishRunLifecyclePluginEvent(claimed);

    if (!nativeReviewContext) {
      await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    }

    // Fix A (lazy locking): stamp executionRunId now that the run is actually running,
    // not at queue time. Guard is idempotent — safe if called more than once.
    const claimedContext = parseObject(claimed.contextSnapshot);
    const claimedIssueId = readNonEmptyString(claimedContext.issueId);
    const claimedWakeReason = readNonEmptyString(claimedContext.wakeReason);
    if (
      !nativeReviewContext && claimedIssueId &&
      claimedWakeReason !== "source_scoped_recovery_action"
    ) {
      const claimedAgent = await getAgent(claimed.agentId);
      await db
        .update(issues)
        .set({
          executionRunId: claimed.id,
          executionAgentNameKey: normalizeAgentNameKey(claimedAgent?.name),
          executionLockedAt: claimedAt,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(issues.id, claimedIssueId),
            eq(issues.companyId, claimed.companyId),
            // Mention/context runs can touch an issue, but only the current assignee
            // owns the issue execution lock shown as the active run.
            eq(issues.assigneeAgentId, claimed.agentId),
            ["native_safe_replacement", "native_provider_overloaded"].includes(claimed.scheduledRetryReason ?? "")
              ? or(
                  isNull(issues.checkoutRunId),
                  eq(issues.checkoutRunId, claimed.id),
                )
              : undefined,
            or(
              isNull(issues.executionRunId),
              eq(issues.executionRunId, claimed.id),
            ),
          ),
        );
    }

    return claimed;
  }

  // startNextQueuedRunForAgent checks admission suppression once, then claims
  // runs (sets status "running"), then dispatches each to executeRun, which
  // checks suppression again before it does any work. Suppression (task
  // drain, worktree mode, a database restore) can start in the gap between
  // those two checks. When executeRun's check catches that, the run is
  // already claimed — release it back to "queued" so it does not keep a
  // running execution lock that nothing will ever process. This runs inside
  // the same promise startNextQueuedRunForAgent already tracks in
  // activeRunExecutionPromises, so getTaskDrainStatus() keeps reporting the
  // run as active until the release finishes.
  //
  // The run row, the wakeup request, and the issue execution lock all guard
  // the same claim, so one transaction commits all three writes together. A
  // partial write (for example the run flips to "queued" but the wakeup or
  // issue update then fails) would let the execution promise clear from
  // activeRunExecutionPromises while the wakeup stayed "claimed" or the
  // issue stayed locked to a queued run — task-drain status would then read
  // quiescent while the database still held part of the old claim.
  async function releaseRunClaimedJustBeforeSuppression(runId: string) {
    const now = new Date();
    await db.transaction(async (tx) => {
      const released = await tx
        .update(heartbeatRuns)
        .set({
          status: "queued",
          startedAt: null,
          responsibleUserId: null,
          updatedAt: now,
        })
        .where(
          and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!released) return;

      if (released.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "queued", claimedAt: null, updatedAt: now })
          .where(and(eq(agentWakeupRequests.id, released.wakeupRequestId), ne(agentWakeupRequests.status, "cancelled")));
      }

      const context = parseObject(released.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, issueId),
              eq(issues.companyId, released.companyId),
              eq(issues.executionRunId, released.id),
            ),
          );
      }
    });
  }

  async function cancelQueuedRunForBlockedDependencies(
    run: typeof heartbeatRuns.$inferSelect,
    issueId: string,
    unresolvedBlockerIssueIds: string[],
  ) {
    const now = new Date();
    const reason =
      "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve";
    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: now,
      error: reason,
      errorCode: "issue_dependencies_blocked",
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: "issue_dependencies_blocked",
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "dependency_gate",
        timeoutFired: false,
      },
    });
    if (!cancelled) return null;

    await setWakeupStatus(run.wakeupRequestId, "skipped", {
      finishedAt: now,
      error: reason,
    });

    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.companyId, run.companyId),
          eq(issues.id, issueId),
          eq(issues.executionRunId, run.id),
        ),
      );

    await appendRunEvent(cancelled, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason,
      payload: {
        issueId,
        unresolvedBlockerIssueIds,
      },
    });

    return cancelled;
  }

  /**
   * A parked self-reblock wake on an issue with no prior run has no release to
   * promote it, so the sweep re-admits the original wake with its own reason,
   * context and self-reblock provenance: admission applies the limit (or the
   * owner suppression) again. One transaction holds a per-wake promotion lock
   * and retires the parked receipt only after the re-admitted wake is durable
   * under a key derived from it. A crash before that commit leaves the wake
   * parked, and the next sweep finds the re-admitted receipt by that key
   * instead of admitting it twice. If nothing was admitted (still over the
   * limit, or admission failed), the receipt stays parked with its reason.
   */
  async function promoteAnchorlessParkedSelfReblockWake(
    wake: typeof agentWakeupRequests.$inferSelect,
    repark: (executor: Db, wake: typeof agentWakeupRequests.$inferSelect) => Promise<unknown>,
  ) {
    const promotionKey = `self-reblock-anchor-missing:${wake.id}`;
    await db.transaction(async (tx) => {
      const locks = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${promotionKey}, 0)) as acquired`,
      );
      if (!locks[0]?.acquired) return;
      const promotionReceipt = () => tx
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, wake.companyId), eq(agentWakeupRequests.idempotencyKey, promotionKey)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!(await promotionReceipt())) {
        const {
          [SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY]: _parkedState,
          [DEFERRED_WAKE_CONTEXT_KEY]: parkedContext,
          ...payload
        } = parseObject(wake.payload);
        const marker = readSelfReblockWakeMarker(wake.payload, wake.agentId);
        await enqueueWakeup(wake.agentId, {
          source: (wake.source ?? "automation") as unknown as WakeupOptions["source"],
          triggerDetail: (wake.triggerDetail ?? "system") as unknown as WakeupOptions["triggerDetail"],
          // A limit-parked receipt's own reason is the deferral, not the wake.
          reason: marker?.reason ?? wake.reason,
          payload: { ...payload, selfReblockPromotion: "anchor_missing" },
          contextSnapshot: parseObject(parkedContext),
          requestedByActorType: (wake.requestedByActorType ?? undefined) as WakeupOptions["requestedByActorType"],
          requestedByActorId: wake.requestedByActorId,
          idempotencyKey: promotionKey,
          ...(marker?.runId
            ? { causedBy: { kind: "self_reblock" as const, runId: marker.runId, actorId: marker.causeActorId } }
            : {}),
        }).catch((err) => {
          logger.warn({ err, queueId: wake.id }, "anchorless parked self-reblock wake was not re-admitted");
        });
      }
      if (await promotionReceipt()) {
        await tx.update(agentWakeupRequests).set({
          status: "cancelled",
          reason: "issue_self_reblock_anchor_missing_promoted",
          finishedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(agentWakeupRequests.id, wake.id),
          eq(agentWakeupRequests.companyId, wake.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ));
      } else {
        await repark(tx as unknown as Db, wake);
      }
    });
  }

  const countersForCompany = deferredWakeCountersForCompany;
  // The completion trigger runs after a run frees a slot. Promotion queues a run
  // whose start calls `startNextQueuedRunForAgent` again, so one pass per agent.
  const deferredWakeCompletionPassesInFlight = new Set<string>();

  /**
   * The holds that mean "do not wake this issue" and need more than a column to
   * prove: an active subtree pause hold, an execution blocker that awaits an
   * operator, and an operator Stop. An operator Stop never promotes old queued
   * work by itself; the next explicit wake adopts it. Read once for a whole
   * batch: one pause-hold probe per company, one latest-run read for all issues,
   * and the per-issue blocker read only for the wakes about to be promoted.
   */
  async function readDeferredWakeHolds(candidates: readonly OrphanedDeferredWakeRow[]) {
    // An execution blocker carries its cause, so a reader sees which recovery holds the wake.
    const holds = new Map<
      string,
      { reason: "pause_hold" | "execution_blocker" | "operator_stop"; cause: string | null }
    >();
    const blockers = new Map<string, ExecutionBlocker>();
    if (candidates.length === 0) return { holds, blockers };

    const companyIds = [...new Set(candidates.map((candidate) => candidate.companyId))];
    const companiesWithPauseHold = new Set(
      (await db
        .selectDistinct({ companyId: issueTreeHolds.companyId })
        .from(issueTreeHolds)
        .where(and(
          inArray(issueTreeHolds.companyId, companyIds),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
        ))).map((row) => row.companyId),
    );

    const issueKey = sql`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const latestRuns = await db
      .selectDistinctOn([issueKey])
      .from(heartbeatRuns)
      .where(and(
        inArray(heartbeatRuns.companyId, companyIds),
        sql`${issueKey} in (${sql.join(
          [...new Set(candidates.map((candidate) => candidate.issueId))].map((issueId) => sql`${issueId}`),
          sql`, `,
        )})`,
      ))
      .orderBy(issueKey, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
    const latestRunByIssueId = new Map(
      latestRuns.map((run) => [String(parseObject(run.contextSnapshot).issueId), run]),
    );

    for (const candidate of candidates) {
      if (
        companiesWithPauseHold.has(candidate.companyId) &&
        (await treeControlSvc.getActivePauseHoldGate(candidate.companyId, candidate.issueId))
      ) {
        holds.set(candidate.wakeId, { reason: "pause_hold", cause: null });
        continue;
      }
      const executionBlocker = await getExecutionBlocker(db, candidate.companyId, candidate.issueId);
      if (executionBlocker) {
        holds.set(candidate.wakeId, { reason: "execution_blocker", cause: executionBlocker.cause });
        blockers.set(candidate.wakeId, executionBlocker);
        continue;
      }
      const latest = latestRunByIssueId.get(candidate.issueId);
      if (
        latest &&
        (isAcknowledgedNativeReassignmentStop(latest) ||
          (latest.status === "cancelled" &&
            (parseObject(latest.resultJson?.executionCancellation).state === "acknowledged" ||
              isAcknowledgedNativeStop(latest))))
      ) {
        holds.set(candidate.wakeId, { reason: "operator_stop", cause: null });
      }
    }
    return { holds, blockers };
  }

  /**
   * Records, once per wake, that the sweep keeps a wake parked longer than
   * `DEFERRED_WAKE_HELD_NOTICE_MS`, whatever holds it: no free run slot, an agent
   * that cannot run, a budget stop, a pause hold, an operator Stop, an execution
   * blocker (with its cause, run and recovery action) or admission deferring it
   * again. The advisory lock makes the check and the insert atomic.
   */
  async function recordDeferredWakeHeld(
    candidate: OrphanedDeferredWakeRow,
    reason: DeferredWakeHeldReason,
    blocker: ExecutionBlocker | null,
  ) {
    const publications: ActivityPublication[] = [];
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`deferred-wake-held:${candidate.wakeId}`}, 0))`,
      );
      const [existing] = await txDb
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, candidate.companyId),
          eq(activityLog.action, DEFERRED_WAKE_HELD_ACTION),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, candidate.issueId),
          sql`${activityLog.details} ->> 'wakeId' = ${candidate.wakeId}`,
        ))
        .limit(1);
      if (existing) return;
      await logActivity(txDb, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "heartbeat",
        agentId: candidate.agentId,
        action: DEFERRED_WAKE_HELD_ACTION,
        entityType: "issue",
        entityId: candidate.issueId,
        details: {
          wakeId: candidate.wakeId,
          reason,
          parkedSince: candidate.requestedAt.toISOString(),
          ...(blocker
            ? {
                cause: blocker.cause,
                runId: blocker.runId,
                recoveryActionId: blocker.recoveryActionId,
                nextAction: blocker.nextAction,
              }
            : {}),
        },
      }, publications);
    });
    for (const publication of publications) publishActivity(publication);
  }

  /**
   * Re-drives one orphaned wake through ordinary admission. Admission takes the
   * issue-row lock, compare-and-swaps the parked receipt, applies every gate
   * (budget, pause hold, execution blocker, dependencies, a closed task, a former
   * assignee), creates the successor run and consumes the receipt in ONE
   * transaction. A concurrent release drain, adoption or cancellation that got
   * the lock first leaves nothing to deliver, so a wake starts at most one run
   * and never leaves a second parked receipt behind.
   */
  async function redeliverDeferredWake(candidate: OrphanedDeferredWakeRow) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, candidate.wakeId),
      eq(agentWakeupRequests.companyId, candidate.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    if (!wake) return "retired" as const;
    // The context rides inside the receipt's payload; hand it back as the
    // wake's context so the successor run is built as the original would be.
    const { [DEFERRED_WAKE_CONTEXT_KEY]: deferredContext, ...payload } = parseObject(wake.payload);
    const context = parseObject(deferredContext);
    await enqueueWakeup(wake.agentId, {
      source: (wake.source ?? "automation") as WakeupOptions["source"],
      triggerDetail: (wake.triggerDetail ?? "system") as WakeupOptions["triggerDetail"],
      // A parked receipt's own reason is the deferral; the wake's reason is in its context.
      reason: readNonEmptyString(context.wakeReason) ?? wake.reason,
      payload,
      contextSnapshot: context,
      requestedByActorType: (wake.requestedByActorType ?? undefined) as WakeupOptions["requestedByActorType"],
      requestedByActorId: wake.requestedByActorId,
      redeliverDeferredWake: true,
    }, wake.id);
    const [after] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, candidate.wakeId));
    if (!after || after.status === "deferred_issue_execution") return "stillDeferred" as const;
    return after.runId ? ("promoted" as const) : ("retired" as const);
  }

  /**
   * Safety net for deferred wakes nothing will promote. A wake is parked behind
   * its issue's execution lock and promoted when the holder releases; several
   * paths clear that lock without the drain (the stale-lock sweeper, the
   * claim-time stale-run cancel, a reaped holder), and the older recovery only
   * saw comment-shaped wakes of an agent that had already run the issue. This
   * finds every wake whose open issue has no lock and no live run, skips held
   * work, and re-delivers in priority then FIFO order, at most one per issue
   * and one per free agent slot, and at most `DEFERRED_WAKE_SWEEP_MAX_PER_PASS`
   * per pass so a backlog drains over several passes instead of one burst.
   * Idempotent: an optimistic claim on the wake and the issue-locked admission
   * mean concurrent passes can start at most one run per wake.
   */
  async function sweepDeferredWakes(opts: {
    agentId?: string;
    /** `0` for the run-completion trigger; the periodic sweep waits `DEFERRED_WAKE_SWEEP_MIN_AGE_MS`. */
    minAgeMs?: number;
    recheckMs?: number;
    maxPromotions?: number;
    now?: Date;
  } = {}) {
    const result = {
      scanned: 0,
      promoted: 0,
      retired: 0,
      stillDeferred: 0,
      skippedHeld: 0,
      skippedPauseHold: 0,
      skippedExecutionBlocker: 0,
      skippedOperatorStop: 0,
      skippedBudget: 0,
      skippedNotInvokable: 0,
      skippedCapacity: 0,
      executionBlockerCauses: {} as Record<string, number>,
      failed: 0,
    };
    if ((await getSchedulingSuppression()).suppressed) return result;
    const now = opts.now ?? new Date();
    if (!opts.agentId) {
      // A wake parked on a closed task will never run; finalize it instead of
      // keeping it parked.
      const retiredClosed = await wakeQueue.retireClosedIssueDeferredWakes({
        now,
        minAgeMs: DEFERRED_WAKE_SWEEP_MIN_AGE_MS,
      });
      result.retired += retiredClosed.length;
      for (const wake of retiredClosed) countersForCompany(wake.companyId).retired += 1;
    }

    const orphans = await wakeQueue.listOrphanedDeferredWakes({
      now,
      minAgeMs: opts.minAgeMs ?? DEFERRED_WAKE_SWEEP_MIN_AGE_MS,
      recheckMs: opts.recheckMs ?? DEFERRED_WAKE_SWEEP_RECHECK_MS,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      requestedAtGte: await getWorktreeExecutionCutoff(),
    });
    result.scanned = orphans.length;
    if (orphans.length === 0) return result;
    for (const orphan of orphans) {
      const counters = countersForCompany(orphan.companyId);
      counters.examined += 1;
      counters.lastExaminedAt = now;
    }

    // Agent facts for the whole batch: the agents, each company's org rows for
    // the invokability chain, and each agent's running count, in three reads.
    const agentIds = [...new Set(orphans.map((orphan) => orphan.agentId))];
    const agentRows = await db.select().from(agents).where(inArray(agents.id, agentIds));
    const agentById = new Map(agentRows.map((row) => [row.id, row]));
    const orgRowsByCompany = new Map<string, AgentOrgRow[]>();
    for (const companyId of new Set(agentRows.map((row) => row.companyId))) {
      orgRowsByCompany.set(companyId, await listCompanyAgentOrgRows(companyId));
    }
    const runningRows = await db
      .select({ agentId: heartbeatRuns.agentId, running: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.agentId, agentIds), eq(heartbeatRuns.status, "running")))
      .groupBy(heartbeatRuns.agentId);
    const runningByAgent = new Map(runningRows.map((row) => [row.agentId, Number(row.running)]));

    const freeSlotsByAgent = new Map<string, number>();
    const notInvokableAgentIds = new Set<string>();
    for (const agentId of agentIds) {
      const agent = agentById.get(agentId);
      if (!agent) continue;
      const invokable = evaluateAgentInvokability(toAgentOrgRow(agent), orgRowsByCompany.get(agent.companyId) ?? [])
        .invokable;
      if (!invokable) {
        notInvokableAgentIds.add(agentId);
        continue;
      }
      freeSlotsByAgent.set(
        agentId,
        Math.max(0, parseHeartbeatPolicy(agent).maxConcurrentRuns - (runningByAgent.get(agentId) ?? 0)),
      );
    }
    // A wake of an agent that cannot run waits for it. Move those wakes to the
    // back of the recheck window in one write, so they cannot crowd out others.
    const notInvokableWakes = orphans.filter((orphan) => notInvokableAgentIds.has(orphan.agentId));
    if (notInvokableWakes.length > 0) {
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        inArray(agentWakeupRequests.id, notInvokableWakes.map((orphan) => orphan.wakeId)),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      for (const orphan of notInvokableWakes) countersForCompany(orphan.companyId).skippedNotInvokable += 1;
      result.skippedNotInvokable = notInvokableWakes.length;
    }
    // Why each examined wake stays parked this pass; promoted wakes are removed.
    const heldReasons = new Map<string, { reason: DeferredWakeHeldReason; blocker: ExecutionBlocker | null }>(
      orphans.map((orphan) => [
        orphan.wakeId,
        {
          reason: notInvokableAgentIds.has(orphan.agentId)
            ? "agent_not_invokable"
            : (freeSlotsByAgent.get(orphan.agentId) ?? 0) === 0
              ? "no_free_run_slot"
              : "waiting_for_turn",
          blocker: null,
        },
      ]),
    );

    // Without them, an issue is served through its oldest wake that can run now.
    const invokableOrphans = orphans.filter((orphan) => !notInvokableAgentIds.has(orphan.agentId));
    const selected = selectDeferredWakesToPromote(invokableOrphans, freeSlotsByAgent, {
      maxTotal: sweepPromotionBudget(opts.maxPromotions),
    });
    // An eligible issue the pass did not select waits for a free slot or the next pass.
    const eligibleIssuesByCompany = new Map<string, Set<string>>();
    for (const orphan of invokableOrphans) {
      const issuesOfCompany = eligibleIssuesByCompany.get(orphan.companyId) ?? new Set<string>();
      issuesOfCompany.add(orphan.issueId);
      eligibleIssuesByCompany.set(orphan.companyId, issuesOfCompany);
    }
    for (const [companyId, eligibleIssues] of eligibleIssuesByCompany) {
      const left = Math.max(
        0,
        eligibleIssues.size - selected.filter((candidate) => candidate.companyId === companyId).length,
      );
      countersForCompany(companyId).skippedCapacity += left;
      result.skippedCapacity += left;
    }
    const { holds, blockers } = await readDeferredWakeHolds(selected);
    // Company, agent and project decide a budget block, so one read serves every
    // wake that shares them.
    const budgetBlockByScope = new Map<string, boolean>();

    for (const candidate of selected) {
      const counters = countersForCompany(candidate.companyId);
      try {
        const claimed = await wakeQueue.claimDeferredWakeExamination({
          companyId: candidate.companyId,
          wakeId: candidate.wakeId,
          observedUpdatedAt: candidate.observedUpdatedAt,
          now: new Date(),
        });
        if (!claimed) {
          // Another pass owns this wake now.
          heldReasons.delete(candidate.wakeId);
          continue;
        }
        const hold = holds.get(candidate.wakeId);
        if (hold) {
          // The wake stays parked and moves to the back of the recheck window.
          // Count it by what holds it, so the endpoint says why it was not woken.
          const reasonKey = {
            pause_hold: "skippedPauseHold",
            execution_blocker: "skippedExecutionBlocker",
            operator_stop: "skippedOperatorStop",
          }[hold.reason] as "skippedPauseHold" | "skippedExecutionBlocker" | "skippedOperatorStop";
          for (const tally of [result, counters]) {
            tally.skippedHeld += 1;
            tally[reasonKey] += 1;
            if (hold.cause) tally.executionBlockerCauses[hold.cause] = (tally.executionBlockerCauses[hold.cause] ?? 0) + 1;
          }
          heldReasons.set(candidate.wakeId, { reason: hold.reason, blocker: blockers.get(candidate.wakeId) ?? null });
          continue;
        }
        const budgetScope = `${candidate.companyId}:${candidate.agentId}:${candidate.projectId ?? ""}`;
        if (!budgetBlockByScope.has(budgetScope)) {
          budgetBlockByScope.set(
            budgetScope,
            Boolean(await budgets.getInvocationBlock(candidate.companyId, candidate.agentId, {
              issueId: candidate.issueId,
              projectId: candidate.projectId,
            })),
          );
        }
        if (budgetBlockByScope.get(budgetScope)) {
          // A hard stop leaves the receipt parked and untouched: no run row is
          // created and none is cancelled later. It resumes when the budget does.
          result.skippedBudget += 1;
          counters.skippedBudget += 1;
          heldReasons.set(candidate.wakeId, { reason: "budget_stop", blocker: null });
          continue;
        }
        const outcome = await redeliverDeferredWake(candidate);
        result[outcome] += 1;
        counters[outcome] += 1;
        if (outcome === "stillDeferred") {
          heldReasons.set(candidate.wakeId, { reason: "admission_deferred", blocker: null });
        } else {
          heldReasons.delete(candidate.wakeId);
        }
      } catch (err) {
        result.failed += 1;
        counters.failed += 1;
        heldReasons.delete(candidate.wakeId);
        logger.warn({ err, queueId: candidate.wakeId }, "failed to re-deliver an orphaned deferred wake");
      }
    }

    for (const orphan of orphans) {
      const held = heldReasons.get(orphan.wakeId);
      if (!held || now.getTime() - orphan.requestedAt.getTime() < DEFERRED_WAKE_HELD_NOTICE_MS) continue;
      await recordDeferredWakeHeld(orphan, held.reason, held.blocker).catch((err) => {
        logger.warn({ err, wakeId: orphan.wakeId }, "failed to record a held deferred wake");
      });
    }

    // One line per pass that read any wake, so a stall can be read from the log:
    // what was seen, what started, and what held the rest.
    const summary = { trigger: opts.agentId ? "run_completed" : "periodic", ...result };
    if (result.failed > 0) logger.warn(summary, "deferred wake sweep pass");
    else logger.info(summary, "deferred wake sweep pass");
    return result;
  }

  /**
   * Run-completion trigger: a run just freed one of this agent's slots, so
   * promote its oldest (priority-aware) orphaned deferred wake now instead of
   * waiting for the periodic sweep. Best effort; the periodic sweep is the net.
   */
  async function redeliverDeferredWakesForAgent(agentId: string) {
    if (deferredWakeCompletionPassesInFlight.has(agentId)) return;
    deferredWakeCompletionPassesInFlight.add(agentId);
    try {
      await sweepDeferredWakes({ agentId, minAgeMs: 0, recheckMs: 0 });
    } catch (err) {
      logger.warn({ err, agentId }, "failed to re-deliver deferred wakes after a run completed");
    } finally {
      deferredWakeCompletionPassesInFlight.delete(agentId);
    }
  }

  /**
   * Per-agent deferred-queue health for the API: how many wakes are parked, how
   * long the oldest has waited, and how many were promoted recently. The sweep
   * counters are this company's own, since the last server restart.
   */
  async function getDeferredWakeStats(companyId: string, now = new Date()) {
    const perAgent = await wakeQueue.getDeferredWakeAgentStats({ companyId, now });
    const parked = await wakeQueue.getDeferredWakeParkedBreakdown({ companyId });
    const agentStats = perAgent.map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName,
      deferredCount: row.deferredCount,
      oldestDeferredAt: row.oldestDeferredAt,
      oldestDeferredAgeSeconds: row.oldestDeferredAt
        ? Math.max(0, Math.round((now.getTime() - row.oldestDeferredAt.getTime()) / 1000))
        : null,
      promotedLast24h: row.promotedLast24h,
    }));
    const oldest = agentStats
      .map((row) => row.oldestDeferredAt)
      .filter((at): at is Date => at !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    return {
      generatedAt: now,
      deferredTotal: agentStats.reduce((sum, row) => sum + row.deferredCount, 0),
      promotedLast24h: agentStats.reduce((sum, row) => sum + row.promotedLast24h, 0),
      oldestDeferredAt: oldest,
      oldestDeferredAgeSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null,
      agents: agentStats,
      parked,
      sweep: {
        ...countersForCompany(companyId),
        executionBlockerCauses: { ...countersForCompany(companyId).executionBlockerCauses },
      },
    };
  }

  async function resumeQueuedRuns() {
    if ((await getSchedulingSuppression()).suppressed) return;
    await resumeExecutionWaitComments();
    const cutoff = await getWorktreeExecutionCutoff();
    const pendingInterrupts = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId })
      .from(agentWakeupRequests).innerJoin(companies, eq(companies.id, agentWakeupRequests.companyId))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(companies.status, "active"),
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    for (const wake of pendingInterrupts) {
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      await resumeQueuedCommentInterrupt(wake.companyId, wake.id).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to resume interrupted comment queue");
      });
    }
    // A server restart or a message/cleanup race can leave a deferred wake
    // after its owner has released the issue lock. Revisit it through the same
    // release admission, so recovery holds and operator Stops still apply.
    const strandedQueues = await db.select({ wake: agentWakeupRequests })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
        issueIdEqualsText(sql`${agentWakeupRequests.payload}->>'issueId'`),
        or(eq(issues.assigneeAgentId, agentWakeupRequests.agentId),
          sql`${agentWakeupRequests.payload} #>> '{_paperclipWakeContext,wakeReason}' = 'issue_comment_mentioned'`)))
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        isNull(issues.executionRunId),
        or(and(
          sql`jsonb_typeof(${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}') = 'array'`,
          sql`${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
        ), sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`),
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
        // A limit-parked self-reblock wake waits for its own window; the parked
        // re-drive below admits it once that window has passed.
        sql`${agentWakeupRequests.payload} -> ${SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY}::text is null`,
        sql`NOT EXISTS (SELECT 1 FROM heartbeat_runs live_issue_run
          WHERE live_issue_run.company_id = ${issues.companyId}
            AND (live_issue_run.context_snapshot->>'issueId' = ${issues.id}::text
              OR live_issue_run.native_issue_id = ${issues.id})
            AND live_issue_run.status IN ('queued', 'running', 'scheduled_retry'))`,
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    for (const { wake } of strandedQueues) {
      if (!queuedCommentIdsFromWakePayload(wake.payload).length &&
          !await readQueuedInteractionResponse(db, wake.companyId, String(wake.payload?.issueId), wake.payload)) continue;
      const [latest] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, wake.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${String(wake.payload?.issueId)}`,
        or(isNull(heartbeatRuns.nativeIssueId), sql`${heartbeatRuns.nativeIssueId}::text = ${String(wake.payload?.issueId)}`),
      )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      if (!latest || !latest.finishedAt || !isHeartbeatRunTerminalStatus(latest.status)) continue;
      if (latest.runtimeMode !== "legacy" && latest.runtimeMode !== "native") continue;
      if (latest.runtimeMode === "legacy") {
        const cancelledAdmission = latest.status === "cancelled" && !latest.startedAt &&
          latest.errorCode === "execution_reconciliation_required";
        if ((latest.status !== "cancelled" || cancelledAdmission) && await getExecutionBlocker(db, wake.companyId, String(wake.payload?.issueId))) {
          await resumeSavedLegacyComments(wake.companyId, wake.id).catch(err => {
            logger.warn({ err, queueId: wake.id }, "failed to deliver saved legacy comment after recovery stopped");
          });
        }
      }
      await releaseIssueExecutionAndPromote(latest, { suppressImmediateRecovery: true, resumeStrandedQueue: true }).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to promote stranded comments");
      });
    }

    // A self-reblock wake held back by its limit stays a durable deferred
    // receipt. Once its window has passed and no run holds the issue, re-drive
    // the issue's queue through the same release admission that promotes it.
    // The anchor run confers no ownership, so the limit decides alone. The
    // module picks an anchor whose release cannot replay failure handling.
    const dueParkedWakes = await db
      .select({ wake: agentWakeupRequests })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
        issueIdEqualsText(sql`${agentWakeupRequests.payload}->>'issueId'`)))
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        isNull(issues.executionRunId),
        sql`(${agentWakeupRequests.payload} -> ${SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY} ->> 'notBefore')::timestamptz <= now()`,
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    // Re-check a wake that stays parked (a successor, an execution hold, or the
    // limit again) at most once per window instead of on every tick.
    const reparkDueSelfReblockWake = (executor: Db, wake: typeof agentWakeupRequests.$inferSelect) =>
      executor.update(agentWakeupRequests).set({
        payload: sql`jsonb_set(${agentWakeupRequests.payload}, array[${SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY}]::text[],
          ${JSON.stringify(buildSelfReblockWakeParkedState(new Date(Date.now() + SELF_REBLOCK_WAKE_WINDOW_MS)))}::jsonb)`,
        updatedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.id, wake.id),
        eq(agentWakeupRequests.companyId, wake.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`(${agentWakeupRequests.payload} -> ${SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY} ->> 'notBefore')::timestamptz <= now()`,
      )).returning({ id: agentWakeupRequests.id });
    const reDrivenParkedIssues = new Set<string>();
    for (const { wake } of dueParkedWakes) {
      const issueId = String(wake.payload?.issueId);
      if (reDrivenParkedIssues.has(issueId)) continue;
      reDrivenParkedIssues.add(issueId);
      const anchor = await wakeQueue.findParkedWakeAnchorRun({ companyId: wake.companyId, issueId });
      if (anchor) {
        await releaseIssueExecutionAndPromote(anchor, { suppressImmediateRecovery: true, anchorRunOnly: true }).catch((err) => {
          logger.warn({ err, queueId: wake.id }, "failed to re-drive a parked self-reblock wake");
        });
        await reparkDueSelfReblockWake(db, wake);
      } else {
        await promoteAnchorlessParkedSelfReblockWake(wake, reparkDueSelfReblockWake).catch((err) => {
          logger.warn({ err, queueId: wake.id }, "failed to promote anchorless parked self-reblock wake");
        });
      }
    }

    // The cancellation marker is durable intent. Retry while its exact queue
    // is still deferred, including after a failed cleanup promotion or restart.
    // Normal admission still checks process ownership, leases, pauses, and scope.
    const interruptedQueues = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, and(
        sql`${heartbeatRuns.resultJson}->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text`,
        eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
        eq(heartbeatRuns.agentId, agentWakeupRequests.agentId),
      ))
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(and(
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(heartbeatRuns.status, "cancelled"),
        eq(heartbeatRuns.runtimeMode, "legacy"),
        eq(companies.status, "active"),
        cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
      ));
    for (const run of interruptedQueues) {
      await releaseIssueExecutionAndPromote(run, { suppressImmediateRecovery: true }).catch((err) => {
        logger.error({ err, runId: run.id }, "failed to retry interrupted comment queue");
      });
    }

    // Every deferred wake above waits for a specific trigger. Any other wake
    // whose issue lock is already free has no run left to promote it, so
    // re-deliver it here instead of leaving it parked indefinitely.
    await sweepDeferredWakes().catch((err) => {
      logger.error({ err }, "failed to sweep orphaned deferred wakes");
    });

    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          eq(companies.status, "active"),
          cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
        ),
      );

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      // One agent's claim error must not stop the agents after it.
      try {
        await startNextQueuedRunForAgent(agentId);
      } catch (err) {
        logger.error({ err, agentId }, "failed to resume queued runs for an agent");
      }
    }
  }

  // A 403 from claimQueuedRun comes from the run's own persisted identity
  // (an unverifiable interrupt receipt, a manual wake with no user). Those rows
  // do not change, so the claim fails the same way on every pass and restart.
  function isPermanentClaimRejection(err: unknown): err is HttpError {
    return err instanceof HttpError && err.status === 403;
  }

  // Other 4xx rejections can clear later (a responsible user gets assigned, a
  // conflicting claim finishes). Keep the run queued, but do not let it stop
  // the rest of the queue or startup recovery.
  function isDeferrableClaimRejection(err: unknown): err is HttpError {
    return err instanceof HttpError && err.status >= 400 && err.status < 500;
  }

  // Settle runs that can never be claimed. Letting the error escape stalls the
  // agent's queue and, during startup recovery, stops the server from booting.
  async function cancelRejectedQueuedRuns(
    rejected: Array<{ run: typeof heartbeatRuns.$inferSelect; err: HttpError }>,
  ) {
    for (const { run, err } of rejected) {
      logger.warn(
        { err, runId: run.id, agentId: run.agentId, companyId: run.companyId },
        "cancelling queued heartbeat run whose claim was rejected",
      );
      try {
        await cancelRunInternal(
          run.id,
          `Cancelled because the queued run cannot be claimed: ${err.message}`,
          { errorCode: "queued_run_claim_rejected" },
        );
      } catch (cancelErr) {
        logger.error(
          { err: cancelErr, runId: run.id },
          "failed to cancel queued heartbeat run whose claim was rejected; it stays queued for the next recovery pass",
        );
      }
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    if ((await getSchedulingSuppression()).suppressed) return [];
    const cutoff = await getWorktreeExecutionCutoff();
    // Cancelled after the start lock is released: cancelRunInternal promotes the
    // agent's next queued run, which takes this same lock.
    const rejectedClaims: Array<{ run: typeof heartbeatRuns.$inferSelect; err: HttpError }> = [];
    const deferredPostCommitEffects: WakeQueuePostCommitEffect[] = [];
    let cancellationReason: string | undefined;

    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      const invokability = await getAgentInvokability(agent);
      if (!invokability.invokable) {
        if (shouldCancelRunsForNonInvokableAgent(invokability)) {
          cancellationReason = `Cancelled because the agent is not invokable: ${invokability.reason}`;
        }
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(
        0,
        policy.maxConcurrentRuns - runningCount,
      );
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
            cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt));
      if (queuedRuns.length === 0) return [];
      if (queuedRuns.every(run => !run.startedAt) && !await canStartNewExternalBotWork(agent)) return [];

      const dependencyReadiness = await listQueuedRunDependencyReadiness(
        agent.companyId,
        queuedRuns,
      );
      const queuedIssueIds = [
        ...new Set(
          queuedRuns
            .map((run) =>
              readNonEmptyString(parseObject(run.contextSnapshot).issueId),
            )
            .filter((issueId): issueId is string => Boolean(issueId)),
        ),
      ];
      const issueRows = await db
        .select({
          id: issues.id,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          queuedIssueIds.length > 0
            ? and(
                eq(issues.companyId, agent.companyId),
                inArray(issues.id, queuedIssueIds),
              )
            : sql`false`,
        );
      const issueById = new Map(issueRows.map((row) => [row.id, row]));
      const companyAgents = await listCompanyAgentOrgRows(agent.companyId);
      const prioritizedRuns = [...queuedRuns].sort((left, right) => {
        const leftIssueId = readNonEmptyString(
          parseObject(left.contextSnapshot).issueId,
        );
        const rightIssueId = readNonEmptyString(
          parseObject(right.contextSnapshot).issueId,
        );
        const leftReadiness = leftIssueId
          ? dependencyReadiness.get(leftIssueId)
          : null;
        const rightReadiness = rightIssueId
          ? dependencyReadiness.get(rightIssueId)
          : null;
        const leftReady = leftIssueId
          ? (leftReadiness?.isDependencyReady ?? true)
          : true;
        const rightReady = rightIssueId
          ? (rightReadiness?.isDependencyReady ?? true)
          : true;
        const leftIssue = leftIssueId ? issueById.get(leftIssueId) : null;
        const rightIssue = rightIssueId ? issueById.get(rightIssueId) : null;
        const leftRank = leftIssueId
          ? leftReady
            ? leftIssue?.status === "in_progress"
              ? 0
              : 1
            : 3
          : 2;
        const rightRank = rightIssueId
          ? rightReady
            ? rightIssue?.status === "in_progress"
              ? 0
              : 1
            : 3
          : 2;
        if (leftRank !== rightRank) return leftRank - rightRank;
        const leftPriorityRank = issueRunPriorityRank(leftIssue?.priority);
        const rightPriorityRank = issueRunPriorityRank(rightIssue?.priority);
        if (leftPriorityRank !== rightPriorityRank)
          return leftPriorityRank - rightPriorityRank;
        return left.createdAt.getTime() - right.createdAt.getTime();
      });

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of prioritizedRuns) {
        if (claimedRuns.length >= availableSlots) break;
        let claimed: typeof heartbeatRuns.$inferSelect | null;
        try {
          claimed = await claimQueuedRun(queuedRun, companyAgents, deferredPostCommitEffects);
        } catch (err) {
          if (isPermanentClaimRejection(err)) {
            rejectedClaims.push({ run: queuedRun, err });
            continue;
          }
          if (!isDeferrableClaimRejection(err)) throw err;
          logger.warn(
            { err, runId: queuedRun.id, agentId: queuedRun.agentId, companyId: queuedRun.companyId },
            "queued heartbeat run claim was rejected; leaving it queued for the next recovery pass",
          );
          continue;
        }
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        const execution = executeRun(claimedRun.id).catch((err) => {
          logger.error(
            { err, runId: claimedRun.id },
            "queued heartbeat execution failed",
          );
        });
        // Register the in-flight execution so drainActiveRunExecutions() can await
        // it. executeRun resolves only after its finally block finishes flushing
        // run rows/events, so awaiting this promise guarantees the run's writes
        // have landed before a caller (e.g. a test's afterEach) mutates the DB.
        activeRunExecutionPromises.add(execution);
        void execution.finally(() => {
          // drainActiveRunExecutions loops on activeRunExecutionPromises.size,
          // so an entry that never clears here would hang it forever.
          activeRunExecutionPromises.delete(execution);
        });
      }
      return claimedRuns;
    }).finally(async () => {
      // Dispatch promoted inputs after the agent start lock is released.
      try {
        await applyWakeQueuePostCommitEffects(deferredPostCommitEffects);
      } finally {
        if (cancellationReason) await cancelActiveForAgentInternal(agentId, cancellationReason);
        await cancelRejectedQueuedRuns(rejectedClaims);
      }
    });
  }

  // Public wakeup entry point. Callers dispatch it fire-and-forget, so register
  // the promise in activeWakeupPromises before it starts its asynchronous
  // prologue. drainActiveRunExecutions can then await a wake that is still before
  // run registration. Internal callers reference enqueueWakeup directly and
  // already await it, so they do not need this registration.
  function trackWakeup(
    agentId: string,
    opts: WakeupOptions = {},
  ): ReturnType<typeof enqueueWakeup> {
    const promise = enqueueWakeup(agentId, opts);
    activeWakeupPromises.add(promise);
    void promise
      .catch(() => {})
      .finally(() => {
        activeWakeupPromises.delete(promise);
      });
    return promise;
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}, executionWaitRequestId?: string) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = {
      ...(opts.contextSnapshot ?? {}),
    };
    const reason = opts.reason ?? null;
    let payload = opts.payload ? { ...opts.payload } : null;
    // Only the board queue route can record interruption authority on an
    // existing receipt. Never accept this internal marker from a wake caller.
    if (payload) {
      delete payload.queuedCommentInterrupt;
      delete payload.manualUserWake;
      // Loop-guard provenance is derived below from server facts only.
      delete payload[SELF_REBLOCK_WAKE_PAYLOAD_KEY];
      delete payload[SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY];
      delete payload[AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY];
    }
    if (opts.manualUserWake) {
      if (opts.requestedByActorType !== "user" || !opts.requestedByActorId || opts.failedRunId) {
        throw new HttpError(403, "Manual wake requires an authenticated user");
      }
      payload = { ...payload, manualUserWake: true };
    }
    const executionReconciliationWake =
      contextSnapshot.source === "execution.reconciled" ||
      opts.idempotencyKey?.startsWith("execution-reconciliation:") === true;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    // Keep each request's own server-derived origin, including coalesced wakes.
    // A run's merged context cannot establish which caller authored one receipt.
    // Overwrite caller-supplied nested context rather than trusting it.
    payload = { ...payload, [DEFERRED_WAKE_CONTEXT_KEY]: { ...enrichedContextSnapshot } };
    // Record who caused an unblock/re-block wake, so deferral and promotion
    // keep the original reason and self-vs-other provenance with the receipt.
    const selfReblockWake = deriveSelfReblockWakeMarker({
      agentId,
      reason: reason ?? readNonEmptyString(enrichedContextSnapshot.wakeReason),
      mutation: payload.mutation,
      causedBy: opts.causedBy,
    });
    if (selfReblockWake) payload = { ...payload, [SELF_REBLOCK_WAKE_PAYLOAD_KEY]: selfReblockWake };
    let issueId =
      readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;
    if (executionReconciliationWake && !issueId) return null;

    let agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    // Mentions only annotate comments. Ignore legacy callers before creating
    // a run or deferred request; assignment and review have their own wakes.
    if (reason === "issue_comment_mentioned" || enrichedContextSnapshot.wakeReason === "issue_comment_mentioned") return null;
    if (issueId) {
      const conversation = await getIssueExecutionContext(agent.companyId, issueId);
      if (reason === "issue_children_completed" && conversation?.originKind === "onboarding_first_task") enrichedContextSnapshot.onboardingCompletion = true;
      if (isConversation(conversation)) {
        if (opts.manualUserWake && conversation!.conversationUserId !== opts.requestedByActorId) {
          throw new HttpError(403, "Only the conversation owner can start a chat run");
        }
        if (isConversationExecutionWake(conversation, reason ?? readNonEmptyString(enrichedContextSnapshot.wakeReason))) return null;
        if (agent.id !== conversation!.conversationAgentId) return null;
        if (!(await instanceSettings.getExperimental()).enableAgentChat) return null;
        if (!wakeCommentId && isWaitingConversation(conversation) && !hasInteractionContinuationWakeContext(enrichedContextSnapshot) && reason !== CHAT_COMPLETION_WAKE_REASON) return null;
      }
    }
    if (agent.adapterType === "paperclip_runner") {
      const oldConfig = parseObject(agent.adapterConfig);
      const nextConfig = normalizeLegacyRunnerProvider(oldConfig);
      if (nextConfig !== oldConfig) {
        await agentService(db).update(
          agent.id,
          { adapterConfig: nextConfig },
          {
            recordRevision: {
              source: "normalize_runner_provider",
              createdByAgentId: null,
              createdByUserId: null,
            },
          },
        );
        await logActivity(db, {
          companyId: agent.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "agent.updated",
          entityType: "agent",
          entityId: agent.id,
          details: { provider: "codex", reason: "native_codex_provider" },
        });
        agent = (await getAgent(agentId))!;
      }
    }

    if (opts.failedRunId) {
      const failed = await getRun(opts.failedRunId, { includeExecutionEvidence: true });
      if (opts.requestedByActorType !== "user" || !opts.requestedByActorId ||
          reason !== "retry_failed_run" || source !== "on_demand" || triggerDetail !== "manual" ||
          !failed || failed.companyId !== agent.companyId || failed.agentId !== agentId ||
          !(await canRetryStoppedRun(db, failed)) ||
          (failed.nativeIssueId ?? readNonEmptyString(failed.contextSnapshot?.issueId)) !== issueId) {
        throw conflict("The selected failed run cannot be retried for this task.");
      }
      if (!activeRunExecutions.has(failed.id) && !adapterExecutionControls.has(failed.id)) {
        await sweepPendingCleanupLeases({ explicitRetry: {
          companyId: failed.companyId, runId: failed.id, actorId: opts.requestedByActorId,
        } });
      }
      if (isConversationAdapter(agent.adapterType) || agent.adapterType === "paperclip_runner") {
        enrichedContextSnapshot.previousRunId = failed.id;
        enrichedContextSnapshot.forceFreshSession = true;
      }
    }

    const durableRequest = opts.durableChatRequest;
    if (durableRequest) {
      assertDurableChatWakeupRequest(durableRequest, {
        agentId,
        companyId: agent.companyId,
        issueId,
        commentId: wakeCommentId ?? null,
        requestedByActorType: opts.requestedByActorType,
        requestedByActorId: opts.requestedByActorId,
      });
      opts = { ...opts, idempotencyKey: durableRequest.idempotencyKey };
    }
    if (
      Object.hasOwn(enrichedContextSnapshot, "chatFailedRunRetry") &&
      !durableRequest?.failedRunRetry
    ) {
      throw new FailedChatRunRetryAuthorizationError();
    }
    if (durableRequest?.failedRunRetry) {
      opts = { ...opts, allowRunCoalescing: false };
    }
    const dotRequest = opts.durableDotRequest;
    const museRequest = opts.durableMuseRequest;
    if (dotRequest && (durableRequest || museRequest || dotRequest.agentId !== agentId ||
        dotRequest.companyId !== agent.companyId || dotRequest.issueId !== issueId ||
        dotRequest.requestId !== payload?.dotRequestId || source !== "assignment" ||
        opts.requestedByActorType !== "agent" || opts.requestedByActorId !== agentId ||
        agent.adapterType !== "paperclip_runner" || !["openai_dot", "grok_bot"].includes(String(parseObject(agent.adapterConfig).provider)) ||
        opts.idempotencyKey !== dotRequest.idempotencyKey)) {
      throw conflict("Dot work request does not match its admission authority.");
    }
    if (museRequest && (durableRequest || dotRequest || museRequest.agentId !== agentId ||
        museRequest.companyId !== agent.companyId || museRequest.issueId !== issueId ||
        museRequest.requestId !== payload?.museRequestId || source !== "assignment" ||
        opts.requestedByActorType !== "agent" || opts.requestedByActorId !== agentId ||
        agent.adapterType !== "paperclip_runner" || parseObject(agent.adapterConfig).provider !== "muse" ||
        parseObject(agent.adapterConfig).museBindingId !== museRequest.bindingId ||
        !Number.isSafeInteger(museRequest.bindingGeneration) || museRequest.bindingGeneration < 1 ||
        payload?.museBindingId !== museRequest.bindingId || payload?.museBindingGeneration !== museRequest.bindingGeneration ||
        payload?.museRequestDigest !== museRequest.requestDigest || !/^sha256:[a-f0-9]{64}$/.test(museRequest.requestDigest) ||
        opts.idempotencyKey !== museRequest.idempotencyKey)) {
      throw conflict("Muse work request does not match its admission authority.");
    }
    const receiptRequest = durableRequest ?? dotRequest ?? museRequest;
    const durableReceiptFields = receiptRequest
      ? { id: receiptRequest.id, requestedAt: receiptRequest.requestedAt }
      : {};
    const existingDurableReceipt = async (queryDb: Db) => {
      if (!receiptRequest) return null;
      const receipt = await queryDb
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receiptRequest.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (receipt && durableRequest) assertDurableChatWakeupReceipt(durableRequest, receipt);
      if (receipt && dotRequest && (receipt.companyId !== dotRequest.companyId ||
          receipt.agentId !== dotRequest.agentId || receipt.source !== "assignment" ||
          receipt.requestedByActorType !== "agent" || receipt.requestedByActorId !== dotRequest.agentId ||
          receipt.idempotencyKey !== dotRequest.idempotencyKey || receipt.payload?.issueId !== dotRequest.issueId ||
          receipt.payload?.dotRequestId !== dotRequest.requestId)) {
        throw conflict("requestId was reused for another task.");
      }
      if (receipt && museRequest && (receipt.companyId !== museRequest.companyId ||
          receipt.agentId !== museRequest.agentId || receipt.source !== "assignment" ||
          receipt.requestedByActorType !== "agent" || receipt.requestedByActorId !== museRequest.agentId ||
          receipt.idempotencyKey !== museRequest.idempotencyKey || receipt.payload?.issueId !== museRequest.issueId ||
          receipt.payload?.museRequestId !== museRequest.requestId || receipt.payload?.museBindingId !== museRequest.bindingId ||
          receipt.payload?.museBindingGeneration !== museRequest.bindingGeneration || receipt.payload?.museRequestDigest !== museRequest.requestDigest)) {
        throw conflict("Request ID reused with changed input.");
      }
      return receipt;
    };
    // An assignment wake's key names one assignee and one assignment generation.
    // Replaying it (a retry after a lost acknowledgement, or recovery racing the
    // route) returns the committed receipt instead of admitting a duplicate. A
    // partial unique index backs this check for writers outside the issue lock.
    const assignmentIdempotencyKey =
      !durableRequest &&
      opts.idempotencyKey?.startsWith(ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX)
        ? opts.idempotencyKey
        : null;
    const assignmentKeyParts = assignmentIdempotencyKey
      ? parseIssueAssignmentIdempotencyKey(assignmentIdempotencyKey)
      : null;
    const existingAssignmentReceipt = async (queryDb: Db) => {
      if (!assignmentIdempotencyKey) return null;
      return queryDb
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, agent.companyId),
            eq(agentWakeupRequests.idempotencyKey, assignmentIdempotencyKey),
            // The unique index's own predicate, so this is one index probe.
            ISSUE_ASSIGNMENT_LIVE_RECEIPT_PREDICATE,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    };
    // The newest assignment generation recorded for the issue. The issue
    // filter uses the company/payload-issue index, so the lookup under the
    // issue lock reads only this issue's receipts. A refusal is not an
    // assignment and never supersedes one.
    const newestRecordedAssignmentGeneration = async (queryDb: Db, issueIdForKey: string) =>
      queryDb
        .select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, agent.companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueIdForKey}`,
          like(agentWakeupRequests.idempotencyKey, `${ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX}${issueIdForKey}:%`),
          sql`${agentWakeupRequests.reason} is distinct from ${ISSUE_ASSIGNMENT_WAKE_REFUSED_REASON}`,
        ))
        .then((rows) => rows.reduce<number | null>((newest, row) => {
          const generation = row.idempotencyKey
            ? parseIssueAssignmentIdempotencyKey(row.idempotencyKey)?.assignmentGeneration
            : undefined;
          return generation !== undefined && (newest === null || generation > newest) ? generation : newest;
        }, null));
    const assignmentRefusalReceipt = (
      refusal: IssueAssignmentWakeRefusal,
      details: Record<string, unknown>,
    ) => {
      // Every refusal is durable and logged: the assignee would otherwise wait
      // on a wake that never runs, with nothing to show why.
      logger[ISSUE_ASSIGNMENT_WAKE_REFUSAL_LOG_LEVEL[refusal]](
        { agentId, companyId: agent.companyId, issueId, idempotencyKey: assignmentIdempotencyKey, refusal, ...details },
        "assignment wake refused",
      );
      return {
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: ISSUE_ASSIGNMENT_WAKE_REFUSED_REASON,
        payload: {
          ...(payload ?? {}),
          heartbeatSkip: { reason: ISSUE_ASSIGNMENT_WAKE_REFUSED_REASON, refusal, requestedReason: reason, ...details },
        },
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: assignmentIdempotencyKey,
        finishedAt: new Date(),
      } satisfies typeof agentWakeupRequests.$inferInsert;
    };
    if (assignmentIdempotencyKey && (!assignmentKeyParts || !issueId)) {
      // A malformed reserved key, or one on a wake without an issue, can never
      // be checked against the issue lock. Admission below checks the rest.
      await db.insert(agentWakeupRequests).values(
        assignmentRefusalReceipt(assignmentKeyParts ? "assignee_mismatch" : "malformed_key", { wakeIssueId: issueId ?? null }),
      );
      return null;
    }
    const priorReceipt = await existingDurableReceipt(db);
    if (priorReceipt) {
      // Replaying an admission receipt is not fresh authority to dispatch it.
      // The normal queue owns dispatch and its current execution-policy checks.
      return priorReceipt.runId ? getRun(priorReceipt.runId) : null;
    }

    const agentDebug = parseObject(parseObject(agent.runtimeConfig).debug);
    const runDebug = parseObject(enrichedContextSnapshot.debug);
    if (
      agentDebug.providerTrace === "raw" &&
      runDebug.providerTrace !== "raw"
    ) {
      enrichedContextSnapshot.debug = {
        ...runDebug,
        providerTrace: "raw",
      };
      enrichedContextSnapshot.providerTraceRequestedBy = `agent:${agent.id}:debug-setting`;
      enrichedContextSnapshot.providerTraceRequestSource =
        "agent_debug_setting";
    }

    // Automatic signals are replaceable; user input and interaction delivery
    // retain distinct durable receipts even when the same gate blocks them.
    const coalesceExecutionWait =
      opts.requestedByActorType === "system" &&
      !receiptRequest &&
      !wakeCommentId &&
      queuedCommentIdsFromRunContext(enrichedContextSnapshot).length === 0 &&
      !isInteractionResolutionWakePayload(payload ?? {}) &&
      !hasInteractionContinuationWakeContext(enrichedContextSnapshot);
    const writeSkippedRequest = async (
      skipReason: string,
      patch: Partial<typeof agentWakeupRequests.$inferInsert> = {},
      waitCondition?: Record<string, unknown>,
    ) => {
      if (executionWaitRequestId) {
        await db.update(agentWakeupRequests).set({
          payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
            coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify({
              reason: skipReason, message: patch.error ?? (skipReason === "issue_tree_hold_active"
                ? "This task is paused. Resume it to send your saved message."
                : "Waiting for task execution to be enabled. Your message is saved."),
            })}::jsonb)`,
          updatedAt: new Date(),
        }).where(and(eq(agentWakeupRequests.id, executionWaitRequestId),
          eq(agentWakeupRequests.companyId, agent.companyId), eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution")));
        return { created: false };
      }
      const request = {
        ...durableReceiptFields,
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
        ...patch,
      };
      if (waitCondition && issueId && isUuidLike(issueId)) {
        const waitIssueId = issueId;
        return db.transaction(async (tx) => {
          await tx.execute(sql`select id from issues where id = ${waitIssueId} and company_id = ${agent.companyId} for update`);
          return recordExecutionWait(tx as unknown as Db, {
            issueId: waitIssueId, request, condition: waitCondition, coalesce: coalesceExecutionWait,
          });
        });
      }
      await db.insert(agentWakeupRequests).values(request);
      return { created: true };
    };
    const writeSkippedHeartbeatRequest = async (
      skipReason: string,
      details: Record<string, unknown>,
    ) => {
      await writeSkippedRequest(skipReason, {
        payload: {
          ...(payload ?? {}),
          heartbeatSkip: details,
        },
      });
    };

    const schedulingSuppression = await getSchedulingSuppression();
    // A task drain holds ADMISSION, not the request. The drain is a
    // process-local pre-restart hold, so a wake that arrives while it is
    // active still names real work that must run once the process comes
    // back: leave it in the durable queue and let the dispatch-side checks
    // (startNextQueuedRunForAgent / executeRun) keep it from starting until
    // the drain lifts or the restart clears it. Writing it as `skipped`
    // here dropped the wake permanently — an accepted plan whose
    // continuation wake landed mid-drain left its issue in `todo` with no
    // run and no path until a person noticed.
    if (
      schedulingSuppression.suppressed &&
      schedulingSuppression.reason !== "task_drain"
    ) {
      await writeSkippedHeartbeatRequest("heartbeat.scheduling_suppressed", {
        reason: schedulingSuppression.reason,
      });
      return null;
    }

    const worktreeExecutionCutoff =
      opts.requestedByActorType === "user"
        ? null
        : await getWorktreeExecutionCutoff();

    const company = await db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, agent.companyId))
      .then((rows) => rows[0] ?? null);

    if (!company || company.status !== "active") {
      const companyStatus = company?.status ?? "missing";
      if (opts.requestedByActorType === "user") {
        throw conflict("Company is not active", { status: companyStatus });
      }
      await writeSkippedRequest("company.inactive", {
        error: `Wake suppressed because company status is ${companyStatus}`,
      }, { companyStatus });
      return null;
    }

    const explicitResumeSession = await resolveExplicitResumeSessionOverride(
      agent,
      payload,
      taskKey,
    );
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId =
        explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId =
        explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams =
        explicitResumeSession.sessionParams;
      if (
        !readNonEmptyString(enrichedContextSnapshot.issueId) &&
        explicitResumeSession.issueId
      ) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (
        !readNonEmptyString(enrichedContextSnapshot.taskId) &&
        explicitResumeSession.taskId
      ) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (
        !readNonEmptyString(enrichedContextSnapshot.taskKey) &&
        explicitResumeSession.taskKey
      ) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    const effectiveTaskKey =
      readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      (await resolveSessionBeforeForWakeup(agent, effectiveTaskKey));
    let hasResolvablePriorSessionWorkspace: boolean | null = null;
    const resolveHasResolvablePriorSessionWorkspace = async () => {
      if (hasResolvablePriorSessionWorkspace !== null)
        return hasResolvablePriorSessionWorkspace;
      hasResolvablePriorSessionWorkspace = issueId
        ? await hasResolvablePriorSessionWorkspaceForWake({
            agent,
            contextSnapshot: enrichedContextSnapshot,
            taskKey: effectiveTaskKey,
            explicitResumeSession,
          })
        : false;
      return hasResolvablePriorSessionWorkspace;
    };
    const continuationAttempt = readContinuationAttempt(
      enrichedContextSnapshot.livenessContinuationAttempt,
    );

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      // Look up by either UUID or identifier (e.g. "ENV-13"), but always scope
      // by companyId so a row from another tenant can never be returned even
      // when identifiers collide across companies. Guard the UUID arm because
      // issues.id is a Postgres uuid column — passing "ENV-13" into eq(issues.id, …)
      // would fail with an invalid-input-syntax cast error before the OR is
      // evaluated.
      const lookupIsUuid = isUuidLike(issueId);
      const idMatch = lookupIsUuid
        ? or(
            eq(issues.id, issueId),
            eq(issues.identifier, issueId.toUpperCase()),
          )
        : eq(issues.identifier, issueId.toUpperCase());
      const resolvedIssue = await db
        .select({
          id: issues.id,
          projectId: issues.projectId,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, agent.companyId), idMatch))
        .then((rows) => rows[0] ?? null);
      if (resolvedIssue) {
        if (
          worktreeExecutionCutoff &&
          resolvedIssue.createdAt < worktreeExecutionCutoff
        ) {
          await writeSkippedHeartbeatRequest(
            "heartbeat.worktree_execution_cutoff",
            {
              reason: "worktree_execution_cutoff",
              cutoff: worktreeExecutionCutoff.toISOString(),
              issueId: resolvedIssue.id,
            },
          );
          return null;
        }
        projectId = resolvedIssue.projectId ?? null;
        // Canonicalize context to the UUID so downstream lookups always use UUID
        if (resolvedIssue.id !== issueId) {
          issueId = resolvedIssue.id;
          enrichedContextSnapshot.issueId = issueId;
          if (readNonEmptyString(enrichedContextSnapshot.taskId)) {
            enrichedContextSnapshot.taskId = issueId;
          }
        }
      }
    }
    // Propagate projectId into context so resolveWorkspaceForRun can bind the
    // project workspace even when context.projectId wasn't set by the caller.
    if (projectId && !readNonEmptyString(enrichedContextSnapshot.projectId)) {
      enrichedContextSnapshot.projectId = projectId;
    }
    const isolatedWorkspacesEnabled = issueId
      ? (await instanceSettings.getExperimental()).enableIsolatedWorkspaces
      : false;
    let operatorResponsibleUserId: string | null = opts.manualUserWake ? opts.requestedByActorId! : null;
    let queuedResponsibleUserIdPromise: Promise<string> | null = null;
    const resolveQueuedResponsibleUserId = () => {
      if (operatorResponsibleUserId) return Promise.resolve(operatorResponsibleUserId);
      queuedResponsibleUserIdPromise ??= (async () => {
        const queuedIssueContext = issueId
          ? await getIssueExecutionContext(agent.companyId, issueId)
          : null;
        const queuedRoutineEnvContext = await getRoutineEnvForExecutionIssue(
          agent.companyId,
          queuedIssueContext,
        );
        const queuedResponsibleUserId =
          await resolveResponsibleUserIdForRunSeed({
            companyId: agent.companyId,
            contextSnapshot: enrichedContextSnapshot,
            issueContext: queuedIssueContext,
            routineEnvContext: queuedRoutineEnvContext,
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            source,
            triggerDetail,
          });
        if (!queuedResponsibleUserId) {
          throw new HttpError(
            422,
            "Unable to resolve responsible user for heartbeat run dispatch",
            {
              code: "responsible_user_unresolved",
              agentId,
              companyId: agent.companyId,
              issueId: issueId ?? null,
              source,
              triggerDetail,
              wakeReason: readNonEmptyString(
                enrichedContextSnapshot.wakeReason,
              ),
            },
          );
        }
        return queuedResponsibleUserId;
      })();
      return queuedResponsibleUserIdPromise;
    };

    const budgetBlock = await budgets.getInvocationBlock(
      agent.companyId,
      agentId,
      {
        issueId,
        projectId,
      },
    );
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked", { error: budgetBlock.reason }, {
        scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId,
      });
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    // Setup delays execution, but must not discard work accepted by a caller.
    const invokability = await getAgentInvokability(isAgentAwaitingSetup(agent) ? { ...agent, status: "idle" } : agent);
    if (!invokability.invokable) {
      if (opts.requestedByActorType !== "user" || executionWaitRequestId) {
        await writeSkippedRequest("agent.not_invokable", {
          error: invokability.message,
        }, { status: agent.status, reason: invokability.reason });
      }
      throw conflict(invokability.message, {
        status: agent.status,
        reason: invokability.reason,
        invalidOrgChain: invokability.invalidOrgChain,
        ...invokability.details,
      });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled", {}, { enabled: false });
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled", {}, { wakeOnDemand: false });
      return null;
    }

    const genericTimerWake =
      source === "timer" &&
      !issueId &&
      !wakeCommentId &&
      !readNonEmptyString(enrichedContextSnapshot.taskId) &&
      !readNonEmptyString(enrichedContextSnapshot.taskKey);
    if (
      policy.skipTimerWhenNoActionableWork &&
      genericTimerWake &&
      !(await hasActionableTimerWork(agent))
    ) {
      await writeSkippedHeartbeatRequest("heartbeat.timer.no_actionable_work", {
        reason:
          "No assigned todo or in_progress issue requires this agent before timer adapter invocation.",
      });
      await markTimerHeartbeatChecked(agentId, source);
      return null;
    }

    if (issueId) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
        agent.companyId,
        issueId,
      );
      if (activePauseHold) {
        const treeHoldInteractionWake =
          await isVerifiedIssueTreeControlInteractionWake(db, {
            companyId: agent.companyId,
            issueId,
            agentId,
            contextSnapshot: enrichedContextSnapshot,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
          });

        if (!treeHoldInteractionWake) {
          const wait = await writeSkippedRequest("issue_tree_hold_active", {}, {
            holdId: activePauseHold.holdId,
          });
          if (wait.created) await logActivity(db, {
            companyId: agent.companyId,
            actorType: "system",
            actorId: "system",
            agentId,
            runId: null,
            action: "issue.tree_hold_wakeup_deferred",
            entityType: "issue",
            entityId: issueId,
            details: {
              holdId: activePauseHold.holdId,
              rootIssueId: activePauseHold.rootIssueId,
              requestedReason: reason,
              source,
              triggerDetail,
              securityPrinciples: [
                "Complete Mediation",
                "Fail Securely",
                "Secure Defaults",
              ],
            },
          });
          return null;
        }

        enrichedContextSnapshot.treeHoldInteraction = true;
        enrichedContextSnapshot.activeTreeHold = {
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          reason: activePauseHold.reason,
          releasePolicy: activePauseHold.releasePolicy,
          interaction: true,
        };
      }
    }

    if (issueId) {
      // Mention-triggered wakes can request input from another agent, but they must
      // still respect the issue execution lock so a second agent cannot start on the
      // same issue workspace while the assignee already has a live run.
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const cancelledRunsToEmit: (typeof heartbeatRuns.$inferSelect)[] = [];

      const outcome = await db
        .transaction(async (tx) => {
          await tx.execute(
            sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
          );

          if (assignmentKeyParts) {
            const lockedAssignmentIssue = await tx
              .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, statusVersion: issues.statusVersion })
              .from(issues)
              .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            const newestRecordedGeneration = lockedAssignmentIssue
              ? await newestRecordedAssignmentGeneration(tx as unknown as Db, lockedAssignmentIssue.id)
              : null;
            const refusal = decideIssueAssignmentWakeRefusal({
              key: assignmentKeyParts,
              wakeAgentId: agentId,
              lockedIssue: lockedAssignmentIssue,
              newestRecordedGeneration,
            });
            if (refusal) {
              await tx.insert(agentWakeupRequests).values(assignmentRefusalReceipt(refusal, {
                lockedAssigneeAgentId: lockedAssignmentIssue?.assigneeAgentId ?? null,
                lockedStatusVersion: lockedAssignmentIssue?.statusVersion ?? null,
                newestRecordedGeneration,
              }));
              return { kind: "skipped" as const };
            }
          }

          if (executionWaitRequestId) {
            const redelivery = opts.redeliverDeferredWake === true;
            const [pending] = await tx.select().from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.id, executionWaitRequestId), eq(agentWakeupRequests.companyId, agent.companyId),
              eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
              // A user message can join a queue originally created by a
              // system wake. Admission validates the saved user comment or board click.
              // A redelivered receipt keeps its own actor; the lock below revalidates it.
              redelivery || (opts.queuedCommentInterruptId ?? opts.queuedCommentRequestId) === executionWaitRequestId
                ? undefined : eq(agentWakeupRequests.requestedByActorType, "user"),
              redelivery ? undefined
                : opts.queuedCommentInterruptId === executionWaitRequestId
                ? sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${opts.requestedByActorId ?? ""}`
                : opts.queuedCommentRequestId === executionWaitRequestId ? undefined
                  : eq(agentWakeupRequests.requestedByActorId, opts.requestedByActorId ?? ""),
              sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
            ));
            if (redelivery) {
              // Another writer under this lock may already have promoted, adopted
              // or cancelled the receipt. Then there is nothing left to deliver.
              if (!pending) return { kind: "deferred" as const };
              const [lockedIssue] = await tx
                .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
                .from(issues)
                .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
              // A closed task is not revived by an old parked wake. The receipt
              // stays parked; the release of the task's next run retires it.
              if (!lockedIssue || lockedIssue.status === "done" || lockedIssue.status === "cancelled") {
                return { kind: "deferred" as const };
              }
              // Task messages parked for a former assignee now belong to the
              // current one, as on a normal release. Retire the receipt.
              if (
                ["issue_commented", "issue_reopened_via_comment"].includes(reason ?? "") &&
                queuedCommentIdsFromWakePayload(pending.payload).length > 0 &&
                lockedIssue.assigneeAgentId !== agentId
              ) {
                const retiredAt = new Date();
                await tx.update(agentWakeupRequests).set({
                  status: "cancelled",
                  error: "Deferred task messages now belong to the current assignee",
                  finishedAt: retiredAt,
                  updatedAt: retiredAt,
                }).where(and(
                  eq(agentWakeupRequests.id, pending.id),
                  eq(agentWakeupRequests.status, "deferred_issue_execution"),
                ));
                return { kind: "skipped" as const };
              }
            } else if (!pending || (!(wakeCommentId && queuedCommentIdsFromWakePayload(pending.payload).includes(wakeCommentId)) &&
                !(opts.queuedCommentInterruptId && await readQueuedInteractionResponse(tx as unknown as Db,
                  agent.companyId, issueId, pending.payload)))) {
              // The issue lock serializes cleanup callbacks and periodic workers.
              // An adopted, discarded, or edited receipt is no longer authority.
              return { kind: "deferred" as const };
            }
            if (opts.queuedCommentRequestId) {
              const ids = await undeliveredLegacyUserCommentIds(tx as unknown as Db,
                agent.companyId, issueId, agentId, queuedCommentIdsFromWakePayload(pending.payload));
              if (!wakeCommentId || !ids.includes(wakeCommentId)) return { kind: "deferred" as const };
              pending.payload = withQueuedCommentIdsInWakePayload(parseObject(pending.payload), ids);
              await tx.update(agentWakeupRequests).set({ payload: pending.payload }).where(and(
                eq(agentWakeupRequests.id, pending.id), eq(agentWakeupRequests.companyId, agent.companyId),
              ));
            }
            if (!opts.queuedCommentInterruptId && !opts.queuedCommentRequestId && pending.payload?.manualUserWake === true) {
              // A persisted manual wake keeps its actor when an execution wait
              // resumes. The locked receipt above has revalidated that actor.
              payload = { ...payload, manualUserWake: true };
              operatorResponsibleUserId = opts.requestedByActorId!;
            }
            if (opts.queuedCommentInterruptId) {
              // The locked board receipt supplies execution authority even when
              // another user authored the messages. Dispatch revalidates the receipt.
              operatorResponsibleUserId = opts.requestedByActorId!;
            }
            if (opts.queuedCommentInterruptId || opts.queuedCommentRequestId) {
              // Edits/discards between the click and dispatch remain authoritative.
              Object.assign(enrichedContextSnapshot, withQueuedCommentIdsInRunContext(
                enrichedContextSnapshot, queuedCommentIdsFromWakePayload(pending.payload),
              ));
            }
          }
          let automaticParentRunId: string | null = null;
          if (
            source === "automation" &&
            opts.requestedByActorType === "system"
          ) {
            const nativeParent = await readChatControlNativeParent(
              tx as unknown as Db,
              { companyId: agent.companyId, issueId, agentId },
              opts.requestedByActorId ?? null,
            );
            const genericParent =
              !opts.requestedByActorId && reason === "issue_continuation_needed"
                ? readNonEmptyString(enrichedContextSnapshot.retryOfRunId)
                : null;
            automaticParentRunId =
              nativeParent.kind === "parent"
                ? nativeParent.runId
                : genericParent;
            if (automaticParentRunId) {
              const [parent] = await tx
                .select({
                  agentId: heartbeatRuns.agentId,
                  context: heartbeatRuns.contextSnapshot,
                })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, agent.companyId),
                    eq(heartbeatRuns.id, automaticParentRunId),
                  ),
                )
                .limit(1);
              if (
                parent &&
                (parseObject(parent.context).issueId ??
                  parseObject(parent.context).taskId) === issueId &&
                parent.agentId !== agentId
              )
                automaticParentRunId = null;
            }
            const proof =
              nativeParent.kind === "unresolved"
                ? { kind: "unresolved" as const }
                : automaticParentRunId
                  ? await readChatControlRecoveryStop(
                      tx as unknown as Db,
                      {
                        companyId: agent.companyId,
                        issueId,
                        agentId,
                        sourceRunId: automaticParentRunId,
                      },
                      true,
                    )
                  : { kind: "clear" as const };
            if (proof.kind !== "clear") {
              await tx
                .insert(agentWakeupRequests)
                .values({
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason:
                    proof.kind === "stopped"
                      ? CHAT_CONTROL_RECOVERY_STOP_CODE
                      : CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
                  payload: { issueId },
                  status: "skipped",
                  requestedByActorType: "system",
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                  finishedAt: new Date(),
                });
              return { kind: "skipped" as const };
            }
          }

          const durableReceipt = await existingDurableReceipt(
            tx as unknown as Db,
          );
          if (durableReceipt)
            return { kind: "durable" as const, receipt: durableReceipt };
          const assignmentReceipt = await existingAssignmentReceipt(
            tx as unknown as Db,
          );
          if (assignmentReceipt) {
            // A replay after a lost acknowledgement still starts its queued run.
            const [assignedRun] = assignmentReceipt.runId
              ? await tx
                  .select()
                  .from(heartbeatRuns)
                  .where(
                    and(
                      eq(heartbeatRuns.id, assignmentReceipt.runId),
                      eq(heartbeatRuns.companyId, agent.companyId),
                    ),
                  )
              : [];
            return assignedRun
              ? { kind: "replayed" as const, run: assignedRun }
              : { kind: "durable" as const, receipt: assignmentReceipt };
          }
          const failedChatRetry = await authorizeFailedChatRunRetryWake(
            db,
            tx as unknown as Db,
            {
              phase: "admission",
              wakeupRequestId: durableRequest?.id ?? null,
              companyId: agent.companyId,
              agentId,
              issueId,
              contextSnapshot: enrichedContextSnapshot,
            },
          );
          if (
            failedChatRetry !== Boolean(durableRequest?.failedRunRetry) ||
            (failedChatRetry &&
              durableRequest?.failedRunRetry?.failedRunId !==
                readNonEmptyString(enrichedContextSnapshot.retryOfRunId))
          ) {
            throw new FailedChatRunRetryAuthorizationError();
          }
          if (durableRequest) {
            if (issueId !== durableRequest.issueId)
              throw new Error("chat_inbound_wakeup_binding_denied");
            await durableRequest.authorize(tx as unknown as Db);
          } else {
            if (
              source === "on_demand" &&
              triggerDetail === "manual" &&
              reason === "retry_failed_run"
            ) {
              // Generic Board retry does not carry server-authorized failed-run
              // lineage. Caller-supplied source/comment/retry markers cannot
              // restore it, including for a retired conversation generation.
              const [chatBinding] = await tx
                .select({ id: chatConversations.id })
                .from(chatConversations)
                .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId))
                .where(
                  and(
                    eq(chatEndpoints.externalExecutionPolicy, "restricted"),
                    eq(chatConversations.companyId, agent.companyId),
                    eq(chatConversations.issueId, issueId),
                  ),
                )
                .limit(1);
              if (chatBinding) {
                throw conflict(
                  "Retry needs the exact failed chat request and current access. Send the request again in the current connected conversation.",
                  { code: "chat_failed_run_retry_requires_authorized_context" },
                );
              }
            }
            const [held] = await tx
              .select({ id: issues.id })
              .from(issues)
              .where(
                and(
                  eq(issues.id, issueId),
                  eq(issues.companyId, agent.companyId),
                  unadmittedChatWakeupCondition(issues.id, issues.companyId),
                ),
              )
              .limit(1);
            if (held) {
              throw conflict(
                "This task has external chat input that has not been admitted. Check the connection's Activity; let pending input finish, or restore access and send a new authorized message before starting the task.",
                { code: "chat_inbound_wakeup_unadmitted", issueId },
              );
            }
          }

          const issue = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              identifier: issues.identifier,
              conversationAgentId: issues.conversationAgentId,
              conversationUserId: issues.conversationUserId,
              conversationState: issues.conversationState,
              status: issues.status,
              statusVersion: issues.statusVersion,
              projectId: issues.projectId,
              projectWorkspaceId: issues.projectWorkspaceId,
              executionWorkspaceId: issues.executionWorkspaceId,
              executionWorkspacePreference: issues.executionWorkspacePreference,
              executionWorkspaceSettings: issues.executionWorkspaceSettings,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
              monitorNextCheckAt: issues.monitorNextCheckAt,
              monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
              executionRunId: issues.executionRunId,
              executionAgentNameKey: issues.executionAgentNameKey,
              createdAt: issues.createdAt,
              originKind: issues.originKind,
              originId: issues.originId,
            })
            .from(issues)
            .where(
              and(
                eq(issues.id, issueId),
                eq(issues.companyId, agent.companyId),
              ),
            )
            .then((rows) => rows[0] ?? null);

          if (!issue) {
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_issue_not_found",
              payload,
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          // An agent that re-blocks an issue from its own run on it never
          // wakes itself on that issue again. Every other wake,
          // including the board's or another agent's, carries no marker.
          const selfReblockWakeMarker = readSelfReblockWakeMarker(payload, agentId);
          if (selfReblockWakeMarker) {
            // Moving an issue to blocked clears its lock columns, so ownership
            // is the agent's own running run on this issue, not the lock.
            const holdingRun = await tx
              .select({ id: heartbeatRuns.id })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, issue.companyId),
                  eq(heartbeatRuns.agentId, agentId),
                  eq(heartbeatRuns.status, "running"),
                  or(
                    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
                    eq(heartbeatRuns.nativeIssueId, issue.id),
                  ),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null);
            if (
              isSelfReblockWakeOwner({
                agentId,
                holdingRunAgentId: holdingRun ? agentId : null,
              })
            ) {
              const suppressedAt = new Date();
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: ISSUE_SELF_REBLOCK_WAKE_SUPPRESSED_REASON,
                payload: {
                  ...(payload ?? {}),
                  heartbeatSkip: {
                    reason: ISSUE_SELF_REBLOCK_WAKE_SUPPRESSED_REASON,
                    requestedReason: selfReblockWakeMarker.reason,
                  },
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                // Server clock, like the issue's blockedTransitionAt: the
                // dependency backstop compares the two to scope the cycle.
                finishedAt: suppressedAt,
                updatedAt: suppressedAt,
              });
              await logActivity(tx as unknown as Db, {
                companyId: agent.companyId,
                actorType: "system",
                actorId: "issue_wake_loop_guard",
                agentId,
                runId: holdingRun?.id ?? null,
                action: "issue.wake_suppressed_self",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  reason: selfReblockWakeMarker.reason,
                  phase: "admission",
                  cause: "self_reblock_owner",
                },
              });
              return { kind: "skipped" as const };
            }
          }

          const issueStateGuard = opts.issueStateGuard;
          const activeMonitorRun = issueStateGuard?.monitorNextCheckAt === undefined ? null
            : await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.nativeIssueId, issue.id),
              eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
            )).limit(1).then(rows => rows[0] ?? null);
          if (
            issueStateGuard &&
            (!issueStateGuard.statuses.includes(issue.status) ||
              issue.assigneeAgentId !== issueStateGuard.assigneeAgentId ||
              (issueStateGuard.statusVersion !== undefined && issue.statusVersion !== issueStateGuard.statusVersion) ||
              (issueStateGuard.monitorNextCheckAt !== undefined && (
                activeMonitorRun !== null || issue.assigneeUserId !== null ||
                issue.monitorNextCheckAt?.toISOString() !== issueStateGuard.monitorNextCheckAt ||
                issue.monitorWakeRequestedAt?.toISOString() !== issueStateGuard.monitorWakeRequestedAt
              )))
          ) {
            // A deferred monitor retains its schedule; do not create a receipt
            // that could suppress its next admission attempt.
            if (issueStateGuard.monitorNextCheckAt !== undefined) return { kind: "skipped" as const };
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_state_guard_mismatch",
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason:
                    "Issue status or assignee changed before the wake could be queued.",
                  issueId: issue.id,
                  expectedStatuses: issueStateGuard.statuses,
                  actualStatus: issue.status,
                  expectedAssigneeAgentId: issueStateGuard.assigneeAgentId,
                  actualAssigneeAgentId: issue.assigneeAgentId,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          if (opts.failedRunId) {
            // The issue lock makes double-clicks and network retries adopt the
            // same successor, including after it has already finished.
            const [previousRetry] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId),
              eq(heartbeatRuns.retryOfRunId, opts.failedRunId),
              sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'retry_failed_run'`,
            )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
            if (previousRetry) return { kind: "replayed" as const, run: previousRetry };
          }

          let reconciledSourceRunId: string | null = null;
          let reconciledRestoreRetryCount: number | null = null;
          if (executionReconciliationWake) {
            const actionId = readNonEmptyString(
              enrichedContextSnapshot.recoveryActionId,
            );
            if (
              !actionId ||
              !isUuidLike(actionId) ||
              source !== "automation" ||
              triggerDetail !== "system" ||
              reason !== "issue_recovery_action_restored" ||
              opts.requestedByActorType !== "system" ||
              opts.requestedByActorId !== "execution-recovery" ||
              opts.idempotencyKey !== `execution-reconciliation:${actionId}` ||
              enrichedContextSnapshot.source !== "execution.reconciled" ||
              enrichedContextSnapshot.forceFreshSession !== true ||
              payload?.issueId !== issue.id ||
              payload?.recoveryActionId !== actionId ||
              issue.assigneeAgentId !== agentId ||
              ["done", "cancelled"].includes(issue.status)
            )
              return { kind: "skipped" as const };

            // The issue lock serializes all admissions for this source. Validate
            // the durable operator decision, then reconcile a prior queue commit
            // before considering a new wake (including a now-terminal successor).
            const [action] = await tx
              .select()
              .from(issueRecoveryActions)
              .where(
                and(
                  eq(issueRecoveryActions.companyId, issue.companyId),
                  eq(issueRecoveryActions.sourceIssueId, issue.id),
                  eq(issueRecoveryActions.id, actionId),
                ),
              )
              .for("update");
            const decision = parseObject(
              action?.evidence.executionReconciliation,
            );
            const sourceRunId = readNonEmptyString(decision.runId);
            if (
              !action ||
              action.status !== "resolved" ||
              action.kind !== "active_run_watchdog" ||
              action.returnOwnerAgentId !== agentId ||
              !sourceRunId ||
              !isUuidLike(sourceRunId) ||
              decision.providerStopped !== true ||
              !["completed", "not_performed", "mixed"].includes(
                String(decision.actionOutcome),
              ) ||
              !readNonEmptyString(decision.outcomeEvidence) ||
              enrichedContextSnapshot.previousRunId !== sourceRunId ||
              enrichedContextSnapshot.retryOfRunId !== sourceRunId ||
              !["pending", "delivered"].includes(
                String(action.evidence.continuationDelivery),
              )
            )
              return { kind: "skipped" as const };

            const [existingWake] = await tx
              .select()
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, issue.companyId),
                  eq(agentWakeupRequests.agentId, agentId),
                  eq(agentWakeupRequests.idempotencyKey, opts.idempotencyKey),
                  ne(agentWakeupRequests.status, "skipped"),
                ),
              )
              .orderBy(asc(agentWakeupRequests.requestedAt))
              .limit(1);
            if (existingWake) {
              if (
                existingWake.payload?.issueId !== issue.id ||
                existingWake.payload?.recoveryActionId !== action.id ||
                existingWake.requestedByActorType !== "system" ||
                existingWake.requestedByActorId !== "execution-recovery" ||
                !existingWake.runId
              )
                return { kind: "deferred" as const };
              const [existingRun] = await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, issue.companyId),
                    eq(heartbeatRuns.agentId, agentId),
                    eq(heartbeatRuns.id, existingWake.runId),
                  ),
                );
              if (
                !existingRun ||
                existingRun.contextSnapshot?.issueId !== issue.id ||
                existingRun.contextSnapshot?.recoveryActionId !== action.id ||
                existingRun.contextSnapshot?.previousRunId !== sourceRunId
              )
                return { kind: "deferred" as const };
              return { kind: "replayed" as const, run: existingRun };
            }
            if (action.evidence.continuationDelivery !== "pending")
              return { kind: "skipped" as const };
            const [reconciledRun] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, sourceRunId),
            ));
            if (decision.workspaceReconstruction) {
              await validateNativeWorkspaceReconstruction(tx as unknown as Db, {
                companyId: issue.companyId, issueId: issue.id, runId: sourceRunId, actionId,
              });
              reconciledRestoreRetryCount = executionFailureRetryCount(reconciledRun!);
              enrichedContextSnapshot.workspaceReconstructionActionId = action.id;
            }
            if (hasWorkspaceRestoreFailure(reconciledRun?.resultJson)) {
              if ((readNonEmptyString(decision.workspaceRepairEvidence)?.length ?? 0) < 20)
                return { kind: "skipped" as const };
              // Repair does not reset the remaining automatic retry budget.
              reconciledRestoreRetryCount = executionFailureRetryCount(reconciledRun!);
            }
            reconciledSourceRunId = sourceRunId;
          }

          let continuationWait = { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." };
          const deferBlockedExecution = async (
            executionBlocker: NonNullable<Awaited<ReturnType<typeof getExecutionBlocker>>>,
          ) => {
            const condition = { recoveryActionId: executionBlocker.recoveryActionId, ...continuationWait };
            if (executionWaitRequestId) {
              await tx.update(agentWakeupRequests).set({
                payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}', ${JSON.stringify(condition)}::jsonb)`,
                updatedAt: new Date(),
              }).where(eq(agentWakeupRequests.id, executionWaitRequestId));
              return { kind: "deferred" as const };
            }
            if (durableRequest || wakeCommentId ||
                hasInteractionContinuationWakeContext(enrichedContextSnapshot) ||
                readNonEmptyString(enrichedContextSnapshot.nativeStatusWakeIntentId)) {
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId, agentId, source, triggerDetail, reason,
                payload: withQueuedCommentIdsInWakePayload({
                  ...payload,
                  issueId: issue.id,
                  [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
                  executionWait: condition,
                }, [...new Set([
                  ...queuedCommentIdsFromRunContext(enrichedContextSnapshot),
                  ...(wakeCommentId ? [wakeCommentId] : []),
                ])]),
                status: "deferred_issue_execution",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
              });
            } else {
              await recordExecutionWait(tx as unknown as Db, {
                issueId: issue.id, condition, coalesce: coalesceExecutionWait,
                request: {
                  ...durableReceiptFields,
                  companyId: agent.companyId, agentId, source, triggerDetail,
                  reason: "execution_reconciliation_required",
                  error: executionBlocker.nextAction,
                  payload,
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                },
              });
            }
            return { kind: "deferred" as const };
          };
          const explicitContinuationRunId = randomUUID();
          const executionBlocker = await getExecutionBlocker(
            tx as unknown as Db, issue.companyId, issue.id,
            { conversationResetCommentId: opts.requestedByActorType === "user" ? wakeCommentId : null },
          );
          // Prove eligibility without retiring the hold. Later gates can still
          // decline this wake; hold retirement and successor creation stay atomic.
          // A bound chat request has already rechecked its current principal
          // above. Treat its new user message like a board comment, but keep
          // failed-run retry actions on their separate exact-request path.
          const ownsReconstructionContinuation = reconciledSourceRunId && executionBlocker?.runId === reconciledSourceRunId
            && executionBlocker.recoveryActionId === enrichedContextSnapshot.recoveryActionId;
          if (executionBlocker && !ownsReconstructionContinuation && !(await admitExplicitNativeContinuation({
            db: tx as unknown as Db, companyId: issue.companyId, issueId: issue.id,
            agentId, actorType: opts.requestedByActorType, actorId: opts.requestedByActorId,
            reason: durableRequest && !failedChatRetry ? "issue_commented" : reason,
            commentId: wakeCommentId ?? null, failedRunId: opts.failedRunId, successorRunId: explicitContinuationRunId,
            queuedCommentInterruptId: opts.queuedCommentInterruptId,
            queuedCommentRequestId: opts.queuedCommentRequestId,
            dryRun: true,
            onBlocked: (reason, message) => { continuationWait = { reason, message }; },
          }))) return deferBlockedExecution(executionBlocker);


          if (
            worktreeExecutionCutoff &&
            issue.createdAt < worktreeExecutionCutoff
          ) {
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "heartbeat.worktree_execution_cutoff",
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason: "worktree_execution_cutoff",
                  cutoff: worktreeExecutionCutoff.toISOString(),
                  issueId: issue.id,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          const cancelStaleScheduledRetry = async (
            scheduledRun: typeof heartbeatRuns.$inferSelect,
          ) => {
            const issueCancelled = issue.status === "cancelled";
            if (
              scheduledRun.status !== "scheduled_retry" ||
              (scheduledRun.agentId === issue.assigneeAgentId &&
                !issueCancelled)
            ) {
              return false;
            }

            const now = new Date();
            const reason = issueCancelled
              ? "Cancelled because the issue was cancelled before the scheduled retry became due"
              : "Cancelled because the issue was reassigned before the scheduled retry became due";
            const cancelled = await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: reason,
                errorCode: issueCancelled
                  ? "issue_cancelled"
                  : "issue_reassigned",
                updatedAt: now,
              })
              .where(
                and(
                  eq(heartbeatRuns.id, scheduledRun.id),
                  eq(heartbeatRuns.status, "scheduled_retry"),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);

            if (!cancelled) return false;

            if (scheduledRun.wakeupRequestId) {
              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: reason,
                  updatedAt: now,
                })
                .where(
                  eq(agentWakeupRequests.id, scheduledRun.wakeupRequestId),
                );
            }

            if (issue.executionRunId === scheduledRun.id) {
              await tx
                .update(issues)
                .set({
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(issues.id, issue.id),
                    eq(issues.executionRunId, scheduledRun.id),
                  ),
                );
            }

            const eventSeq = await allocateHeartbeatRunEventSeq(
              tx as unknown as Db,
              cancelled.id,
            );

            await tx.insert(heartbeatRunEvents).values({
              companyId: cancelled.companyId,
              runId: cancelled.id,
              agentId: cancelled.agentId,
              seq: eventSeq,
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: issueCancelled
                ? "Scheduled retry cancelled because issue was cancelled before it became due"
                : "Scheduled retry cancelled because issue ownership changed before it became due",
              payload: {
                issueId: issue.id,
                issueStatus: issue.status,
                scheduledRetryAttempt: cancelled.scheduledRetryAttempt,
                scheduledRetryAt: cancelled.scheduledRetryAt
                  ? new Date(cancelled.scheduledRetryAt).toISOString()
                  : null,
                scheduledRetryReason: cancelled.scheduledRetryReason,
                previousRetryAgentId: cancelled.agentId,
                currentAssigneeAgentId: issue.assigneeAgentId,
              },
            });
            await tx
              .update(heartbeatRuns)
              .set({ nextEventSeq: eventSeq + 1, updatedAt: now })
              .where(eq(heartbeatRuns.id, cancelled.id));

            cancelledRunsToEmit.push(cancelled);

            return true;
          };

          let activeExecutionRun = issue.executionRunId
            ? await tx
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, issue.executionRunId))
                .then((rows) => rows[0] ?? null)
            : null;

          if (
            activeExecutionRun &&
            !EXECUTION_PATH_HEARTBEAT_RUN_STATUSES.includes(
              activeExecutionRun.status as (typeof EXECUTION_PATH_HEARTBEAT_RUN_STATUSES)[number],
            )
          ) {
            activeExecutionRun = null;
          }

          if (
            activeExecutionRun &&
            (await cancelStaleScheduledRetry(activeExecutionRun))
          ) {
            activeExecutionRun = null;
          }

          // A queued/scheduled run holding the lock for an agent that is
          // no longer the issue's assignee is stale by design — the issue
          // has been re-routed (e.g. blocked → in_review with a different
          // assignee). Cancel it and release the lock; otherwise the new
          // assignee's wake gets parked in `deferred_issue_execution`
          // forever, because the original queued holder will never run
          // (the issue's status / target now belongs to someone else).
          //
          // Race guard: pin the cancel UPDATE to the exact non-running
          // status we read above. A worker could transition the holder
          // from `queued` → `running` between the SELECT and this UPDATE;
          // the status predicate ensures we never clobber a freshly-
          // claimed running run. If zero rows matched, leave
          // `activeExecutionRun` populated so the defer path runs
          // normally against the now-running holder.
          if (
            activeExecutionRun &&
            activeExecutionRun.status !== "running" &&
            issue.assigneeAgentId &&
            activeExecutionRun.agentId !== issue.assigneeAgentId
          ) {
            const cancelled = await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: new Date(),
                error:
                  "Execution lock released after issue reassigned to a different agent",
                errorCode: "lock_released_on_reassignment",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(heartbeatRuns.id, activeExecutionRun.id),
                  eq(heartbeatRuns.status, activeExecutionRun.status),
                ),
              )
              .returning();
            if (cancelled.length > 0) {
              cancelledRunsToEmit.push(cancelled[0]);
              if (activeExecutionRun.wakeupRequestId) {
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    status: "cancelled",
                    finishedAt: new Date(),
                    error:
                      "Execution lock released after issue reassigned to a different agent",
                    updatedAt: new Date(),
                  })
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      activeExecutionRun.wakeupRequestId,
                    ),
                  );
              }
              activeExecutionRun = null;
            }
          }

          if (!activeExecutionRun && issue.executionRunId) {
            await tx
              .update(issues)
              .set({
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }

          if (!activeExecutionRun) {
            const legacyRun = await tx
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, issue.companyId),
                  inArray(heartbeatRuns.status, [
                    ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
                  ]),
                  sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
                ),
              )
              .orderBy(
                sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
                asc(heartbeatRuns.createdAt),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (legacyRun) {
              if (await cancelStaleScheduledRetry(legacyRun)) {
                activeExecutionRun = null;
              } else {
                const legacyAgent = await tx
                  .select({ name: agents.name })
                  .from(agents)
                  .where(eq(agents.id, legacyRun.agentId))
                  .then((rows) => rows[0] ?? null);
                try {
                  // A savepoint, so a lost race on the routine execution slot rolls back
                  // this update alone and not the whole wake.
                  await tx.transaction(async (rebindTx) => {
                    await rebindTx
                      .update(issues)
                      .set({
                        executionRunId: legacyRun.id,
                        executionAgentNameKey: normalizeAgentNameKey(
                          legacyAgent?.name,
                        ),
                        executionLockedAt: new Date(),
                        updatedAt: new Date(),
                      })
                      .where(eq(issues.id, issue.id));
                  });
                } catch (error) {
                  // Another open copy of the same routine execution holds the slot, so this
                  // issue cannot bind it. The legacy run is still live for this issue, so
                  // the wake still joins it below, without the lock. Queueing a new run
                  // instead would let it claim the slot once the holder's lock is cleared
                  // and run next to the legacy run.
                  if (!isRoutineExecutionSlotConflict(error)) throw error;
                  logRoutineExecutionSlotConflict(legacyRun.id, issue.id, "enqueueWakeup");
                }
                activeExecutionRun = legacyRun;
              }
            }
          }

          const dependencyReadiness = await issuesSvc
            .listDependencyReadiness(issue.companyId, [issue.id], tx)
            .then((rows) => rows.get(issue.id) ?? null);

          // Blocked descendants should stay idle until the final blocker resolves.
          // Human comment/mention wakes are the exception: they may run in a
          // bounded interaction mode so the assignee can answer or triage.
          const blockedInteractionWake =
            dependencyReadiness &&
            !dependencyReadiness.isDependencyReady &&
            allowsIssueInteractionWake(
              enrichedContextSnapshot,
              ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
            );

          if (blockedInteractionWake) {
            enrichedContextSnapshot.dependencyBlockedInteraction = true;
            enrichedContextSnapshot.unresolvedBlockerIssueIds =
              dependencyReadiness.unresolvedBlockerIssueIds;
            enrichedContextSnapshot.unresolvedBlockerCount =
              dependencyReadiness.unresolvedBlockerCount;
            enrichedContextSnapshot.unresolvedBlockerSummaries =
              await listUnresolvedBlockerSummaries(
                tx,
                issue.companyId,
                issue.id,
                dependencyReadiness.unresolvedBlockerIssueIds,
              );
          }

          if (
            !activeExecutionRun &&
            dependencyReadiness &&
            !dependencyReadiness.isDependencyReady &&
            !blockedInteractionWake
          ) {
            await recordExecutionWait(tx as unknown as Db, {
              issueId: issue.id,
              coalesce: coalesceExecutionWait,
              condition: { unresolvedBlockerIssueIds: [...dependencyReadiness.unresolvedBlockerIssueIds].sort() },
              request: {
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: "issue_dependencies_blocked",
                payload: {
                  ...(payload ?? {}),
                  issueId,
                  unresolvedBlockerIssueIds:
                    dependencyReadiness.unresolvedBlockerIssueIds,
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: new Date(),
              },
            });
            return { kind: "skipped" as const };
          }

          if (
            isolatedWorkspacesEnabled &&
            !activeExecutionRun &&
            issue.status !== "done" &&
            issue.status !== "cancelled"
          ) {
            const issueSettings = parseIssueExecutionWorkspaceSettings(
              issue.executionWorkspaceSettings,
            );
            const resolvedMode = resolveExecutionWorkspaceMode({
              projectPolicy: null,
              issueSettings,
              legacyUseProjectWorkspace: null,
            });
            const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig(
              {
                agentConfig: parseObject(agent.adapterConfig),
                projectPolicy: null,
                issueSettings,
                mode: resolvedMode,
                legacyUseProjectWorkspace: null,
              },
            );
            const resolvedStrategy = resolveEffectiveWorkspaceStrategyType(
              resolvedMode,
              workspaceManagedConfig,
            );
            const existingExecutionWorkspaceStatus = issue.executionWorkspaceId
              ? await tx
                  .select({ status: executionWorkspaces.status })
                  .from(executionWorkspaces)
                  .where(
                    and(
                      eq(executionWorkspaces.id, issue.executionWorkspaceId),
                      eq(executionWorkspaces.companyId, issue.companyId),
                    ),
                  )
                  .then((rows) => rows[0]?.status ?? null)
              : null;
            const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
              issueExecutionWorkspaceId: issue.executionWorkspaceId,
              issueExecutionWorkspacePreference:
                issue.executionWorkspacePreference,
              existingExecutionWorkspaceStatus,
            });
            const hasResolvablePriorSessionWorkspace =
              await resolveHasResolvablePriorSessionWorkspace();

            if (
              isUnrunnableWorktreeCombo({
                issue: {
                  projectId: issue.projectId ?? projectId ?? null,
                  projectWorkspaceId: issue.projectWorkspaceId,
                  executionWorkspaceId: issue.executionWorkspaceId,
                  executionWorkspacePreference:
                    issue.executionWorkspacePreference,
                },
                resolvedMode,
                resolvedStrategy,
                reusableExecutionWorkspaceAvailable:
                  reuseRequest.existingExecutionWorkspaceAvailable,
                hasResolvablePriorSessionWorkspace,
              })
            ) {
              const now = new Date();
              const issueLabel = formatIssueIdentifierLink(
                issue.identifier,
                issue.id,
              );
              const blockedComment = [
                `Paperclip blocked ${issueLabel} before dispatch because its workspace settings are not runnable.`,
                "",
                `- Code: \`${WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE}\``,
                `- Reason: ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE}`,
                `- Next action: ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION}`,
              ].join("\n");
              await tx
                .update(issues)
                .set({
                  status: "blocked",
                  checkoutRunId: null,
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(eq(issues.id, issue.id));
              await tx.insert(issueComments).values({
                companyId: issue.companyId,
                issueId: issue.id,
                body: blockedComment,
                createdAt: now,
                updatedAt: now,
              });
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                payload: {
                  ...(payload ?? {}),
                  issueId,
                  heartbeatSkip: {
                    code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                    reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
                    remediation:
                      WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
                  },
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: now,
              });
              await logActivity(tx as unknown as Db, {
                companyId: issue.companyId,
                actorType: "system",
                actorId: "system",
                agentId,
                runId: null,
                action: "issue.workspace_preflight_blocked",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                  reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
                  remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
                  requestedReason: reason,
                  source,
                  triggerDetail,
                  resolvedMode,
                  resolvedStrategy,
                  hasResolvablePriorSessionWorkspace,
                },
              });
              return { kind: "skipped" as const };
            }
          }

          // Automation window: a recovery, retry or monitor wake that lands within
          // the resolved `minSecondsBetweenAutomationWakes` (company < agent <
          // routine < wake type) of the agent's last such run is parked, and later
          // ones merge into the same receipt. The deferred-wake sweep delivers it
          // once the window ends; nothing is dropped. Assignment and human-driven
          // wakes never pass through here. Unset everywhere means off.
          let automationAdmittedAt: Date | undefined;
          const automationWakeReason = reason ?? readNonEmptyString(enrichedContextSnapshot.wakeReason);
          const automationWakeWindowSec =
            automationWakeReason &&
            !reconciledSourceRunId &&
            !opts.manualUserWake
              ? await resolveAutomationWakeWindowSec(tx as unknown as Db, {
                  agent,
                  reason: automationWakeReason,
                  issue,
                })
              : 0;
          if (automationWakeReason && automationWakeWindowSec > 0) {
            const windowMs = automationWakeWindowSec * 1000;
            // Wakes for different issues of one agent share the window; the lock
            // makes the check and the run insert below atomic per agent.
            await lockAutomationWakeWindow(tx as unknown as Db, agent.companyId, agentId);
            // Read the clock after the lock wait: the transaction-start default would
            // age a run by that wait and let the next wake into a window it still owns.
            const gateNow = new Date();
            automationAdmittedAt = gateNow;
            const lastAutomationRun = await findLastAutomationRun(tx as unknown as Db, {
              companyId: agent.companyId,
              agentId,
              since: new Date(gateNow.getTime() - windowMs),
            });
            if (lastAutomationRun) {
              // A redelivered receipt already exists; it simply waits longer.
              if (executionWaitRequestId) return { kind: "deferred" as const };
              const notBefore = new Date(lastAutomationRun.createdAt.getTime() + windowMs);
              const [coalesced] = await tx
                .select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
                .from(agentWakeupRequests)
                .where(
                  and(
                    eq(agentWakeupRequests.companyId, agent.companyId),
                    eq(agentWakeupRequests.agentId, agentId),
                    eq(agentWakeupRequests.status, "deferred_issue_execution"),
                    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                    sql`${agentWakeupRequests.payload} -> ${AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY} is not null`,
                  ),
                )
                .orderBy(asc(agentWakeupRequests.requestedAt))
                .limit(1);
              const coalescedState = buildAutomationWakeCoalescedState({
                notBefore,
                existing: coalesced ? parseObject(coalesced.payload) : null,
                reason: automationWakeReason,
              });
              if (coalesced) {
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    payload: sql`jsonb_set(${agentWakeupRequests.payload}, array[${AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY}]::text[], ${JSON.stringify(coalescedState)}::jsonb)`,
                    coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
                    updatedAt: gateNow,
                  })
                  .where(eq(agentWakeupRequests.id, coalesced.id));
              } else {
                await tx.insert(agentWakeupRequests).values({
                  ...durableReceiptFields,
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason: "automation_wake_coalesced",
                  payload: {
                    ...(payload ?? {}),
                    issueId: issue.id,
                    [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
                    [AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY]: coalescedState,
                  },
                  status: "deferred_issue_execution",
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                });
              }
              return { kind: "deferred" as const };
            }
          }

          if (activeExecutionRun) {
            // The resolved action is already a durable retry outbox. Do not merge
            // its fresh-session contract into unrelated work or create a second
            // deferred wake that could later replay the same reconciliation.
            if (reconciledSourceRunId) return { kind: "deferred" as const };
            // A run took the issue after the sweep read it. The receipt being
            // redelivered is already parked behind that run and its release
            // promotes it. Parking or merging a second receipt would duplicate it.
            if (opts.redeliverDeferredWake) return { kind: "deferred" as const };

            // Offer the input to the active external agent, but keep a durable queued wake
            // until it reads the comment. A finish racing the event tick must
            // leave unread input available for the next assignment.
            const followUpProvider = parseObject(agent.adapterConfig).provider;
            const museFollowUp = followUpProvider === "muse";
            const bindingId = readNonEmptyString(parseObject(agent.adapterConfig)[museFollowUp ? "museBindingId" : followUpProvider === "grok_bot" ? "externalBindingId" : "dotBindingId"]);
            const followUpPayloadKey = museFollowUp ? "museAssignmentFollowUp" : "dotAssignmentFollowUp";
            let followUp: false | { assignmentId: string; consumed: boolean } = false;
            let pendingFollowUps: typeof agentWakeupRequests.$inferSelect[] = [];
            if (agent.adapterType === "paperclip_runner" && ["openai_dot", "grok_bot", "muse"].includes(String(followUpProvider))
                && bindingId && activeExecutionRun.agentId === agentId && issue.assigneeAgentId === agentId
                && reason === "issue_commented" && wakeCommentId && opts.allowRunCoalescing !== false
                && enrichedContextSnapshot.forceFreshSession !== true && !explicitResumeSession && !opts.manualUserWake
                && !enrichedContextSnapshot.interactionId && !payload?.interactionId && !receiptRequest) {
              // Receipt consumption uses the same issue -> wake -> run -> guard ->
              // binding order. Lock before publishing, then reuse these wake rows.
              pendingFollowUps = await tx.select().from(agentWakeupRequests).where(and(
                eq(agentWakeupRequests.companyId, agent.companyId), eq(agentWakeupRequests.agentId, agentId),
                isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->>${followUpPayloadKey} is not null`,
              )).orderBy(asc(agentWakeupRequests.createdAt), asc(agentWakeupRequests.id)).for("update");
              const [currentRun] = await tx.select().from(heartbeatRuns).where(and(
                eq(heartbeatRuns.id, activeExecutionRun.id), eq(heartbeatRuns.companyId, agent.companyId),
                eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running"),
                eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.nativeIssueId, issue.id),
              )).for("update");
              if (currentRun) followUp = await withExternalAdmissionGuard(tx, agent.companyId, agentId,
                () => (museFollowUp ? publishActiveMuseComment : publishActiveDotComment)(tx as unknown as Db, {
                  companyId: agent.companyId, agentId, bindingId, runId: currentRun.id,
                  issueId: issue.id, commentId: wakeCommentId,
                }));
            }
            if (followUp) {
              const assignmentId = followUp.assignmentId;
              const pending = followUp.consumed ? undefined : pendingFollowUps.find(wake =>
                wake.payload?.[followUpPayloadKey] === assignmentId &&
                wake.requestedByActorType === (opts.requestedByActorType ?? null) &&
                wake.requestedByActorId === (opts.requestedByActorId ?? null));
              if (pending) await tx.update(agentWakeupRequests).set({
                payload: withQueuedCommentIdsInWakePayload(pending.payload,
                  [...new Set([...queuedCommentIdsFromWakePayload(pending.payload), wakeCommentId!])]),
                coalescedCount: pending.coalescedCount + 1, updatedAt: new Date(),
              }).where(and(eq(agentWakeupRequests.id, pending.id), eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
              else await tx.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId, source, triggerDetail,
                reason, payload: withQueuedCommentIdsInWakePayload({ ...payload, issueId: issue.id,
                  [followUpPayloadKey]: followUp.assignmentId,
                  [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot }, [wakeCommentId!]),
                status: followUp.consumed ? "coalesced" : "deferred_issue_execution",
                runId: followUp.consumed ? activeExecutionRun.id : null,
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null, idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: followUp.consumed ? new Date() : null });
              return { kind: "coalesced" as const, run: activeExecutionRun };
            }

            const admissionScope = wakeQueue.createAdmissionTransactionScope(
              agent.companyId,
              tx as unknown as Db,
            );
            const admission = await wakeQueue.admitWakeBehindIssueExecution(
              admissionScope,
              {
                companyId: agent.companyId,
                issueId: issue.id,
                agentId,
                agentNameKey,
                issueExecutionAgentNameKey: issue.executionAgentNameKey,
                activeExecutionRun: {
                  id: activeExecutionRun.id,
                  agentId: activeExecutionRun.agentId,
                  status: activeExecutionRun.status,
                  contextSnapshot: activeExecutionRun.contextSnapshot,
                  wakeupRequestId: activeExecutionRun.wakeupRequestId,
                },
                allowRunCoalescing: isConversation(issue) ? false : opts.allowRunCoalescing,
                durableReceipt: receiptRequest
                  ? {
                      id: receiptRequest.id,
                      requestedAt: receiptRequest.requestedAt,
                    }
                  : undefined,
                reason,
                liveRunExecutions,
                wakeCommentId,
                forceFreshSession:
                  enrichedContextSnapshot.forceFreshSession === true,
                contextSnapshot: enrichedContextSnapshot,
                source,
                triggerDetail,
                payload,
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
              },
            );

            if (admission.kind === "coalesced") {
              return {
                kind: "coalesced" as const,
                run: admission.run as typeof heartbeatRuns.$inferSelect,
              };
            }
            if (admission.kind === "deferred") {
              return { kind: "deferred" as const };
            }
            // admission.kind === "proceed": no active run absorbed this wake,
            // so fall through to the ordinary queue path below.
          }

          // PAP-13775: no live run holds the lock, so this wake would start a
          // fresh adapter session. If this agent's recent runs on this issue
          // keep succeeding without any issue-visible progress and the wake
          // carries no new information, hold it back for an escalating cooldown
          // so external pollers/reconcilers can't storm full-price sessions.
          // Server-side recovery retries insert runs directly and never reach
          // this gate.
          if (
            isThrottleCandidateIssueRewake({
              reason,
              wakeCommentId: wakeCommentId ?? null,
              requestedByActorType: opts.requestedByActorType ?? null,
              forceFreshSession:
                enrichedContextSnapshot.forceFreshSession === true,
              hasExplicitResume: Boolean(explicitResumeSession),
            })
          ) {
            const throttleNow = new Date();
            const recentTerminalRuns = await tx
              .select({
                id: heartbeatRuns.id,
                status: heartbeatRuns.status,
                finishedAt: heartbeatRuns.finishedAt,
              })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, agent.companyId),
                  eq(heartbeatRuns.agentId, agentId),
                  sql`${heartbeatRuns.finishedAt} is not null`,
                  gte(
                    heartbeatRuns.finishedAt,
                    new Date(throttleNow.getTime() - ISSUE_REWAKE_LOOKBACK_MS),
                  ),
                  sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
                ),
              )
              .orderBy(desc(heartbeatRuns.finishedAt))
              .limit(ISSUE_REWAKE_RUN_SAMPLE_LIMIT);

            if (recentTerminalRuns.length > 0) {
              const sampleRunIds = recentTerminalRuns.map(
                (sampleRun) => sampleRun.id,
              );
              const progressRows = await tx
                .select({ runId: activityLog.runId })
                .from(activityLog)
                .where(
                  and(
                    eq(activityLog.companyId, agent.companyId),
                    eq(activityLog.entityType, "issue"),
                    eq(activityLog.entityId, issue.id),
                    inArray(activityLog.runId, sampleRunIds),
                    inArray(
                      activityLog.action,
                      ISSUE_PROGRESS_ACTIVITY_ACTIONS,
                    ),
                  ),
                );
              const lastRunFinishedAt =
                recentTerminalRuns[0]?.finishedAt ?? null;
              const newInputRows = lastRunFinishedAt
                ? await tx
                    .select({ id: activityLog.id })
                    .from(activityLog)
                    .where(
                      and(
                        eq(activityLog.companyId, agent.companyId),
                        eq(activityLog.entityType, "issue"),
                        eq(activityLog.entityId, issue.id),
                        gt(activityLog.createdAt, lastRunFinishedAt),
                        sql`coalesce(${activityLog.details}->>'origin', '') <> 'fast_response'`,
                        inArray(
                          activityLog.action,
                          ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
                        ),
                        wakeCommentId && opts.requestedByActorType === "agent"
                          ? ne(activityLog.actorType, "agent")
                          : undefined,
                      ),
                    )
                    .limit(1)
                : [];

              const throttleDecision = evaluateIssueRewakeThrottle({
                now: throttleNow,
                recentTerminalRuns,
                runIdsWithIssueProgress: new Set(
                  progressRows
                    .map((row) => row.runId)
                    .filter((runId): runId is string => Boolean(runId)),
                ),
                // For an agent comment wake, the query excludes agent-authored
                // activity while preserving genuinely new user/system input.
                // Presentation/author metadata therefore cannot smuggle human
                // wake privilege, nor can it mask an actual human response.
                hasNewIssueInputSinceLastRun: newInputRows.length > 0,
              });

              if (throttleDecision.blocked) {
                await tx.insert(agentWakeupRequests).values({
                  ...durableReceiptFields,
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason: "issue_rewake_throttled",
                  payload: {
                    ...(payload ?? {}),
                    issueId,
                    heartbeatSkip: {
                      reason: "issue_rewake_throttled",
                      requestedReason: reason,
                      noProgressStreak: throttleDecision.noProgressStreak,
                      cooldownMs: throttleDecision.cooldownMs,
                      lastRunFinishedAt:
                        throttleDecision.lastRunFinishedAt.toISOString(),
                      nextAllowedAt:
                        throttleDecision.nextAllowedAt.toISOString(),
                    },
                  },
                  status: "skipped",
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                  finishedAt: throttleNow,
                });
                return { kind: "skipped" as const };
              }
            }
          }

          // A non-owner's own re-block wakes may start at most
          // SELF_REBLOCK_WAKE_LIMIT runs on this issue per window. A wake over
          // the limit is parked as a durable deferred receipt, never dropped:
          // the issue's release drain or the resume sweep admits it once the
          // window has passed. Wakes caused by anyone else are not counted.
          if (selfReblockWakeMarker) {
            const limitNow = new Date();
            const limit = decideSelfReblockWakeLimit({
              recentSelfReblockRunCount: await wakeQueue.countRecentSelfReblockWakeRuns(
                wakeQueue.createAdmissionTransactionScope(agent.companyId, tx as unknown as Db),
                {
                  companyId: agent.companyId,
                  agentId,
                  issueId: issue.id,
                  since: selfReblockWakeWindowStart(limitNow),
                },
              ),
              now: limitNow,
            });
            if (limit.kind === "park") {
              const parkedState = buildSelfReblockWakeParkedState(limit.notBefore);
              const [parked] = await tx
                .select({ id: agentWakeupRequests.id })
                .from(agentWakeupRequests)
                .where(
                  and(
                    eq(agentWakeupRequests.companyId, agent.companyId),
                    eq(agentWakeupRequests.agentId, agentId),
                    eq(agentWakeupRequests.status, "deferred_issue_execution"),
                    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                    sql`${agentWakeupRequests.payload} -> ${SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY} is not null`,
                  ),
                )
                .orderBy(asc(agentWakeupRequests.requestedAt))
                .limit(1);
              if (parked) {
                // One parked receipt per agent and issue carries the deferral.
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
                    updatedAt: limitNow,
                  })
                  .where(eq(agentWakeupRequests.id, parked.id));
              } else {
                await tx.insert(agentWakeupRequests).values({
                  ...durableReceiptFields,
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason: "issue_wake_rate_limited",
                  payload: {
                    ...(payload ?? {}),
                    issueId: issue.id,
                    [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
                    [SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY]: parkedState,
                  },
                  status: "deferred_issue_execution",
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                });
              }
              await logActivity(tx as unknown as Db, {
                companyId: agent.companyId,
                actorType: "system",
                actorId: "issue_wake_loop_guard",
                agentId,
                runId: null,
                action: "issue.wake_rate_limited",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  reason: selfReblockWakeMarker.reason,
                  outcome: "deferred",
                  ...parkedState,
                },
              });
              return { kind: "deferred" as const };
            }
          }

          const dailyCapBlock = await getHeartbeatDailyCapBlock(
            agent,
            policy,
            {},
            tx,
          );
          if (dailyCapBlock) {
            if (executionWaitRequestId && executionBlocker) {
              continuationWait = { reason: dailyCapBlock.reason,
                message: "The agent has reached its daily limit. Your message is saved until work can resume." };
              return deferBlockedExecution(executionBlocker);
            }
            const now = new Date();
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: dailyCapBlock.reason,
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason:
                    "Per-agent heartbeat daily cap reached before adapter invocation.",
                  observed: dailyCapBlock.observed,
                  limit: dailyCapBlock.limit,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: now,
            });
            if (source === "timer") {
              await tx
                .update(agents)
                .set({
                  lastHeartbeatAt: now,
                  updatedAt: now,
                })
                .where(eq(agents.id, agentId));
            }
            return { kind: "skipped" as const };
          }

          const explicitContinuation = await admitExplicitNativeContinuation({
            db: tx as unknown as Db, companyId: issue.companyId, issueId: issue.id,
            agentId, actorType: opts.requestedByActorType, actorId: opts.requestedByActorId,
            reason: durableRequest && !failedChatRetry ? "issue_commented" : reason,
            commentId: wakeCommentId ?? null, failedRunId: opts.failedRunId, successorRunId: explicitContinuationRunId,
            queuedCommentInterruptId: opts.queuedCommentInterruptId,
            queuedCommentRequestId: opts.queuedCommentRequestId,
          });
          if (!explicitContinuation && executionBlocker && !ownsReconstructionContinuation) return deferBlockedExecution(executionBlocker);
          if (explicitContinuation) {
            enrichedContextSnapshot.forceFreshSession = true;
            enrichedContextSnapshot.previousRunId = explicitContinuation.previousRunId;
            enrichedContextSnapshot.explicitUserContinuation = explicitContinuation;
          }

          const wakeupRequest = await tx
            .insert(agentWakeupRequests)
            .values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason,
              payload,
              status: "queued",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
            })
            .returning()
            .then((rows) => rows[0]);

          // A handoff changes the executor, not the owner of saved user input.
          // Validate its exact stopped source while the issue row is locked;
          // unrelated agents and dedicated continuations keep their own wakes.
          const interruptedRunId = readNonEmptyString(enrichedContextSnapshot.interruptedRunId);
          const handoffSource = source === "assignment" && reason === "issue_assigned" &&
            issue.assigneeAgentId === agentId && interruptedRunId && isUuidLike(interruptedRunId)
              ? await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
                  eq(heartbeatRuns.id, interruptedRunId), eq(heartbeatRuns.companyId, issue.companyId),
                  eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.errorCode, "issue_reassigned"),
                  ne(heartbeatRuns.agentId, agentId),
                  sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
                  or(isNull(heartbeatRuns.nativeIssueId), eq(heartbeatRuns.nativeIssueId, issue.id)),
                )).then(rows => rows[0] ?? null)
              : null;
          const canCoalesceComments = !isConversation(issue) && opts.allowRunCoalescing !== false;
          // A resumed receipt already passed admission under this issue lock.
          // Consume it with its successor even when chat keeps other messages
          // in separate turns, or finalization will deliver it a second time.
          const pendingComments =
            (executionWaitRequestId || canCoalesceComments) &&
            (ownsReconstructionContinuation || !(await getExecutionBlocker(tx as unknown as Db, issue.companyId, issue.id)))
              ? await tx
                  .select()
                  .from(agentWakeupRequests)
                  .where(
                    and(
                      eq(agentWakeupRequests.companyId, issue.companyId),
                      inArray(agentWakeupRequests.agentId, handoffSource ? [agentId, handoffSource.agentId] : [agentId]),
                      eq(agentWakeupRequests.status, "deferred_issue_execution"),
                      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                      canCoalesceComments ? undefined : eq(agentWakeupRequests.id, executionWaitRequestId!),
                    ),
                  )
                  .orderBy(asc(agentWakeupRequests.requestedAt))
              : [];
          const adoptedComments = pendingComments.filter((wake) => {
            if (wake.id === executionWaitRequestId) return true;
            if (wake.id === opts.queuedCommentInterruptId || wake.id === opts.queuedCommentRequestId) return true;
            const deferredPayload = parseObject(wake.payload);
            const deferredContext = parseObject(
              deferredPayload[DEFERRED_WAKE_CONTEXT_KEY],
            );
            // Dedicated interaction wakes carry their own source and session
            // contract. ID-only adoption must not erase that continuation.
            return (
              // Durable chat work must keep its receipt, actor, source, and
              // session contract through normal promotion and authorization.
              !wake.idempotencyKey?.startsWith("chat-inbound:") &&
              !isInteractionResolutionWakePayload(deferredPayload) &&
              !hasInteractionContinuationWakeContext(deferredContext) &&
              ["issue_commented", "issue_reopened_via_comment"].includes(String(deferredContext.wakeReason ?? wake.reason)) &&
              queuedCommentIdsFromWakePayload(wake.payload).length > 0
            );
          });
          let adoptedCommentIds = [
            ...new Set([
              ...adoptedComments.flatMap((wake) =>
                queuedCommentIdsFromWakePayload(wake.payload),
              ),
              ...queuedCommentIdsFromRunContext(enrichedContextSnapshot),
            ]),
          ];
          if (opts.queuedCommentRequestId || handoffSource) {
            adoptedCommentIds = await undeliveredLegacyUserCommentIds(tx as unknown as Db,
              agent.companyId, issueId, agentId, adoptedCommentIds);
          }
          const newRun = await tx
            .insert(heartbeatRuns)
            .values({
              ...(automationAdmittedAt ? { createdAt: automationAdmittedAt } : {}),
              ...(explicitContinuation ? { id: explicitContinuationRunId } : {}),
              companyId: agent.companyId,
              agentId,
            scopeKind: readNonEmptyString(enrichedContextSnapshot.issueId) ? "issue" : "company",
            issueId: readNonEmptyString(enrichedContextSnapshot.issueId),
              invocationSource: source,
              triggerDetail,
              status: "queued",
              responsibleUserId: await resolveQueuedResponsibleUserId(),
              wakeupRequestId: wakeupRequest.id,
              retryOfRunId: failedChatRetry
                ? durableRequest!.failedRunRetry!.failedRunId
                : opts.failedRunId ?? automaticParentRunId,
              contextSnapshot: adoptedComments.length
                ? withQueuedCommentIdsInRunContext(
                    enrichedContextSnapshot,
                    adoptedCommentIds,
                    adoptedComments.map((wake) => wake.id),
                  )
                : enrichedContextSnapshot,
              sessionIdBefore: explicitContinuation ? null : sessionBefore,
              continuationAttempt,
              ...(reconciledSourceRunId
                ? { retryOfRunId: reconciledSourceRunId }
                : {}),
              ...(reconciledRestoreRetryCount !== null ? {
                scheduledRetryAttempt: reconciledRestoreRetryCount,
                scheduledRetryReason: "transient_failure",
              } : {}),
            })
            .returning()
            .then((rows) => rows[0]);

          if (ownsReconstructionContinuation) {
            await tx.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
              continuationDelivery: "delivered", continuationRunId: newRun.id,
            })}::jsonb` }).where(and(eq(issueRecoveryActions.companyId, issue.companyId),
              eq(issueRecoveryActions.id, String(enrichedContextSnapshot.recoveryActionId)),
              sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`));
          }

          await tx
            .update(agentWakeupRequests)
            .set({
              runId: newRun.id,
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, wakeupRequest.id));

          if (adoptedComments.length) {
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "coalesced",
                runId: newRun.id,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                inArray(
                  agentWakeupRequests.id,
                  adoptedComments.map((wake) => wake.id),
                ),
              );
            await tx
              .update(agentWakeupRequests)
              .set({
                payload: withQueuedCommentIdsInWakePayload(payload, adoptedCommentIds),
              })
              .where(eq(agentWakeupRequests.id, wakeupRequest.id));
            if (opts.redeliverDeferredWake && executionWaitRequestId) {
              // The same marker a release promotion leaves, so the queue stats count it.
              await tx
                .update(agentWakeupRequests)
                .set({ reason: "issue_execution_promoted" })
                .where(eq(agentWakeupRequests.id, executionWaitRequestId));
            }
          }

          // executionRunId is NOT stamped here (enqueueWakeup queues the run but
          // doesn't start it). It will be stamped in claimQueuedRun() once the run
          // transitions to "running" — Fix A (lazy locking).

          return { kind: "queued" as const, run: newRun };
        })
        .catch(async (error) => {
          if (isExternalChatWaitAuthorizationContention(error))
            return { kind: "deferred" as const };
          // A writer outside this issue lock committed the same assignment
          // generation first. Its receipt is the one delivery of this wake.
          if (
            assignmentIdempotencyKey &&
            isUniqueViolation(error, ISSUE_ASSIGNMENT_IDEMPOTENCY_UNIQUE_INDEX)
          ) {
            const receipt = await existingAssignmentReceipt(db);
            if (receipt) return { kind: "durable" as const, receipt };
          }
          throw error;
        });

      // Telemetry for the cancelled runs is best-effort background work.
      // Fire it here and never await it: none of the lifecycle work below,
      // nor this function's return, depends on it, so a slow telemetry
      // lookup must not delay them.
      for (const cancelledRun of cancelledRunsToEmit) {
        void emitAgentTaskRun(db, cancelledRun);
      }

      if (outcome.kind === "durable") {
        return outcome.receipt.runId ? getRun(outcome.receipt.runId) : null;
      }
      if (outcome.kind === "skipped" && opts.redeliverDeferredWake && executionWaitRequestId) {
        // Admission judged this redelivered wake final and recorded why in its
        // own receipt. Retire the parked receipt, or the sweep would re-evaluate
        // it on every recheck. A transient wait is "deferred", not "skipped".
        const retiredAt = new Date();
        await db.update(agentWakeupRequests).set({
          status: "skipped",
          error: "Redelivery of this deferred wake was skipped by admission",
          finishedAt: retiredAt,
          updatedAt: retiredAt,
        }).where(and(
          eq(agentWakeupRequests.id, executionWaitRequestId),
          eq(agentWakeupRequests.companyId, agent.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ));
      }
      if (outcome.kind === "deferred" || outcome.kind === "skipped") {
        return null;
      }
      if (outcome.kind === "coalesced") {
        await startNextQueuedRunForAgent(agent.id);
        return outcome.run;
      }
      if (outcome.kind === "replayed") {
        if (outcome.run.status === "queued")
          await startNextQueuedRunForAgent(agent.id);
        return outcome.run;
      }

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    if (durableRequest) throw new Error("chat_inbound_wakeup_binding_denied");

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [
            ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) =>
        candidate.status === "queued" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeScheduledRetryRun = activeRuns.find(
      (candidate) =>
        candidate.status === "scheduled_retry" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) =>
        candidate.status === "running" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForRunningWake =
      Boolean(sameScopeRunningRun) &&
      !sameScopeQueuedRun &&
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: enrichedContextSnapshot,
        wakeCommentId,
      });
    // Unscoped manual wakes need their own receipt and execution identity too.
    const rawCoalescedTarget =
      opts.allowRunCoalescing === false || opts.manualUserWake
        ? null
        : (sameScopeQueuedRun ??
          sameScopeScheduledRetryRun ??
          (shouldQueueFollowupForRunningWake
            ? null
            : (sameScopeRunningRun ?? null)));

    const coalescedTargetRun = filterZombieCoalesceTarget(
      rawCoalescedTarget,
      liveRunExecutions,
    );

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        enrichedContextSnapshot,
        {
          preserveExistingInteractionContinuation:
            coalescedTargetRun.status === "queued" ||
            coalescedTargetRun.status === "scheduled_retry",
        },
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        ...durableReceiptFields,
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const queueOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${agent.companyId} for update`,
      );

      const dailyCapBlock = await getHeartbeatDailyCapBlock(
        agent,
        policy,
        {},
        tx,
      );
      if (dailyCapBlock) {
        const now = new Date();
        await tx.insert(agentWakeupRequests).values({
          ...durableReceiptFields,
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason: dailyCapBlock.reason,
          payload: {
            ...(payload ?? {}),
            heartbeatSkip: {
              reason:
                "Per-agent heartbeat daily cap reached before adapter invocation.",
              observed: dailyCapBlock.observed,
              limit: dailyCapBlock.limit,
            },
          },
          status: "skipped",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
          finishedAt: now,
        });
        if (source === "timer") {
          await tx
            .update(agents)
            .set({
              lastHeartbeatAt: now,
              updatedAt: now,
            })
            .where(eq(agents.id, agentId));
        }
        return { kind: "skipped" as const };
      }

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          ...durableReceiptFields,
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "queued",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      const newRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: agent.companyId,
          agentId,
          scopeKind: readNonEmptyString(enrichedContextSnapshot.issueId) ? "issue" : "company",
          issueId: readNonEmptyString(enrichedContextSnapshot.issueId),
          invocationSource: source,
          triggerDetail,
          status: "queued",
          responsibleUserId: await resolveQueuedResponsibleUserId(),
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: enrichedContextSnapshot,
          sessionIdBefore: sessionBefore,
          continuationAttempt,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: newRun.id,
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      return { kind: "queued" as const, run: newRun };
    });

    if (queueOutcome.kind === "skipped") return null;
    const newRun = queueOutcome.run;

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  /**
   * Native status commitment deliberately persists dependency/parent wake
   * intents in the same transaction as the authoritative status projection.
   * Those rows are not runnable until the heartbeat scheduler has applied its
   * normal policy, workspace, concurrency, and responsible-user checks. Bridge
   * the durable intent into that scheduler here instead of treating a bare
   * `agent_wakeup_requests` row as if it were already a queued heartbeat run.
   *
   * The intent is claimed before dispatch. A deterministic dispatcher actor id
   * lets a later sweep recover the narrow process-crash window after the real
   * wake was inserted but before the intent was linked to it. Dispatch failure
   * only requeues the intent; it never changes the provider run outcome.
   */
  async function dispatchPendingNativeStatusWakeups(
    input: {
      companyId?: string;
      limit?: number;
      staleClaimMs?: number;
    } = {},
  ) {
    const now = new Date();
    const staleClaimMs = Math.max(1_000, input.staleClaimMs ?? 60_000);
    const candidates = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          input.companyId
            ? eq(agentWakeupRequests.companyId, input.companyId)
            : undefined,
          eq(agentWakeupRequests.requestedByActorType, "system"),
          eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          isNull(agentWakeupRequests.runId),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));

    let dispatched = 0;
    let recovered = 0;
    let deferred = 0;
    const deliveredByIssueScope = new Map<
      string,
      { runId: string | null; status: string }
    >();

    for (const candidate of candidates) {
      const dispatchActorId = `native-status-wake-dispatch:${candidate.id}`;
      const existingDispatch = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, candidate.companyId),
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, dispatchActorId),
          ),
        )
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingDispatch) {
        const recoveredStatus = existingDispatch.runId
          ? "coalesced"
          : existingDispatch.status === "deferred_issue_execution"
            ? "coalesced"
            : existingDispatch.status;
        await db
          .update(agentWakeupRequests)
          .set({
            status: recoveredStatus,
            runId: existingDispatch.runId,
            finishedAt:
              (existingDispatch.runId ?? existingDispatch.finishedAt)
                ? (existingDispatch.finishedAt ?? now)
                : null,
            error: existingDispatch.error,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, candidate.id),
              isNull(agentWakeupRequests.runId),
            ),
          );
        recovered += 1;
        continue;
      }

      if (
        candidate.status === "claimed" &&
        candidate.claimedAt &&
        now.getTime() - candidate.claimedAt.getTime() < staleClaimMs
      ) {
        deferred += 1;
        continue;
      }

      const claimed = await db
        .update(agentWakeupRequests)
        .set({
          status: "claimed",
          claimedAt: now,
          error: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, candidate.id),
            isNull(agentWakeupRequests.runId),
            candidate.status === "claimed"
              ? eq(agentWakeupRequests.status, "claimed")
              : eq(agentWakeupRequests.status, "queued"),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      if (claimed.length === 0) continue;

      const payload = parseObject(candidate.payload);
      const wakeContext = parseObject(payload._paperclipWakeContext);
      const issueId =
        readNonEmptyString(payload.issueId) ??
        readNonEmptyString(payload.taskId) ??
        readNonEmptyString(wakeContext.issueId) ??
        null;
      const scopeKey = issueId
        ? `${candidate.companyId}:${candidate.agentId}:${issueId}:${readNativeReviewAssignmentContext(wakeContext)?.nativeReviewInteractionId ?? ""}`
        : null;
      const priorDelivery = scopeKey
        ? deliveredByIssueScope.get(scopeKey)
        : null;
      if (priorDelivery) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "coalesced",
            runId: priorDelivery.runId,
            finishedAt: new Date(),
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, candidate.id));
        recovered += 1;
        continue;
      }

      let completedOnboardingGuard: WakeupOptions["issueStateGuard"];
      if (issueId) {
        const targetIssue = await db
          .select({
            status: issues.status,
            statusVersion: issues.statusVersion,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(
            and(
              eq(issues.id, issueId),
              eq(issues.companyId, candidate.companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const nativeReview = candidate.reason === "native_completion_review"
          ? await getNativeReviewAssignment(db, {
              companyId: candidate.companyId, issueId, agentId: candidate.agentId,
              contextSnapshot: wakeContext,
            })
          : null;
        const onboardingResultReport = targetIssue?.status === "done" && await isCompletedOnboardingHandoffWake(db, {
          companyId: candidate.companyId, issueId, agentId: candidate.agentId,
          reason: candidate.reason, contextSnapshot: wakeContext,
        });
        if (onboardingResultReport) completedOnboardingGuard = { assigneeAgentId: candidate.agentId, statuses: ["done"], statusVersion: targetIssue!.statusVersion };
        if (
          !targetIssue ||
          (["done", "cancelled"].includes(targetIssue.status) && !onboardingResultReport) ||
          (targetIssue.assigneeAgentId !== candidate.agentId && !nativeReview) ||
          (candidate.reason === "native_completion_review" && !nativeReview)
        ) {
          await db
            .update(agentWakeupRequests)
            .set({
              status: "skipped",
              finishedAt: new Date(),
              error: !targetIssue
                ? "Native status wake target no longer exists"
                : ["done", "cancelled"].includes(targetIssue.status)
                  ? `Native status wake target is already ${targetIssue.status}`
                  : "Native status wake target has a different assignee",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, candidate.id));
          recovered += 1;
          continue;
        }
      }

      try {
        const wakeRun = await enqueueWakeup(candidate.agentId, {
          source: candidate.source as WakeupOptions["source"],
          triggerDetail: (candidate.triggerDetail ??
            "system") as WakeupOptions["triggerDetail"],
          reason: candidate.reason,
          payload,
          idempotencyKey: candidate.idempotencyKey,
          requestedByActorType: "system",
          requestedByActorId: dispatchActorId,
          ...(completedOnboardingGuard ? { issueStateGuard: completedOnboardingGuard } : {}),
          contextSnapshot: {
            ...wakeContext,
            ...(issueId ? { issueId, taskId: issueId } : {}),
            wakeReason: candidate.reason,
            source: "native_status_decision",
            statusDecisionSource: "native_status_decision",
            nativeStatusWakeIntentId: candidate.id,
          },
        });

        const delivered = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, candidate.companyId),
              eq(agentWakeupRequests.requestedByActorType, "system"),
              eq(agentWakeupRequests.requestedByActorId, dispatchActorId),
            ),
          )
          .orderBy(desc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        // The committer intent is the durable outbox entry. When admission is
        // blocked, enqueueWakeup creates a separate deferred dispatch receipt;
        // leave the original intent coalesced so the release drain cannot
        // promote both rows (the original has no nativeStatusWakeIntentId
        // provenance and would otherwise run once before the dispatch receipt).
        const deliveredStatus = delivered?.status ?? "queued";
        await db
          .update(agentWakeupRequests)
          .set({
            status: wakeRun || deliveredStatus === "deferred_issue_execution"
              ? "coalesced"
              : deliveredStatus,
            runId: wakeRun?.id ?? delivered?.runId ?? null,
            finishedAt:
              wakeRun || delivered?.finishedAt
                ? (delivered?.finishedAt ?? new Date())
                : null,
            error: delivered?.error ?? null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, candidate.id));

        if (scopeKey) {
          deliveredByIssueScope.set(scopeKey, {
            runId: wakeRun?.id ?? delivered?.runId ?? null,
            status: wakeRun ? "coalesced" : (delivered?.status ?? "queued"),
          });
        }

        if (wakeRun) dispatched += 1;
        else deferred += 1;
      } catch (error) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            claimedAt: null,
            error:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : String(error).slice(0, 1_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentWakeupRequests.id, candidate.id),
              eq(agentWakeupRequests.status, "claimed"),
              isNull(agentWakeupRequests.runId),
            ),
          );
        logger.warn(
          {
            err: error,
            wakeupRequestId: candidate.id,
            agentId: candidate.agentId,
          },
          "failed to dispatch persisted native status wake intent",
        );
        deferred += 1;
      }
    }

    return { scanned: candidates.length, dispatched, recovered, deferred };
  }

  return {
    enqueueWakeup,
    dispatchPendingNativeStatusWakeups,
    startNextQueuedRunForAgent,
    countRunningRunsForAgent,
    releaseRunClaimedJustBeforeSuppression,
    claimQueuedRun,
    withChatControlRecoveryGate,
    trackWakeup,
    resumeQueuedRuns,
    parseHeartbeatPolicy,
    getHeartbeatDailyCapBlock,
    claimDueTimerHeartbeat,
    admitThroughAutomationWindow,
    sweepDeferredWakes,
    redeliverDeferredWakesForAgent,
    getDeferredWakeStats,
  };
}
