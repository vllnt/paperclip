import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { issueExecutionDecisions, issues, routineRuns, runUsageRecords, type Db } from "@paperclipai/db";
import {
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  type RoutineStep,
  type RoutineStepStats,
  type RoutineStepStatsFigures,
  type RoutineStepStatsStep,
} from "@paperclipai/shared";

/** A step issue id in a run payload is used only when it has the shape of a uuid. */
const UUID_TEXT_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** What the stats read for one routine. */
export interface RoutineStepStatsInput {
  companyId: string;
  routineId: string;
  /** The most recent routine runs to read. */
  runs: number;
}

/**
 * Builds the one statement the stats send. It is exported so the query plan test explains exactly the
 * SQL the service runs.
 *
 * The statement reads the latest `runs` runs of the routine through the `(company_id, routine_id,
 * created_at)` index, expands the step issue ids each run recorded, reads each step issue by primary
 * key, and adds one aggregate per step issue over its run usage records and over its review
 * decisions, both through their `(company_id, issue_id)` indexes. Every per-step read is a lateral
 * subquery that the planner cannot turn into a join over a whole table. It returns one row per step
 * issue, and one row with a null step for a run that created no step, so the window size stays known.
 * The work grows with `runs` times the steps per run, never with the size of the tables.
 * @returns A statement whose rows {@link parseRoutineStepStatsRow} reads.
 */
export function buildRoutineStepStatsQuery(input: RoutineStepStatsInput): SQL {
  return sql`
    with recent_runs as materialized (
      select ${routineRuns.id} as run_id,
             ${routineRuns.createdAt} as run_created_at,
             ${routineRuns.triggerPayload} -> ${ROUTINE_STEPS_RUN_PAYLOAD_KEY}::text -> 'stepIssueIds' as step_issue_ids
      from ${routineRuns}
      where ${routineRuns.companyId} = ${input.companyId}
        and ${routineRuns.routineId} = ${input.routineId}
      order by ${routineRuns.createdAt} desc
      limit ${input.runs}
    ),
    run_steps as (
      select recent_runs.run_id,
             recent_runs.run_created_at,
             entry.key as step_key,
             case when entry.value ~ ${UUID_TEXT_PATTERN} then entry.value::uuid end as issue_id
      from recent_runs
      left join lateral jsonb_each_text(
        case when jsonb_typeof(recent_runs.step_issue_ids) = 'object' then recent_runs.step_issue_ids else '{}'::jsonb end
      ) as entry(key, value) on true
    )
    select run_steps.run_id,
           run_steps.run_created_at,
           run_steps.step_key,
           step.status,
           step.created_at,
           step.started_at,
           step.completed_at,
           step.cancelled_at,
           usage.agent_runs,
           usage.input_tokens,
           usage.cache_read_tokens,
           usage.output_tokens,
           usage.cost_micros,
           usage.agent_duration_ms,
           decisions.review_rounds,
           decisions.changes_requested
    from run_steps
    left join lateral (
      select ${issues.id} as id,
             ${issues.status} as status,
             ${issues.createdAt} as created_at,
             ${issues.startedAt} as started_at,
             ${issues.completedAt} as completed_at,
             ${issues.cancelledAt} as cancelled_at
      from ${issues}
      where ${issues.id} = run_steps.issue_id
        and ${issues.companyId} = ${input.companyId}
        and ${issues.originKind} = 'routine_step'
        and ${issues.originId} = ${input.routineId}
      limit 1
    ) as step on true
    left join lateral (
      select count(*) as agent_runs,
             sum(${runUsageRecords.inputTokens}) as input_tokens,
             sum(${runUsageRecords.cacheReadTokens}) as cache_read_tokens,
             sum(${runUsageRecords.outputTokens}) as output_tokens,
             sum(${runUsageRecords.costMicros}) as cost_micros,
             sum(${runUsageRecords.durationMs}) as agent_duration_ms
      from ${runUsageRecords}
      where ${runUsageRecords.companyId} = ${input.companyId}
        and ${runUsageRecords.issueId} = step.id
    ) as usage on true
    left join lateral (
      select count(*) as review_rounds,
             count(*) filter (where ${issueExecutionDecisions.outcome} = 'changes_requested') as changes_requested
      from ${issueExecutionDecisions}
      where ${issueExecutionDecisions.companyId} = ${input.companyId}
        and ${issueExecutionDecisions.issueId} = step.id
    ) as decisions on true
  `;
}

