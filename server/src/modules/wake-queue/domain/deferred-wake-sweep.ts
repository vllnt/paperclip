// Pure rules for re-delivering orphaned deferred wakes.
//
// A wake parked as `deferred_issue_execution` waits behind its issue's execution
// lock and is promoted when the lock holder releases (`releaseIssueExecution`).
// Several paths clear the lock without that drain (the stale-lock sweeper, the
// claim-time stale-run cancel, a reaped holder). A wake parked behind one of
// them is orphaned: nothing will ever promote it. The sweep finds those wakes
// and re-drives them. This file decides which candidates may still run, then
// orders and budgets them; the caller reads the database and applies the hold
// checks.

/**
 * Context key the run of a promoted parked wake carries: when that wake was
 * first requested. The agent's queue measures the run's wait from then, so a
 * wake that sat parked keeps its place instead of starting at the back.
 */
export const QUEUED_RUN_REQUESTED_AT_CONTEXT_KEY = "parkedWakeRequestedAt";

/** A deferred wake must be parked this long before the periodic sweep touches it. */
export const DEFERRED_WAKE_SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/** A wake the sweep already examined is not examined again within this window. */
export const DEFERRED_WAKE_SWEEP_RECHECK_MS = 60 * 1000;
/** Upper bound on wakes read per pass, so one backlog cannot monopolise a tick. */
export const DEFERRED_WAKE_SWEEP_BATCH_LIMIT = 100;
/**
 * Upper bound on wakes re-delivered per pass. The first pass after a deploy
 * sees every wake that was stranded before it; they drain over several passes
 * (30 seconds apart by default) instead of one burst of runs and holds checks.
 */
export const DEFERRED_WAKE_SWEEP_MAX_PER_PASS = 20;
/**
 * Upper bound on one agent's wakes re-delivered per pass, so one agent's
 * backlog cannot fill a pass and the other agents' wakes still move.
 */
export const DEFERRED_WAKE_SWEEP_MAX_PER_AGENT_PER_PASS = 3;

/** A caller may ask for fewer wakes per pass, never for more than the cap. */
export function sweepPromotionBudget(requested?: number): number {
  return Math.max(0, Math.min(requested ?? DEFERRED_WAKE_SWEEP_MAX_PER_PASS, DEFERRED_WAKE_SWEEP_MAX_PER_PASS));
}

/**
 * Wake reasons that address the agent as the issue's assignee. Such a wake for
 * an agent that no longer holds the issue is superseded: the new assignee got
 * its own wake. Mentions, review and approval requests are not in this set,
 * because they address an agent that need not be the assignee.
 */
const ASSIGNEE_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_continuation_needed",
]);

/**
 * Wake reasons that only signal "look at this issue again". When one wake of
 * an agent on an issue is promoted, the agent's other parked wakes on that
 * issue with one of these reasons (and no saved input) add nothing the
 * promoted run will not see, so they are folded into its run.
 * `issue_children_completed` is not here: it names the completed child and
 * its summary, which the promoted run's context would not carry.
 */
export const COALESCIBLE_PARKED_WAKE_REASONS: readonly string[] = [
  "issue_assigned",
  "issue_continuation_needed",
  "issue_status_changed",
  "issue_blockers_resolved",
];

export type DeferredWakeDisposition =
  /** Re-deliver it through ordinary admission. */
  | "promote"
  /** An assignee wake for an agent that no longer holds the issue: close it, never run it. */
  | "superseded"
  /**
   * The same, but the wake carries saved input (for example a person's
   * comment). Leave it parked: the new assignee's admission adopts its saved
   * comments, and the release drain cancels it once the new assignee has run.
   */
  | "keptForHandoff";

export type DeferredWakeDispositionFacts = {
  agentId: string;
  /** The reason the wake was requested for (the parked context's `wakeReason`, else the row's reason). */
  wakeReason: string | null;
  issueAssigneeAgentId: string | null;
  /** The wake delivers saved input; see `carriesSavedInput` in the Postgres adapter. */
  carriesSavedInput: boolean;
};

