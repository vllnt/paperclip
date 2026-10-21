import { z } from "zod";
import { routineStepIssueFieldsSchema } from "./validators/issue.js";
import { multilineTextSchema } from "./validators/text.js";

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

/** Rounds a step may send work back on one edge when it sets no `maxSendBacks`. */
export const DEFAULT_ROUTINE_STEP_MAX_SEND_BACKS = 2;
/** The highest `maxSendBacks` a step may set. */
export const MAX_ROUTINE_STEP_SEND_BACKS = 10;

export const routineStepSchema = routineStepIssueFieldsSchema
  .extend({
    key: routineStepKeySchema,
    title: z.string().trim().min(1).max(200),
    after: z.array(routineStepKeySchema).max(MAX_ROUTINE_STEPS).default([]),
    /** Earlier steps (ones this step waits for, directly or not) that this step may send work back to. */
    sendBackTo: z.array(routineStepKeySchema).max(MAX_ROUTINE_STEPS).optional(),
    /** Most agent send-backs on each `sendBackTo` edge; {@link DEFAULT_ROUTINE_STEP_MAX_SEND_BACKS} when unset. */
    maxSendBacks: z.number().int().min(1).max(MAX_ROUTINE_STEP_SEND_BACKS).optional(),
  })
  .strict();
export type RoutineStep = z.infer<typeof routineStepSchema>;

/** Keys of the steps that must finish before `step` starts, in the order they were written. */
export function routineStepPredecessorKeys(step: Pick<RoutineStep, "after">): string[] {
  return [...new Set(step.after)];
}

/**
 * Keys of every step that `key` waits for, directly or through other steps.
 * @returns an empty set for an unknown key; unknown keys inside `after` are skipped.
 */
export function routineStepAncestorKeys(
  steps: ReadonlyArray<Pick<RoutineStep, "key" | "after">>,
  key: string,
): Set<string> {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const ancestors = new Set<string>();
  const pending = [...(byKey.get(key)?.after ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || ancestors.has(next) || !byKey.has(next)) continue;
    ancestors.add(next);
    pending.push(...(byKey.get(next)?.after ?? []));
  }
  return ancestors;
}

/**
 * The steps that run again when `fromKey` sends work back to `toKey`, in written order, besides the
 * target itself: every step that waits for `toKey` and that `fromKey` waits for, plus `fromKey`. A step
 * on a parallel branch, one that waits for `toKey` but not on the way to `fromKey`, is not part of it.
 * @example
 * // implement -> review -> qa, and implement -> docs
 * routineStepSendBackLoopKeys(steps, "qa", "implement"); // ["review", "qa"]
 */
export function routineStepSendBackLoopKeys(
  steps: ReadonlyArray<Pick<RoutineStep, "key" | "after">>,
  fromKey: string,
  toKey: string,
): string[] {
  const beforeSender = routineStepAncestorKeys(steps, fromKey);
  return steps
    .filter(
      (step) =>
        step.key === fromKey || (beforeSender.has(step.key) && routineStepAncestorKeys(steps, step.key).has(toKey)),
    )
    .map((step) => step.key);
}

/** The rounds cap on each send-back edge of `step`. */
export function routineStepMaxSendBacks(step: Pick<RoutineStep, "maxSendBacks">): number {
  return step.maxSendBacks ?? DEFAULT_ROUTINE_STEP_MAX_SEND_BACKS;
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

/**
 * Whether the steps of one run can no longer move on their own.
 *
 * That holds when no step has work left (every status is done, cancelled or blocked), at least one
 * step was cancelled, and every blocked step waits, directly or through other blocked steps, for a
 * cancelled one. A cancelled step never resolves a blocker, so its dependents and the run's root
 * stay blocked for good. Nothing cascades: the dependents stay visibly blocked. A step with any
 * other status, or with none, counts as live, so a missing issue never frees the routine.
 * @param statusesByKey Issue status of each step, by step key.
 */
export function isRoutineStepRunStalled(
  steps: ReadonlyArray<Pick<RoutineStep, "key" | "after">>,
  statusesByKey: Readonly<Record<string, string>>,
): boolean {
  let anyCancelled = false;
  for (const step of steps) {
    const status = statusesByKey[step.key];
    if (status !== "done" && status !== "cancelled" && status !== "blocked") return false;
    if (status === "cancelled") anyCancelled = true;
  }
  if (!anyCancelled) return false;

  const stuck = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) {
      if (stuck.has(step.key) || statusesByKey[step.key] !== "blocked") continue;
      const waitsForDeadEnd = routineStepPredecessorKeys(step).some(
        (key) => statusesByKey[key] === "cancelled" || stuck.has(key),
      );
      if (waitsForDeadEnd) {
        stuck.add(step.key);
        grew = true;
      }
    }
  }
  return steps.every((step) => statusesByKey[step.key] !== "blocked" || stuck.has(step.key));
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
      step.after.forEach((entry, afterIndex) => {
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
      return;
    }
    steps.forEach((step, index) => {
      if (!step.sendBackTo?.length) return;
      const earlier = routineStepAncestorKeys(steps, step.key);
      const seen = new Set<string>();
      step.sendBackTo.forEach((entry, entryIndex) => {
        const path = [index, "sendBackTo", entryIndex];
        if (seen.has(entry)) {
          ctx.addIssue({ code: "custom", path, message: `Step "${step.key}" names "${entry}" twice in sendBackTo` });
        } else if (!earlier.has(entry)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `Step "${step.key}" can only send work back to a step it waits for; "${entry}" is not one`,
          });
        }
        seen.add(entry);
      });
    });
  });

