import { z } from "zod";
import { routineStepIssueFieldsSchema } from "./validators/issue.js";

/** Most steps one routine may define; the same cap as the child-issue helper. */
export const MAX_ROUTINE_STEPS = 25;

/**
 * Origin kinds of the issues one routine run creates: its root and each of its steps. Both carry the
 * routine's id as `originId`, so anything a routine configures for its run applies to both.
 */
export const ROUTINE_RUN_ISSUE_ORIGIN_KINDS = ["routine_execution", "routine_step"] as const;

/** Whether an issue with this origin kind was created by a routine run, as its root or as one of its steps. */
export function isRoutineRunIssueOriginKind(originKind: string | null | undefined): boolean {
  return ROUTINE_RUN_ISSUE_ORIGIN_KINDS.some((kind) => kind === originKind);
}

/** The run payload key that holds the steps a run was created from and the issues it made. */
export const ROUTINE_STEPS_RUN_PAYLOAD_KEY = "routineSteps";

/** A step key is a short lowercase slug, unique inside one routine. */
export const ROUTINE_STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const routineStepKeySchema = z
  .string()
  .trim()
  .regex(ROUTINE_STEP_KEY_PATTERN, "Step keys are lowercase letters, digits, hyphens and underscores (max 40)");

/**
 * The outcomes a conditional `after` entry can wait for: the terminal status of the step it names.
 * On a step with a review or approval stage, `done` means approved and `cancelled` means rejected
 * or stopped by the board; a reviewer asking for changes does not end the step.
 */
export const ROUTINE_STEP_CONDITIONS = ["done", "cancelled"] as const;
export type RoutineStepCondition = (typeof ROUTINE_STEP_CONDITIONS)[number];

/** A conditional `after` entry: wait for `step`, and run only when it ends with the `when` outcome. */
export const routineStepConditionalAfterSchema = z
  .object({
    step: routineStepKeySchema,
    when: z.enum(ROUTINE_STEP_CONDITIONS),
  })
  .strict();

/** One `after` entry: a step key (wait for it to be done), or a step key with a condition. */
export const routineStepAfterEntrySchema = z.union([routineStepKeySchema, routineStepConditionalAfterSchema]);
export type RoutineStepAfterEntry = z.infer<typeof routineStepAfterEntrySchema>;

export const routineStepSchema = routineStepIssueFieldsSchema
  .extend({
    key: routineStepKeySchema,
    title: z.string().trim().min(1).max(200),
    after: z.array(routineStepAfterEntrySchema).max(MAX_ROUTINE_STEPS).default([]),
  })
  .strict();
export type RoutineStep = z.infer<typeof routineStepSchema>;

/** One edge into a step: the step it waits for, and the outcome it needs (`null` for a plain edge). */
export interface RoutineStepEdge {
  step: string;
  when: RoutineStepCondition | null;
}

/** The key an `after` entry names. */
export function routineStepAfterKey(entry: RoutineStepAfterEntry): string {
  return typeof entry === "string" ? entry : entry.step;
}

/**
 * The edges into `step`, one per predecessor, in the order they were written. A predecessor named
 * twice keeps its first entry; the schema refuses two entries for one step with different conditions.
 */
export function routineStepEdges(step: Pick<RoutineStep, "after">): RoutineStepEdge[] {
  const edges = new Map<string, RoutineStepEdge>();
  for (const entry of step.after) {
    const key = routineStepAfterKey(entry);
    if (!edges.has(key)) edges.set(key, { step: key, when: typeof entry === "string" ? null : entry.when });
  }
  return [...edges.values()];
}

/** Whether any step waits for a predecessor's outcome through a conditional `after` entry. */
export function routineStepsHaveConditions(steps: ReadonlyArray<Pick<RoutineStep, "after">>): boolean {
  return steps.some((step) => step.after.some((entry) => typeof entry !== "string"));
}

