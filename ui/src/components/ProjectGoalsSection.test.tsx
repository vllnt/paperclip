// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectGoalsSection, projectGoalSummaries } from "./ProjectGoalsSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const goalsListMock = vi.hoisted(() => vi.fn());
const issuesListAllMock = vi.hoisted(() => vi.fn());
const routinesListMock = vi.hoisted(() => vi.fn());
const agentsListMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/goals", () => ({ goalsApi: { list: goalsListMock } }));
vi.mock("../api/issues", () => ({ issuesApi: { listAll: issuesListAllMock } }));
vi.mock("../api/routines", () => ({ routinesApi: { list: routinesListMock } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: agentsListMock } }));

const goals: Array<Pick<Goal, "id" | "title" | "status" | "ownerAgentId">> = [
  { id: "goal-1", title: "Ship the beta", status: "active", ownerAgentId: "agent-owner" },
  { id: "goal-2", title: "Cut costs", status: "planned", ownerAgentId: null },
  { id: "goal-3", title: "Old goal", status: "cancelled", ownerAgentId: null },
];
const tasks = [
  { goalId: "goal-1", assigneeAgentId: "agent-builder", status: "todo" },
  { goalId: "goal-1", assigneeAgentId: null, status: "in_progress" },
  { goalId: "goal-2", assigneeAgentId: "agent-builder", status: "todo" },
  { goalId: null, assigneeAgentId: "agent-other", status: "todo" },
];
const routines = [
  { goalId: "goal-1", assigneeAgentId: "agent-scheduler", status: "active" },
  { goalId: "goal-1", assigneeAgentId: "agent-gone", status: "archived" },
];

describe("projectGoalSummaries", () => {
  it("groups the project's open tasks, live routines and their agents under each linked goal", () => {
    const summaries = projectGoalSummaries({
      goalRefs: [{ id: "goal-1", title: "Ship the beta" }, { id: "goal-hidden", title: "Hidden goal" }],
      goals,
      tasks,
      routines,
    });

    expect(summaries).toEqual([
      {
        goalId: "goal-1",
        title: "Ship the beta",
        status: "active",
        openTaskCount: 2,
        routineCount: 1,
        agents: [
          { agentId: "agent-owner", reasons: ["owner"] },
          { agentId: "agent-builder", reasons: ["task"] },
          { agentId: "agent-scheduler", reasons: ["routine"] },
        ],
      },
      { goalId: "goal-hidden", title: "Hidden goal", status: null, openTaskCount: 0, routineCount: 0, agents: [] },
    ]);
  });
});

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProjectGoalsSection", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    goalsListMock.mockReset().mockResolvedValue(goals);
    issuesListAllMock.mockReset().mockResolvedValue(tasks);
    routinesListMock.mockReset().mockResolvedValue(routines);
    agentsListMock.mockReset().mockResolvedValue([
      { id: "agent-owner", name: "Owner" },
      { id: "agent-builder", name: "Builder" },
      { id: "agent-scheduler", name: "Scheduler" },
    ]);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    queryClient.clear();
  });

  async function render(element: ReactNode) {
    root = createRoot(container);
    await act(() => root!.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>));
    await flush();
  }

  function unlinkButton(title: string) {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="Unlink goal ${title}"]`);
  }

  it("shows each goal's open tasks, routines and agents in this project, and reads only the project's work", async () => {
    await render(
      <ProjectGoalsSection
        companyId="company-1"
        projectId="project-1"
        goalRefs={[{ id: "goal-1", title: "Ship the beta" }, { id: "goal-2", title: "Cut costs" }]}
        onGoalIdsChange={vi.fn()}
      />,
    );

    expect(issuesListAllMock).toHaveBeenCalledWith("company-1", expect.objectContaining({ projectId: "project-1" }));
    expect(routinesListMock).toHaveBeenCalledWith("company-1", { projectId: "project-1" });
    expect(container.querySelector('a[href="/goals/goal-1"]')?.textContent).toBe("Ship the beta");
    expect(container.textContent).toContain("2 open tasks · 1 routine · Agents: Owner, Builder, Scheduler");
    expect(container.textContent).toContain("1 open task · 0 routines · Agents: Builder");
  });

  it("unlinks a goal by saving the project's other goals", async () => {
    const onGoalIdsChange = vi.fn(async () => undefined);
    await render(
      <ProjectGoalsSection
        companyId="company-1"
        projectId="project-1"
        goalRefs={[{ id: "goal-1", title: "Ship the beta" }, { id: "goal-2", title: "Cut costs" }]}
        onGoalIdsChange={onGoalIdsChange}
      />,
    );

    await act(() => unlinkButton("Ship the beta")!.click());
    await flush();

    expect(onGoalIdsChange).toHaveBeenCalledWith(["goal-2"]);
  });

  it("shows a failed save and keeps the goals", async () => {
    const onGoalIdsChange = vi.fn(async () => {
      throw new Error("Goal not found");
    });
    await render(
      <ProjectGoalsSection
        companyId="company-1"
        projectId="project-1"
        goalRefs={[{ id: "goal-1", title: "Ship the beta" }]}
        onGoalIdsChange={onGoalIdsChange}
      />,
    );

    await act(() => unlinkButton("Ship the beta")!.click());
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Goal not found");
    expect(container.textContent).toContain("Ship the beta");
  });

  it("offers no changes for a project that cannot change, and reads no work without goals", async () => {
    await render(<ProjectGoalsSection companyId="company-1" projectId="project-1" goalRefs={[]} />);

    expect(container.textContent).toContain("This project serves no goal yet.");
    expect(container.querySelector('[aria-label="Link a goal"]')).toBeNull();
    expect(goalsListMock).not.toHaveBeenCalled();
    expect(issuesListAllMock).not.toHaveBeenCalled();
    expect(routinesListMock).not.toHaveBeenCalled();
  });

  it("keeps every change disabled until the save, including the page refresh, finishes", async () => {
    let finishSave: () => void = () => {};
    const onGoalIdsChange = vi.fn(() => new Promise<void>((resolve) => {
      finishSave = resolve;
    }));
    await render(
      <ProjectGoalsSection
        companyId="company-1"
        projectId="project-1"
        goalRefs={[{ id: "goal-1", title: "Ship the beta" }, { id: "goal-2", title: "Cut costs" }]}
        onGoalIdsChange={onGoalIdsChange}
      />,
    );

    await act(() => unlinkButton("Ship the beta")!.click());
    await flush();

    expect(unlinkButton("Ship the beta")!.disabled).toBe(true);
    expect(unlinkButton("Cut costs")!.disabled).toBe(true);

    await act(() => finishSave());
    await flush();

    expect(unlinkButton("Cut costs")!.disabled).toBe(false);
    expect(onGoalIdsChange).toHaveBeenCalledTimes(1);
  });

  it("offers the link picker for a project that can change, and reads no work without goals", async () => {
    await render(
      <ProjectGoalsSection companyId="company-1" projectId="project-1" goalRefs={[]} onGoalIdsChange={vi.fn()} />,
    );

    expect(container.querySelector('[aria-label="Link a goal"]')).not.toBeNull();
    expect(goalsListMock).toHaveBeenCalledWith("company-1");
    expect(issuesListAllMock).not.toHaveBeenCalled();
  });
});
