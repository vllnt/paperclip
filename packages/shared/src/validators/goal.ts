import { z } from "zod";
import { GOAL_HORIZONS, GOAL_KINDS, GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";
import { objectWithoutDefaults } from "./partial.js";
import { MISSION_MAX_LENGTH } from "./onboarding-seed.js";

/**
 * The longest goal title. The onboarding seed puts the first line of a company's mission into the
 * company goal's title, so a title must fit a whole mission. Agents receive focus titles cut much shorter.
 */
const GOAL_TITLE_MAX_LENGTH = MISSION_MAX_LENGTH;

const goalTargetDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number(value.slice(0, 4)) >= 1 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, "Use a real calendar date");

export const createGoalSchema = z.object({
  title: z.string().min(1).max(GOAL_TITLE_MAX_LENGTH),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().guid().optional().nullable(),
  ownerAgentId: z.string().guid().optional().nullable(),
  kind: z.enum(GOAL_KINDS).optional().default("goal"),
  horizon: z.enum(GOAL_HORIZONS).optional().nullable(),
  /** Calendar date, `YYYY-MM-DD`. */
  targetDate: goalTargetDateSchema.optional().nullable(),
  /** How to tell the goal is reached, for example "open pull requests = 0". */
  successCriteria: z.string().trim().max(2000).optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = objectWithoutDefaults(createGoalSchema).partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