/** Keys of the steps that must finish before `step` starts, in the order they were written. */
export function routineStepPredecessorKeys(step: Pick<RoutineStep, "after">): string[] {
  return routineStepEdges(step).map((edge) => edge.step);
}

/**
 * Orders steps in layers: first the steps with nothing to wait for, then the steps whose
 * predecessors are all placed, and so on. Every step comes after the steps it waits for,
 * and the steps of one layer keep the order they were written in.
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

/** The text of the comment on a step that the dead-path rule skips. */
export const ROUTINE_STEP_SKIPPED_COMMENT = "Skipped: condition not met";

/** What the dead-path rule says about one run, from the steps it recorded and their current statuses. */
export interface RoutineStepRunEvaluation {
  /** Blocked steps to cancel as skipped now, in topological order: every edge into them is dead. */
  skip: string[];
  /**
   * Predecessors to drop from the blocker set of each step that is still open, by step key. A cancelled
   * predecessor never resolves a blocker, so an edge it ends (a condition it met or failed, or a skip)
   * must leave the set for the step to start.
   */
  release: Record<string, string[]>;
  /** Steps the run's root stops waiting for: skipped steps, and cancelled steps whose every outgoing edge has a condition. */
  releaseFromRoot: string[];
  /** True when nothing in the run can move on its own any more. */
  stalled: boolean;
}

type StepState = "done" | "cancelled" | "skipped" | "live" | "stuck";
type EdgeState = "met" | "dead" | "held" | "pending";

function edgeState(edge: RoutineStepEdge, source: StepState | undefined): EdgeState {
  switch (source) {
    case "skipped":
      return "dead";
    case "done":
      return edge.when === "cancelled" ? "dead" : "met";
    case "cancelled":
      if (edge.when === "cancelled") return "met";
      return edge.when === "done" ? "dead" : "held";
    case "stuck":
      return "held";
    default:
      return "pending";
  }
}

/**
 * The dead-path rule for one run of a routine with steps. It reads only the recorded steps and the
 * current statuses, so evaluating it again after its changes are applied finds nothing more to do.
 *
 * - An edge is dead when its `when` does not match its source's outcome, or its source was skipped.
 * - A blocked step whose edges are all dead is skipped, and the rule continues downstream.
 * - A plain edge from a cancelled step is held, not dead: the step stays visibly blocked, so a cancel
 *   never cascades without a condition that asks for it.
 * - The root waits for every step except skipped ones and cancelled ones whose every outgoing edge has
 *   a condition: such a cancel is an outcome the routine handles.
 *
 * The run is stalled when no step can still move and the root waits for a step that will never
 * finish. A step whose status is missing or open (other than blocked) counts as live, so a missing
 * issue never frees the routine.
 * @param statusesByKey Issue status of each step, by step key.
 * @param options.heldByPeople Blocked steps whose block a person owns. Only that person may end the
 * block, so the rule never skips them and counts them as live work.
 */
