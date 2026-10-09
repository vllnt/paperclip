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

  it("includes routine execution issues in search queries", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const setQueryButton = container.querySelector('button[aria-label="Set query"]');
    expect(setQueryButton).not.toBeNull();

    act(() => {
      setQueryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "pull/3303",
        limit: 10,
        includeRoutineExecutions: true,
      });
    });

    act(() => {
      root.unmount();
    });
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
    expect(groupHeadings(container)[0]).toBe("This view");
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
      expect(groupHeadings(container).slice(0, 3)).toEqual(["Navigate", "Create", "General"]);
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
      expect(groupHeadings(container)[0]).toBe("Recent");
    });
    expect(container.querySelector('section[aria-label="Recent"]')?.textContent).toContain("Agents");
    expect(container.querySelector('section[aria-label="Navigate"]')?.textContent).not.toContain("Agents");

    act(() => {
      root.unmount();
    });
  });

  it("offers a Search-all command when the query is non-empty and routes Enter to /search when no issues match", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "auth flake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const searchAllButton = container.querySelector(
        'button[data-testid="command-search-all"]',
      ) as HTMLButtonElement | null;
      expect(searchAllButton).not.toBeNull();
      expect(searchAllButton!.textContent).toContain("auth flake");
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=auth+flake");
    });

    act(() => {
      root.unmount();
    });
  });

  it("promotes matching projects above the Tasks group when typing", async () => {
    const projects = [
      { id: "p1", urlKey: "mobile", name: "Mobile App", description: "iOS client", archivedAt: null },
      { id: "p2", urlKey: "billing", name: "Billing Service", description: null, archivedAt: null },
    ];
    mockProjectsApi.list.mockResolvedValue(projects);
    mockIssuesApi.list.mockImplementation((_companyId: string, opts?: { q?: string }) =>
      Promise.resolve(opts?.q ? [{ id: "i1", identifier: "ENG-9", title: "Fix login" }] : []),
    );

    const { root } = renderWithQueryClient(<CommandPalette />, container, (queryClient) => {
      // Seed the caches so the already-loaded data is available synchronously —
      // this harness's flush model doesn't reliably propagate fresh async fetches.
      queryClient.setQueryData(queryKeys.projects.list("company-1"), projects);
      queryClient.setQueryData(queryKeys.issues.search("company-1", "mob", undefined, 10), [
        { id: "i1", identifier: "ENG-9", title: "Fix login" },
      ]);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "mob");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const match = container.querySelector('button[data-testid="command-project-match"]');
      expect(match).not.toBeNull();
      expect(match!.textContent).toContain("Mobile App");
    });

    // Non-matching project is excluded from the typeahead results.
    expect(container.textContent).not.toContain("Billing Service");

    // The promoted project renders above the fold — before the Tasks group.
    await waitForAssertion(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("Fix login");
      expect(text.indexOf("Mobile App")).toBeLessThan(text.indexOf("Fix login"));
    });

    // Selecting the promoted project navigates to its URL.
    act(() => {
      container
        .querySelector('button[data-testid="command-project-match"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/projects/mobile");
    });

    act(() => {
      root.unmount();
    });
  });

  it("navigates to /search when the user clicks the Search-all command", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "deflake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    let searchAllButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      searchAllButton = container.querySelector(
        'button[data-testid="command-search-all"]',
      ) as HTMLButtonElement | null;
      expect(searchAllButton).not.toBeNull();
    });

    act(() => {
      searchAllButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=deflake");
    });

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

  it("parses operators for lightweight issue search but keeps filters for command-enter handoff", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "auth status:blocked updated:>7d");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "auth",
        limit: 10,
        includeRoutineExecutions: true,
      });
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=auth&status=blocked&updatedWithin=7d");
    });

    act(() => {
      root.unmount();
    });
  });

});
