import { z } from "zod";

/**
 * Routine sources that can be skipped. A manual run is a person asking and a webhook is an
 * outside event Paperclip cannot see into, so both always run.
 */
export const ROUTINE_NOOP_SKIP_SOURCES = ["schedule", "api"] as const;
export type RoutineNoopSkipSource = (typeof ROUTINE_NOOP_SKIP_SOURCES)[number];

/**
 * Settings for skipping a routine run whose inputs match the last run and whose last
 * issue closed without changes. Stored at company, agent and routine level.
 * `skipUnchanged` is that level's choice for every source; `bySource` overrides it per
 * wake type and, as the most specific layer, beats the level-wide value of every level.
 * Unset means off (the pre-feature behavior).
 */
export const routineNoopSkipSettingsSchema = z.object({
  skipUnchanged: z.boolean().optional(),
  bySource: z.partialRecord(z.enum(ROUTINE_NOOP_SKIP_SOURCES), z.boolean()).optional(),
});
export type RoutineNoopSkipSettings = z.infer<typeof routineNoopSkipSettingsSchema>;
