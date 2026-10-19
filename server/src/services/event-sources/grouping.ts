import crypto from "node:crypto";
import {
  eventSeverityRank,
  type EventGrouping,
  type EventSeverity,
  type EventState,
  type NormalizedEvent,
} from "@paperclipai/shared";

/** `fingerprint = "event:" + sha256(groupKey)`; the group's issue carries it as `originFingerprint`. */
export function eventGroupFingerprint(groupKey: string): string {
  return `event:${crypto.createHash("sha256").update(groupKey).digest("hex")}`;
}

/** The per-routine group that absorbs new alerts once a source exceeds its new-issue budget. */
export function eventStormGroupKey(source: string): string {
  return `storm:${source}`;
}

/** The slice of a `routine_event_groups` row the decision needs. */
export interface EventGroupState {
  firstSeenAt: Date;
  lastCommentAt: Date | null;
  lastSeverity: EventSeverity;
  lastState: EventState;
  repeatCount: number;
}

export type EventGroupDecision =
  /** No open group issue: open one (problems and info). */
  | { kind: "new_issue" }
  /** Inside the cooldown: only the counters move. */
  | { kind: "silent" }
  | {
    kind: "comment";
    /** Why the repeat is worth a comment and a wake. */
    reason: "cooldown_elapsed" | "severity_increase" | "after_recovery";
    severityIncreasedFrom: EventSeverity | null;
  }
  | { kind: "recovery_comment"; wake: boolean }
  | { kind: "recovery_without_issue" }
  | { kind: "recovery_ignored" };

/**
 * The §3.4 decision table. `group` is the oldest open group issue for the
 * routine and fingerprint, or null when there is none.
 *
 * One addition over the table: a problem that arrives after the group already
 * recorded a recovery always comments and wakes. Staying silent there would
 * hide a flapping alert from the agent that just read "recovered".
 */
export function decideEventGroupAction(input: {
  event: Pick<NormalizedEvent, "state" | "severity">;
  grouping: Pick<EventGrouping, "repeatCommentCooldownSec" | "rewakeOnSeverityIncrease" | "onRecovery">;
  group: EventGroupState | null;
  now: Date;
}): EventGroupDecision {
  const { event, grouping, group, now } = input;

  if (event.state === "recovery") {
    if (!group) return { kind: "recovery_without_issue" };
    if (grouping.onRecovery === "ignore") return { kind: "recovery_ignored" };
    return { kind: "recovery_comment", wake: grouping.onRecovery === "comment_and_wake" };
  }

  if (!group) return { kind: "new_issue" };

  if (group.lastState === "recovery") {
    return { kind: "comment", reason: "after_recovery", severityIncreasedFrom: null };
  }
  const increased = grouping.rewakeOnSeverityIncrease
    && eventSeverityRank(event.severity) > eventSeverityRank(group.lastSeverity);
  if (increased) {
    return { kind: "comment", reason: "severity_increase", severityIncreasedFrom: group.lastSeverity };
  }
  const reference = group.lastCommentAt ?? group.firstSeenAt;
  const cooldownMs = grouping.repeatCommentCooldownSec * 1000;
  if (now.getTime() - reference.getTime() >= cooldownMs) {
    return { kind: "comment", reason: "cooldown_elapsed", severityIncreasedFrom: null };
  }
  return { kind: "silent" };
}

/** Silent repeats never lower the recorded severity, so a later spike still counts as an increase. */
export function higherEventSeverity(a: EventSeverity, b: EventSeverity): EventSeverity {
  return eventSeverityRank(b) > eventSeverityRank(a) ? b : a;
}
