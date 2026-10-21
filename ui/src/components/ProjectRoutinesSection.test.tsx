// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoutineListItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRoutinesSection } from "./ProjectRoutinesSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routinesListMock = vi.hoisted(() => vi.fn());
const routinesUpdateMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const composerRenderMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/routines", () => ({
  routinesApi: { list: routinesListMock, update: routinesUpdateMock, run: vi.fn() },
}));
vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Builder", icon: null }]) },
}));
vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => [{ id: "project-1", name: "Project Alpha", color: null }]) },
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: pushToastMock }) }));
vi.mock("./RoutineRunVariablesDialog", () => ({ RoutineRunVariablesDialog: () => null }));
vi.mock("./RoutineComposerDialog", () => ({
  RoutineComposerDialog: (props: ComposerProps) => {
    composerRenderMock(props);
    if (!props.open) return null;
    return (
      <div data-testid={props.routine ? "routine-editor" : "routine-composer"}>
        {props.routine?.title ?? props.initialDraft?.projectId}
        <button type="button" onClick={() => props.onOpenChange(false)}>Close dialog</button>
      </div>
    );
  },
}));

interface ComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routine?: RoutineListItem | null;
  initialDraft?: { projectId?: string };
  afterCreate?: string;
}

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

function routine(overrides: Partial<RoutineListItem>): RoutineListItem {
  return {
    id: "routine-1",
    title: "Nightly triage",
    status: "active",
    projectId: "project-1",
    assigneeAgentId: "agent-1",
    variables: [],
    lastRun: null,
    ...overrides,
  } as RoutineListItem;
}

describe("ProjectRoutinesSection", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    routinesListMock.mockReset();
    routinesUpdateMock.mockReset();
    pushToastMock.mockReset();
    composerRenderMock.mockReset();
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    queryClient.clear();
  });

  async function renderSection(canCreate = true) {
    root = createRoot(container);
    await act(() => root!.render(
      <QueryClientProvider client={queryClient}>
        <ProjectRoutinesSection companyId="company-1" projectId="project-1" canCreate={canCreate} />
      </QueryClientProvider>,
    ));
    await flush();
  }

  function button(label: string) {
    return [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  }

  it("lists the project's routines with links to their detail pages and hides archived ones until asked", async () => {
    routinesListMock.mockResolvedValue([
      routine({ id: "routine-1", title: "Nightly triage" }),
      routine({ id: "routine-2", title: "Old sync", status: "archived" }),
    ]);

    await renderSection();

    expect(routinesListMock).toHaveBeenCalledWith("company-1", { projectId: "project-1" });
    expect(queryClient.getQueryCache().find({ queryKey: ["routines", "company-1", "project-1"] })).toBeTruthy();
    expect(container.textContent).toContain("Nightly triage");
    expect(container.textContent).toContain("Project Alpha");
    expect(container.textContent).toContain("Builder");
    expect(container.querySelector('a[href="/routines/routine-1/overview"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Old sync");
    expect(button("New routine")).toBeTruthy();
    expect(container.querySelector('[aria-label="Edit Nightly triage"]')).not.toBeNull();

    await act(() => button("Show archived (1)")!.click());

    expect(container.textContent).toContain("Old sync");
    expect(button("Hide archived")).toBeTruthy();
  });

  it("shows an empty state whose New routine opens the composer in place with the project chosen", async () => {
    routinesListMock.mockResolvedValue([]);

    await renderSection();

    expect(container.textContent).toContain("No routines in this project yet.");
    expect(container.querySelector('a[href^="/routines?new=1"]')).toBeNull();
    expect(container.querySelector('[data-testid="routine-composer"]')).toBeNull();

    await act(() => button("New routine")!.click());

    expect(container.querySelector('[data-testid="routine-composer"]')?.textContent).toContain("project-1");
    const props = composerRenderMock.mock.calls
      .map(([call]) => call as ComposerProps)
      .filter((call) => call.open && !call.routine)
      .at(-1);
    expect(props?.initialDraft).toEqual({ projectId: "project-1" });
    expect(props?.afterCreate).toBe("stay");

    await act(() => button("Close dialog")!.click());
    expect(container.querySelector('[data-testid="routine-composer"]')).toBeNull();
  });

  it("offers no New routine for an archived project", async () => {
    routinesListMock.mockResolvedValue([]);

    await renderSection(false);

    expect(container.textContent).toContain("No routines in this project yet.");
    expect(button("New routine")).toBeUndefined();
  });

  it("edits a routine in place from its row", async () => {
    routinesListMock.mockResolvedValue([
      routine({ id: "routine-1", title: "Nightly triage" }),
      routine({ id: "routine-2", title: "Weekly sweep" }),
    ]);

    await renderSection();
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit Nightly triage"]')!.click());

    expect(container.querySelector('[data-testid="routine-editor"]')?.textContent).toContain("Nightly triage");
    expect(container.querySelector('[data-testid="routine-composer"]')).toBeNull();

    await act(() => button("Close dialog")!.click());
    expect(container.querySelector('[data-testid="routine-editor"]')).toBeNull();
    // The closed editor keeps its routine, so the dialog content does not change while it animates out.
    const last = composerRenderMock.mock.calls
      .map(([call]) => call as ComposerProps)
      .filter((call) => call.routine !== undefined)
      .at(-1);
    expect(last?.open).toBe(false);
    expect(last?.routine?.id).toBe("routine-1");
  });

  it("pauses a routine from its row and refreshes the project's list", async () => {
    routinesListMock.mockResolvedValue([routine({ id: "routine-1", title: "Nightly triage" })]);
    routinesUpdateMock.mockResolvedValue({});

    await renderSection();
    const listCalls = routinesListMock.mock.calls.length;
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Disable Nightly triage"]')!.click());
    await flush();

    expect(routinesUpdateMock).toHaveBeenCalledWith("routine-1", { status: "paused" });
    expect(routinesListMock.mock.calls.length).toBeGreaterThan(listCalls);
  });

  it("asks for a default agent instead of enabling a draft routine", async () => {
    routinesListMock.mockResolvedValue([routine({ title: "Draft routine", status: "paused", assigneeAgentId: null })]);

    await renderSection();
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Enable Draft routine"]')!.click());

    expect(routinesUpdateMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Default agent required" }));
  });

  it("keeps a loaded list on screen when a later refetch fails", async () => {
    routinesListMock.mockResolvedValueOnce([routine({ title: "Nightly triage" })]);
    await renderSection();

    routinesListMock.mockRejectedValueOnce(new Error("Server unavailable"));
    await act(() => queryClient.refetchQueries({ queryKey: ["routines", "company-1", "project-1"] }).catch(() => undefined));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Server unavailable");
    expect(container.textContent).toContain("Nightly triage");
  });

  it("says only archived routines exist rather than none", async () => {
    routinesListMock.mockResolvedValue([routine({ status: "archived" })]);

    await renderSection();

    expect(container.textContent).toContain("Only archived routines in this project.");
    expect(button("Show archived (1)")).toBeTruthy();
  });

  it("shows a fetch error inline and retries on request", async () => {
    routinesListMock.mockRejectedValueOnce(new Error("Server unavailable"));

    await renderSection();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Failed to load routines: Server unavailable");
    expect(container.textContent).not.toContain("No routines in this project yet.");

    routinesListMock.mockResolvedValueOnce([routine({ title: "Recovered routine" })]);
    await act(() => button("Retry")!.click());
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Recovered routine");
  });
});
