import type { RoutineGate, RoutineGateResult } from "@paperclipai/shared";
import { renderGateFailureNote, renderGateOutputForPrompt } from "./command.js";

/** Actor id on the audit rows the gate writes (`routine.run_skipped`, `routine.gate_failed`, the commit's `routine.run_triggered`). */
export const ROUTINE_GATE_ACTOR_ID = "routine-gate";

/** One claim per attempt; a webhook or event run gets the first try plus three retries. */
export const GATE_MAX_ATTEMPTS = 4;

/** Wait before retry n+1 after a retryable transport fault on attempt n, in seconds. */
export const GATE_RETRY_BACKOFF_SEC = [30, 120, 600] as const;

/** A claim older than the gate's own timeout plus this margin is treated as abandoned. */
export const GATE_CLAIM_MARGIN_SEC = 60;

/** A routine whose gate was removed while a run was gating still has a claim to age out. */
const FALLBACK_TIMEOUT_SEC = 120;

export type GateSourceKind = "schedule" | "webhook" | "event";

export function gateClaimStalenessSec(gate: Pick<RoutineGate, "timeoutSec"> | null | undefined): number {
  return (gate?.timeoutSec ?? FALLBACK_TIMEOUT_SEC) + GATE_CLAIM_MARGIN_SEC;
}

/**
 * What the commit does with a finished gate run. `wake` carries the gate stdout (class `ok`)
 * or a failure note (a script fault, or a transport fault that outlived its retries).
 */
export type GateDecision =
  | { action: "skip" }
  | { action: "unavailable" }
  | { action: "wake"; stdout: string; note: string | null };

export type GateVerdict = GateDecision | { action: "retry"; delaySec: number };

/**
 * The §3.4 outcome table. Script faults fail open (the routine still wakes, with a note); a
 * transport fault is not the script's fault, so a schedule skips and polls again next tick
 * while a webhook or event is retried and then wakes.
 */
export function decideGateOutcome(input: {
  source: GateSourceKind;
  result: RoutineGateResult;
  stdout: string;
  retryable: boolean;
  attempts: number;
}): GateVerdict {
  const { result } = input;
  switch (result.class) {
    case "ok":
      return { action: "wake", stdout: input.stdout, note: null };
    case "skip":
      return { action: "skip" };
    case "script_fault":
    case "timeout":
    case "overflow":
      return { action: "wake", stdout: "", note: renderGateFailureNote(result.class, result.detail ?? null) };
    case "transport":
      if (input.source === "schedule") return { action: "unavailable" };
      if (input.retryable && input.attempts < GATE_MAX_ATTEMPTS) {
        const delaySec = GATE_RETRY_BACKOFF_SEC[Math.min(Math.max(input.attempts, 1), GATE_RETRY_BACKOFF_SEC.length) - 1]!;
        return { action: "retry", delaySec };
      }
      return { action: "wake", stdout: "", note: renderGateFailureNote("transport", result.detail ?? null) };
  }
}

/** The text a woken agent sees for a decision, or null when there is nothing to add. */
export function renderGateDecisionBlock(decision: GateDecision): string | null {
  if (decision.action !== "wake") return null;
  if (decision.note) return decision.note;
  const output = renderGateOutputForPrompt(decision.stdout);
  return output.length > 0 ? output : null;
}

/** `routine_runs.gate_dispatch_input`: what a gated run needs to be committed later, as the trigger first saw it. */
export interface GateDispatchInput {
  v: 1;
  kind: "dispatch";
  payload: Record<string, unknown> | null;
  variables: Record<string, unknown> | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  assigneeAgentId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  descriptionAppendix: string | null;
  actorUserId: string | null;
  actorAgentId: string | null;
}

export interface GateEventDispatchInput {
  v: 1;
  kind: "event";
  /** The normalized event as `routine_runs.trigger_payload.event` stores it. */
  eventDeliveryId: string | null;
  stormFold: boolean;
}

export type StoredGateDispatchInput = GateDispatchInput | GateEventDispatchInput;
