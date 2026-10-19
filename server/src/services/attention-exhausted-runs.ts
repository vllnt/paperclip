import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";

/** VALUES rows per statement: four parameters each, far below Postgres' 65,535 limit. */
const SUPERSEDED_CHECK_CHUNK = 500;

/**
 * The run's issue as heartbeat_runs_company_issue_or_task_idx indexes it. Keep this
 * exact expression: the planner uses the index only for a matching expression.
 */
const runIssueOrTask = sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`;

/**
 * The exhausted runs that a newer run of the same agent on the same issue
 * supersedes. `issueId` is the run's issue as `readRunIssueId` reads it (null
 * when it has none). For an exhausted run on an issue, later runs are found
 * through the issue index, so no run context is loaded (detoasted). For the
 * rare exhausted run without an issue, the planner may read the agent's later
 * runs instead, and their context, up to the first match.
 * "Newer" compares milliseconds, as the JavaScript dates the feed compares.
 */
export async function listSupersededExhaustedRunIds(
  db: Db,
  companyId: string,
  runs: ReadonlyArray<{ id: string; agentId: string; createdAt: Date; issueId: string | null }>,
): Promise<Set<string>> {
  const superseded = new Set<string>();
  const check = async (chunk: typeof runs, sameIssue: SQL) => {
    if (!chunk.length) return;
    const rows = await db.execute<{ id: string }>(sql`
      select candidate.id from (values ${sql.join(
        chunk.map((run) => sql`(${run.id}::uuid, ${run.agentId}::uuid, ${run.issueId}::text, ${run.createdAt.toISOString()}::timestamptz)`),
        sql`, `,
      )}) as candidate(id, agent_id, issue_id, created_at)
      where exists (
        select 1 from ${heartbeatRuns}
        where ${heartbeatRuns.companyId} = ${companyId}
          and ${heartbeatRuns.agentId} = candidate.agent_id
          and date_trunc('milliseconds', ${heartbeatRuns.createdAt}) > candidate.created_at
          and ${sameIssue}
      )`);
    for (const row of rows) superseded.add(row.id);
  };
  for (let start = 0; start < runs.length; start += SUPERSEDED_CHECK_CHUNK) {
    const chunk = runs.slice(start, start + SUPERSEDED_CHECK_CHUNK);
    await check(chunk.filter((run) => run.issueId !== null), sql`${runIssueOrTask} = candidate.issue_id`);
    // readRunIssueId reads an empty issue as none.
    await check(chunk.filter((run) => run.issueId === null), sql`(${runIssueOrTask} is null or ${runIssueOrTask} = '')`);
  }
  return superseded;
}

export function listAttentionExhaustedRuns(db: Db, companyId: string) {
  // Recovery can revisit an exhausted run. Deduplicate its historical events
  // before joining run data so duplicate events never multiply the wire payload.
  const latestExhaustion = db
    .selectDistinctOn([heartbeatRunEvents.runId], {
      runId: heartbeatRunEvents.runId,
      eventId: heartbeatRunEvents.id,
      message: heartbeatRunEvents.message,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.eventType, "lifecycle"),
      sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
    ))
    .orderBy(asc(heartbeatRunEvents.runId), desc(heartbeatRunEvents.id))
    .as("latest_exhaustion");

  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      // Preserve JSON types and issueId/taskId fallback semantics without
      // transferring prompts, transcripts, or the rest of the run context.
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
        'issueId', ${heartbeatRuns.contextSnapshot} -> 'issueId',
        'taskId', ${heartbeatRuns.contextSnapshot} -> 'taskId'
      )`,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      finishedAt: heartbeatRuns.finishedAt,
      exhaustionMessage: latestExhaustion.message,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoin(latestExhaustion, eq(latestExhaustion.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(agents.companyId, companyId),
      notInArray(agents.status, ["terminated"]),
      inArray(heartbeatRuns.status, ["failed", "timed_out"]),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(latestExhaustion.eventId));
}
