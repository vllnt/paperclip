import { routineStepAncestorKeys, routineStepsSchema, type RoutineStep } from "@paperclipai/shared";

/** The fields of a step an editor can change; the key, `after` and `sendBackTo` have their own helpers. */
export type RoutineStepPatch = Partial<Omit<RoutineStep, "key" | "after" | "sendBackTo">>;

/** A key no other step uses, in the form the key pattern accepts. */
export function nextRoutineStepKey(steps: readonly RoutineStep[]): string {
  const used = new Set(steps.map((step) => step.key));
  let index = steps.length + 1;
  while (used.has(`step-${index}`)) index += 1;
  return `step-${index}`;
}

/** Appends an empty step that starts with the run. */
export function addRoutineStep(steps: readonly RoutineStep[]): RoutineStep[] {
  return [...steps, { key: nextRoutineStepKey(steps), title: `Step ${steps.length + 1}`, after: [] }];
}

/** Changes the fields of one step. */
export function updateRoutineStep(
  steps: readonly RoutineStep[],
  key: string,
  patch: RoutineStepPatch,
): RoutineStep[] {
  return steps.map((step) => (step.key === key ? { ...step, ...patch } : step));
}

/** Sets `sendBackTo`, dropping it and its round cap when nothing is left. */
function withSendBackTo(step: RoutineStep, sendBackTo: string[]): RoutineStep {
  if (sendBackTo.length > 0) return { ...step, sendBackTo };
  const rest = { ...step };
  delete rest.sendBackTo;
  delete rest.maxSendBacks;
  return rest;
}

/** Drops every `sendBackTo` entry that no longer names a step its step waits for. */
function pruneRoutineStepSendBacks(steps: RoutineStep[]): RoutineStep[] {
  return steps.map((step) => {
    if (!step.sendBackTo) return step;
    const earlier = routineStepAncestorKeys(steps, step.key);
    const kept = step.sendBackTo.filter((key) => earlier.has(key));
    return kept.length === step.sendBackTo.length ? step : withSendBackTo(step, kept);
  });
}

/**
 * Renames a step and every `after` and `sendBackTo` entry that points to it. A key another step
 * already uses is ignored, so two steps never share one.
 */
export function renameRoutineStepKey(steps: readonly RoutineStep[], from: string, to: string): RoutineStep[] {
  if (from === to || steps.some((step) => step.key === to)) return [...steps];
  const rename = (entry: string) => (entry === from ? to : entry);
  return steps.map((step) => ({
    ...step,
    key: rename(step.key),
    after: step.after.map(rename),
    ...(step.sendBackTo ? { sendBackTo: step.sendBackTo.map(rename) } : {}),
  }));
}

/** Removes a step and every `after` and `sendBackTo` entry that pointed to it. */
export function removeRoutineStep(steps: readonly RoutineStep[], key: string): RoutineStep[] {
  return pruneRoutineStepSendBacks(
    steps
      .filter((step) => step.key !== key)
      .map((step) => ({ ...step, after: step.after.filter((entry) => entry !== key) })),
  );
}

/** True when `key` waits for `predecessorKey`, directly or through other steps. */
function waitsForTransitively(steps: readonly RoutineStep[], key: string, predecessorKey: string): boolean {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const seen = new Set<string>();
  const pending = [key];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of byKey.get(current)?.after ?? []) {
      if (next === predecessorKey) return true;
      pending.push(next);
    }
  }
  return false;
}

/** A step may wait for any other step that does not already wait for it, so no cycle forms. */
export function canRoutineStepWaitFor(steps: readonly RoutineStep[], key: string, predecessorKey: string): boolean {
  return key !== predecessorKey && !waitsForTransitively(steps, predecessorKey, key);
}

/**
 * Adds or removes one predecessor of a step. A step that no longer waits for a step it could send
 * work back to loses that send-back.
 */
export function toggleRoutineStepPredecessor(
  steps: readonly RoutineStep[],
  key: string,
  predecessorKey: string,
): RoutineStep[] {
  return pruneRoutineStepSendBacks(
    steps.map((step) => {
      if (step.key !== key) return step;
      const waits = step.after.includes(predecessorKey);
      return {
        ...step,
        after: waits ? step.after.filter((entry) => entry !== predecessorKey) : [...step.after, predecessorKey],
      };
    }),
  );
}

/** A step may send work back only to a step it waits for, directly or through other steps. */
export function canRoutineStepSendBackTo(steps: readonly RoutineStep[], key: string, targetKey: string): boolean {
  return routineStepAncestorKeys(steps, key).has(targetKey);
}

/** Adds or removes one step that a step may send work back to. */
export function toggleRoutineStepSendBack(steps: readonly RoutineStep[], key: string, targetKey: string): RoutineStep[] {
  return steps.map((step) => {
    if (step.key !== key) return step;
    const current = step.sendBackTo ?? [];
    return withSendBackTo(
      step,
      current.includes(targetKey) ? current.filter((entry) => entry !== targetKey) : [...current, targetKey],
    );
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * True when two step lists say the same thing. The server returns fields in its own order,
 * so a plain JSON comparison would call a saved draft changed.
 */
export function routineStepsEqual(left: readonly RoutineStep[], right: readonly RoutineStep[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** What is wrong with the steps, in words an editor can show; empty when they are valid. */
export function routineStepsIssues(steps: readonly RoutineStep[]): string[] {
  const parsed = routineStepsSchema.safeParse(steps);
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => issue.message))];
}
