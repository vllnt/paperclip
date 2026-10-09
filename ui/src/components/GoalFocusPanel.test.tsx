// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyFocus } from "@paperclipai/shared";
import { GoalFocusPanel } from "./GoalFocusPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

const focus: CompanyFocus = {
  guidance: "Pick work that serves the focus first.",
  goals: [
    {
      id: "goal-1",
      title: "Land all open pull requests",
      kind: "goal",
      level: "company",
      targetDate: "2026-10-16",
      daysLeft: 7,
      successCriteria: "Open PRs = 0",
      ownerAgentId: null,
      progress: { total: 8, done: 2, open: 6 },
      milestones: [
        { id: "m-1", title: "Reviewed", status: "active", targetDate: "2026-10-08", daysLeft: -1, progress: { total: 4, done: 4, open: 0 } },
      ],
    },
    {
      id: "goal-2",
      title: "Undated push",
      kind: "goal",
      level: "team",
      targetDate: null,
      daysLeft: null,
      successCriteria: null,
      ownerAgentId: null,
      progress: { total: 0, done: 0, open: 0 },
      milestones: [],
    },
  ],
};

describe("GoalFocusPanel", () => {
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

  const render = (value: CompanyFocus) => act(() => root.render(<GoalFocusPanel focus={value} />));
  const text = () => container.textContent ?? "";

  it("shows each focus goal with its target, progress, due date and milestones, linked to the goal", () => {
    render(focus);

    expect(text()).toContain("Current focus");
    expect(text()).toContain("Land all open pull requests");
    expect(text()).toContain("Open PRs = 0");
    expect(text()).toContain("2/8 done");
    expect(text()).toContain("7 days left");
    expect(text()).toContain("Reviewed");
    expect(text()).toContain("1 day overdue");
    expect(text()).toContain("No date");
    expect(container.querySelector('a[href="/goals/goal-1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/goals/m-1"]')).not.toBeNull();
    const bar = container.querySelector<HTMLElement>('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("25");
  });

  it("explains how to set a focus when there is none", () => {
    render({ goals: [], guidance: "x" });

    expect(text()).toContain("No current focus");
    expect(text()).toContain("short");
  });
});
