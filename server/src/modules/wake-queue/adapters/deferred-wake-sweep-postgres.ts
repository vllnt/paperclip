import { and, asc, count, eq, gte, inArray, isNull, lt, lte, notExists, notInArray, or, sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY } from "../domain/self-reblock-wake.js";
import { DEFERRED_WAKE_SWEEP_BATCH_LIMIT, type OrphanedDeferredWake } from "../domain/deferred-wake-sweep.js";

const DEFERRED_WAKE_STATUS = "deferred_issue_execution";
const PROMOTED_WAKE_REASON = "issue_execution_promoted";
const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
/** A closed task is not revived by an old parked wake. */
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"] as const;
/** An agent in one of these states is held, not broken: its wakes wait for it to resume. */
const HELD_AGENT_STATUSES = ["paused", "terminated", "pending_approval"] as const;

export type ListOrphanedDeferredWakesInput = {
  now: Date;
  /** Only wakes parked at least this long. `0` disables the age gate. */
  minAgeMs: number;
  /** Skip wakes examined within this window. `0` disables the throttle. */
  recheckMs: number;
  limit?: number;
  /** Restrict to one agent, as the run-completion trigger does. */
  agentId?: string;
  /** Instance-level worktree cutoff: older requests are never revived. */
  requestedAtGte?: Date | null;
};

export type OrphanedDeferredWakeRow = OrphanedDeferredWake & {
  /** The row's `updated_at` as read, the token `claimDeferredWakeExamination` compares against. */
  observedUpdatedAt: Date;
  /** The issue's project, which scopes a project budget hard stop. */
  projectId: string | null;
};

/** `payload.issueId` as a uuid, or null when it is not one, so the join can use the issue primary key. */
const wakeIssueId = sql`(case when ${agentWakeupRequests.payload} ->> 'issueId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (${agentWakeupRequests.payload} ->> 'issueId')::uuid end)`;

/** Wakes another recovery owns: a queued-comment interrupt, a limit-parked self-reblock wake, durable chat input. */
const notOwnedByOtherRecovery = (wake: { payload: AnyPgColumn; idempotencyKey: AnyPgColumn }) =>
  and(
    sql`${wake.payload} -> 'queuedCommentInterrupt' is null`,
    sql`${wake.payload} -> ${SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY}::text is null`,
    sql`coalesce(${wake.idempotencyKey}, '') not like 'chat-inbound:%'`,
  );

/**
 * Deferred wakes whose issue lock is free: nothing holds `executionRunId` and no
 * queued, running or scheduled-retry run exists for the issue. Such a wake has no
 * run left to drain it. Held work is excluded here where a column proves it (a
 * closed task, a held agent, a hidden issue, a wake owned by another sweep); the
 * caller checks the holds that need more than a column (pause holds, execution
 * blockers, budgets). A closed task is excluded because an old parked wake must
 * not revive it; the release of the task's next run retires the wake.
 *
 * Only each agent's oldest parked wake on an issue is returned; the caller then
 * serves the issue through its oldest returned wake. That head is chosen before
 * the recheck window applies: a head that was just examined hides itself and
 * waits out the window, and the agent's younger wakes on the issue must not step
 * forward in its place. The head is per agent because another agent's older wake
 * may never be selected (a held agent, a wake below the cutoff) or invoked, and
 * must not strand the issue.
 *
 * The scan starts from the partial index on deferred wakes, a set of a few rows,
 * and reaches each issue through its primary key.
 */