export function evaluateRoutineStepRun(
  steps: ReadonlyArray<Pick<RoutineStep, "key" | "after">>,
  statusesByKey: Readonly<Record<string, string>>,
  options: { heldByPeople?: ReadonlySet<string> } = {},
): RoutineStepRunEvaluation {
  let ordered: Array<Pick<RoutineStep, "key" | "after">>;
  try {
    ordered = orderRoutineStepsTopologically([...steps]);
  } catch {
    // A recorded graph that is not valid any more cannot be reasoned about: keep the run live and change nothing.
    return { skip: [], release: {}, releaseFromRoot: [], stalled: false };
  }
  const states = new Map<string, StepState>();
  const skip: string[] = [];
  const release: Record<string, string[]> = {};
  const conditionalOnlyOutgoing = new Map<string, boolean>();
  for (const step of steps) {
    for (const edge of routineStepEdges(step)) {
      const previous = conditionalOnlyOutgoing.get(edge.step) ?? true;
      conditionalOnlyOutgoing.set(edge.step, previous && edge.when !== null);
    }
  }

  for (const step of ordered) {
    const status = statusesByKey[step.key];
    const edges = routineStepEdges(step).map((edge) => ({ edge, state: edgeState(edge, states.get(edge.step)) }));
    const allDead = edges.length > 0 && edges.every(({ state }) => state === "dead");
    if (status === "done") {
      states.set(step.key, "done");
      continue;
    }
    if (status === "cancelled") {
      states.set(step.key, allDead ? "skipped" : "cancelled");
      continue;
    }
    const heldByPerson = options.heldByPeople?.has(step.key) === true;
    if (status === "blocked" && allDead && !heldByPerson) {
      skip.push(step.key);
      states.set(step.key, "skipped");
      continue;
    }
    if (status !== undefined) {
      const released = edges.flatMap(({ edge, state }) => {
        const source = states.get(edge.step);
        return state !== "held" && (source === "cancelled" || source === "skipped") ? [edge.step] : [];
      });
      if (released.length > 0) release[step.key] = released;
    }
    const stuck = status === "blocked" && !heldByPerson && edges.some(({ state }) => state === "held");
    states.set(step.key, stuck ? "stuck" : "live");
  }

  const releaseFromRoot = steps.flatMap((step) => {
    const state = states.get(step.key);
    if (state === "skipped") return [step.key];
    return state === "cancelled" && conditionalOnlyOutgoing.get(step.key) === true ? [step.key] : [];
  });
  const releasedFromRoot = new Set(releaseFromRoot);
  const anyLive = steps.some((step) => states.get(step.key) === "live");
  const rootWaitsForever = steps.some((step) => {
    const state = states.get(step.key);
    return (state === "cancelled" || state === "stuck") && !releasedFromRoot.has(step.key);
  });
  return { skip, release, releaseFromRoot, stalled: !anyLive && rootWaitsForever };
}

/**
 * Whether the steps of one run can no longer move on their own ({@link evaluateRoutineStepRun}).
 *
 * Without conditions this holds when no step has work left, at least one step was cancelled, and
 * every blocked step waits, directly or through other blocked steps, for a cancelled one: a cancelled
 * step never resolves a blocker, so its dependents and the run's root stay blocked for good. With
 * conditions, steps the dead-path rule skips count as finished, and a cancel that the routine handles
 * no longer holds the root.
 * @param statusesByKey Issue status of each step, by step key.
 */
export function isRoutineStepRunStalled(
  steps: ReadonlyArray<Pick<RoutineStep, "key" | "after">>,
  statusesByKey: Readonly<Record<string, string>>,
): boolean {
  return evaluateRoutineStepRun(steps, statusesByKey).stalled;
}

/**
 * The steps of one routine. Checks the structure only: unique keys, `after`
 * pointing at other steps, no cycles. Agents and labels need the
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
      const conditionByKey = new Map<string, RoutineStepCondition | null>();
      step.after.forEach((entry, afterIndex) => {
        const key = routineStepAfterKey(entry);
        const when = typeof entry === "string" ? null : entry.when;
        if (key === step.key) {
          structurallyValid = false;
          ctx.addIssue({ code: "custom", path: [index, "after", afterIndex], message: "A step cannot wait for itself" });
        } else if (!keys.has(key)) {
          structurallyValid = false;
          ctx.addIssue({
            code: "custom",
            path: [index, "after", afterIndex],
            message: `Step "${step.key}" waits for unknown step "${key}"`,
          });
        } else if (conditionByKey.has(key) && conditionByKey.get(key) !== when) {
          ctx.addIssue({
            code: "custom",
            path: [index, "after", afterIndex],
            message: `Step "${step.key}" waits for step "${key}" more than once with different conditions`,
          });
        }
        if (!conditionByKey.has(key)) conditionByKey.set(key, when);
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
