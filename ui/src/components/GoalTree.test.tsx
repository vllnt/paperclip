// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "@paperclipai/shared";
import { GoalTree } from "./GoalTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

function goal(overrides: Partial<Goal>): Goal {
  return {
    id: "g",
    companyId: "c",
    title: "Goal",
    description: null,
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    kind: "goal",
    horizon: null,
    targetDate: null,
    successCriteria: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

describe("GoalTree planning details", () => {
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

  it("shows horizon, milestone, target date and progress on each row", () => {
    const goals = [
      goal({ id: "root", title: "Ship v2", horizon: "short", targetDate: "2026-10-16" }),
      goal({ id: "m1", title: "Reviewed", kind: "milestone", parentId: "root", targetDate: "2026-10-12" }),
    ];

    act(() => root.render(
      <GoalTree goals={goals} goalLink={(g) => `/goals/${g.id}`} progress={{ root: { total: 4, done: 1, open: 3 } }} />,
    ));

    const rows = [...container.querySelectorAll("a")].map((a) => a.textContent ?? "");
    expect(rows[0]).toContain("Short term");
    expect(rows[0]).toContain("Oct 16, 2026");
    expect(rows[0]).toContain("1/4");
    expect(rows[1]).toContain("Milestone");
    expect(rows[1]).toContain("Oct 12, 2026");
    expect(rows[1]).not.toContain("/");
  });
});