export async function listOrphanedDeferredWakes(
  db: Db,
  input: ListOrphanedDeferredWakesInput,
): Promise<OrphanedDeferredWakeRow[]> {
  const olderWake = alias(agentWakeupRequests, "older_deferred_wake");
  return db
    .select({
      wakeId: agentWakeupRequests.id,
      companyId: agentWakeupRequests.companyId,
      agentId: agentWakeupRequests.agentId,
      requestedAt: agentWakeupRequests.requestedAt,
      observedUpdatedAt: agentWakeupRequests.updatedAt,
      issueId: issues.id,
      issuePriority: issues.priority,
      projectId: issues.projectId,
    })
    .from(agentWakeupRequests)
    .innerJoin(
      issues,
      and(eq(issues.id, wakeIssueId), eq(issues.companyId, agentWakeupRequests.companyId)),
    )
    .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
    .innerJoin(
      agents,
      and(eq(agents.id, agentWakeupRequests.agentId), eq(agents.companyId, agentWakeupRequests.companyId)),
    )
    .where(
      and(
        eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
        input.agentId ? eq(agentWakeupRequests.agentId, input.agentId) : undefined,
        lte(agentWakeupRequests.requestedAt, new Date(input.now.getTime() - input.minAgeMs)),
        lte(agentWakeupRequests.updatedAt, new Date(input.now.getTime() - input.recheckMs)),
        input.requestedAtGte ? gte(agentWakeupRequests.requestedAt, input.requestedAtGte) : undefined,
        isNull(issues.executionRunId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, [...CLOSED_ISSUE_STATUSES]),
        notInArray(agents.status, [...HELD_AGENT_STATUSES]),
        // Owned by other recovery: a queued-comment interrupt resumes on its own
        // sweep, a limit-parked self-reblock wake waits out its window there, and
        // durable chat input keeps its receipt and publication path.
        notOwnedByOtherRecovery(agentWakeupRequests),
        // Only an agent's oldest parked wake on the issue (by the same ownership
        // rule and cutoff) is a candidate, whatever its age or recheck state. Per
        // agent, so an older wake the sweep never selects or invokes (a paused
        // agent, a broken chain of command) cannot strand another agent's wake.
        notExists(
          db
            .select({ id: olderWake.id })
            .from(olderWake)
            .where(
              and(
                eq(olderWake.companyId, agentWakeupRequests.companyId),
                eq(olderWake.agentId, agentWakeupRequests.agentId),
                eq(olderWake.status, DEFERRED_WAKE_STATUS),
                sql`${olderWake.payload} ->> 'issueId' = ${agentWakeupRequests.payload} ->> 'issueId'`,
                input.requestedAtGte ? gte(olderWake.requestedAt, input.requestedAtGte) : undefined,
                notOwnedByOtherRecovery(olderWake),
                or(
                  lt(olderWake.requestedAt, agentWakeupRequests.requestedAt),
                  and(
                    eq(olderWake.requestedAt, agentWakeupRequests.requestedAt),
                    lt(olderWake.id, agentWakeupRequests.id),
                  ),
                ),
              ),
            ),
        ),
        sql`not exists (
          select 1 from ${heartbeatRuns} holder
          where holder.company_id = ${issues.companyId}
            and holder.status in (${sql.join(
              EXECUTION_PATH_HEARTBEAT_RUN_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )})
            and holder.context_snapshot ->> 'issueId' = ${issues.id}::text
        )`,
      ),
    )
    .orderBy(
      sql`case ${issues.priority} when 'critical' then 0 when 'high' then 1 when 'low' then 3 else 2 end`,
      asc(agentWakeupRequests.requestedAt),
      asc(agentWakeupRequests.id),
    )
    .limit(input.limit ?? DEFERRED_WAKE_SWEEP_BATCH_LIMIT);
}

/**
 * Optimistic claim on one wake's examine cursor: the write succeeds only for the
 * pass that saw the row's current `updated_at`, so two concurrent passes cannot
 * both drive the same wake. It also moves the wake to the back of the recheck
 * window, so one wake that stays held cannot be re-read on every tick.
 *
 * The observed value is a JavaScript `Date`, which keeps milliseconds. A row
 * inserted with the column default `now()` keeps microseconds, so an exact
 * comparison would never match it. The stored value is truncated to milliseconds
 * for the comparison.
 */
