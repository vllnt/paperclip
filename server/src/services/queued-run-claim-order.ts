import { and, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { ISSUE_PRIORITIES, type IssuePriority } from "@paperclipai/shared";

/**
 * How long a queued run waits before it ranks one issue priority higher. It
 * bounds starvation: a low run ranks as critical after three steps, and from
 * then on only runs created before it start first.
 */
export const QUEUED_RUN_PRIORITY_AGING_STEP_MS = 30 * 60 * 1000;

// Runs without an issue (timer heartbeats, routines without an issue) rank as
// the default issue priority, so they neither jump urgent work nor wait behind
// every issue run. A run whose issue is gone ranks the same; its claim cancels it.
const DEFAULT_PRIORITY_LEVEL = ISSUE_PRIORITIES.indexOf("medium");

export type QueuedRunIssueFacts = {
  /** The issue's current priority, read when the queue is claimed. */
  priority: string | null | undefined;
  inProgress: boolean;
  dependencyReady: boolean;
};

type QueuedRunTiming = {
  id: string;
  createdAt: Date;
  scheduledRetryAt: Date | null;
};

/**
 * One agent's queued runs. The company predicate lets the planner use the
 * (company_id, status, ...) indexes; without it every run of the agent is read.
 */
export function selectAgentQueuedRuns(
  db: Db,
  input: { companyId: string; agentId: string; cutoff: Date | null },
) {
  return db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "queued"),
        input.cutoff ? gte(heartbeatRuns.createdAt, input.cutoff) : undefined,
      ),
    );
}

function priorityLevel(priority: string | null | undefined) {
  const level = ISSUE_PRIORITIES.indexOf(priority as IssuePriority);
  return level === -1 ? DEFAULT_PRIORITY_LEVEL : level;
}

function rank(run: QueuedRunTiming, issue: QueuedRunIssueFacts | null, now: Date) {
  // A promoted scheduled retry keeps its creation time; it waits in the queue
  // only from the moment it became due.
  const queuedSince = Math.max(run.createdAt.getTime(), run.scheduledRetryAt?.getTime() ?? 0);
  const agingSteps = Math.max(0, Math.floor((now.getTime() - queuedSince) / QUEUED_RUN_PRIORITY_AGING_STEP_MS));
  const baseLevel = issue ? priorityLevel(issue.priority) : DEFAULT_PRIORITY_LEVEL;
  return {
    blocked: issue ? !issue.dependencyReady : false,
    level: Math.max(0, baseLevel - agingSteps),
    aged: agingSteps > 0,
    inProgress: issue?.inProgress ?? false,
  };
}

/**
 * The order in which an agent's queued runs are offered to the claim:
 * 1. runs whose issue still has unresolved blockers go last;
 * 2. higher effective priority first (issue priority, raised one level per aging step);
 * 3. at equal effective priority, a run that has aged starts before a fresh one,
 *    and fresh runs of in-progress issues start before other fresh runs;
 * 4. then the oldest run (by creation time) first.
 */
export function orderQueuedRunsForClaim<T extends QueuedRunTiming>(
  runs: readonly T[],
  issueOf: (run: T) => QueuedRunIssueFacts | null,
  now: Date,
): T[] {
  return runs
    .map((run) => ({ run, rank: rank(run, issueOf(run), now) }))
    .sort((a, b) =>
      Number(a.rank.blocked) - Number(b.rank.blocked) ||
      a.rank.level - b.rank.level ||
      Number(b.rank.aged) - Number(a.rank.aged) ||
      (a.rank.aged ? 0 : Number(b.rank.inProgress) - Number(a.rank.inProgress)) ||
      a.run.createdAt.getTime() - b.run.createdAt.getTime() ||
      (a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0))
    .map(({ run }) => run);
}
