// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RoutineStep, RoutineVariable } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineStepsEditor } from "./RoutineStepsEditor";
import { RoutineVariablesEditor } from "./RoutineVariablesEditor";

vi.mock("./MarkdownEditor", () => ({ MarkdownEditor: () => null }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = [{ id: "agent-1", label: "Builder" }];

function step(key: string, after: string[] = [], extra: Partial<RoutineStep> = {}): RoutineStep {
  return { key, title: `Title ${key}`, after, ...extra };
}

describe("RoutineStepsEditor", () => {
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

  async function render(steps: RoutineStep[], defaultAgentName: string | null = "Lead") {
    await act(async () => {
      root.render(
        <RoutineStepsEditor
          steps={steps}
          onChange={onChange}
          agentOptions={AGENTS}
          defaultAgentName={defaultAgentName}
          mentionOptions={[]}
        />,
      );
    });
  }

  function buttonByText(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    if (!found) throw new Error(`Button not found: ${text}`);
    return found;
  }

  function inputByLabel(label: string): HTMLInputElement {
    const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!found) throw new Error(`Input not found: ${label}`);
    return found;
  }

  it("says what an empty list means and adds a step that starts with the run", async () => {
    await render([]);

    expect(container.textContent).toContain("No steps. Each run creates a single task from the instructions.");
    await act(async () => buttonByText("Add step").click());

    expect(onChange).toHaveBeenCalledWith([{ key: "step-1", title: "Step 1", after: [] }]);
  });

  it("makes a step wait for another and lets it stop waiting", async () => {
    await render([step("build"), step("ship")]);

    const shipChips = [...container.querySelectorAll<HTMLButtonElement>("li:nth-of-type(2) button[aria-pressed]")];
    expect(shipChips.map((chip) => chip.textContent)).toEqual(["build"]);
    await act(async () => shipChips[0]!.click());

    expect(onChange).toHaveBeenCalledWith([step("build"), step("ship", ["build"])]);
  });

  it("will not offer a step that already waits for this one", async () => {
    await render([step("build"), step("ship", ["build"])]);

    const buildChip = container.querySelector<HTMLButtonElement>("li:nth-of-type(1) button[aria-pressed]");
    expect(buildChip?.textContent).toBe("ship");
    expect(buildChip?.disabled).toBe(true);
  });

  it("removes a step together with the waits that pointed to it", async () => {
    await render([step("build"), step("ship", ["build"])]);

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove step 1"]')!.click());

    expect(onChange).toHaveBeenCalledWith([step("ship")]);
  });

  it("renames a key everywhere it is used", async () => {
    await render([step("build"), step("ship", ["build"])]);
    const keyInput = inputByLabel("Key of step 1");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    await act(async () => {
      setValue.call(keyInput, "compile");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith([{ ...step("build"), key: "compile" }, step("ship", ["compile"])]);
  });

  it("shows what is wrong with the steps", async () => {
    await render([step("a", ["ghost"])]);

    expect(container.querySelector('ul[aria-label="Step problems"]')?.textContent).toContain(
      'Step "a" waits for unknown step "ghost"',
    );
  });

  it("lets a step send work back only to a step it waits for", async () => {
    await render([step("build"), step("ship", ["build"])]);

    expect(container.querySelector('button[aria-label^="Step 1 can send work back"]')).toBeNull();
    expect(container.querySelector("li:nth-of-type(1)")?.textContent).toContain(
      "Only a step this one waits for can take its work back",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Step 2 can send work back to build"]')!.click(),
    );

    expect(onChange).toHaveBeenCalledWith([step("build"), step("ship", ["build"], { sendBackTo: ["build"] })]);
  });

  it("shows the default round cap of a send-back and changes it", async () => {
    await render([step("build"), step("ship", ["build"], { sendBackTo: ["build"] })]);
    const cap = container.querySelector<HTMLInputElement>("#routine-step-1-max-send-backs")!;
    expect(cap.value).toBe("2");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    await act(async () => {
      setValue.call(cap, "5");
      cap.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith([
      step("build"),
      step("ship", ["build"], { sendBackTo: ["build"], maxSendBacks: 5 }),
    ]);
  });

  it("asks for an agent only when neither the step nor the routine has one", async () => {
    await render([step("a")], null);
    expect(container.textContent).toContain("Choose an agent for this step");

    await render([step("a")], "Lead");
    expect(container.textContent).not.toContain("Choose an agent for this step");

    await render([step("a", [], { assigneeAgentId: "agent-1" })], null);
    expect(container.textContent).not.toContain("Choose an agent for this step");
  });
});

describe("RoutineVariablesEditor with steps", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a variable that only a step uses", async () => {
    const onChange = vi.fn();
    const variables: RoutineVariable[] = [
      { name: "target", label: null, type: "text", defaultValue: "alpha", required: false, options: [] },
    ];

    await act(async () => {
      root.render(
        <RoutineVariablesEditor
          title="Release"
          description=""
          steps={[step("a", [], { title: "Check {{target}}" })]}
          value={variables}
          onChange={onChange}
        />,
      );
    });

    expect(container.textContent).toContain("{{target}}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops that variable when no step uses it any more", async () => {
    const onChange = vi.fn();
    const variables: RoutineVariable[] = [
      { name: "target", label: null, type: "text", defaultValue: "alpha", required: false, options: [] },
    ];

    await act(async () => {
      root.render(
        <RoutineVariablesEditor title="Release" description="" steps={[step("a")]} value={variables} onChange={onChange} />,
      );
    });

    expect(onChange).toHaveBeenCalledWith([]);
  });
});
