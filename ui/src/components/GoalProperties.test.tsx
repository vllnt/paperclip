// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "@paperclipai/shared";
import { GoalProperties } from "./GoalProperties";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  progress: vi.fn(async () => ({ "goal-1": { total: 5, done: 3, open: 2 } })),
}));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

const goal: Goal = {
  id: "goal-1",
  companyId: "company-1",
  title: "Land PRs",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  kind: "goal",
  horizon: "short",
  targetDate: "2026-10-16",
  successCriteria: "Open PRs = 0",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

describe("GoalProperties planning fields", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(value: Goal, onUpdate?: (data: Record<string, unknown>) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <GoalProperties goal={value} onUpdate={onUpdate} />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  const text = () => container.textContent ?? "";

  it("shows kind, horizon, target date, success criteria and progress", async () => {
    await render(goal, vi.fn());

    expect(text()).toContain("Goal");
    expect(text()).toContain("Short term");
    expect(text()).toContain("Open PRs = 0");
    expect(text()).toContain("3/5 done");
    expect(container.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2026-10-16");
  });

  it("saves the date only when the field is left, so partial typing never saves", async () => {
    const onUpdate = vi.fn();
    await render(goal, onUpdate);
    const input = container.querySelector<HTMLInputElement>('input[type="date"]')!;
    const setValue = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const leave = () => act(() => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });

    for (const partial of ["0002-10-16", "0020-10-16", "0202-10-16", "2026-10-20"]) setValue(partial);
    expect(onUpdate).not.toHaveBeenCalled();
    leave();
    expect(onUpdate.mock.calls).toEqual([[{ targetDate: "2026-10-20" }]]);

    leave();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    setValue("");
    leave();
    expect(onUpdate.mock.calls.at(-1)).toEqual([{ targetDate: null }]);
  });

  it("saves on Enter", async () => {
    const onUpdate = vi.fn();
    await render(goal, onUpdate);
    const input = container.querySelector<HTMLInputElement>('input[type="date"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2026-11-01");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onUpdate.mock.calls).toEqual([[{ targetDate: "2026-11-01" }]]);
  });

  it("offers no editing controls when read only", async () => {
    await render({ ...goal, horizon: null, targetDate: null, successCriteria: null, kind: "milestone" });

    expect(text()).toContain("Milestone");
    expect(text()).toContain("No horizon");
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });
});
