/**
 * Per-agent coalescing of wakes the server raises on its own.
 *
 * With a `minSecondsBetweenAutomationWakes` window resolved for the wake, a recovery, retry or
 * monitor wake that arrives within that window of the agent's last such run is
 * not started. It is parked as one deferred receipt per agent and issue, later
 * wakes merge into it, and the deferred-wake sweep delivers it once the window
 * has passed. Nothing is dropped. Assignment and human-driven wakes are never
 * coalesced.
 */

import {
  AUTOMATION_WAKE_REASONS,
  MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES,
  type AutomationWakeSettings,
} from "@paperclipai/shared";

/** Server-owned payload key on the deferred receipt that carries merged automation wakes. */
export const AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY = "_paperclipAutomationWakeCoalesced";

export const AUTOMATION_WAKE_REASON_SET: ReadonlySet<string> = new Set(AUTOMATION_WAKE_REASONS);

type SettingsLayer = AutomationWakeSettings | null | undefined;

/**
 * Resolves the window for one automation wake. Layers, least to most specific:
 * company < agent < routine < wake type. The wake-type value comes from the most
 * specific scope that sets one for this reason; otherwise the level-wide value of the
 * most specific scope that sets one applies. Unset everywhere means 0 (off).
 */
export function resolveMinSecondsBetweenAutomationWakes(input: {
  reason: string;
  company?: SettingsLayer;
  agent?: SettingsLayer;
  routine?: SettingsLayer;
}): number {
  const mostSpecificFirst = [input.routine, input.agent, input.company];
  for (const layer of mostSpecificFirst) {
    const byReason: Partial<Record<string, number>> = layer?.byWakeReason ?? {};
    const seconds = byReason[input.reason];
    if (typeof seconds === "number") return clampSeconds(seconds);
  }
  for (const layer of mostSpecificFirst) {
    const seconds = layer?.minSecondsBetweenAutomationWakes;
    if (typeof seconds === "number") return clampSeconds(seconds);
  }
  return 0;
}

function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES);
}

export type AutomationWakeCoalescedState = {
  notBefore: string;
  /** Every wake reason merged into the receipt, in arrival order. */
  reasons: string[];
};

export function buildAutomationWakeCoalescedState(input: {
  notBefore: Date;
  existing?: Record<string, unknown> | null;
  reason: string;
}): AutomationWakeCoalescedState {
  const previous = input.existing?.[AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY];
  const previousReasons =
    previous && typeof previous === "object" && Array.isArray((previous as { reasons?: unknown }).reasons)
      ? ((previous as { reasons: unknown[] }).reasons.filter((value): value is string => typeof value === "string"))
      : [];
  return {
    notBefore: input.notBefore.toISOString(),
    reasons: [...new Set([...previousReasons, input.reason])],
  };
}

/** Reads the window end of a coalesced receipt, or null when the wake is not one. */
export function readAutomationWakeCoalescedUntil(
  payload: Record<string, unknown> | null | undefined,
): Date | null {
  const raw = payload?.[AUTOMATION_WAKE_COALESCED_PAYLOAD_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const notBefore = (raw as Record<string, unknown>).notBefore;
  if (typeof notBefore !== "string") return null;
  const parsed = new Date(notBefore);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
