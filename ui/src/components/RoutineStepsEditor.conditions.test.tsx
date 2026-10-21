// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { issueExecutionPolicySchema, type RoutineStep } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineStepsEditor } from "./RoutineStepsEditor";

vi.mock("./MarkdownEditor", () => ({ MarkdownEditor: () => null }));
// The Radix select needs a layout engine. This stand-in lists every option inline and reports the chosen value.
vi.mock("@/components/ui/select", async () => {
  const { createContext, createElement, useContext } = await import("react");
  const SelectState = createContext<{ value: string; onValueChange: (value: string) => void }>({
    value: "",
    onValueChange: () => undefined,
  });
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => createElement(SelectState.Provider, { value: { value, onValueChange } }, children),
    SelectTrigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => {
      const { value } = useContext(SelectState);
      return createElement("button", { type: "button", "data-value": value, ...props }, children);
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const state = useContext(SelectState);
      return createElement(
        "button",
        { type: "button", role: "option", "aria-selected": state.value === value, onClick: () => state.onValueChange(value) },
        children,
      );
    },
  };
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = [{ id: "agent-1", label: "Builder" }];

function step(key: string, after: RoutineStep["after"] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Title ${key}`, after, ...extra };
}

const approval = issueExecutionPolicySchema.parse({ stages: [{ type: "approval" }] });

describe("RoutineStepsEditor conditions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(steps: RoutineStep[]) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onChange = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(steps: RoutineStep[]) {
    await act(async () => {
      root.render(
        <RoutineStepsEditor
          steps={steps}
          onChange={onChange}
          agentOptions={AGENTS}
          defaultAgentName="Lead"
          mentionOptions={[]}
        />,
      );
    });
  }

  function trigger(label: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`Condition select not found: ${label}`);
    return found;
  }

  function optionTexts(label: string): string[] {
    const row = trigger(label).closest("li")!;
    return [...row.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
  }

  async function choose(label: string, optionText: string) {
    const row = trigger(label).closest("li")!;
    const option = [...row.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (item) => item.textContent === optionText,
    );
    if (!option) throw new Error(`Option not found: ${optionText}`);
    await act(async () => option.click());
  }

  it("offers a condition for each predecessor, in the words of its outcome", async () => {
    await render([step("review", [], { executionPolicy: approval }), step("build"), step("ship", ["review", "build"])]);

    expect(optionTexts("Condition on review for step 3")).toEqual([
      "Wait until approved",
      "Only if approved",
      "Only if rejected or stopped by the board",
    ]);
    expect(optionTexts("Condition on build for step 3")).toEqual([
      "Wait until done",
      "Only if done",
      "Only if cancelled",
    ]);
    expect(trigger("Condition on review for step 3").dataset.value).toBe("plain");
  });

  it("shows the condition a step already has", async () => {
    await render([step("review"), step("rework", [{ step: "review", when: "cancelled" }])]);

    expect(trigger("Condition on review for step 2").dataset.value).toBe("cancelled");
  });

  it("puts the chosen condition on that edge only", async () => {
    const review = step("review", [], { executionPolicy: approval });
    await render([review, step("build"), step("ship", ["review", "build"])]);

    await choose("Condition on review for step 3", "Only if rejected or stopped by the board");

    expect(onChange).toHaveBeenCalledWith([
      review,
      step("build"),
      step("ship", [{ step: "review", when: "cancelled" }, "build"]),
    ]);
  });

  it("goes back to a plain wait when the wait option is chosen again", async () => {
    await render([step("review"), step("rework", [{ step: "review", when: "cancelled" }])]);

    await choose("Condition on review for step 2", "Wait until done");

    expect(onChange).toHaveBeenCalledWith([step("review"), step("rework", ["review"])]);
  });

  it("explains skipping only on a step that has a condition", async () => {
    await render([step("review"), step("rework", [{ step: "review", when: "cancelled" }]), step("report", ["rework"])]);

    // The hint sits next to the list of conditions of the step.
    const conditionsOf = (label: string) => trigger(label).closest("ul")!.parentElement!.textContent ?? "";
    expect(conditionsOf("Condition on review for step 2")).toContain("Skipped: condition not met");
    expect(conditionsOf("Condition on rework for step 3")).not.toContain("Skipped: condition not met");
  });

  it("shows no conditions for a step that waits for nothing", async () => {
    await render([step("review")]);

    expect(container.textContent).not.toContain("Conditions");
  });
});