const countSchema = z.coerce.number().int().nonnegative();
const sumSchema = z.union([z.null(), z.coerce.number().int()]);
const timeSchema = z.union([z.null(), z.coerce.date()]);

const rawRowSchema = z.object({
  run_id: z.string(),
  run_created_at: z.coerce.date(),
  step_key: z.string().nullable(),
  status: z.string().nullable(),
  created_at: timeSchema,
  started_at: timeSchema,
  completed_at: timeSchema,
  cancelled_at: timeSchema,
  agent_runs: countSchema,
  input_tokens: sumSchema,
  cache_read_tokens: sumSchema,
  output_tokens: sumSchema,
  cost_micros: sumSchema,
  agent_duration_ms: sumSchema,
  review_rounds: countSchema,
  changes_requested: countSchema,
});

/** One step issue of one routine run, as the stats statement returns it. */
export interface RoutineStepStatsIssue {
  stepKey: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  agentRuns: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  agentDurationMs: number | null;
  reviewRounds: number;
  changesRequested: number;
}

/** One row of the stats statement: a routine run and, when it has one, one of its step issues. */
export interface RoutineStepStatsRow {
  runId: string;
  runCreatedAt: Date;
  /** Null for a run that created no step, or whose step issue no longer exists. */
  issue: RoutineStepStatsIssue | null;
}

/**
 * Reads one row of the stats statement.
 * @throws ZodError when the row does not have the statement's shape.
 */
export function parseRoutineStepStatsRow(row: unknown): RoutineStepStatsRow {
  const raw = rawRowSchema.parse(row);
  const issue =
    raw.step_key !== null && raw.status !== null && raw.created_at !== null
      ? {
          stepKey: raw.step_key,
          status: raw.status,
          createdAt: raw.created_at,
          startedAt: raw.started_at,
          completedAt: raw.completed_at,
          cancelledAt: raw.cancelled_at,
          agentRuns: raw.agent_runs,
          inputTokens: raw.input_tokens,
          cacheReadTokens: raw.cache_read_tokens,
          outputTokens: raw.output_tokens,
          costMicros: raw.cost_micros,
          agentDurationMs: raw.agent_duration_ms,
          reviewRounds: raw.review_rounds,
          changesRequested: raw.changes_requested,
        }
      : null;
  return { runId: raw.run_id, runCreatedAt: raw.run_created_at, issue };
}

