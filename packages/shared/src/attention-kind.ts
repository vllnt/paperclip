import type { AttentionSourceKind } from "./types/attention.js";

/**
 * The two kinds of attention item. `blocking` reports something stuck (a
 * failure, an error, a blocked dependency, a recovery, a budget stop); `review`
 * waits on a verdict (a decision, an approval, a question, a join request, a
 * review). The Inbox shows `review` items in its Decide tab and `blocking`
 * items in its Alerts tab, and the CLI's `inbox attention --tab` uses the same
 * split.
 */
export type AttentionKind = "blocking" | "review";

/** Source kinds that report something stuck; every other source kind is `review`. */
export const ATTENTION_BLOCKING_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "failed_run",
  "agent_error_alert",
  "blocker_attention",
  "recovery_action",
  "budget_alert",
]);

/**
 * The kind an attention source belongs to.
 *
 * @param sourceKind - The attention item's source kind.
 * @returns `blocking` for failures, errors, blockers, recoveries and budget stops; `review` otherwise.
 * @example attentionKindForSourceKind("decision") // "review"
 */
export function attentionKindForSourceKind(sourceKind: AttentionSourceKind): AttentionKind {
  return ATTENTION_BLOCKING_SOURCE_KINDS.has(sourceKind) ? "blocking" : "review";
}

/** The Inbox tab that lists attention items of each kind. */
export const ATTENTION_INBOX_TAB_BY_KIND = {
  review: "decide",
  blocking: "alerts",
} as const satisfies Record<AttentionKind, string>;
