import { describe, expect, it } from "vitest";
import { issueExecutionPolicySchema, type RoutineStep } from "@paperclipai/shared";
import {
  addRoutineStep,
  canRoutineStepWaitFor,
  isGatedRoutineStep,
  nextRoutineStepKey,
  removeRoutineStep,
  renameRoutineStepKey,
  routineStepCondition,
  routineStepOutcomeLabel,
  routineStepsEqual,
  routineStepsIssues,
  setRoutineStepCondition,
  toggleRoutineStepPredecessor,
  updateRoutineStep,
} from "./routine-steps";

function step(key: string, after: RoutineStep["after"] = []): RoutineStep {
  return { key, title: `Step ${key}`, after };
}

describe("routine step helpers", () => {
  it("adds a step with a key no other step uses", () => {
    expect(nextRoutineStepKey([])).toBe("step-1");
    expect(nextRoutineStepKey([step("step-2")])).toBe("step-3");
    expect(addRoutineStep([step("step-2")])).toEqual([
      step("step-2"),
      { key: "step-3", title: "Step 2", after: [] },
    ]);
  });

  it("updates only the named step", () => {
    const updated = updateRoutineStep([step("a"), step("b")], "b", { title: "Ship", priority: "high" });
    expect(updated[0]).toEqual(step("a"));
    expect(updated[1]).toMatchObject({ key: "b", title: "Ship", priority: "high" });
  });

  it("renames a key and the after entries that point to it", () => {
    const renamed = renameRoutineStepKey([step("a"), step("b", ["a"]), step("c", ["b", "a"])], "a", "build");
    expect(renamed.map((entry) => entry.key)).toEqual(["build", "b", "c"]);
    expect(renamed[1]!.after).toEqual(["build"]);
    expect(renamed[2]!.after).toEqual(["b", "build"]);
  });

  it("ignores a rename onto a key another step already uses", () => {
    const steps = [step("a"), step("b", ["a"])];
    expect(renameRoutineStepKey(steps, "a", "b")).toEqual(steps);
  });

  it("removes a step and the after entries that pointed to it", () => {
    expect(removeRoutineStep([step("a"), step("b", ["a"]), step("c", ["a", "b"])], "a")).toEqual([
      step("b"),
      step("c", ["b"]),
    ]);
  });

  it("never lets a step wait for itself or for a step that waits for it", () => {
    const steps = [step("a"), step("b", ["a"]), step("c", ["b"])];
    expect(canRoutineStepWaitFor(steps, "a", "a")).toBe(false);
    expect(canRoutineStepWaitFor(steps, "a", "b")).toBe(false);
    expect(canRoutineStepWaitFor(steps, "a", "c")).toBe(false);
    expect(canRoutineStepWaitFor(steps, "c", "a")).toBe(true);
    expect(canRoutineStepWaitFor([step("a"), step("b")], "a", "b")).toBe(true);
  });

  it("toggles a predecessor on and off", () => {
    const steps = [step("a"), step("b")];
    const waiting = toggleRoutineStepPredecessor(steps, "b", "a");
    expect(waiting[1]!.after).toEqual(["a"]);
    expect(toggleRoutineStepPredecessor(waiting, "b", "a")[1]!.after).toEqual([]);
  });

  it("compares steps by content, not by the order of their fields", () => {
    const sent: RoutineStep = { key: "a", title: "A", after: ["b"] };
    const returned: RoutineStep = { title: "A", after: ["b"], key: "a", description: undefined };
    expect(routineStepsEqual([sent], [returned])).toBe(true);
    expect(routineStepsEqual([sent], [{ ...returned, title: "B" }])).toBe(false);
    expect(routineStepsEqual([sent], [])).toBe(false);
    expect(routineStepsEqual([step("a"), step("b")], [step("b"), step("a")])).toBe(false);
  });

  it("reports what is wrong with the steps, and nothing for valid steps", () => {
    expect(routineStepsIssues([step("a"), step("b", ["a"])])).toEqual([]);
    expect(routineStepsIssues([step("a"), step("a")])).toContain('Duplicate step key "a"');
    expect(routineStepsIssues([step("a", ["ghost"])])).toContain('Step "a" waits for unknown step "ghost"');
    expect(routineStepsIssues([{ ...step("a"), title: "" }]).length).toBeGreaterThan(0);
  });

  it("keeps the condition on an edge when the step it names is renamed or other steps change", () => {
    const steps = [step("review"), step("ship", [{ step: "review", when: "done" }, "lint"]), step("lint")];
    const renamed = renameRoutineStepKey(steps, "review", "gate");
    expect(renamed[1]!.after).toEqual([{ step: "gate", when: "done" }, "lint"]);
    expect(removeRoutineStep(steps, "lint")[1]!.after).toEqual([{ step: "review", when: "done" }]);
    expect(removeRoutineStep(steps, "review").find((entry) => entry.key === "ship")!.after).toEqual(["lint"]);
  });

  it("treats a conditional edge as a wait when it looks for a cycle, and drops it when toggled off", () => {
    const steps = [step("a"), step("b", [{ step: "a", when: "cancelled" }])];
    expect(canRoutineStepWaitFor(steps, "a", "b")).toBe(false);
    expect(toggleRoutineStepPredecessor(steps, "b", "a")[1]!.after).toEqual([]);
    expect(toggleRoutineStepPredecessor([step("a"), step("b")], "b", "a")[1]!.after).toEqual(["a"]);
  });

  it("sets, changes and clears the condition on one edge and keeps its place", () => {
    const steps = [step("a"), step("b"), step("c", ["a", "b"])];
    const gated = setRoutineStepCondition(steps, "c", "a", "cancelled");
    expect(gated[2]!.after).toEqual([{ step: "a", when: "cancelled" }, "b"]);
    expect(gated[0]).toBe(steps[0]);
    expect(setRoutineStepCondition(gated, "c", "a", "done")[2]!.after).toEqual([{ step: "a", when: "done" }, "b"]);
    expect(setRoutineStepCondition(gated, "c", "a", null)[2]!.after).toEqual(["a", "b"]);
    expect(setRoutineStepCondition(steps, "c", "ghost", "done")[2]!.after).toEqual(["a", "b"]);
  });

  it("reads the condition on an edge, and null for a plain edge or an unknown step", () => {
    const target = step("c", [{ step: "a", when: "cancelled" }, "b"]);
    expect(routineStepCondition(target, "a")).toBe("cancelled");
    expect(routineStepCondition(target, "b")).toBeNull();
    expect(routineStepCondition(target, "ghost")).toBeNull();
  });

  it("words the outcomes of a gated step as approved and rejected, and of any other step as done and cancelled", () => {
    const gated: RoutineStep = {
      ...step("review"),
      executionPolicy: issueExecutionPolicySchema.parse({ stages: [{ type: "approval" }] }),
    };
    const ungated: RoutineStep = { ...step("build"), executionPolicy: issueExecutionPolicySchema.parse({}) };
    expect(isGatedRoutineStep(gated)).toBe(true);
    expect(isGatedRoutineStep(step("a"))).toBe(false);
    expect(isGatedRoutineStep(ungated)).toBe(false);
    expect(routineStepOutcomeLabel(gated, "done")).toBe("approved");
    expect(routineStepOutcomeLabel(gated, "cancelled")).toBe("rejected or stopped by the board");
    expect(routineStepOutcomeLabel(ungated, "done")).toBe("done");
    expect(routineStepOutcomeLabel(ungated, "cancelled")).toBe("cancelled");
    expect(routineStepOutcomeLabel(undefined, "cancelled")).toBe("cancelled");
  });

  it("reports one predecessor named with two different conditions", () => {
    const conflicting = step("b", [
      { step: "a", when: "done" },
      { step: "a", when: "cancelled" },
    ]);
    expect(routineStepsIssues([step("a"), conflicting])).toContain(
      'Step "b" waits for step "a" more than once with different conditions',
    );
    expect(routineStepsIssues([step("a"), step("b", [{ step: "a", when: "done" }, "a"])])).toContain(
      'Step "b" waits for step "a" more than once with different conditions',
    );
    expect(routineStepsIssues([step("a"), step("b", [{ step: "a", when: "done" }, { step: "a", when: "done" }])])).toEqual([]);
  });
});
