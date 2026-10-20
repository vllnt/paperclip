import { describe, expect, it } from "vitest";
import type { RoutineStep } from "@paperclipai/shared";
import {
  addRoutineStep,
  canRoutineStepWaitFor,
  nextRoutineStepKey,
  removeRoutineStep,
  renameRoutineStepKey,
  routineStepsEqual,
  routineStepsIssues,
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
    const renamed = renameRoutineStepKey([step("a"), step("b", ["a"]), step("c", [{ step: "a", when: "done" }])], "a", "build");
    expect(renamed.map((entry) => entry.key)).toEqual(["build", "b", "c"]);
    expect(renamed[1]!.after).toEqual(["build"]);
    expect(renamed[2]!.after).toEqual([{ step: "build", when: "done" }]);
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
});
