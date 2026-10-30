import { isRoutineRunIssueOriginKind } from "@paperclipai/shared";
import { TRIAGE_DEFAULT_PRIORITY, TRIAGE_MIN_TITLE_WORDS } from "./constants.js";
import type { TriageIssueFacts } from "./types.js";

/**
 * What to do with a new issue before any model call:
 * - `ignore`: leave no record (routine-made, hidden or already closed issues keep their values).
 * - `skip`: record that the rules ruled out a model call.
 * - `ask`: send the questions that are still open. An explicit assignee or priority is never asked
 *   about, so it keeps its value.
 */
export type TriagePlan =
  | { kind: "ignore"; reason: "routine_issue" | "hidden" | "closed" }
  | { kind: "skip"; reason: "short_title" }
  | { kind: "ask"; askPriority: boolean; askOwner: boolean };

const CLOSED_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

/** Counts the words (runs of letters or digits) in a text. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/**
 * Decides, from the stored issue alone, whether and what to ask the model.
 * A priority other than the default counts as explicit. The default cannot be told apart from a
 * chosen "medium", so it stays open to a suggestion; the suggestion never changes the issue.
 */
export function planTriage(issue: TriageIssueFacts): TriagePlan {
  if (isRoutineRunIssueOriginKind(issue.originKind)) return { kind: "ignore", reason: "routine_issue" };
  if (issue.hidden) return { kind: "ignore", reason: "hidden" };
  if (CLOSED_STATUSES.has(issue.status)) return { kind: "ignore", reason: "closed" };
  if (countWords(issue.title) < TRIAGE_MIN_TITLE_WORDS) return { kind: "skip", reason: "short_title" };
  return {
    kind: "ask",
    askPriority: issue.priority === TRIAGE_DEFAULT_PRIORITY,
    askOwner: issue.assigneeAgentId === null && issue.assigneeUserId === null,
  };
}