/** One send-back recorded on a run: who sent the work from which step to which, and what came of it. */
export const routineStepSendBackSchema = z.object({
  fromStepKey: z.string(),
  toStepKey: z.string(),
  actorType: z.enum(["agent", "user"]),
  actorId: z.string(),
  /** The comment on the target (`sent_back`) or on the sending step (`cap_reached`). */
  commentId: z.string().guid().nullable(),
  at: z.string(),
  /** `sent_back` reopened the target; `cap_reached` was refused and handed the sending step to the board. */
  outcome: z.enum(["sent_back", "cap_reached"]),
});
export type RoutineStepSendBack = z.infer<typeof routineStepSendBackSchema>;

/**
 * Agent send-backs on one edge that count toward its cap: those after the last board send-back on
 * the edge, because a human decision resets the count as it does for review rounds.
 */
export function countRoutineStepSendBackRounds(
  sendBacks: ReadonlyArray<RoutineStepSendBack>,
  fromStepKey: string,
  toStepKey: string,
): number {
  let rounds = 0;
  for (const entry of sendBacks) {
    if (entry.fromStepKey !== fromStepKey || entry.toStepKey !== toStepKey || entry.outcome !== "sent_back") continue;
    rounds = entry.actorType === "user" ? 0 : rounds + 1;
  }
  return rounds;
}

/** Body of `POST /issues/{id}/routine-step/send-back`, sent for the step that sends its work back. */
export const routineStepSendBackRequestSchema = z
  .object({
    /** The earlier step that takes the work back; one of the sending step's `sendBackTo`. */
    toStepKey: routineStepKeySchema,
    /** What the earlier step must fix. Posted on it, or on the sending step when the cap refuses. */
    comment: multilineTextSchema.pipe(z.string().trim().min(1, "Say what to fix").max(20_000)),
  })
  .strict();
export type RoutineStepSendBackRequest = z.infer<typeof routineStepSendBackRequestSchema>;

/** The 409 code of a send-back that the rounds cap refused. */
export const ROUTINE_STEP_SEND_BACK_CAP_REACHED = "send_back_cap_reached";

/** What a send-back did; the body of its 200 and the `details` of its cap 409. */
export interface RoutineStepSendBackResult {
  outcome: RoutineStepSendBack["outcome"];
  routineRunId: string;
  fromStepKey: string;
  toStepKey: string;
  fromIssueId: string;
  toIssueId: string;
  /** Agent send-backs on this edge that count toward the cap, this one included when it was sent. */
  rounds: number;
  maxSendBacks: number;
  /** The steps set back to `blocked`: the loop without its target. Empty when the cap refused. */
  reblockedIssueIds: string[];
  /** The comment posted on the target, or on the sending step when the cap refused. */
  commentId: string;
}

/** One step of a run as its task stands now; the task is null when it is gone or hidden. */
export interface RoutineStepRunStep {
  key: string;
  issueId: string | null;
  identifier: string | null;
  title: string;
  status: string | null;
}

/** A step the viewed step may send its work back to, and how many of its rounds count so far. */
export interface RoutineStepRunSendBackTarget {
  stepKey: string;
  issueId: string | null;
  rounds: number;
  maxSendBacks: number;
}

/** The run of one routine step, as `GET /issues/{id}/routine-step` returns it. */
export interface RoutineStepRun {
  routineId: string;
  routineRunId: string;
  rootIssueId: string;
  /** The viewed step. */
  stepKey: string;
  /** Every step of the run, in the routine's order. */
  steps: RoutineStepRunStep[];
  sendBackTo: RoutineStepRunSendBackTarget[];
  /** Send-backs of the run, oldest first. */
  sendBacks: RoutineStepSendBack[];
}

/** What a run with steps records in its trigger payload, so the run stays self-contained. */
export const routineStepsRunPayloadSchema = z.object({
  steps: z.array(routineStepSchema),
  stepIssueIds: z.record(z.string(), z.string().guid()),
  /** Send-backs of the run, oldest first. Runs from before send-back have none. */
  sendBacks: z.array(routineStepSendBackSchema).default([]),
});
export type RoutineStepsRunPayload = z.infer<typeof routineStepsRunPayloadSchema>;

/** Reads the steps and issue ids a run recorded; `null` when the run had no steps. */
export function readRoutineStepsRunPayload(triggerPayload: unknown): RoutineStepsRunPayload | null {
  if (typeof triggerPayload !== "object" || triggerPayload === null) return null;
  if (!(ROUTINE_STEPS_RUN_PAYLOAD_KEY in triggerPayload)) return null;
  const parsed = routineStepsRunPayloadSchema.safeParse(triggerPayload[ROUTINE_STEPS_RUN_PAYLOAD_KEY]);
  return parsed.success ? parsed.data : null;
}