/**
 * Decides whether an orphaned parked wake may still run. An assignee wake
 * whose agent lost the issue is superseded: the new assignee got its own
 * wake, and this one could not check the issue out. It is closed with its
 * reason instead of started, unless it carries saved input, which is left
 * parked for the handoff. Every other wake is promoted, however long it
 * waited: closing an old wake on an open issue could leave assigned work with
 * no run, because the stranded-issue recovery does not dispatch every such
 * issue again.
 */
export function decideDeferredWakeDisposition(wake: DeferredWakeDispositionFacts): DeferredWakeDisposition {
  if (
    wake.wakeReason !== null &&
    ASSIGNEE_WAKE_REASONS.has(wake.wakeReason) &&
    wake.issueAssigneeAgentId !== wake.agentId
  ) {
    return wake.carriesSavedInput ? "keptForHandoff" : "superseded";
  }
  return "promote";
}

const ISSUE_PRIORITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Lower is more urgent. An unknown or missing priority ranks as `medium`. */
export function issuePriorityRank(priority: string | null | undefined): number {
  return ISSUE_PRIORITY_RANK[priority ?? ""] ?? ISSUE_PRIORITY_RANK.medium!;
}

export type OrphanedDeferredWake = {
  wakeId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  requestedAt: Date;
  issuePriority: string | null;
};

/** Most urgent issue first, then oldest request first; the id keeps the order total. */
export function compareDeferredWakes(left: OrphanedDeferredWake, right: OrphanedDeferredWake): number {
  return (
    issuePriorityRank(left.issuePriority) - issuePriorityRank(right.issuePriority) ||
    left.requestedAt.getTime() - right.requestedAt.getTime() ||
    left.wakeId.localeCompare(right.wakeId)
  );
}

/**
 * Chooses which orphaned wakes to promote now.
 *
 * - One wake per issue, the issue's oldest: its queue drains in request order
 *   and promotes one wake at a time, so a younger wake on the same issue waits
 *   for the first one's run to release. The per-agent cap is judged on that
 *   oldest wake; if its agent's share of the pass is used up the issue is
 *   skipped, never served through a younger wake.
 * - FIFO and priority-aware: the chosen wakes are ordered by `compareDeferredWakes`.
 * - A busy agent does not hold a wake back. Promotion queues a run, and the
 *   agent's queue claim admits it only into a free run slot, ordered by how
 *   long it has waited since its request. Holding it parked until a slot is
 *   free starved it: the agent's queued runs took every freed slot first.
 * - At most `maxTotal` wakes per pass, and at most `maxPerAgent` of one agent.
 */
export function selectDeferredWakesToPromote<T extends OrphanedDeferredWake>(
  candidates: readonly T[],
  options: { maxTotal?: number; maxPerAgent?: number } = {},
): T[] {
  const oldestByIssue = new Map<string, T>();
  for (const candidate of candidates) {
    const current = oldestByIssue.get(candidate.issueId);
    if (
      !current ||
      candidate.requestedAt.getTime() < current.requestedAt.getTime() ||
      (candidate.requestedAt.getTime() === current.requestedAt.getTime() && candidate.wakeId < current.wakeId)
    ) {
      oldestByIssue.set(candidate.issueId, candidate);
    }
  }

  const maxPerAgent = options.maxPerAgent ?? DEFERRED_WAKE_SWEEP_MAX_PER_AGENT_PER_PASS;
  const selectedByAgent = new Map<string, number>();
  const selected: T[] = [];
  for (const candidate of [...oldestByIssue.values()].sort(compareDeferredWakes)) {
    if (options.maxTotal !== undefined && selected.length >= options.maxTotal) break;
    const taken = selectedByAgent.get(candidate.agentId) ?? 0;
    if (taken >= maxPerAgent) continue;
    selectedByAgent.set(candidate.agentId, taken + 1);
    selected.push(candidate);
  }
  return selected;
}
