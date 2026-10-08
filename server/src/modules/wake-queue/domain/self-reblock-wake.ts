/**
 * Loop guard for self-caused re-block wakes.
 *
 * An agent that blocks an issue on blockers that are already resolved, or that
 * names itself the unblock owner, used to wake itself on that same issue. Each
 * woken run re-blocked the issue and woke the agent again (ANT-3260: 90 runs in
 * 61 minutes). These pure rules identify that provenance from server-derived
 * facts, so admission and deferred-wake promotion apply one policy.
 *
 * Wakes caused by anyone else (the board, users, other agents completing
 * blockers) never carry the marker and are never suppressed or limited here.
 */

/** Server-owned payload key. Admission overwrites any caller-supplied value. */
export const SELF_REBLOCK_WAKE_PAYLOAD_KEY = "_paperclipSelfReblockWake";
/** Server-owned payload key on a deferred wake parked by the self-reblock limit. */
export const SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY = "_paperclipSelfReblockWakeParked";
/** At most this many runs per agent and issue start from self-reblock wakes per window. */
export const SELF_REBLOCK_WAKE_LIMIT = 3;
export const SELF_REBLOCK_WAKE_WINDOW_MS = 10 * 60 * 1000;

const ISSUE_UNBLOCK_REQUESTED_REASON = "issue_unblock_requested";
const ISSUE_BLOCKERS_RESOLVED_REASON = "issue_blockers_resolved";
const BLOCKED_DEPENDENCY_RESTORED_MUTATION = "blocked_dependency_restored";

export type SelfReblockWakeMarker = {
  agentId: string;
  /** The original wake reason, kept through deferral and promotion. */
  reason: string;
  causeActorType: "agent";
  causeActorId: string;
};

/**
 * Returns the marker when the woken agent itself caused an unblock/re-block
 * cycle wake. A blocker that the same agent completes (`blocker_done`) is real
 * progress, not a re-block cycle, so it never carries the marker.
 */
export function deriveSelfReblockWakeMarker(input: {
  agentId: string;
  reason: string | null | undefined;
  mutation: unknown;
  causeActorType: string | null | undefined;
  causeActorId: string | null | undefined;
}): SelfReblockWakeMarker | null {
  if (input.causeActorType !== "agent" || !input.causeActorId || input.causeActorId !== input.agentId) {
    return null;
  }
  const reblockCycle =
    input.reason === ISSUE_UNBLOCK_REQUESTED_REASON ||
    (input.reason === ISSUE_BLOCKERS_RESOLVED_REASON &&
      input.mutation === BLOCKED_DEPENDENCY_RESTORED_MUTATION);
  if (!reblockCycle || !input.reason) return null;
  return {
    agentId: input.agentId,
    reason: input.reason,
    causeActorType: "agent",
    causeActorId: input.causeActorId,
  };
}

/** Reads a marker that belongs to `agentId`; anything else is not self-caused. */
export function readSelfReblockWakeMarker(
  payload: Record<string, unknown> | null | undefined,
  agentId: string,
): SelfReblockWakeMarker | null {
  const raw = payload?.[SELF_REBLOCK_WAKE_PAYLOAD_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (marker.agentId !== agentId || marker.causeActorId !== agentId) return null;
  if (typeof marker.reason !== "string" || marker.reason.length === 0) return null;
  return { agentId, reason: marker.reason, causeActorType: "agent", causeActorId: agentId };
}

/**
 * Merges the loop-guard marker of a deferred wake and an incoming wake. The
 * merged wake stays self-caused only when both contributions are self-caused;
 * any other contribution (a board unblock, another agent's completion) clears
 * the marker, so the merged wake is never suppressed or held back by the
 * self-reblock limit. Parked wakes are never merge targets, so a merge never
 * carries a parked state.
 */
export function mergeSelfReblockWakePayload(input: {
  agentId: string;
  existingPayload: Record<string, unknown>;
  incomingPayload: Record<string, unknown> | null | undefined;
  mergedPayload: Record<string, unknown>;
}): Record<string, unknown> {
  const existing = readSelfReblockWakeMarker(input.existingPayload, input.agentId);
  const incoming = readSelfReblockWakeMarker(input.incomingPayload, input.agentId);
  const merged = { ...input.mergedPayload };
  if (existing && incoming) merged[SELF_REBLOCK_WAKE_PAYLOAD_KEY] = existing;
  else delete merged[SELF_REBLOCK_WAKE_PAYLOAD_KEY];
  delete merged[SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY];
  return merged;
}

/**
 * The woken agent owns the issue's execution when its own run holds (or is
 * releasing) the issue. Waking it because of a re-block it made from that run
 * only restarts the same agent on the same issue. Being the assignee alone is
 * not ownership: an agent that assigns itself a blocked-ready issue from a run
 * elsewhere still needs the wake.
 */
export function isSelfReblockWakeOwner(input: {
  agentId: string;
  holdingRunAgentId: string | null | undefined;
}): boolean {
  return input.holdingRunAgentId === input.agentId;
}

export type SelfReblockWakeLimitDecision =
  | { kind: "allow" }
  | { kind: "park"; notBefore: Date };

/** Applies the self-reblock admission limit for one agent and issue. */
export function decideSelfReblockWakeLimit(input: {
  recentSelfReblockRunCount: number;
  now: Date;
}): SelfReblockWakeLimitDecision {
  if (input.recentSelfReblockRunCount < SELF_REBLOCK_WAKE_LIMIT) return { kind: "allow" };
  return { kind: "park", notBefore: new Date(input.now.getTime() + SELF_REBLOCK_WAKE_WINDOW_MS) };
}

/** The start of the counting window that ends at `now`. */
export function selfReblockWakeWindowStart(now: Date): Date {
  return new Date(now.getTime() - SELF_REBLOCK_WAKE_WINDOW_MS);
}

/** Reads the parked deferral's `notBefore`, or null when the wake is not parked. */
export function readSelfReblockWakeParkedUntil(
  payload: Record<string, unknown> | null | undefined,
): Date | null {
  const raw = payload?.[SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const notBefore = (raw as Record<string, unknown>).notBefore;
  if (typeof notBefore !== "string") return null;
  const parsed = new Date(notBefore);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildSelfReblockWakeParkedState(notBefore: Date): Record<string, unknown> {
  return {
    notBefore: notBefore.toISOString(),
    limit: SELF_REBLOCK_WAKE_LIMIT,
    windowMs: SELF_REBLOCK_WAKE_WINDOW_MS,
  };
}
