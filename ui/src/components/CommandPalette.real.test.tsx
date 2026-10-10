// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { CommandActionsProvider } from "../context/CommandActionsContext";

// Unlike CommandPalette.test.tsx, this file renders the real cmdk components
// (no mock of @/components/ui/command), so it checks the production DOM.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Context values are stable in the app; fresh functions per render would
// re-run the palette's effects forever.
const stable = vi.hoisted(() => ({
  company: { selectedCompanyId: "company-1" },
  dialog: { openNewIssue: () => {} },
  sidebar: { isMobile: false, setSidebarOpen: () => {} },
  navigate: vi.fn(),
  search: vi.fn(),
  runDashboard: vi.fn(),
  runTasks: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => stable.company,
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => stable.dialog,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => stable.sidebar,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => stable.navigate,
}));

const NO_BINDINGS = {};

vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]), listLabels: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) },
}));

vi.mock("../api/search", () => ({
  searchApi: { search: stable.search },
}));

const NAV_BINDINGS = {
  "nav.dashboard": { run: stable.runDashboard },
  "nav.tasks": { run: stable.runTasks },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function issueResult(id: string, title: string) {
  return {
    id,
    type: "issue",
    score: 1,
    title,
    href: `/PAP/issues/${id}`,
    matchedFields: ["title"],
    sourceLabel: null,
    snippet: null,
    snippets: [],
    updatedAt: null,
    previewImageUrl: null,
  };
}

function searchResponse(results: ReturnType<typeof issueResult>[]) {
  return {
    query: "",
    normalizedQuery: "",
    scope: "all",
    sort: "relevance",
    limit: 20,
    offset: 0,
    results,
    countsByType: { issue: results.length, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 },
    filterOptionCounts: { status: {}, priority: {}, assigneeAgentId: {}, assigneeUserId: {}, projectId: {}, labelId: {}, updatedWithin: {} },
    zeroResults: null,
    hasMore: false,
  };
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(input: HTMLInputElement, key: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Runs the debounce, the request and the renders that follow. */
async function advance(ms = 200) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function option(name: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>("[role='option']"))
    .find((element) => element.textContent?.includes(name));
}

function selectedOptionText(): string | undefined {
  return document.body.querySelector("[role='option'][aria-selected='true']")?.textContent ?? undefined;
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
  }
  return element.getAttribute("aria-label")?.trim() ?? "";
}

function combobox(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[role='combobox']");
}

function pressCommandK(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("CommandPalette with the real command components", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(extra?: ReactNode, globalBindings: typeof NO_BINDINGS = NO_BINDINGS) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CommandActionsProvider globalBindings={globalBindings}>
            {extra}
            <CommandPalette />
          </CommandActionsProvider>
        </QueryClientProvider>,
      );
    });
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("opens from the page body with a named command search combobox", () => {
    render();
    pressCommandK(document.body);

    const input = combobox();
    expect(input).not.toBeNull();
    expect(accessibleName(input!)).toBe("Command launcher");
  });

  it("leaves Cmd/Ctrl+K to text fields and rich-text editors", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const textarea = document.createElement("textarea");
    render();
    document.body.append(editor, textarea);

    expect(pressCommandK(editor).defaultPrevented).toBe(false);
    expect(pressCommandK(textarea, { metaKey: false, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(combobox()).toBeNull();
  });

  it("ignores Cmd/Ctrl+K during IME composition or after another handler claimed it", () => {
    render();

    pressCommandK(document.body, { isComposing: true });
    expect(combobox()).toBeNull();

    const claimed = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    claimed.preventDefault();
    act(() => {
      document.body.dispatchEvent(claimed);
    });
    expect(combobox()).toBeNull();
  });

  it("does not open over another modal dialog", () => {
    render(<div role="dialog" data-state="open" data-slot="dialog-content">Another dialog</div>);

    expect(pressCommandK(document.body).defaultPrevented).toBe(false);
    expect(combobox()).toBeNull();
  });

  describe("search results that arrive late", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // React Query passes results to React on a later timer tick, which act
      // does not wait for; run that hand-off at once instead.
      notifyManager.setScheduler((callback) => callback());
      stable.navigate.mockReset();
      stable.search.mockReset();
      stable.runDashboard.mockReset();
      stable.runTasks.mockReset();
    });

    afterEach(() => {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      vi.useRealTimers();
    });

    it("does not let Enter open a result of the previous query while the next one loads", async () => {
      const beta = deferred<ReturnType<typeof searchResponse>>();
      stable.search.mockImplementation((_companyId: string, params: { q: string }) =>
        params.q === "alpha" ? Promise.resolve(searchResponse([issueResult("A-1", "Alpha task")])) : beta.promise);
      render();
      pressCommandK(document.body);
      const input = combobox() as HTMLInputElement;

      typeInto(input, "alpha");
      await advance();
      expect(selectedOptionText()).toContain("Alpha task");

      typeInto(input, "beta");
      await advance();
      expect(stable.search).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ q: "beta" }));
      pressKey(input, "Enter");
      await advance(0);
      expect(stable.navigate).not.toHaveBeenCalled();
      // The alpha row may stay on screen, but it cannot be chosen.
      expect(option("Alpha task")?.getAttribute("aria-disabled")).toBe("true");
      expect(document.body.textContent).toContain("Searching…");

      beta.resolve(searchResponse([issueResult("B-1", "Beta task")]));
      await advance(0);
      expect(option("Alpha task")).toBeUndefined();
      expect(selectedOptionText()).toContain("Beta task");
      pressKey(input, "Enter");
      await advance(0);
      expect(stable.navigate).toHaveBeenCalledWith("/PAP/issues/B-1");
    });

    it("keeps a row the user moved to with the arrow keys when results arrive late", async () => {
      const board = deferred<ReturnType<typeof searchResponse>>();
      stable.search.mockImplementation(() => board.promise);
      render(undefined, NAV_BINDINGS);
      pressCommandK(document.body);
      const input = combobox() as HTMLInputElement;

      // "board" is inside "Dashboard" and a keyword of "Tasks"; neither is a
      // strong match, so results would rank above them once they arrive.
      typeInto(input, "board");
      await advance();
      expect(selectedOptionText()).toContain("Dashboard");
      pressKey(input, "ArrowDown");
      expect(selectedOptionText()).toContain("Tasks");

      board.resolve(searchResponse([issueResult("R-1", "Board cleanup")]));
      await advance(0);
      expect(option("Board cleanup")).toBeDefined();
      expect(selectedOptionText()).toContain("Tasks");
      pressKey(input, "Enter");
      await advance(0);
      expect(stable.runTasks).toHaveBeenCalledTimes(1);
      expect(stable.navigate).not.toHaveBeenCalled();

      // A new query follows its best row again.
      stable.search.mockImplementation(() => Promise.resolve(searchResponse([issueResult("R-2", "Board review")])));
      pressCommandK(document.body);
      typeInto(combobox() as HTMLInputElement, "board review");
      await advance();
      expect(selectedOptionText()).toContain("Board review");
    });
  });
});
