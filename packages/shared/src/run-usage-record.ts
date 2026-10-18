import { z } from "zod";

/**
 * Version of the `run_usage_records` row shape. A worker pass replaces a stored record only when
 * its version is lower than this one, so a taxonomy or mapping change is a version bump followed
 * by a re-derive.
 */
export const RUN_USAGE_RECORD_SCHEMA_VERSION = 1;

/**
 * Lowest record `schema_version` that has already taken everything it needs from the run's events
 * and log. The session-warehouse prune guard may delete a run's events and log only when the run
 * has a record at or above this version. Slice 1a reads no events, so it equals the first version;
 * a later slice that starts reading events raises this together with the schema version.
 */
export const RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION = 1;

/**
 * How trustworthy a record's token counts are. `measured` came straight from the provider,
 * `declared` is an adapter claim that is not yet verified, `derived` was computed by the server
 * (for example a session baseline was subtracted), and `missing` means the run reported none.
 */
export const RUN_USAGE_QUALITIES = ["measured", "declared", "derived", "missing"] as const;
export type RunUsageQuality = (typeof RUN_USAGE_QUALITIES)[number];

/** Which code path wrote a record. */
export const RUN_USAGE_RECORD_SOURCES = ["derived", "backfill"] as const;
export type RunUsageRecordSource = (typeof RUN_USAGE_RECORD_SOURCES)[number];

/** Terminal heartbeat run statuses: the only runs that get a usage record. */
export const RUN_USAGE_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
export type RunUsageTerminalStatus = (typeof RUN_USAGE_TERMINAL_STATUSES)[number];

/**
 * Collector health for one company, returned by `GET /companies/:companyId/observability/health`.
 * Counts cover terminal runs that finished more than the settle delay ago. Times are ISO-8601 UTC.
 */
export const observabilityHealthSchema = z.object({
  /** The record schema version this server writes. */
  schemaVersion: z.number().int(),
  /** Settled terminal runs created in the last 24 hours. */
  terminalRuns24h: z.number().int().nonnegative(),
  /** Of those, how many have a usage record. */
  derivedRuns24h: z.number().int().nonnegative(),
  /** Settled terminal runs created in the last 48 hours that have no record yet. */
  pendingRuns: z.number().int().nonnegative(),
  /** Creation time of the oldest pending run, or null when none is pending. */
  oldestPendingAt: z.string().nullable(),
  /** Records written more than 48 hours after their run was created (found by the daily sweep). */
  lateRecords30d: z.number().int().nonnegative(),
  /** Settled terminal runs created 2 to 30 days ago that still have no record. */
  unreconciledRuns30d: z.number().int().nonnegative(),
  /** When the newest record was written, or null when the company has none. */
  lastDerivedAt: z.string().nullable(),
});

export type ObservabilityHealth = z.infer<typeof observabilityHealthSchema>;