export async function claimDeferredWakeExamination(
  db: Db,
  input: { companyId: string; wakeId: string; observedUpdatedAt: Date; now: Date },
): Promise<boolean> {
  const claimed = await db
    .update(agentWakeupRequests)
    .set({ updatedAt: input.now })
    .where(
      and(
        eq(agentWakeupRequests.id, input.wakeId),
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
        sql`date_trunc('milliseconds', ${agentWakeupRequests.updatedAt}) = ${input.observedUpdatedAt.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: agentWakeupRequests.id });
  return claimed.length > 0;
}

export type DeferredWakeParkedBreakdown = {
  /** On a done, cancelled, hidden or deleted issue; the next run's release retires the wake. */
  closedIssue: number;
  /** Parked by an execution-recovery gate (`payload.executionWait`), by that gate's reason. */
  awaitingRecovery: Record<string, number>;
  /** Behind a held issue lock or a live run; the release drain promotes it. */
  behindIssueLock: number;
  /** Owned by another recovery: a queued-comment interrupt, a limit-parked self-reblock wake, chat input. */
  otherRecovery: number;
  /** The wake's agent is paused, terminated or awaiting approval; the sweep leaves it parked until the agent resumes. */
  heldAgent: number;
  /** No lock, no live run, no recovery wait, an active agent: the periodic sweep's own work. */
  orphaned: number;
};

/**
 * Why each of a company's parked wakes is parked, from durable state. The same
 * facts the sweep reads, grouped so a reader sees the cause of a stall without
 * the process that ran the sweep: a wake on a recovery wait is not an orphan.
 * Classes are exclusive and tested in the order of the type above.
 */
export async function getDeferredWakeParkedBreakdown(
  db: Db,
  input: { companyId: string },
): Promise<DeferredWakeParkedBreakdown> {
  const parked = db
    .select({
      state: sql<string>`case
        when ${issues.id} is null or ${issues.hiddenAt} is not null or ${inArray(issues.status, [...CLOSED_ISSUE_STATUSES])}
          then 'closed_issue'
        when ${agentWakeupRequests.payload} -> 'executionWait' is not null then 'awaiting_recovery'
        when ${issues.executionRunId} is not null or exists (
          select 1 from ${heartbeatRuns} holder
          where holder.company_id = ${issues.companyId}
            and holder.status in (${sql.join(
              EXECUTION_PATH_HEARTBEAT_RUN_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )})
            and holder.context_snapshot ->> 'issueId' = ${issues.id}::text
        ) then 'behind_issue_lock'
        when not (${notOwnedByOtherRecovery(agentWakeupRequests)}) then 'other_recovery'
        when ${inArray(agents.status, [...HELD_AGENT_STATUSES])} then 'held_agent'
        else 'orphaned' end`.as("state"),
      waitReason: sql<string | null>`${agentWakeupRequests.payload} -> 'executionWait' ->> 'reason'`.as("wait_reason"),
    })
    .from(agentWakeupRequests)
    .leftJoin(
      issues,
      and(eq(issues.id, wakeIssueId), eq(issues.companyId, agentWakeupRequests.companyId)),
    )
    .leftJoin(
      agents,
      and(eq(agents.id, agentWakeupRequests.agentId), eq(agents.companyId, agentWakeupRequests.companyId)),
    )
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
      ),
    )
    .as("parked");
  const rows = await db
    .select({ state: parked.state, waitReason: parked.waitReason, count: count() })
    .from(parked)
    .groupBy(parked.state, parked.waitReason);

  const breakdown: DeferredWakeParkedBreakdown = {
    closedIssue: 0,
    awaitingRecovery: {},
    behindIssueLock: 0,
    otherRecovery: 0,
    heldAgent: 0,
    orphaned: 0,
  };
  for (const row of rows) {
    const total = Number(row.count);
    if (row.state === "closed_issue") breakdown.closedIssue += total;
    else if (row.state === "awaiting_recovery") {
      const reason = row.waitReason?.trim() || "unspecified";
      breakdown.awaitingRecovery[reason] = (breakdown.awaitingRecovery[reason] ?? 0) + total;
    } else if (row.state === "behind_issue_lock") breakdown.behindIssueLock += total;
    else if (row.state === "other_recovery") breakdown.otherRecovery += total;
    else if (row.state === "held_agent") breakdown.heldAgent += total;
    else breakdown.orphaned += total;
  }
  return breakdown;
}

export type DeferredWakeAgentStats = {
  agentId: string;
  agentName: string;
  deferredCount: number;
  oldestDeferredAt: Date | null;
  promotedLast24h: number;
};

/**
 * Per-agent view of the deferred queue: how many wakes are parked, how old the
 * oldest is, and how many wakes requested in the last 24 hours were promoted.
 * Agents with nothing parked and nothing promoted are omitted.
 */
export async function getDeferredWakeAgentStats(
  db: Db,
  input: { companyId: string; now: Date },
): Promise<DeferredWakeAgentStats[]> {
  // A raw `sql` fragment carries no column type, so bind the instant as text.
  const since = sql`${new Date(input.now.getTime() - 24 * 60 * 60 * 1000).toISOString()}::timestamptz`;
  const rows = await db
    .select({
      agentId: agentWakeupRequests.agentId,
      agentName: agents.name,
      deferredCount: sql<number>`count(*) filter (where ${agentWakeupRequests.status} = ${DEFERRED_WAKE_STATUS})::int`,
      oldestDeferredAt: sql<string | null>`min(${agentWakeupRequests.requestedAt}) filter (where ${agentWakeupRequests.status} = ${DEFERRED_WAKE_STATUS})`,
      promotedLast24h: sql<number>`count(*) filter (where ${agentWakeupRequests.reason} = ${PROMOTED_WAKE_REASON} and ${agentWakeupRequests.requestedAt} >= ${since})::int`,
    })
    .from(agentWakeupRequests)
    .innerJoin(agents, eq(agents.id, agentWakeupRequests.agentId))
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        sql`(${agentWakeupRequests.status} = ${DEFERRED_WAKE_STATUS} or (${agentWakeupRequests.reason} = ${PROMOTED_WAKE_REASON} and ${agentWakeupRequests.requestedAt} >= ${since}))`,
      ),
    )
    .groupBy(agentWakeupRequests.agentId, agents.name)
    .orderBy(asc(agents.name));
  return rows.map((row) => ({
    agentId: row.agentId,
    agentName: row.agentName,
    deferredCount: Number(row.deferredCount ?? 0),
    oldestDeferredAt: row.oldestDeferredAt ? new Date(row.oldestDeferredAt) : null,
    promotedLast24h: Number(row.promotedLast24h ?? 0),
  }));
}
