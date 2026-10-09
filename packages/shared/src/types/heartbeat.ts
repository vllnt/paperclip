import type {
  AgentRole,
  AgentStatus,
  HeartbeatInvocationSource,
  HeartbeatRunStatus,
  RunLivenessState,
  WakeupTriggerDetail,
  WakeupRequestStatus,
} from "../constants.js";

export interface ProviderTraceDebugRequest {
  providerTrace: "raw";
}

export type ProviderTraceDirection =
  "client_to_provider" | "provider_to_client" | "provider_stderr";
export type ProviderTraceDisposition =
  "mapped" | "generic" | "ignored" | "rejected" | "operator_only";

export type ProviderTraceFieldMappingAction =
  "copied" | "renamed" | "normalized" | "derived" | "dropped" | "redacted";

export interface ProviderTraceFieldMapping {
  inputPath?: string;
  outputPath?: string;
  action: ProviderTraceFieldMappingAction;
  reason?: string;
}

export interface ProviderTraceFrame {
  kind?: "frame";
  schema: "paperclip.provider_trace_frame.v1";
  debugChannel: string;
  debugSequence: number;
  frameId: number;
  timestamp: string;
  direction: ProviderTraceDirection;
  transport: string;
  provider: string;
  byteLength: number;
  digest: `sha256:${string}`;
  rawBase64: string;
}

export interface ProviderTraceInterpretation {
  kind?: "interpretation";
  schema: "paperclip.provider_trace_interpretation.v1";
  debugChannel: string;
  debugSequence: number;
  frameId: number;
  stage: string;
  ruleId: string;
  disposition: ProviderTraceDisposition;
  emittedEventIds: string[];
  droppedFields: string[];
  fieldMappings?: ProviderTraceFieldMapping[];
  reason: string;
}

export type ProviderTraceStatus =
  "capturing" | "complete" | "incomplete" | "truncated" | "deleted" | "expired";

export interface ProviderTraceMetadata {
  schema: "paperclip.provider_trace_metadata.v1";
  id: string;
  runId: string;
  companyId: string;
  status: ProviderTraceStatus;
  provider: string;
  frameCount: number;
  byteCount: number;
  digest: `sha256:${string}` | null;
  reason: string | null;
  requestedBy: string;
  createdAt: string | Date;
  expiresAt: string | Date;
  deletedAt: string | Date | null;
}

export type RunPresentationSource =
  | "existing_issue_comment"
  | "final_agent_message"
  | "semantic_result_summary"
  | "adapter_final_response"
  | "none";

export interface RunPresentationDecision {
  schema: "paperclip.run_presentation_decision.v1";
  resolverVersion: string;
  chosenSource: RunPresentationSource;
  sourceEventId: string | null;
  commentAction: "reuse" | "create" | "none";
  commentId: string | null;
  activityDisposition: "collapse";
  reasonCodes: string[];
}

export type GitWorktreeBranchAncestryVerdict =
  "ancestor" | "diverged" | "unknown";

export type GitWorktreeInProgressOperation =
  "rebase" | "merge" | "cherry_pick" | "revert" | "bisect";

export interface GitWorktreeBranchIncoherenceEvidence {
  reason: "git_worktree_branch_incoherence";
  fingerprint: string;
  sourceIssueId: string | null;
  sourceIdentifier: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  repoRoot: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  /**
   * Interrupted git operation (rebase/merge/cherry-pick/revert/bisect) whose
   * state directory is still present in the worktree. Optional so previously
   * persisted evidence payloads stay valid.
   */
  inProgressOperation?: GitWorktreeInProgressOperation | null;
  statusEntryCount: number | null;
  dirtyPathSample: string[];
  contention: {
    claimedByWorkspaceId: string;
    claimedByIssueId: string | null;
    claimedByIssueIdentifier: string | null;
    activeRun: {
      id: string;
      status: "queued" | "running";
      issueId: string | null;
      issueIdentifier: string | null;
    } | null;
  } | null;
  provenance: {
    expectedBranchRef: string;
    actualBranchRef: string | null;
    registeredBranchRef: string | null;
    registeredPathFound: boolean;
    registeredBranchMatchesHead: boolean;
    expectedBranchExists: boolean;
    actualBranchExists: boolean | null;
    expectedHeadSha: string | null;
    actualHeadSha: string | null;
    sameHead: boolean;
    ancestryVerdict: GitWorktreeBranchAncestryVerdict;
    plainLanguageReason: string;
  };
  safeRepair: {
    eligible: boolean;
    attempted: boolean;
    succeeded: boolean;
    reason: string;
  };
}

