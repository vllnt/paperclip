// Pure rules for re-delivering orphaned deferred wakes.
//
// A wake parked as `deferred_issue_execution` waits behind its issue's execution
// lock and is promoted when the lock holder releases (`releaseIssueExecution`).
// Several paths clear the lock without that drain (the stale-lock sweeper, the
// claim-time stale-run cancel, a reaped holder). A wake parked behind one of
// them is orphaned: nothing will ever promote it. The sweep finds those wakes
// and re-drives them. This file only orders and budgets the candidates; the
// caller reads the database and applies the hold checks.

/** A deferred wake must be parked this long before the periodic sweep touches it. */
export const DEFERRED_WAKE_SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/** A wake the sweep already examined is not examined again within this window. */
export const DEFERRED_WAKE_SWEEP_RECHECK_MS = 60 * 1000;
/** Upper bound on wakes read per pass, so one backlog cannot monopolise a tick. */
export const DEFERRED_WAKE_SWEEP_BATCH_LIMIT = 100;

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
 *   for the first one's run to release. Capacity is judged on that oldest wake;
 *   if its agent is full the issue is skipped, never served through a younger
 *   wake, because the drain would still promote the oldest.
 * - FIFO and priority-aware: the chosen wakes are ordered by `compareDeferredWakes`.
 * - Capacity: an agent receives at most its free slots. An agent absent from
 *   `freeSlotsByAgent` has none, so its wakes stay parked until a run completes.
 */
export function selectDeferredWakesToPromote<T extends OrphanedDeferredWake>(
  candidates: readonly T[],
  freeSlotsByAgent: ReadonlyMap<string, number>,
  options: { maxTotal?: number } = {},
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

  const remainingSlots = new Map(freeSlotsByAgent);
  const selected: T[] = [];
  for (const candidate of [...oldestByIssue.values()].sort(compareDeferredWakes)) {
    if (options.maxTotal !== undefined && selected.length >= options.maxTotal) break;
    const slots = remainingSlots.get(candidate.agentId) ?? 0;
    if (slots <= 0) continue;
    remainingSlots.set(candidate.agentId, slots - 1);
    selected.push(candidate);
  }
  return selected;
}
