// @vitest-environment jsdom

import type { KeyboardEventHandler, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { queryKeys } from "../lib/queryKeys";
import { CommandActionsProvider, useRegisterCommandActions, type CommandActionBindings } from "../context/CommandActionsContext";
import { useGlobalCommandActionBindings } from "../lib/command-action-bindings";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
  openNewAgent: vi.fn(),
  openNewProject: vi.fn(),
  openNewGoal: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSearchApi = vi.hoisted(() => ({
  search: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
  useDialogActions: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

const navigateState = vi.hoisted(() => ({
  navigate: vi.fn(),
}));
const locationState = vi.hoisted(() => ({
  location: { pathname: "/", search: "", hash: "" },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateState.navigate,
  useLocation: () => locationState.location,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/search", () => ({
  searchApi: mockSearchApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: { heading?: string; children: ReactNode }) => (
    <section aria-label={heading}>{children}</section>
  ),
  CommandInput: ({
    value,
    onValueChange,
    onKeyDown,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  }) => (
    <div>
      <input
        aria-label="Command search"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" aria-label="Set query" onClick={() => onValueChange("pull/3303")} />
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    "data-testid"?: string;
  }) => (
    <button data-testid={testId} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandSeparator: () => <hr />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

const noop = () => {};

function PageActions({ bindings }: { bindings: CommandActionBindings }) {
  useRegisterCommandActions(bindings);
  return null;
}

function Shell({ children, pageActions }: { children: ReactNode; pageActions?: CommandActionBindings }) {
  const globalBindings = useGlobalCommandActionBindings({
    onToggleSidebar: noop,
    onTogglePanel: noop,
    onShowShortcuts: noop,
  });
  return (
    <CommandActionsProvider globalBindings={globalBindings}>
      {pageActions ? <PageActions bindings={pageActions} /> : null}
      {children}
    </CommandActionsProvider>
  );
}

function openPalette() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  });
}

function typeQuery(container: HTMLElement, value: string) {
  const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

/** Search requests are debounced and fetched asynchronously; wait past both. */
async function settleDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

function groupHeadings(container: HTMLElement) {
  return Array.from(container.querySelectorAll("section[aria-label]")).map((section) => section.getAttribute("aria-label"));
}

function renderWithQueryClient(
  node: ReactNode,
  container: HTMLDivElement,
  seedQueryClient?: (queryClient: QueryClient) => void,
  pageActions?: CommandActionBindings,
) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  seedQueryClient?.(queryClient);

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Shell pageActions={pageActions}>{node}</Shell>
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

function searchResult(type: "issue" | "project" | "agent" | "artifact", id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    score: 1,
    title,
    href: `/PAP/${type === "issue" ? "issues" : `${type}s`}/${id}`,
    matchedFields: ["title"],
    sourceLabel: null,
    snippet: null,
    snippets: [],
    updatedAt: null,
    previewImageUrl: null,
    ...extra,
  };
}

function searchResponse(results: ReturnType<typeof searchResult>[], page: { offset?: number; hasMore?: boolean; total?: number } = {}) {
  const issues = results.filter((result) => result.type === "issue").length;
  return {
    query: "",
    normalizedQuery: "",
    scope: "all",
    sort: "relevance",
    limit: 20,
    offset: page.offset ?? 0,
    results,
    countsByType: { issue: page.total ?? issues, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 },
    filterOptionCounts: { status: {}, priority: {}, assigneeAgentId: {}, assigneeUserId: {}, projectId: {}, labelId: {}, updatedWithin: {} },
    zeroResults: null,
    hasMore: page.hasMore ?? false,
  };
}

describe("CommandPalette", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
    dialogState.openNewAgent.mockReset();
    dialogState.openNewProject.mockReset();
    dialogState.openNewGoal.mockReset();
    window.localStorage.clear();
    sidebarState.setSidebarOpen.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockAuthApi.getSession.mockReset();
    mockSearchApi.search.mockReset();
    mockSearchApi.search.mockImplementation(() => Promise.resolve(searchResponse([])));
    navigateState.navigate.mockReset();
    locationState.location.pathname = "/";
    locationState.location.search = "";
    locationState.location.hash = "";
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableExperimentalFileViewer: false,
    });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { userId: "user-1" } });
  });

  afterEach(() => {
    container.remove();
    window.localStorage.clear();
  });

  it("lists only the contextual actions the current page registers, under This view", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container, undefined, {
      "issue.focus-comment": { run: vi.fn() },
      "issue.open-file": null,
    });

    openPalette();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Create new task");
    });
    expect(groupHeadings(container).slice(0, 2)).toEqual(["Create", "This view"]);
    expect(container.querySelector('section[aria-label="This view"]')?.textContent).toContain("Comment on this task");
    expect(container.textContent).not.toContain("Open file in this issue");

    act(() => {
      root.unmount();
    });
  });

  it("runs a registered contextual action and closes the palette", async () => {
    const openFile = vi.fn();
    const { root } = renderWithQueryClient(<CommandPalette />, container, undefined, {
      "issue.open-file": { run: openFile },
    });

    openPalette();

    let row: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      row = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open file in this issue"));
      expect(row).toBeDefined();
    });
    act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input[aria-label="Command search"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("groups global actions for an empty query and shows their shortcuts", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    openPalette();

    await waitForAssertion(() => {
      expect(groupHeadings(container).slice(0, 3)).toEqual(["Create", "Navigate", "General"]);
    });
    const navigateGroup = container.querySelector('section[aria-label="Navigate"]');
    expect(navigateGroup?.textContent).toContain("Dashboard");
    expect(navigateGroup?.textContent).toContain("Approvals");
    expect(navigateGroup?.textContent).toMatch(/Dashboard\s*gthend/);

    act(() => {
      root.unmount();
    });
  });

  it("lists a typed action first when its title starts with the query, and runs it", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    openPalette();
    typeQuery(container, "dash");

    await waitForAssertion(() => {
      expect(groupHeadings(container)[0]).toBe("Actions");
    });
    const firstRow = container.querySelector('section[aria-label="Actions"] button');
    expect(firstRow?.textContent).toContain("Dashboard");

    act(() => {
      firstRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateState.navigate).toHaveBeenCalledWith("/dashboard");

    act(() => {
      root.unmount();
    });
  });

  it("opens the create dialogs from their actions", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    openPalette();
    typeQuery(container, "create new pro");

    let row: Element | null = null;
    await waitForAssertion(() => {
      row = container.querySelector('section[aria-label="Actions"] button');
      expect(row?.textContent).toContain("Create new project");
    });
    act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(dialogState.openNewProject).toHaveBeenCalledTimes(1);
    expect(navigateState.navigate).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("follows the sidebar's Connectors gate: hidden in the legacy shell unless apps are enabled", async () => {
    const legacy = { enableStreamlinedUi: false, enableApps: false };
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(legacy);
    const { root } = renderWithQueryClient(<CommandPalette />, container, (queryClient) => {
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, legacy);
    });

    openPalette();
    await waitForAssertion(() => {
      expect(container.querySelector('section[aria-label="Navigate"]')?.textContent).toContain("Dashboard");
    });
    expect(container.textContent).not.toContain("Connectors");

    act(() => {
      root.unmount();
    });

    const streamlined = { enableStreamlinedUi: true };
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(streamlined);
    const second = renderWithQueryClient(<CommandPalette />, container, (queryClient) => {
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, streamlined);
    });
    openPalette();
    await waitForAssertion(() => {
      expect(container.querySelector('section[aria-label="Navigate"]')?.textContent).toContain("Connectors");
    });

    act(() => {
      second.root.unmount();
    });
  });

  it("lists Goals even when the sidebar hides its Goals link", async () => {
    // The sidebar-link flag only places a link; the /goals route always
    // exists, and the previous palette always listed Goals.
    const settings = { enableStreamlinedUi: true, enableGoalsSidebarLink: false };
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(settings);
    const { root } = renderWithQueryClient(<CommandPalette />, container, (queryClient) => {
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, settings);
    });

    openPalette();
    await waitForAssertion(() => {
      expect(container.querySelector('section[aria-label="Navigate"]')?.textContent).toContain("Goals");
    });

    act(() => {
      root.unmount();
    });
  });

  it("remembers used actions and lists them under Recent", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    openPalette();
    typeQuery(container, "agents");
    let row: Element | null = null;
    await waitForAssertion(() => {
      row = container.querySelector('section[aria-label="Actions"] button');
      expect(row?.textContent).toContain("Agents");
    });
    act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    openPalette();

    await waitForAssertion(() => {
      expect(groupHeadings(container).slice(0, 2)).toEqual(["Create", "Recent"]);
    });
    expect(container.querySelector('section[aria-label="Recent"]')?.textContent).toContain("Agents");
    expect(container.querySelector('section[aria-label="Navigate"]')?.textContent).not.toContain("Agents");

    act(() => {
      root.unmount();
    });
  });

  it("renders quick-filter chips and inserts them into the palette query", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    await waitForAssertion(() => {
      const chips = Array.from(container.querySelectorAll('button[data-testid="command-filter-chip"]'));
      expect(chips.map((chip) => chip.textContent)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("assignee:me"),
          expect.stringContaining("is:open"),
          expect.stringContaining("updated:>7d"),
        ]),
      );
    });

    act(() => {
      container.querySelector('button[data-testid="command-filter-chip"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    await waitForAssertion(() => {
      expect(input.value).toBe("assignee:me");
    });

    act(() => {
      root.unmount();
    });
  });

  it("puts Create new task first for an empty query and opens the new task dialog", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();

    let first: Element | null = null;
    await waitForAssertion(() => {
      first = container.querySelector('section[aria-label="Create"] button');
      expect(groupHeadings(container)[0]).toBe("Create");
      expect(first?.textContent).toContain("Create new task");
    });
    act(() => {
      first!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForAssertion(() => {
      expect(dialogState.openNewIssue).toHaveBeenCalledTimes(1);
    });

    act(() => {
      root.unmount();
    });
  });

  it("searches the company search endpoint with the text, filters, scope and sort", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();
    typeQuery(container, "auth status:blocked updated:>7d scope:issues sort:updated");
    await settleDebounce();

    await waitForAssertion(() => {
      expect(mockSearchApi.search).toHaveBeenCalledWith("company-1", {
        q: "auth",
        status: ["blocked"],
        updatedWithin: "7d",
        scope: "issues",
        sort: "updated",
        limit: 20,
        offset: 0,
      });
    });
    expect(navigateState.navigate).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("does not search scope: or sort: alone, says to add words or a filter, and searches once they are added", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();
    const hint = () => container.querySelector('[data-testid="command-search-hint"]')?.textContent ?? "";

    for (const query of ["scope:issues", "sort:updated", "scope:issues sort:updated"]) {
      typeQuery(container, query);
      await settleDebounce();
      expect(mockSearchApi.search).not.toHaveBeenCalled();
      expect(hint()).toContain("Add words or a filter");
    }

    typeQuery(container, "scope:issues sort:updated deploy");
    await settleDebounce();
    await waitForAssertion(() => {
      expect(mockSearchApi.search).toHaveBeenCalledTimes(1);
    });
    expect(mockSearchApi.search).toHaveBeenCalledWith("company-1", { q: "deploy", scope: "issues", sort: "updated", limit: 20, offset: 0 });
    expect(hint()).toBe("");

    typeQuery(container, "scope:issues status:todo");
    await settleDebounce();
    await waitForAssertion(() => {
      expect(mockSearchApi.search).toHaveBeenCalledTimes(2);
    });
    expect(mockSearchApi.search).toHaveBeenLastCalledWith("company-1", { q: "", status: ["todo"], scope: "issues", limit: 20, offset: 0 });

    act(() => {
      root.unmount();
    });
  });

  it("groups results by kind with the best match first, and opens one", async () => {
    mockSearchApi.search.mockImplementation(() => Promise.resolve(searchResponse([
      searchResult("project", "p1", "Mobile App"),
      searchResult("issue", "i1", "Fix mobile login", { issue: { identifier: "ENG-9" } }),
      searchResult("project", "p2", "Mobile Web"),
    ])));
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();
    typeQuery(container, "mob");
    await settleDebounce();

    await waitForAssertion(() => {
      expect(container.querySelectorAll('button[data-testid="command-search-result"]')).toHaveLength(3);
    });
    const headings = groupHeadings(container);
    expect(headings.indexOf("Projects")).toBeLessThan(headings.findIndex((heading) => heading?.startsWith("Tasks")));
    expect(container.querySelector('section[aria-label^="Tasks"]')?.textContent).toContain("ENG-9");

    act(() => {
      container.querySelector<HTMLButtonElement>('button[data-testid="command-search-result"]')!.click();
    });
    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/PAP/projects/p1");
    });

    act(() => {
      root.unmount();
    });
  });

  it("loads more than the first page of results", async () => {
    const page = (offset: number, count: number, hasMore: boolean) =>
      searchResponse(
        Array.from({ length: count }, (_, index) => searchResult("issue", `i${offset + index}`, `Deploy task ${offset + index}`)),
        { offset, hasMore, total: 30 },
      );
    mockSearchApi.search.mockImplementation((_companyId: string, params: { offset?: number }) =>
      Promise.resolve(params.offset ? page(20, 10, false) : page(0, 20, true)));
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();
    typeQuery(container, "deploy");
    await settleDebounce();

    let more: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      more = container.querySelector<HTMLButtonElement>('button[data-testid="command-search-more"]');
      expect(more?.textContent).toContain("20 of 30");
    });
    act(() => {
      more!.click();
    });
    await settleDebounce();

    await waitForAssertion(() => {
      expect(container.querySelectorAll('button[data-testid="command-search-result"]')).toHaveLength(30);
    });
    expect(mockSearchApi.search).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ q: "deploy", offset: 20 }));
    expect(container.querySelector('button[data-testid="command-search-more"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("shows a visible empty state that offers to create a task from the text", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();
    typeQuery(container, "qqxz nothing");
    await settleDebounce();

    let create: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="command-search-empty"]')?.textContent).toContain("qqxz nothing");
      create = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Create task"));
      expect(create).toBeDefined();
    });
    act(() => {
      create!.click();
    });
    await waitForAssertion(() => {
      expect(dialogState.openNewIssue).toHaveBeenCalledWith({ title: "qqxz nothing" });
    });

    act(() => {
      root.unmount();
    });
  });

  it("surfaces search errors with a retry instead of hiding them", async () => {
    mockSearchApi.search.mockImplementation(() => Promise.reject(new Error("Search is down")));
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    openPalette();
    typeQuery(container, "deploy");
    await settleDebounce();

    let retry: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      retry = container.querySelector<HTMLButtonElement>('button[data-testid="command-search-error"]');
      expect(retry?.textContent).toContain("Search is down");
    });
    const calls = mockSearchApi.search.mock.calls.length;
    act(() => {
      retry!.click();
    });
    await waitForAssertion(() => {
      expect(mockSearchApi.search.mock.calls.length).toBeGreaterThan(calls);
    });

    act(() => {
      root.unmount();
    });
  });
});