export interface HeartbeatRun {
  execution?: import("./execution-projection.js").ExecutionProjection | null;
  id: string;
  companyId: string;
  agentId: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
  responsibleUserId: string | null;
  activeIdentityContextId?: string | null;
  identityHistory?: Array<{
    id: string;
    revision: number;
    responsibleUserId: string | null;
    messageId: string | null;
    parentContextId: string | null;
    cause: string;
    status: string;
    acceptedAt: Date | string | null;
    github: {
      status: "available" | "absent" | "unavailable";
      login?: string;
      source?: "personal" | "dedicated";
      reason?: string;
      connectionId?: string;
      grantId?: string;
      authenticationMode?: "managed" | "host" | "anonymous";
    } | null;
  }>;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  wakeupRequestId: string | null;
  exitCode: number | null;
  signal: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  logStore: string | null;
  logRef: string | null;
  logBytes: number | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  errorCode: string | null;
  externalRunId: string | null;
  processPid: number | null;
  processGroupId?: number | null;
  processStartedAt: Date | null;
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  lastOutputBytes: number | null;
  retryOfRunId: string | null;
  processLossRetryCount: number;
  scheduledRetryAt?: Date | null;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  continuationAttempt: number;
  lastUsefulActionAt: Date | null;
  nextAction: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  outputSilence?: HeartbeatRunOutputSilence;
  /**
   * Ephemeral, process-local current status message for an active run. Resolved
   * from the in-memory runtime status store (never persisted to the database)
   * and only populated for active/live run reads. Disappears on TTL expiry,
   * terminal run status, or server restart.
   */
  currentStatusMessage?: string | null;
  currentStatusUpdatedAt?: Date | string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: Date | string | null;
}

/**
 * Typed phase labels emitted by the sandbox-managed runtime as it progresses
 * through workspace preparation, adapter startup, restore/export, and
 * finalization. Used by the ephemeral runtime status plumbing; not persisted.
 */
export type HeartbeatRunStatusPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize"
  | "run_activity";

export type HeartbeatRunOutputSilenceLevel =
  "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";

export interface HeartbeatRunOutputSilence {
  lastOutputAt: Date | string | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | string | null;
  silenceAgeMs: number | null;
  level: HeartbeatRunOutputSilenceLevel;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | string | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
}

export interface AgentWakeupSkipped {
  status: "skipped";
  reason: string;
  message: string | null;
  issueId: string | null;
  executionRunId: string | null;
  executionAgentId: string | null;
  executionAgentName: string | null;
}

export type AgentWakeupResponse = HeartbeatRun | AgentWakeupSkipped;

/** A durable chat retry can be accepted before a scheduler run exists. */
export interface ChatFailedRunRetryResponse {
  actionId: string;
  issueId: string;
  runId: string | null;
  status:
    "queued" | "deferred" | "running" | "succeeded" | "failed" | "cancelled";
}

