// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Routine } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { RoutineComposerDialog, routineEditPatch, routineComposerDraftFrom } from "./RoutineComposerDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const foldersListMock = vi.hoisted(() => vi.fn(async () => ({ folders: [] })));
const activeAgents = [{ id: "agent-1", name: "Builder", role: "engineer", status: "active" }];
const activeProjects = [{ id: "project-1", name: "Project Alpha", color: null, archivedAt: null }];
const agentsListMock = vi.hoisted(() => vi.fn());
const projectsListMock = vi.hoisted(() => vi.fn());
const activeGoals = [{ id: "goal-1", title: "Ship the beta", description: null, status: "active" }];
const goalsListMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
}));
vi.mock("../api/routines", () => ({ routinesApi: { create: createMock, update: updateMock } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: agentsListMock } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: projectsListMock } }));
vi.mock("../api/folders", () => ({ foldersApi: { list: foldersListMock } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: goalsListMock } }));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: vi.fn(async () => ({ users: [] })) } }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: pushToastMock }) }));
vi.mock("./MarkdownEditor", () => ({ MarkdownEditor: () => <div data-testid="markdown-editor" /> }));
vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: (props: {
    value?: string;
    placeholder?: string;
    options?: { id: string; label: string }[];
    onChange?: (id: string) => void;
  }) => (
    // A click picks the first option, standing in for a choice in the real picker.
    <button
      type="button"
      data-selector={props.placeholder}
      data-labels={props.options?.map((option) => option.label).join("|")}
      onClick={() => props.onChange?.(props.options?.[0]?.id ?? "")}
    >
      {props.value || props.placeholder}
    </button>
  ),
}));

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

function savedRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: "project-1",
    folderId: null,
    goalId: null,
    title: "Nightly triage",
    description: "Sort new tasks",
    assigneeAgentId: "agent-1",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [{ name: "repo", defaultValue: "app" }],
    latestRevisionId: "revision-3",
    ...overrides,
  } as Routine;
}