/** The median of the values, rounded to a whole number; null when there is none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value);
}

function appendTo<T extends object>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Adds a sum that may be unreported: null stays null until some value is reported. */
function addSum(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

/** When a step issue closed: its completion when done, its cancellation when cancelled, else null. */
function closedAt(issue: RoutineStepStatsIssue): Date | null {
  if (issue.status === "done") return issue.completedAt;
  if (issue.status === "cancelled") return issue.cancelledAt;
  return null;
}

/** How long a done step issue took, from its first start (or its creation) to done. */
function doneDurationMs(issue: RoutineStepStatsIssue): number | null {
  if (issue.status !== "done" || !issue.completedAt) return null;
  const start = issue.startedAt ?? issue.createdAt;
  return Math.max(0, issue.completedAt.getTime() - start.getTime());
}

function figuresOf(stepIssues: RoutineStepStatsIssue[]): RoutineStepStatsFigures {
  let done = 0;
  let cancelled = 0;
  let open = 0;
  let agentRuns = 0;
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let outputTokens: number | null = null;
  let costMicros: number | null = null;
  let agentDurationMs: number | null = null;
  let reviewRounds = 0;
  let changesRequested = 0;
  for (const issue of stepIssues) {
    if (issue.status === "done") done += 1;
    else if (issue.status === "cancelled") cancelled += 1;
    else open += 1;
    agentRuns += issue.agentRuns;
    inputTokens = addSum(inputTokens, issue.inputTokens);
    cacheReadTokens = addSum(cacheReadTokens, issue.cacheReadTokens);
    outputTokens = addSum(outputTokens, issue.outputTokens);
    costMicros = addSum(costMicros, issue.costMicros);
    agentDurationMs = addSum(agentDurationMs, issue.agentDurationMs);
    reviewRounds += issue.reviewRounds;
    changesRequested += issue.changesRequested;
  }
  return {
    done,
    cancelled,
    open,
    cancelledRate: ratio(cancelled, done + cancelled),
    agentRuns,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    costMicros,
    agentDurationMs,
    reviewRounds,
    changesRequested,
    changesRequestedRate: ratio(changesRequested, reviewRounds),
  };
}

/**
 * Turns the rows of the stats statement into the response. Pure, so the empty and the large cases
 * are tested without a database.
 * @param input.currentSteps The routine's steps now; they order the result and give the titles.
 * @param input.runs The window the request asked for.
 */
export function summarizeRoutineStepStats(input: {
  routineId: string;
  runs: number;
  currentSteps: Pick<RoutineStep, "key" | "title">[];
  rows: RoutineStepStatsRow[];
}): RoutineStepStats {
  const runCreatedAt = new Map<string, Date>();
  const issuesByRun = new Map<string, RoutineStepStatsIssue[]>();
  const issuesByKey = new Map<string, RoutineStepStatsIssue[]>();
  for (const row of input.rows) {
    runCreatedAt.set(row.runId, row.runCreatedAt);
    if (!row.issue) continue;
    appendTo(issuesByRun, row.runId, row.issue);
    appendTo(issuesByKey, row.issue.stepKey, row.issue);
  }

  const runDurations: number[] = [];
  for (const runIssues of issuesByRun.values()) {
    const closed = runIssues.map(closedAt);
    if (closed.some((value) => value === null)) continue;
    const firstCreated = Math.min(...runIssues.map((issue) => issue.createdAt.getTime()));
    const lastClosed = Math.max(...closed.map((value) => value?.getTime() ?? 0));
    runDurations.push(Math.max(0, lastClosed - firstCreated));
  }

  const allIssues = [...issuesByRun.values()].flat();
  const currentKeys = input.currentSteps.map((step) => step.key);
  const earlierKeys = [...issuesByKey.keys()].filter((key) => !currentKeys.includes(key)).sort();
  const titles = new Map(input.currentSteps.map((step) => [step.key, step.title]));
  const steps: RoutineStepStatsStep[] = [...currentKeys, ...earlierKeys].map((key) => {
    const stepIssues = issuesByKey.get(key) ?? [];
    return {
      key,
      title: titles.get(key) ?? null,
      runs: stepIssues.length,
      medianDurationMs: median(stepIssues.flatMap((issue) => doneDurationMs(issue) ?? [])),
      ...figuresOf(stepIssues),
    };
  });

  const oldest = Math.min(...[...runCreatedAt.values()].map((value) => value.getTime()));
  return {
    routineId: input.routineId,
    window: {
      runs: input.runs,
      scannedRuns: runCreatedAt.size,
      since: runCreatedAt.size > 0 ? new Date(oldest).toISOString() : null,
    },
    routine: {
      runs: issuesByRun.size,
      finishedRuns: runDurations.length,
      medianDurationMs: median(runDurations),
      ...figuresOf(allIssues),
    },
    steps,
  };
}

/**
 * Read-only step stats of one routine over its latest runs, derived from the rows the runs already
 * wrote: the step issue ids each run recorded, the step issues, their run usage records and their
 * review decisions. It sends one statement and writes nothing.
 * @param input.currentSteps The routine's steps now.
 */
export async function getRoutineStepStats(
  db: Db,
  input: RoutineStepStatsInput & { currentSteps: Pick<RoutineStep, "key" | "title">[] },
): Promise<RoutineStepStats> {
  const result = await db.execute(buildRoutineStepStatsQuery(input));
  return summarizeRoutineStepStats({
    routineId: input.routineId,
    runs: input.runs,
    currentSteps: input.currentSteps,
    rows: Array.from(result, parseRoutineStepStatsRow),
  });
}
