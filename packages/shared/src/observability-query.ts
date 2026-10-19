import { z } from "zod";
import { RUN_FAILURE_CAUSES } from "./run-failure-cause.js";
import { RUN_USAGE_TERMINAL_STATUSES } from "./run-usage-record.js";

/** Dimensions that `GET /companies/:companyId/observability/usage` can group by. */
export const OBSERVABILITY_USAGE_GROUPS = [
  "agent",
  "routine",
  "project",
  "issue",
  "adapter",
  "provider",
  "model",
  "status",
  "day",
  "hour",
] as const;
export type ObservabilityUsageGroup = (typeof OBSERVABILITY_USAGE_GROUPS)[number];

/** Dimensions that `GET /companies/:companyId/observability/failures` can group by. */
export const OBSERVABILITY_FAILURE_GROUPS = [
  "cause",
  "agent",
  "routine",
  "project",
  "issue",
  "adapter",
  "provider",
  "model",
  "day",
  "hour",
] as const;
export type ObservabilityFailureGroup = (typeof OBSERVABILITY_FAILURE_GROUPS)[number];

/** The window is the last 7 days when a query gives neither `since` nor `until`. */
export const OBSERVABILITY_DEFAULT_WINDOW_DAYS = 7;
/** The longest window one query may cover. */
export const OBSERVABILITY_MAX_WINDOW_DAYS = 366;
/** The longest window for `groupBy=hour`, so one response stays below 744 buckets. */
export const OBSERVABILITY_MAX_HOURLY_WINDOW_DAYS = 31;
/** Rows returned when a query gives no `limit`. */
export const OBSERVABILITY_DEFAULT_LIMIT = 50;
/** The most rows one response may hold. Day and hour groups are not cut by this limit. */
export const OBSERVABILITY_MAX_LIMIT = 500;

/** A full ISO-8601 instant, or a plain date that means 00:00 UTC of that day. */
const instantSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const identifierSchema = z.string().min(1).max(80);

const filterShape = {
  since: instantSchema.optional(),
  until: instantSchema.optional(),
  agentId: z.string().uuid().optional(),
  routineId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  adapterType: identifierSchema.optional(),
  provider: identifierSchema.optional(),
  model: identifierSchema.optional(),
  limit: z.coerce.number().int().min(1).max(OBSERVABILITY_MAX_LIMIT).optional(),
};

/** Query string of the usage report. Unknown keys are rejected so a typo cannot widen a result. */
export const observabilityUsageQuerySchema = z.strictObject({
  ...filterShape,
  groupBy: z.enum(OBSERVABILITY_USAGE_GROUPS).default("agent"),
  status: z.enum(RUN_USAGE_TERMINAL_STATUSES).optional(),
});
export type ObservabilityUsageQuery = z.infer<typeof observabilityUsageQuerySchema>;

/** Query string of the failures report. A failure is a record with a failure cause. */
export const observabilityFailuresQuerySchema = z.strictObject({
  ...filterShape,
  groupBy: z.enum(OBSERVABILITY_FAILURE_GROUPS).default("cause"),
  cause: z.enum(RUN_FAILURE_CAUSES).optional(),
});
export type ObservabilityFailuresQuery = z.infer<typeof observabilityFailuresQuerySchema>;

const sumSchema = z.number().int().nullable();

/**
 * One group of the usage report. A token or cost sum is null when no run in the group reported
 * that class, so "not reported" stays different from zero. `quality` counts runs by how far the
 * token counts can be trusted.
 */
export const observabilityUsageRowSchema = z.object({
  key: z.string().nullable(),
  label: z.string().nullable(),
  runs: z.number().int().nonnegative(),
  inputTokens: sumSchema,
  cacheReadTokens: sumSchema,
  cacheWriteTokens: sumSchema,
  outputTokens: sumSchema,
  reasoningTokens: sumSchema,
  costMicros: sumSchema,
  apiEquivalentMicros: sumSchema,
  durationMs: sumSchema,
  quality: z.object({
    measured: z.number().int().nonnegative(),
    declared: z.number().int().nonnegative(),
    derived: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
  }),
});
export type ObservabilityUsageRow = z.infer<typeof observabilityUsageRowSchema>;

/** A failures row adds the count of all runs in the group; it is null when grouped by cause. */
export const observabilityFailureRowSchema = observabilityUsageRowSchema.extend({
  allRuns: z.number().int().nonnegative().nullable(),
});
export type ObservabilityFailureRow = z.infer<typeof observabilityFailureRowSchema>;

const windowShape = {
  since: z.string(),
  until: z.string(),
  truncated: z.boolean(),
};

/** Response of the usage report. `totals` covers the whole window, not only the returned rows. */
export const observabilityUsageResponseSchema = z.object({
  groupBy: z.enum(OBSERVABILITY_USAGE_GROUPS),
  ...windowShape,
  rows: z.array(observabilityUsageRowSchema),
  totals: observabilityUsageRowSchema,
});
export type ObservabilityUsageResponse = z.infer<typeof observabilityUsageResponseSchema>;

/** Response of the failures report. */
export const observabilityFailuresResponseSchema = z.object({
  groupBy: z.enum(OBSERVABILITY_FAILURE_GROUPS),
  ...windowShape,
  rows: z.array(observabilityFailureRowSchema),
  totals: observabilityFailureRowSchema,
});
export type ObservabilityFailuresResponse = z.infer<typeof observabilityFailuresResponseSchema>;
