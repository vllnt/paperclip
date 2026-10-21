type RetryRun = {
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

/**
 * A run that a server restart cut short resumes at once on the same session.
 * The restart is not the run's failure, so the resume spends no failure retry
 * (it has its own attempt lane, like a resource wait). At most this many resumes
 * may follow each other; the next interruption uses the ordinary bounded retry.
 */
export const PLANNED_RESTART_RESUME_RETRY_REASON = "planned_restart_resume";
export const PLANNED_RESTART_RESUME_WAKE_REASON = "planned_restart_resume";
export const PLANNED_RESTART_RESUME_MAX_ATTEMPTS = 3;

/** Server-owned counts for one automatic continuation chain. Repair slots live
 * in legacyDispositionEpisode and are never charged to either counter here. */
export interface ExecutionRetryAccounting {
  version: 1;
  failureRetries: number;
  maxTurnContinuations: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// These reasons count their own consecutive attempts and never spend a failure retry.
function hasOwnAttemptLane(reason: string): boolean {
  return reason === "workspace_busy" || reason === "ai_connection_busy" || reason === PLANNED_RESTART_RESUME_RETRY_REASON;
}

function savedAccounting(run: RetryRun): ExecutionRetryAccounting | null {
  const value = run.contextSnapshot?.executionRetryAccounting;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const failureRetries = count(saved.failureRetries);
  const maxTurnContinuations = count(saved.maxTurnContinuations);
  if (saved.version !== 1 || failureRetries === null || maxTurnContinuations === null) return null;
  return { version: 1, failureRetries, maxTurnContinuations };
}

function historicalFailureCount(run: RetryRun): number {
  if (run.scheduledRetryReason === "max_turns_continuation" || run.scheduledRetryReason === "issue_disposition_repair") return 0;
  if (run.scheduledRetryReason === "ai_connection_busy") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeAiConnectionWait);
    if (saved !== null) return saved;
  }
  if (run.scheduledRetryReason === "workspace_busy") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeWorkspaceWait);
    if (saved !== null) return saved;
  }
  if (run.scheduledRetryReason === PLANNED_RESTART_RESUME_RETRY_REASON) {
    const saved = count(run.contextSnapshot?.failureRetriesBeforePlannedRestart);
    if (saved !== null) return saved;
  }
  // Historical ambiguous counters remain conservative rather than resetting.
  return count(run.scheduledRetryAttempt) ?? 0;
}

export function executionRetryAccounting(run: RetryRun): ExecutionRetryAccounting {
  const saved = savedAccounting(run);
  const nonFailureLane = ["max_turns_continuation", "issue_disposition_repair", "workspace_busy", "ai_connection_busy", PLANNED_RESTART_RESUME_RETRY_REASON].includes(run.scheduledRetryReason ?? "");
  return {
    version: 1,
    failureRetries: Math.max(saved?.failureRetries ?? 0, saved && nonFailureLane ? 0 : historicalFailureCount(run)),
    maxTurnContinuations: Math.max(saved?.maxTurnContinuations ?? 0,
      run.scheduledRetryReason === "max_turns_continuation" ? count(run.scheduledRetryAttempt) ?? 0 : 0),
  };
}

/** Resource waits, repairs and productive continuations do not spend failures. */
export function executionFailureRetryCount(run: RetryRun): number {
  return executionRetryAccounting(run).failureRetries;
}

export function executionRetryAttemptCount(run: RetryRun, reason: string): number {
  if (hasOwnAttemptLane(reason)) {
    return run.scheduledRetryReason === reason ? count(run.scheduledRetryAttempt) ?? 0 : 0;
  }
  const accounting = executionRetryAccounting(run);
  return reason === "max_turns_continuation" ? accounting.maxTurnContinuations : accounting.failureRetries;
}

export function accountingForScheduledRetry(run: RetryRun, reason: string, attempt: number): ExecutionRetryAccounting {
  const accounting = executionRetryAccounting(run);
  if (reason === "max_turns_continuation") accounting.maxTurnContinuations = attempt;
  else if (!hasOwnAttemptLane(reason)) accounting.failureRetries = attempt;
  return accounting;
}
