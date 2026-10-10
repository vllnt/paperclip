// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKanbanColumnTone, KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";

const handoffCheck = vi.hoisted(() => vi.fn((_issue: { id: string }) => false));

vi.mock("../lib/successful-run-handoff", () => ({
  isSuccessfulRunHandoffRequired: handoffCheck,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function act(callback: () => void): void {
  flushSync(callback);
}

function createIssue(index: number, status: IssueStatus): Issue {
  return {
    id: `issue-${status}-${index}`,
    identifier: `PAP-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: index === 1 ? "agent-1" : null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function createIssues(count: number, status: IssueStatus): Issue[] {
  return Array.from({ length: count }, (_, index) => createIssue(index + 1, status));
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] }) => {
    act(() => {
      root.render(
        <KanbanBoard
          agents={[{ id: "agent-1", name: "Codex" }]}
          liveIssueIds={new Set(["issue-todo-1"])}
          onUpdateIssue={vi.fn()}
          {...nextProps}
        />,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      issues: createIssues(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 50");
    expect(container.textContent).not.toContain("Issue 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const issues = createIssues(60, "todo");
    const { container, render } = renderBoard({
      issues,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");

    render({
      issues,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 10");
    expect(container.textContent).not.toContain("Issue 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      issues: createIssues(3, "done"),
      collapsedStatuses: ["done"],
    });

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("Issue 1");
  });

  it("gives every column a status-hued tone", () => {
    expect(getKanbanColumnTone("backlog").body).toContain("bg-muted/30");
    expect(getKanbanColumnTone("todo").body).toContain("amber");
    expect(getKanbanColumnTone("in_progress").body).toContain("blue");
    expect(getKanbanColumnTone("in_review").body).toContain("violet");
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("ghosts cancelled lane cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "cancelled"),
    });

    const card = container.querySelector('a[href="/issues/PAP-1"]')?.parentElement;

    expect(card?.className).toContain("bg-muted/35");
    expect(card?.className).toContain("opacity-80");
  });

  it("keeps core issue signals in compact cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

  it("shows placeholders, not a zero count, for columns still loading", () => {
    const { container } = renderBoard({
      issues: createIssues(2, "todo"),
      loadingStatuses: ["done"],
    });

    const done = container.querySelector("[data-kanban-status='done']");
    expect(done?.getAttribute("data-kanban-state")).toBe("loading");
    expect(done?.getAttribute("aria-busy")).toBe("true");
    expect(done?.querySelector("[data-kanban-count]")).toBeNull();
    expect(done?.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);

    const todo = container.querySelector("[data-kanban-status='todo']");
    expect(todo?.getAttribute("data-kanban-state")).toBe("ready");
    expect(todo?.querySelector("[data-kanban-count]")?.textContent).toBe("2");
  });

  it("shows a retryable error for columns that failed to load", () => {
    const onRetryFailedColumns = vi.fn();
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      failedStatuses: ["done"],
      onRetryFailedColumns,
    });

    const done = container.querySelector("[data-kanban-status='done']");
    expect(done?.getAttribute("data-kanban-state")).toBe("failed");
    expect(done?.querySelector("[role='alert']")?.textContent).toContain("Couldn’t load done tasks.");
    expect(done?.querySelector("[data-kanban-count]")?.textContent).toBe("–");

    const retry = Array.from(done?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Retry");
    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetryFailedColumns).toHaveBeenCalledTimes(1);
  });

  it("offers a retry on a collapsed cold lane that failed to load", () => {
    const onRetryFailedColumns = vi.fn();
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      collapsedStatuses: ["done"],
      failedStatuses: ["done"],
      onRetryFailedColumns,
    });

    const doneRail = container.querySelector("[data-kanban-status='done']");
    expect(doneRail?.className).toContain("w-(--sz-52px)");
    expect(doneRail?.getAttribute("title")).toBe("Done: failed to load");
    expect(doneRail?.querySelector("[data-kanban-count]")?.textContent).toBe("–");

    const retry = doneRail?.querySelector("button[aria-label='Retry loading done tasks']");
    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetryFailedColumns).toHaveBeenCalledTimes(1);
  });

  it("keeps loading lanes open in compact mode instead of collapsing them as empty", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      collapsedStatuses: ["backlog"],
      loadingStatuses: ["in_progress"],
    });

    const inProgress = container.querySelector("[data-kanban-status='in_progress']");
    expect(inProgress?.getAttribute("data-kanban-state")).toBe("loading");
    expect(inProgress?.className).toContain("w-(--sz-260px)");
    // A loaded empty lane still collapses to a rail in compact mode.
    expect(container.querySelector("[data-kanban-status='in_review']")?.className).toContain("w-(--sz-52px)");
  });

  it("re-renders only the card whose issue changed", () => {
    const issues = createIssues(3, "todo");
    // Agents come from a cached query in the app, so they keep their identity.
    const agents = [{ id: "agent-1", name: "Codex" }];
    const { container, render } = renderBoard({ issues, agents });
    // Each card render checks its handoff state exactly once.
    handoffCheck.mockClear();

    render({
      agents,
      issues: issues.map((issue) => (issue.id === "issue-todo-2" ? { ...issue, title: "Renamed by an agent" } : issue)),
    });

    expect(container.textContent).toContain("Renamed by an agent");
    expect(handoffCheck.mock.calls.map(([issue]) => issue.id)).toEqual(["issue-todo-2"]);
  });

  it("resolves drop targets from status rails and cards", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBe("blocked");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });
});
