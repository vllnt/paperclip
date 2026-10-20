import { z } from "zod";

/** Routine runs the step stats read when a request gives no `runs`. */
export const ROUTINE_STEP_STATS_DEFAULT_RUNS = 50;
/** The most routine runs one step stats request may read. */
export const ROUTINE_STEP_STATS_MAX_RUNS = 100;

/** Query string of `GET /routines/:id/step-stats`. Unknown keys are rejected so a typo cannot change the window. */
export const routineStepStatsQuerySchema = z.strictObject({
  runs: z.coerce.number().int().min(1).max(ROUTINE_STEP_STATS_MAX_RUNS).default(ROUTINE_STEP_STATS_DEFAULT_RUNS),
});
export type RoutineStepStatsQuery = z.infer<typeof routineStepStatsQuerySchema>;

const countSchema = z.number().int().nonnegative();
/** A sum is null when no agent run reported it, so "not reported" stays different from zero. */
const sumSchema = z.number().int().nullable();
/** A rate is null when nothing it divides by exists yet. */
const rateSchema = z.number().min(0).max(1).nullable();
const durationSchema = z.number().int().nonnegative().nullable();

/** How a set of step issues ended, what their agent runs used, and how their reviews went. */
export const routineStepStatsFiguresSchema = z.object({
  /** Step issues closed as done. */
  done: countSchema,
  /** Step issues closed as cancelled, including steps that a condition skipped. */
  cancelled: countSchema,
  /** Step issues not closed yet. */
  open: countSchema,
  /** `cancelled / (done + cancelled)`. */
  cancelledRate: rateSchema,
  /** Finished agent runs on the step issues that have a run usage record. */
  agentRuns: countSchema,
  inputTokens: sumSchema,
  cacheReadTokens: sumSchema,
  outputTokens: sumSchema,
  /** Cost in micro-USD. */
  costMicros: sumSchema,
  /** Total time the agent runs took. */
  agentDurationMs: sumSchema,
  /** Review and approval decisions recorded on the step issues. */
  reviewRounds: countSchema,
  /** Decisions that asked for changes. */
  changesRequested: countSchema,
  /** `changesRequested / reviewRounds`. */
  changesRequestedRate: rateSchema,
});
export type RoutineStepStatsFigures = z.infer<typeof routineStepStatsFiguresSchema>;

/** Figures for one step key over the runs in the window. */
export const routineStepStatsStepSchema = routineStepStatsFiguresSchema.extend({
  key: z.string(),
  /** The step's title in the routine's current steps; null for a key that only earlier runs had. */
  title: z.string().nullable(),
  /** Routine runs in the window that created this step. */
  runs: countSchema,
  /** Median time from the step's first start (or its creation) to done, over its done issues. */
  medianDurationMs: durationSchema,
});
export type RoutineStepStatsStep = z.infer<typeof routineStepStatsStepSchema>;

/** Figures for every step of the routine over the runs in the window. */
export const routineStepStatsRoutineSchema = routineStepStatsFiguresSchema.extend({
  /** Routine runs in the window that created steps. */
  runs: countSchema,
  /** Of those, the runs whose steps are all closed. */
  finishedRuns: countSchema,
  /** Median time from a finished run's first step creation to its last step closing. */
  medianDurationMs: durationSchema,
});
export type RoutineStepStatsRoutine = z.infer<typeof routineStepStatsRoutineSchema>;

/** Response of `GET /routines/:id/step-stats`: read-only figures derived from rows the runs already wrote. */
export const routineStepStatsSchema = z.object({
  routineId: z.string(),
  window: z.object({
    /** The most recent routine runs the request asked to read. */
    runs: countSchema,
    /** Routine runs read, with or without steps; fewer than `runs` when the routine has fewer. */
    scannedRuns: countSchema,
    /** Creation time of the oldest run read; null when the routine has no run. */
    since: z.string().nullable(),
  }),
  routine: routineStepStatsRoutineSchema,
  /** The routine's current steps in their written order, then keys only earlier runs had, by key. */
  steps: z.array(routineStepStatsStepSchema),
});
export type RoutineStepStats = z.infer<typeof routineStepStatsSchema>;
