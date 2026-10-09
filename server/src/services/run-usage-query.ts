import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { agents, projects, routines, runUsageRecords, type Db } from "@paperclipai/db";
import {
  OBSERVABILITY_DEFAULT_LIMIT,
  OBSERVABILITY_DEFAULT_WINDOW_DAYS,
  OBSERVABILITY_MAX_HOURLY_WINDOW_DAYS,
  OBSERVABILITY_MAX_WINDOW_DAYS,
  type ObservabilityFailureGroup,
  type ObservabilityFailureRow,
  type ObservabilityFailuresQuery,
  type ObservabilityFailuresResponse,
  type ObservabilityUsageGroup,
  type ObservabilityUsageQuery,
  type ObservabilityUsageResponse,
  type ObservabilityUsageRow,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";

const DAY_MS = 24 * 60 * 60_000;

type Dimension = ObservabilityUsageGroup | ObservabilityFailureGroup;

const DIMENSION_KEY: Record<Dimension, SQL> = {
  agent: sql`${runUsageRecords.agentId}::text`,
  routine: sql`${runUsageRecords.routineId}::text`,
  project: sql`${runUsageRecords.projectId}::text`,
  issue: sql`${runUsageRecords.issueId}::text`,
  adapter: sql`${runUsageRecords.adapterType}`,
  provider: sql`${runUsageRecords.provider}`,
  model: sql`${runUsageRecords.model}`,
  status: sql`${runUsageRecords.status}`,
  cause: sql`${runUsageRecords.causeFamily}`,
  day: sql`to_char(${runUsageRecords.day}, 'YYYY-MM-DD')`,
  hour: sql`to_char(date_trunc('hour', ${runUsageRecords.finishedAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"')`,
};

const countSchema = z.coerce.number().int().nonnegative();
const sumSchema = z.union([z.null(), z.coerce.number().int()]);

const rawRowSchema = z.object({
  group_key: z.string().nullable().optional(),
  runs: countSchema,
  all_runs: countSchema,
  input_tokens: sumSchema,
  cache_read_tokens: sumSchema,
  cache_write_tokens: sumSchema,
  output_tokens: sumSchema,
  reasoning_tokens: sumSchema,
  cost_micros: sumSchema,
  api_equivalent_micros: sumSchema,
  duration_ms: sumSchema,
  q_measured: countSchema,
  q_declared: countSchema,
  q_derived: countSchema,
  q_missing: countSchema,
});
type RawRow = z.infer<typeof rawRowSchema>;

interface Aggregates {
  select: SQL;
  runs: SQL;
  volume: SQL;
}

/**
 * Builds the aggregate columns of one report. With a `failureFilter`, every sum and count covers
 * only the records that match it, while `all_runs` still counts every record in the window.
 */
function buildAggregates(failureFilter: SQL | null): Aggregates {
  const only = failureFilter ? sql` filter (where ${failureFilter})` : sql``;
  const sum = (column: SQL): SQL => sql`sum(${column})${only}`;
  const quality = (value: string): SQL =>
    failureFilter
      ? sql`count(*) filter (where ${failureFilter} and ${runUsageRecords.usageQuality} = ${value})`
      : sql`count(*) filter (where ${runUsageRecords.usageQuality} = ${value})`;
  const runs = sql`count(*)${only}`;
  const select = sql.join(
    [
      sql`${runs} as runs`,
      sql`count(*) as all_runs`,
      sql`${sum(sql`${runUsageRecords.inputTokens}`)} as input_tokens`,
      sql`${sum(sql`${runUsageRecords.cacheReadTokens}`)} as cache_read_tokens`,
      sql`${sum(sql`${runUsageRecords.cacheWriteTokens}`)} as cache_write_tokens`,
      sql`${sum(sql`${runUsageRecords.outputTokens}`)} as output_tokens`,
      sql`${sum(sql`${runUsageRecords.reasoningTokens}`)} as reasoning_tokens`,
      sql`${sum(sql`${runUsageRecords.costMicros}`)} as cost_micros`,
      sql`${sum(sql`${runUsageRecords.apiEquivalentMicros}`)} as api_equivalent_micros`,
      sql`${sum(sql`${runUsageRecords.durationMs}`)} as duration_ms`,
      sql`${quality("measured")} as q_measured`,
      sql`${quality("declared")} as q_declared`,
      sql`${quality("derived")} as q_derived`,
      sql`${quality("missing")} as q_missing`,
    ],
    sql`, `,
  );
  const volume = sql`coalesce(${sum(sql`${runUsageRecords.inputTokens}`)}, 0)
    + coalesce(${sum(sql`${runUsageRecords.cacheReadTokens}`)}, 0)
    + coalesce(${sum(sql`${runUsageRecords.cacheWriteTokens}`)}, 0)
    + coalesce(${sum(sql`${runUsageRecords.outputTokens}`)}, 0)`;
  return { select, runs, volume };
}

function toUsageRow(raw: RawRow, key: string | null, label: string | null): ObservabilityUsageRow {
  return {
    key,
    label,
    runs: raw.runs,
    inputTokens: raw.input_tokens,
    cacheReadTokens: raw.cache_read_tokens,
    cacheWriteTokens: raw.cache_write_tokens,
    outputTokens: raw.output_tokens,
    reasoningTokens: raw.reasoning_tokens,
    costMicros: raw.cost_micros,
    apiEquivalentMicros: raw.api_equivalent_micros,
    durationMs: raw.duration_ms,
    quality: {
      measured: raw.q_measured,
      declared: raw.q_declared,
      derived: raw.q_derived,
      missing: raw.q_missing,
    },
  };
}

function parseInstant(value: string): Date {
  return new Date(value);
}

/**
 * Resolves the query window. `since` is inclusive, `until` is exclusive, and a plain date means
 * 00:00 UTC. With no `until` the window ends now. With no `since` it starts 7 days before `until`.
 *
 * @param query - The `since` and `until` values of the request.
 * @param dimension - The group dimension; hour buckets allow a shorter window.
 * @param now - The current time.
 * @returns The window as dates.
 * @throws A 400 error when the window is empty, reversed, or longer than allowed.
 */
export function resolveObservabilityWindow(
  query: { since?: string; until?: string },
  dimension: Dimension,
  now: Date,
): { since: Date; until: Date } {
  const until = query.until ? parseInstant(query.until) : now;
  const since = query.since
    ? parseInstant(query.since)
    : new Date(until.getTime() - OBSERVABILITY_DEFAULT_WINDOW_DAYS * DAY_MS);
  if (since.getTime() >= until.getTime()) {
    throw badRequest("'since' must be before 'until'");
  }
  const spanDays = (until.getTime() - since.getTime()) / DAY_MS;
  if (spanDays > OBSERVABILITY_MAX_WINDOW_DAYS) {
    throw badRequest(`the window may not be longer than ${OBSERVABILITY_MAX_WINDOW_DAYS} days`);
  }
  if (dimension === "hour" && spanDays > OBSERVABILITY_MAX_HOURLY_WINDOW_DAYS) {
    throw badRequest(`a window grouped by hour may not be longer than ${OBSERVABILITY_MAX_HOURLY_WINDOW_DAYS} days`);
  }
  return { since, until };
}

/** Input of one report: the company, the window, the group, and the already-built filters. */
export interface ReportInput {
  companyId: string;
  dimension: Dimension;
  since: Date;
  until: Date;
  limit: number;
  filters: Array<SQL | undefined>;
  failureFilter: SQL | null;
}

interface ReportResult {
  rows: Array<{ raw: RawRow; key: string | null; label: string | null }>;
  totals: RawRow;
  truncated: boolean;
}

/**
 * Builds the two statements of a report: the grouped rows and the whole-window totals. They are
 * exported so the query-plan script can run `EXPLAIN` on exactly the SQL that the service runs.
 *
 * @param input - The report input.
 * @returns The grouped statement, the totals statement, and whether the group is a time bucket.
 */
export function buildReportQueries(input: ReportInput): { grouped: SQL; total: SQL; timeBuckets: boolean } {
  const aggregates = buildAggregates(input.failureFilter);
  const where = and(
    eq(runUsageRecords.companyId, input.companyId),
    gte(runUsageRecords.finishedAt, input.since),
    lt(runUsageRecords.finishedAt, input.until),
    ...input.filters,
  );
  const timeBuckets = input.dimension === "day" || input.dimension === "hour";
  const having = input.failureFilter ? sql`having ${aggregates.runs} > 0` : sql``;
  const order = timeBuckets
    ? sql`group_key asc`
    : sql`${aggregates.volume} desc, ${aggregates.runs} desc, group_key asc nulls last`;
  const limitClause = timeBuckets ? sql`` : sql`limit ${input.limit + 1}`;
  return {
    grouped: sql`
      select ${DIMENSION_KEY[input.dimension]} as group_key, ${aggregates.select}
      from ${runUsageRecords}
      where ${where}
      group by 1
      ${having}
      order by ${order}
      ${limitClause}
    `,
    total: sql`select ${aggregates.select} from ${runUsageRecords} where ${where}`,
    timeBuckets,
  };
}

/**
 * Read-only reports over `run_usage_records`. Every query is limited to one company and one time
 * window, so the `(company_id, finished_at, run_id)` index serves the scan. The records hold
 * counts and closed values only, so no report can return prompt or output text.
 */
export function runUsageQueryService(db: Db) {
  async function labelsFor(companyId: string, dimension: Dimension, keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    if (dimension === "agent") {
      const found = await db
        .select({ id: agents.id, label: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, keys)));
      return new Map(found.map((row) => [row.id, row.label]));
    }
    if (dimension === "project") {
      const found = await db
        .select({ id: projects.id, label: projects.name })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, keys)));
      return new Map(found.map((row) => [row.id, row.label]));
    }
    if (dimension === "routine") {
      const found = await db
        .select({ id: routines.id, label: routines.title })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), inArray(routines.id, keys)));
      return new Map(found.map((row) => [row.id, row.label]));
    }
    return new Map();
  }

  async function report(input: ReportInput): Promise<ReportResult> {
    const queries = buildReportQueries(input);
    const timeBuckets = queries.timeBuckets;
    const [grouped, total] = await Promise.all([db.execute(queries.grouped), db.execute(queries.total)]);

    const parsed = Array.from(grouped, (row) => rawRowSchema.parse(row));
    const truncated = !timeBuckets && parsed.length > input.limit;
    const kept = truncated ? parsed.slice(0, input.limit) : parsed;
    const labels = await labelsFor(
      input.companyId,
      input.dimension,
      kept.flatMap((row) => (row.group_key ? [row.group_key] : [])),
    );
    const totals = rawRowSchema.parse(Array.from(total)[0]);
    return {
      rows: kept.map((raw) => {
        const key = raw.group_key ?? null;
        return { raw, key, label: key ? (labels.get(key) ?? null) : null };
      }),
      totals,
      truncated,
    };
  }

  /**
   * Tokens, cost and duration of a company's runs, grouped by one dimension.
   *
   * @param companyId - The company to report on. No other company's records are read.
   * @param query - The parsed query: group, window, filters and limit.
   * @param now - The current time, for the default window.
   * @returns The groups, the totals for the whole window, and whether the rows were cut at the limit.
   * @throws A 400 error when the window is not allowed.
   */
  async function usage(
    companyId: string,
    query: ObservabilityUsageQuery,
    now: Date = new Date(),
  ): Promise<ObservabilityUsageResponse> {
    const { since, until } = resolveObservabilityWindow(query, query.groupBy, now);
    const result = await report({
      companyId,
      dimension: query.groupBy,
      since,
      until,
      limit: query.limit ?? OBSERVABILITY_DEFAULT_LIMIT,
      filters: [
        query.agentId ? eq(runUsageRecords.agentId, query.agentId) : undefined,
        query.routineId ? eq(runUsageRecords.routineId, query.routineId) : undefined,
        query.projectId ? eq(runUsageRecords.projectId, query.projectId) : undefined,
        query.issueId ? eq(runUsageRecords.issueId, query.issueId) : undefined,
        query.adapterType ? eq(runUsageRecords.adapterType, query.adapterType) : undefined,
        query.provider ? eq(runUsageRecords.provider, query.provider) : undefined,
        query.model ? eq(runUsageRecords.model, query.model) : undefined,
        query.status ? eq(runUsageRecords.status, query.status) : undefined,
      ],
      failureFilter: null,
    });
    return {
      groupBy: query.groupBy,
      since: since.toISOString(),
      until: until.toISOString(),
      rows: result.rows.map((row) => toUsageRow(row.raw, row.key, row.label)),
      totals: toUsageRow(result.totals, null, null),
      truncated: result.truncated,
    };
  }

  /**
   * Failed runs of a company, grouped by one dimension. A failure is a record with a failure cause.
   * Sums cover only the failed runs. `allRuns` counts every run in the group, so a caller can
   * compute a failure rate; it is null when grouped by cause, where it has no meaning.
   *
   * @param companyId - The company to report on. No other company's records are read.
   * @param query - The parsed query: group, window, filters and limit.
   * @param now - The current time, for the default window.
   * @returns The groups, the totals for the whole window, and whether the rows were cut at the limit.
   * @throws A 400 error when the window is not allowed.
   */
  async function failures(
    companyId: string,
    query: ObservabilityFailuresQuery,
    now: Date = new Date(),
  ): Promise<ObservabilityFailuresResponse> {
    const { since, until } = resolveObservabilityWindow(query, query.groupBy, now);
    const result = await report({
      companyId,
      dimension: query.groupBy,
      since,
      until,
      limit: query.limit ?? OBSERVABILITY_DEFAULT_LIMIT,
      filters: [
        query.agentId ? eq(runUsageRecords.agentId, query.agentId) : undefined,
        query.routineId ? eq(runUsageRecords.routineId, query.routineId) : undefined,
        query.projectId ? eq(runUsageRecords.projectId, query.projectId) : undefined,
        query.issueId ? eq(runUsageRecords.issueId, query.issueId) : undefined,
        query.adapterType ? eq(runUsageRecords.adapterType, query.adapterType) : undefined,
        query.provider ? eq(runUsageRecords.provider, query.provider) : undefined,
        query.model ? eq(runUsageRecords.model, query.model) : undefined,
      ],
      failureFilter: query.cause
        ? sql`${runUsageRecords.causeFamily} = ${query.cause}`
        : sql`${runUsageRecords.causeFamily} is not null`,
    });
    const toFailureRow = (raw: RawRow, key: string | null, label: string | null): ObservabilityFailureRow => ({
      ...toUsageRow(raw, key, label),
      allRuns: query.groupBy === "cause" ? null : raw.all_runs,
    });
    return {
      groupBy: query.groupBy,
      since: since.toISOString(),
      until: until.toISOString(),
      rows: result.rows.map((row) => toFailureRow(row.raw, row.key, row.label)),
      totals: { ...toUsageRow(result.totals, null, null), allRuns: result.totals.all_runs },
      truncated: result.truncated,
    };
  }

  return { usage, failures };
}

export type RunUsageQueryService = ReturnType<typeof runUsageQueryService>;
