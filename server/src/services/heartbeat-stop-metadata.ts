export type HeartbeatRunOutcome = "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";

export type HeartbeatRunStopReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "cancelled"
  | "budget_paused"
  | "paused"
  | "max_turns_exhausted"
  | "process_lost"
  | "unmanaged_background_task_stopped"
  | "adapter_failed";

export interface HeartbeatRunTimeoutPolicy {
  effectiveTimeoutSec: number | null;
  effectiveTimeoutMs?: number | null;
  timeoutConfigured: boolean;
  timeoutSource: "config" | "default" | "unknown" | "configured" | "sandbox_default" | "unlimited";
}

export interface HeartbeatRunStopMetadata extends HeartbeatRunTimeoutPolicy {
  stopReason: HeartbeatRunStopReason;
  timeoutFired: boolean;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function defaultTimeoutSecForAdapter(adapterType: string) {
  return adapterType === "openclaw_gateway" ? 120 : 0;
}

export function normalizeMaxTurnStopReason(value: unknown): Extract<HeartbeatRunStopReason, "max_turns_exhausted"> | null {
  return value === "max_turns_exhausted" || value === "turn_limit_exhausted"
    ? "max_turns_exhausted"
    : null;
}

export function resolveHeartbeatRunTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): HeartbeatRunTimeoutPolicy {
  const config = adapterConfig ?? {};

  if (adapterType === "http") {
    const hasTimeoutMs = hasOwn(config, "timeoutMs");
    const rawTimeoutMs = hasTimeoutMs ? readFiniteNumber(config.timeoutMs) : 0;
    const timeoutMs = Math.max(0, Math.floor(rawTimeoutMs ?? 0));
    return {
      effectiveTimeoutSec: timeoutMs / 1000,
      effectiveTimeoutMs: timeoutMs,
      timeoutConfigured: timeoutMs > 0,
      timeoutSource: hasTimeoutMs ? "config" : "default",
    };
  }

  const hasTimeoutSec = hasOwn(config, "timeoutSec");
  const defaultTimeoutSec = defaultTimeoutSecForAdapter(adapterType);
  const rawTimeoutSec = hasTimeoutSec ? readFiniteNumber(config.timeoutSec) : defaultTimeoutSec;
  const timeoutSec = Math.max(0, Math.floor(rawTimeoutSec ?? defaultTimeoutSec));

  return {
    effectiveTimeoutSec: timeoutSec,
    timeoutConfigured: timeoutSec > 0,
    timeoutSource: hasTimeoutSec ? "config" : "default",
  };
}

const UNMANAGED_BACKGROUND_TASK_STOP_REASON = "unmanaged_background_task_stopped";

/**
 * True when the provider turn succeeded but Paperclip had to stop the process
 * because a background task the agent started kept it alive. The adapter names
 * that stop with `unmanaged_background_task_stopped` only for a successful,
 * non-refusal result, and the process runner attaches the cleanup evidence.
 * Such a run is recorded as succeeded with a `backgroundTaskStopped` warning.
 */
export function isSuccessfulRunWithStoppedBackgroundTask(input: {
  errorCode?: string | null;
  timedOut?: boolean | null;
  resultJson?: Record<string, unknown> | null;
}): boolean {
  if (input.errorCode !== UNMANAGED_BACKGROUND_TASK_STOP_REASON || input.timedOut) return false;
  const evidence = input.resultJson?.unmanagedBackgroundTask;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  return (evidence as Record<string, unknown>).stopped === true;
}

export function inferHeartbeatRunStopReason(input: {
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopReason {
  if (input.outcome === "succeeded") return "completed";
  if (input.outcome === "interrupted") return "interrupted";
  const maxTurnStopReason = normalizeMaxTurnStopReason(input.errorCode);
  if (maxTurnStopReason) return maxTurnStopReason;
  if (input.outcome === "timed_out") return "timeout";
  if (input.outcome === "failed" && input.errorCode === "unmanaged_background_task_stopped") return "unmanaged_background_task_stopped";
  if (input.outcome === "failed" && input.errorCode === "process_lost") return "process_lost";
  if (input.outcome === "cancelled") {
    const message = (input.errorMessage ?? "").toLowerCase();
    if (message.includes("budget")) return "budget_paused";
    if (message.includes("pause") || message.includes("paused")) return "paused";
    return "cancelled";
  }
  return "adapter_failed";
}

export function buildHeartbeatRunStopMetadata(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopMetadata {
  const timeoutPolicy = resolveHeartbeatRunTimeoutPolicy(input.adapterType, input.adapterConfig);
  const stopReason = inferHeartbeatRunStopReason(input);
  return {
    ...timeoutPolicy,
    stopReason,
    timeoutFired: stopReason === "timeout",
  };
}

export function mergeHeartbeatRunStopMetadata(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: HeartbeatRunStopMetadata,
): Record<string, unknown> {
  const existingMaxTurnStopReason = normalizeMaxTurnStopReason(resultJson?.stopReason);
  // Only a complete, valid adapter resolution overrides the config fallback.
  // Older adapters and persisted rows retain their existing interpretation.
  const resolution = resultJson?.adapterExecutionTimeout;
  let timeoutPolicy: HeartbeatRunTimeoutPolicy = metadata;
  if (metadata.effectiveTimeoutMs == null && resolution && typeof resolution === "object" && !Array.isArray(resolution)) {
    const { timeoutSec, source } = resolution as Record<string, unknown>;
    if (typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec >= 0 &&
        (source === "configured" || (source === "sandbox_default" && timeoutSec > 0) ||
         (source === "unlimited" && timeoutSec === 0))) {
      timeoutPolicy = {
        effectiveTimeoutSec: timeoutSec,
        timeoutConfigured: source === "configured",
        timeoutSource: source,
      };
    }
  }
  // A succeeded run whose lingering background task was stopped keeps that
  // stop reason, so the run ledger shows the warning next to the success.
  const backgroundTaskStopReason =
    metadata.stopReason === "completed" && resultJson?.backgroundTaskStopped === true
      ? UNMANAGED_BACKGROUND_TASK_STOP_REASON
      : null;
  return {
    ...(resultJson ?? {}),
    stopReason: existingMaxTurnStopReason ?? backgroundTaskStopReason ?? metadata.stopReason,
    effectiveTimeoutSec: timeoutPolicy.effectiveTimeoutSec,
    timeoutConfigured: timeoutPolicy.timeoutConfigured,
    timeoutSource: timeoutPolicy.timeoutSource,
    timeoutFired: metadata.timeoutFired,
    ...(metadata.effectiveTimeoutMs != null ? { effectiveTimeoutMs: metadata.effectiveTimeoutMs } : {}),
  };
}
