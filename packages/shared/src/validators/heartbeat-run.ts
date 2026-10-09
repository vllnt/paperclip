import { z } from "zod";
import { HEARTBEAT_RUN_STATUSES } from "../constants.js";

/** The longest window `GET /api/companies/:companyId/heartbeat-runs/stats` accepts. */
export const HEARTBEAT_RUN_STATS_MAX_WINDOW_DAYS = 90;

/** A comma-separated query value, such as `status=failed,timed_out`. */
function commaSeparated<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item).min(1).max(20));
}

const isoDateTime = z.string().datetime({ offset: true });

/**
 * Filters for `GET /api/companies/:companyId/heartbeat-runs`. `since` and
 * `until` bound the run's creation time. `limit` and `summary` keep their
 * existing lenient parsing in the route, so unknown keys pass through.
 */
export const heartbeatRunListQuerySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    status: commaSeparated(z.enum(HEARTBEAT_RUN_STATUSES)).optional(),
    errorCode: commaSeparated(z.string().min(1).max(200)).optional(),
    since: isoDateTime.optional(),
    until: isoDateTime.optional(),
  })
  .passthrough();

export type HeartbeatRunListQuery = z.infer<typeof heartbeatRunListQuerySchema>;

/** Query for `GET /api/companies/:companyId/heartbeat-runs/stats`. The window defaults to the last 24 hours. */
export const heartbeatRunStatsQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  since: isoDateTime.optional(),
  until: isoDateTime.optional(),
});

export type HeartbeatRunStatsQuery = z.infer<typeof heartbeatRunStatsQuerySchema>;

const runCountsSchema = z.object({
  /** Runs created in the window. */
  runs: z.number().int(),
  /** Runs that finished: succeeded, interrupted, failed, cancelled or timed out. */
  terminal: z.number().int(),
  succeeded: z.number().int(),
  /** Runs that failed, were cancelled or timed out. */
  unsuccessful: z.number().int(),
  byStatus: z.record(z.enum(HEARTBEAT_RUN_STATUSES), z.number().int()),
});

export const heartbeatRunAgentStatsSchema = runCountsSchema.extend({
  agentId: z.string(),
  name: z.string(),
  status: z.string(),
  /** Runs counted against `maxDailyRuns` in the current UTC day, exactly as the cap counts them. */
  runsToday: z.number().int(),
  maxDailyRuns: z.number().int().nullable(),
  remainingToday: z.number().int().nullable(),
  capReached: z.boolean(),
});

export const heartbeatRunStatsSchema = z.object({
  companyId: z.string(),
  window: z.object({ since: z.string(), until: z.string() }),
  /** The UTC day that `runsToday` and the daily run cap count. */
  dailyCapWindow: z.object({ start: z.string(), end: z.string() }),
  totals: runCountsSchema,
  topErrorCodes: z.array(z.object({ errorCode: z.string(), count: z.number().int() })),
  agents: z.array(heartbeatRunAgentStatsSchema),
});

export type HeartbeatRunAgentStats = z.infer<typeof heartbeatRunAgentStatsSchema>;
export type HeartbeatRunStats = z.infer<typeof heartbeatRunStatsSchema>;