export interface HeartbeatRunEvent {
  id: number;
  companyId: string;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: "system" | "stdout" | "stderr" | null;
  level: "info" | "warn" | "error" | null;
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AgentRuntimeState {
  agentId: string;
  companyId: string;
  adapterType: string;
  sessionId: string | null;
  sessionDisplayId?: string | null;
  sessionParamsJson?: Record<string, unknown> | null;
  stateJson: Record<string, unknown>;
  lastRunId: string | null;
  lastRunStatus: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTaskSession {
  id: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentWakeupRequest {
  id: string;
  companyId: string;
  agentId: string;
  source: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  status: WakeupRequestStatus;
  coalescedCount: number;
  requestedByActorType: "user" | "agent" | "system" | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  runId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One agent's deferred-wake queue: wakes parked behind an issue's execution lock. */
export interface DeferredWakeAgentStats {
  agentId: string;
  agentName: string;
  /** Wakes currently parked as `deferred_issue_execution`. */
  deferredCount: number;
  /** When the oldest parked wake was requested; `null` when nothing is parked. */
  oldestDeferredAt: Date | null;
  /** How long the oldest parked wake has waited. A growing value is a stall. */
  oldestDeferredAgeSeconds: number | null;
  /** Wakes requested in the last 24 hours that were promoted into a run. */
  promotedLast24h: number;
}

/**
 * Counters for the deferred-wake redelivery sweep for ONE company since the
 * server last started. They never include another company's activity, and
 * they are not durable.
 */
export interface DeferredWakeSweepCounters {
  /** This company's orphaned wakes read: parked with no run left to promote them. */
  examined: number;
  promoted: number;
  /** Retired by admission instead of started (for example, skipped as final). */
  retired: number;
  /** Left parked after admission declined to start them yet. */
  stillDeferred: number;
  /** Not woken: a pause hold, an execution blocker or an operator Stop. The sum of the three below. */
  skippedHeld: number;
  /** Held by an active subtree pause hold on the issue. */
  skippedPauseHold: number;
  /** Held by an execution blocker (a recovery action or an unreleased execution) that awaits an operator. */
  skippedExecutionBlocker: number;
  /** Held by an operator Stop of the issue's latest run. */
  skippedOperatorStop: number;
  /** Not woken: a company, agent or project budget hard stop. */
  skippedBudget: number;
  skippedNotInvokable: number;
  /** Issues with an eligible wake that a pass left for later: no free agent slot, or the per-pass cap. */
  skippedCapacity: number;
  /** Execution blockers behind `skippedExecutionBlocker`, counted by their cause. */
  executionBlockerCauses: Record<string, number>;
  failed: number;
  /** When the sweep last read one of this company's orphaned wakes. */
  lastExaminedAt: Date | null;
}

/**
 * Why a company's parked wakes are parked, read from durable state, so it holds
 * across restarts and whichever process answers. The classes are exclusive.
 */
export interface DeferredWakeParkedBreakdown {
  /** On a done, cancelled, hidden or deleted issue; the next run's release retires the wake. */
  closedIssue: number;
  /** Parked by an execution-recovery gate, counted by that gate's reason. The sweep leaves these to the recovery. */
  awaitingRecovery: Record<string, number>;
  /** Behind a held issue lock or a live run; the release drain promotes it. */
  behindIssueLock: number;
  /** Owned by another recovery: a queued-comment interrupt, a limit-parked self-reblock wake, chat input. */
  otherRecovery: number;
  /** No lock, no live run, no recovery wait: the periodic sweep's own work. */
  orphaned: number;
}

export interface DeferredWakeStats {
  generatedAt: Date;
  deferredTotal: number;
  promotedLast24h: number;
  oldestDeferredAt: Date | null;
  oldestDeferredAgeSeconds: number | null;
  agents: DeferredWakeAgentStats[];
  parked: DeferredWakeParkedBreakdown;
  sweep: DeferredWakeSweepCounters;
}

export interface InstanceSchedulerHeartbeatAgent {
  id: string;
  companyId: string;
  companyName: string;
  companyIssuePrefix: string;
  agentName: string;
  agentUrlKey: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  adapterType: string;
  intervalSec: number;
  heartbeatEnabled: boolean;
  schedulerActive: boolean;
  lastHeartbeatAt: Date | null;
}
