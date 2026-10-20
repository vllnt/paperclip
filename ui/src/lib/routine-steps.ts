import {
  routineStepAfterKey,
  routineStepsSchema,
  type RoutineStep,
  type RoutineStepAfterEntry,
} from "@paperclipai/shared";

/** The fields of a step an editor can change; the key has its own rename helper. */
export type RoutineStepPatch = Partial<Omit<RoutineStep, "key" | "after">>;

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

function renameAfterEntry(entry: RoutineStepAfterEntry, from: string, to: string): RoutineStepAfterEntry {
  if (typeof entry === "string") return entry === from ? to : entry;
  return entry.step === from ? { ...entry, step: to } : entry;
}

/**
 * Renames a step and every `after` entry that points to it. A key another step
 * already uses is ignored, so two steps never share one.
 */
export function renameRoutineStepKey(steps: readonly RoutineStep[], from: string, to: string): RoutineStep[] {
  if (from === to || steps.some((step) => step.key === to)) return [...steps];
  return steps.map((step) => ({
    ...step,
    key: step.key === from ? to : step.key,
    after: step.after.map((entry) => renameAfterEntry(entry, from, to)),
  }));
}

/** Removes a step and every `after` entry that pointed to it. */
export function removeRoutineStep(steps: readonly RoutineStep[], key: string): RoutineStep[] {
  return steps
    .filter((step) => step.key !== key)
    .map((step) => ({ ...step, after: step.after.filter((entry) => routineStepAfterKey(entry) !== key) }));
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
    for (const entry of byKey.get(current)?.after ?? []) {
      const next = routineStepAfterKey(entry);
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

/** Adds or removes one predecessor of a step. */
export function toggleRoutineStepPredecessor(
  steps: readonly RoutineStep[],
  key: string,
  predecessorKey: string,
): RoutineStep[] {
  return steps.map((step) => {
    if (step.key !== key) return step;
    const waits = step.after.some((entry) => routineStepAfterKey(entry) === predecessorKey);
    return {
      ...step,
      after: waits
        ? step.after.filter((entry) => routineStepAfterKey(entry) !== predecessorKey)
        : [...step.after, predecessorKey],
    };
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