function typeInto(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("routineEditPatch", () => {
  it("is null when nothing the dialog edits changed", () => {
    const routine = savedRoutine();
    expect(routineEditPatch(routine, routineComposerDraftFrom(routine))).toBeNull();
    expect(routineEditPatch(routine, { ...routineComposerDraftFrom(routine), description: "Sort new tasks" })).toBeNull();
  });

  it("sends only the changed fields with the revision the edit started from, never the variable settings", () => {
    const routine = savedRoutine();
    const draft = { ...routineComposerDraftFrom(routine), title: "Morning triage", projectId: "", variables: [] };

    expect(routineEditPatch(routine, draft)).toEqual({
      title: "Morning triage",
      projectId: null,
      baseRevisionId: "revision-3",
    });
  });

  it("links, changes and clears the goal", () => {
    const routine = savedRoutine({ goalId: "goal-1" });
    expect(routineEditPatch(routine, { ...routineComposerDraftFrom(routine), goalId: "goal-2" })).toEqual({
      goalId: "goal-2",
      baseRevisionId: "revision-3",
    });
    expect(routineEditPatch(routine, { ...routineComposerDraftFrom(routine), goalId: "" })).toEqual({
      goalId: null,
      baseRevisionId: "revision-3",
    });
  });

  it("clears the instructions with null", () => {
    const routine = savedRoutine();
    expect(routineEditPatch(routine, { ...routineComposerDraftFrom(routine), description: "   " })).toEqual({
      description: null,
      baseRevisionId: "revision-3",
    });
  });
});

describe("RoutineComposerDialog", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  const onOpenChange = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    createMock.mockReset();
    updateMock.mockReset();
    navigateMock.mockReset();
    pushToastMock.mockReset();
    foldersListMock.mockClear();
    agentsListMock.mockReset().mockResolvedValue(activeAgents);
    projectsListMock.mockReset().mockResolvedValue(activeProjects);
    goalsListMock.mockReset().mockResolvedValue(activeGoals);
    onOpenChange.mockReset();
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    queryClient.clear();
  });

  async function render(element: ReactNode) {
    root = createRoot(container);
    await rerender(element);
  }

  async function rerender(element: ReactNode) {
    await act(() => root!.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>));
    await flush();
  }

  const projectListKey = ["routines", "company-1", "project-1"];

  function seedProjectList() {
    queryClient.setQueryData(projectListKey, []);
    expect(queryClient.getQueryState(projectListKey)?.isInvalidated).toBe(false);
  }

  function projectListInvalidated() {
    return queryClient.getQueryState(projectListKey)?.isInvalidated;
  }

  function dialog() {
    return document.body.querySelector<HTMLElement>('[role="dialog"]');
  }

  function dialogButton(label: string) {
    return [...(dialog()?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.includes(label));
  }

  function titleInput() {
    return dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Routine title"]')!;
  }

  it("creates a routine in the chosen project and stays on the page when asked to", async () => {
    createMock.mockResolvedValue({ ...savedRoutine({ id: "routine-new", title: "Weekly sweep" }), warnings: [] });

    await render(
      <RoutineComposerDialog
        companyId="company-1"
        open
        onOpenChange={onOpenChange}
        initialDraft={{ projectId: "project-1" }}
        afterCreate="stay"
      />,
    );

    expect(dialog()?.textContent).toContain("New routine");
    expect(dialog()?.querySelector('[data-selector="Project"]')?.textContent).toBe("project-1");
    expect(dialogButton("Create routine")?.disabled).toBe(true);
    seedProjectList();

    await act(() => typeInto(titleInput(), "Weekly sweep"));
    await act(() => dialogButton("Create routine")!.click());
    await flush();

    expect(projectListInvalidated()).toBe(true);
    expect(createMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "Weekly sweep",
      projectId: "project-1",
      assigneeAgentId: null,
      description: null,
    }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Routine created",
      action: { label: "Add a trigger", href: "/routines/routine-new/triggers" },
    }));
  });

  it("creates a routine for the goal it opened with", async () => {
    createMock.mockResolvedValue({ ...savedRoutine({ id: "routine-new", goalId: "goal-1" }), warnings: [] });

    await render(
      <RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} initialDraft={{ goalId: "goal-1" }} afterCreate="stay" />,
    );

    expect(dialog()?.querySelector('[data-selector="Goal"]')?.textContent).toBe("goal-1");
    await act(() => typeInto(titleInput(), "Weekly sweep"));
    await act(() => dialogButton("Create routine")!.click());
    await flush();

    expect(createMock).toHaveBeenCalledWith("company-1", expect.objectContaining({ title: "Weekly sweep", goalId: "goal-1", projectId: null }));
  });

  it("links a saved routine to a goal", async () => {
    const routine = savedRoutine();
    updateMock.mockResolvedValue({ ...routine, goalId: "goal-1", warnings: [] });

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={routine} />);
    expect(dialog()?.querySelector('[data-selector="Goal"]')?.textContent).toBe("Goal");
    expect(dialogButton("Save changes")?.disabled).toBe(true);

    await act(() => (dialog()!.querySelector('[data-selector="Goal"]') as HTMLButtonElement).click());
    expect(dialog()?.querySelector('[data-selector="Goal"]')?.textContent).toBe("goal-1");
    await act(() => dialogButton("Save changes")!.click());
    await flush();

    expect(updateMock).toHaveBeenCalledWith("routine-1", { goalId: "goal-1", baseRevisionId: "revision-3" });
  });

  it("opens trigger setup after a create by default", async () => {
    createMock.mockResolvedValue({ ...savedRoutine({ id: "routine-new" }), warnings: [] });

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} />);
    await act(() => typeInto(titleInput(), "Weekly sweep"));
    await act(() => dialogButton("Create routine")!.click());
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/routines/routine-new/triggers");
    expect(pushToastMock).toHaveBeenCalledWith(expect.not.objectContaining({ action: expect.anything() }));
  });

  it("edits a routine: starts from its saved fields and saves only what changed", async () => {
    const routine = savedRoutine();
    updateMock.mockResolvedValue({ ...routine, title: "Morning triage", warnings: [] });

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={routine} />);

    expect(dialog()?.textContent).toContain("Edit routine");
    expect(titleInput().value).toBe("Nightly triage");
    expect(dialog()?.querySelector('[data-selector="Responsible"]')?.textContent).toBe("agent-1");
    expect(dialog()?.querySelector('a[href="/routines/routine-1/overview"]')?.textContent).toContain("Open the full editor");
    expect(dialogButton("Save changes")?.disabled).toBe(true);

    await act(() => typeInto(titleInput(), "Morning triage"));
    expect(dialogButton("Save changes")?.disabled).toBe(false);
    seedProjectList();
    await act(() => dialogButton("Save changes")!.click());
    await flush();

    expect(projectListInvalidated()).toBe(true);
    expect(titleInput().value).toBe("Morning triage");
    expect(updateMock).toHaveBeenCalledWith("routine-1", { title: "Morning triage", baseRevisionId: "revision-3" });
    expect(createMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Routine saved" }));
  });

  it("says when someone else saved the routine first and keeps the dialog open", async () => {
    updateMock.mockRejectedValue(new ApiError("Routine was updated by someone else", 409, {}));

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={savedRoutine()} />);
    await act(() => typeInto(titleInput(), "Morning triage"));
    seedProjectList();
    await act(() => dialogButton("Save changes")!.click());
    await flush();

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Someone else saved this routine");
    expect(projectListInvalidated()).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(pushToastMock).not.toHaveBeenCalled();
  });

  it("drops the last save error once closed, so a reopened routine starts clean", async () => {
    updateMock.mockRejectedValue(new ApiError("Routine was updated by someone else", 409, {}));
    const routine = savedRoutine();

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={routine} />);
    await act(() => typeInto(titleInput(), "Morning triage"));
    await act(() => dialogButton("Save changes")!.click());
    await flush();
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();

    await rerender(<RoutineComposerDialog companyId="company-1" open={false} onOpenChange={onOpenChange} routine={routine} />);
    await rerender(
      <RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={savedRoutine({ id: "routine-2", title: "Weekly report" })} />,
    );

    expect(titleInput().value).toBe("Weekly report");
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps an unsaved new routine across a reopen and drops unsaved edits to a saved one", async () => {
    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} initialDraft={{ projectId: "project-1" }} />);
    await act(() => typeInto(titleInput(), "Weekly sweep"));
    await rerender(<RoutineComposerDialog companyId="company-1" open={false} onOpenChange={onOpenChange} initialDraft={{ projectId: "project-1" }} />);
    await rerender(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} initialDraft={{ projectId: "project-2" }} />);

    expect(titleInput().value).toBe("Weekly sweep");
    expect(dialog()?.querySelector('[data-selector="Project"]')?.textContent).toBe("project-2");

    await act(() => root!.unmount());
    root = null;
    const routine = savedRoutine();
    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={routine} />);
    await act(() => typeInto(titleInput(), "Morning triage"));
    await rerender(<RoutineComposerDialog companyId="company-1" open={false} onOpenChange={onOpenChange} routine={routine} />);
    await rerender(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={routine} />);

    expect(titleInput().value).toBe("Nightly triage");
  });

  it("lists a saved routine's terminated agent and archived project only while editing it", async () => {
    agentsListMock.mockResolvedValue([...activeAgents, { id: "agent-old", name: "Retired", role: "engineer", status: "terminated" }]);
    projectsListMock.mockResolvedValue([...activeProjects, { id: "project-old", name: "Old project", color: null, archivedAt: "2026-01-01T00:00:00.000Z" }]);

    await render(
      <RoutineComposerDialog
        companyId="company-1"
        open
        onOpenChange={onOpenChange}
        routine={savedRoutine({ assigneeAgentId: "agent-old", projectId: "project-old" })}
      />,
    );

    expect(dialog()?.querySelector('[data-selector="Responsible"]')?.getAttribute("data-labels")).toBe("Builder|Retired (terminated)");
    expect(dialog()?.querySelector('[data-selector="Project"]')?.getAttribute("data-labels")).toBe("Project Alpha|Old project (archived)");

    await act(() => root!.unmount());
    root = null;
    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} />);

    expect(dialog()?.querySelector('[data-selector="Responsible"]')?.getAttribute("data-labels")).toBe("Builder");
    expect(dialog()?.querySelector('[data-selector="Project"]')?.getAttribute("data-labels")).toBe("Project Alpha");
  });

  it("lists a saved routine's cancelled goal only while editing it", async () => {
    goalsListMock.mockResolvedValue([...activeGoals, { id: "goal-old", title: "Old goal", description: null, status: "cancelled" }]);

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} routine={savedRoutine({ goalId: "goal-old" })} />);
    expect(dialog()?.querySelector('[data-selector="Goal"]')?.getAttribute("data-labels")).toBe("Ship the beta|Old goal (cancelled)");

    await act(() => root!.unmount());
    root = null;
    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} />);
    expect(dialog()?.querySelector('[data-selector="Goal"]')?.getAttribute("data-labels")).toBe("Ship the beta");
  });

  it("fetches nothing while closed and loads its lists once opened", async () => {
    await render(<RoutineComposerDialog companyId="company-1" open={false} onOpenChange={onOpenChange} />);
    expect(dialog()).toBeNull();
    expect(foldersListMock).not.toHaveBeenCalled();
    expect(goalsListMock).not.toHaveBeenCalled();

    await act(() => root!.render(
      <QueryClientProvider client={queryClient}>
        <RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    ));
    await flush();

    expect(dialog()).not.toBeNull();
    expect(foldersListMock).toHaveBeenCalledWith("company-1", "routine");
    expect(goalsListMock).toHaveBeenCalledWith("company-1");
  });

  it("shows a create failure inline", async () => {
    createMock.mockRejectedValue(new ApiError("Project not found", 404, {}));

    await render(<RoutineComposerDialog companyId="company-1" open onOpenChange={onOpenChange} />);
    await act(() => typeInto(titleInput(), "Weekly sweep"));
    await act(() => dialogButton("Create routine")!.click());
    await flush();

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Project not found");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
