import { z } from "zod";
import { routineStepIssueFieldsSchema } from "./validators/issue.js";

/** Most steps one routine may define; the same cap as the child-issue helper. */
export const MAX_ROUTINE_STEPS = 25;

/** The run payload key that holds the steps a run was created from and the issues it made. */
export const ROUTINE_STEPS_RUN_PAYLOAD_KEY = "routineSteps";

/** A step key is a short lowercase slug, unique inside one routine. */
export const ROUTINE_STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Rejection text for a conditional `after` entry. Conditions are not part of this release. */
export const ROUTINE_STEP_CONDITIONS_UNSUPPORTED_MESSAGE = "Step conditions (when) are not supported yet";

export const ROUTINE_STEP_AFTER_CONDITIONS = ["done", "cancelled"] as const;
export type RoutineStepAfterCondition = (typeof ROUTINE_STEP_AFTER_CONDITIONS)[number];

const routineStepKeySchema = z
  .string()
  .trim()
  .regex(ROUTINE_STEP_KEY_PATTERN, "Step keys are lowercase letters, digits, hyphens and underscores (max 40)");

/**
 * One predecessor of a step: a step key, or a key with the outcome it must have.
 * The object form is accepted by the type so it can be stored later, but
 * {@link routineStepsSchema} rejects it until conditions are supported.
 */
export const routineStepAfterEntrySchema = z.union([
  routineStepKeySchema,
  z.object({ step: routineStepKeySchema, when: z.enum(ROUTINE_STEP_AFTER_CONDITIONS) }).strict(),
]);
export type RoutineStepAfterEntry = z.infer<typeof routineStepAfterEntrySchema>;

export const routineStepSchema = routineStepIssueFieldsSchema
  .extend({
    key: routineStepKeySchema,
    title: z.string().trim().min(1).max(200),
    after: z.array(routineStepAfterEntrySchema).max(MAX_ROUTINE_STEPS).default([]),
  })
  .strict();
export type RoutineStep = z.infer<typeof routineStepSchema>;

/** The key of the step an `after` entry points to. */
export function routineStepAfterKey(entry: RoutineStepAfterEntry): string {
  return typeof entry === "string" ? entry : entry.step;
}

/** Keys of the steps that must finish before `step` starts, in the order they were written. */
export function routineStepPredecessorKeys(step: Pick<RoutineStep, "after">): string[] {
  return [...new Set(step.after.map(routineStepAfterKey))];
}

/**
 * Orders steps so every step comes after the steps it waits for. Steps that are
 * not ordered by `after` keep the order they were written in.
 * @throws Error when a step waits for an unknown key or the steps form a cycle.
 */
export function orderRoutineStepsTopologically<T extends Pick<RoutineStep, "key" | "after">>(steps: T[]): T[] {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const ordered: T[] = [];
  const placed = new Set<string>();
  let remaining = steps;
  while (remaining.length > 0) {
    const ready = remaining.filter((step) =>
      routineStepPredecessorKeys(step).every((key) => {
        if (!byKey.has(key)) throw new Error(`Step "${step.key}" waits for unknown step "${key}"`);
        return placed.has(key);
      }),
    );
    if (ready.length === 0) throw new Error("Routine steps contain a cycle");
    for (const step of ready) {
      ordered.push(step);
      placed.add(step.key);
    }
    remaining = remaining.filter((step) => !placed.has(step.key));
  }
  return ordered;
}

/**
 * Every text of the steps that can hold a `{{variable}}`. Routine variables are
 * kept in sync with the routine's templates, so these join the title and description.
 */
export function routineStepTemplateTexts(
  steps: ReadonlyArray<Pick<RoutineStep, "title" | "description" | "acceptanceCriteria">> | null | undefined,
): string[] {
  return (steps ?? []).flatMap((step) => [step.title, step.description, ...(step.acceptanceCriteria ?? [])]).filter(
    (text): text is string => typeof text === "string" && text.length > 0,
  );
}

/** The steps that start the run: those with nothing to wait for. */
export function routineStartingSteps<T extends Pick<RoutineStep, "after">>(steps: T[]): T[] {
  return steps.filter((step) => step.after.length === 0);
}

/**
 * The steps of one routine. Checks the structure only: unique keys, `after`
 * pointing at other steps, no cycles, no conditions. Agents and labels need the
 * database and are checked by the routine service.
 */
export const routineStepsSchema = z
  .array(routineStepSchema)
  .max(MAX_ROUTINE_STEPS, `A routine may define at most ${MAX_ROUTINE_STEPS} steps`)
  .superRefine((steps, ctx) => {
    const keys = new Set<string>();
    steps.forEach((step, index) => {
      if (keys.has(step.key)) {
        ctx.addIssue({ code: "custom", path: [index, "key"], message: `Duplicate step key "${step.key}"` });
      }
      keys.add(step.key);
    });
    let structurallyValid = true;
    steps.forEach((step, index) => {
      step.after.forEach((entry, afterIndex) => {
        if (typeof entry !== "string") {
          structurallyValid = false;
          ctx.addIssue({
            code: "custom",
            path: [index, "after", afterIndex],
            message: ROUTINE_STEP_CONDITIONS_UNSUPPORTED_MESSAGE,
          });
          return;
        }
        if (entry === step.key) {
          structurallyValid = false;
          ctx.addIssue({ code: "custom", path: [index, "after", afterIndex], message: "A step cannot wait for itself" });
        } else if (!keys.has(entry)) {
          structurallyValid = false;
          ctx.addIssue({
            code: "custom",
            path: [index, "after", afterIndex],
            message: `Step "${step.key}" waits for unknown step "${entry}"`,
          });
        }
      });
    });
    if (!structurallyValid || keys.size !== steps.length) return;
    try {
      orderRoutineStepsTopologically(steps);
    } catch {
      ctx.addIssue({ code: "custom", message: "Routine steps contain a cycle" });
    }
  });

/** What a run with steps records in its trigger payload, so the run stays self-contained. */
export const routineStepsRunPayloadSchema = z.object({
  steps: z.array(routineStepSchema),
  stepIssueIds: z.record(z.string(), z.string().guid()),
});
export type RoutineStepsRunPayload = z.infer<typeof routineStepsRunPayloadSchema>;

/** Reads the steps and issue ids a run recorded; `null` when the run had no steps. */
export function readRoutineStepsRunPayload(triggerPayload: unknown): RoutineStepsRunPayload | null {
  if (typeof triggerPayload !== "object" || triggerPayload === null) return null;
  if (!(ROUTINE_STEPS_RUN_PAYLOAD_KEY in triggerPayload)) return null;
  const parsed = routineStepsRunPayloadSchema.safeParse(triggerPayload[ROUTINE_STEPS_RUN_PAYLOAD_KEY]);
  return parsed.success ? parsed.data : null;
}
