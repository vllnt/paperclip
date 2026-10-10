// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  sidebar: { isMobile: false, setSidebarOpen: () => {} },
  navigate: () => {},
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => stable.company,
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

  function render(extra?: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CommandActionsProvider globalBindings={NO_BINDINGS}>
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
});
