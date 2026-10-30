// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoutineTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutinesTimeline } from "./RoutinesTimeline";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockRoutinesApi = vi.hoisted(() => ({ timeline: vi.fn() }));
const mockRouter = vi.hoisted(() => ({ search: "" }));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/api/routines", () => ({
  routinesApi: mockRoutinesApi,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/routines/timeline" }),
  useNavigate: () => mockNavigate,
  Link: ({ to, children, ...rest }: { to: string; children: unknown } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children as never}
    </a>
  ),
  useSearchParams: () => {
    const [params, setParams] = useState(() => new URLSearchParams(mockRouter.search));
    const set = (next: URLSearchParams | ((current: URLSearchParams) => URLSearchParams)) =>
      setParams(typeof next === "function" ? next(params) : next);
    return [params, set] as const;
  },
}));

vi.mock("@/components/RequestCollapsedSidebar", () => ({
  RequestCollapsedSidebar: () => <div data-testid="request-collapsed-sidebar" />,
}));

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function result(overrides: Partial<RoutineTimelineResult> = {}): RoutineTimelineResult {
  return {
    window: { from: new Date(NOW.getTime() - 24 * HOUR).toISOString(), to: new Date(NOW.getTime() + 24 * HOUR).toISOString() },
    generatedAt: NOW.toISOString(),
    rows: [
      {
        id: "routine:r1",
        kind: "routine",
        refId: "r1",
        title: "Nightly digest",
        status: "active",
        scheduled: true,
        triggers: [
          { id: "t1", kind: "schedule", label: null, enabled: true, cronExpression: "0 9 * * *", timezone: "UTC", nextRunAt: "2026-10-22T09:00:00.000Z", eventSourceId: null },
        ],
      },
      {
        id: "routine:r2",
        kind: "routine",
        refId: "r2",
        title: "Triage on event",
        status: "active",
        scheduled: false,
        triggers: [
          { id: "t2", kind: "event", label: null, enabled: true, cronExpression: null, timezone: null, nextRunAt: null, eventSourceId: "s1" },
        ],
      },
      { id: "routine:r3", kind: "routine", refId: "r3", title: "Manual cleanup", status: "paused", scheduled: false, triggers: [] },
    ],
    runs: [
      {
        id: "run-a",
        rowId: "routine:r1",
        triggerId: "t1",
        source: "schedule",
        status: "completed",
        start: "2026-10-21T09:00:00.000Z",
        end: "2026-10-21T09:20:00.000Z",
        linkedIssueId: "issue-7",
        linkedIssue: { id: "issue-7", identifier: "PAP-7", title: "Digest for 21 Oct", status: "done" },
      },
      {
        id: "run-b",
        rowId: "routine:r2",
        triggerId: "t2",
        source: "event",
        status: "failed",
        start: "2026-10-21T10:00:00.000Z",
        end: "2026-10-21T10:05:00.000Z",
        linkedIssueId: null,
        linkedIssue: null,
      },
    ],
    fires: [{ rowId: "routine:r1", triggerId: "t1", at: "2026-10-22T09:00:00.000Z" }],
    nodes: [
      { id: "routine:r1", kind: "routine", refId: "r1", label: "Nightly digest", parentId: null, status: "active" },
      { id: "routine:r2", kind: "routine", refId: "r2", label: "Triage on event", parentId: null, status: "active" },
      { id: "routine:r3", kind: "routine", refId: "r3", label: "Manual cleanup", parentId: null, status: "paused" },
      { id: "step:r1:a", kind: "step", refId: "a", label: "Collect", parentId: "routine:r1", status: null },
      { id: "step:r1:b", kind: "step", refId: "b", label: "Write", parentId: "routine:r1", status: null },
      { id: "event_source:s1", kind: "event_source", refId: "s1", label: "Inbound mail", parentId: null, status: null },
    ],
    edges: [
      { id: "e1", kind: "event_trigger", from: "event_source:s1", to: "routine:r2", label: "subject: urgent", enabled: true, triggerId: "t2", issueId: null, runId: null },
      { id: "e2", kind: "step_after", from: "step:r1:a", to: "step:r1:b", label: null, enabled: true, triggerId: null, issueId: null, runId: null },
    ],
    limits: { fires: { cap: 500, truncated: false }, runs: { cap: 5000, truncated: false } },
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("RoutinesTimeline", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  async function renderPage() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <RoutinesTimeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function press(selector: string) {
    const element = container.querySelector(selector);
    expect(element, selector).not.toBeNull();
    flushSync(() => {
      element!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      element!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockRoutinesApi.timeline.mockResolvedValue(result());
    mockRouter.search = "";
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("asks for a day back and a day ahead of now by default", async () => {
    await renderPage();
    expect(mockRoutinesApi.timeline).toHaveBeenCalledTimes(1);
    const [companyId, params] = mockRoutinesApi.timeline.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(params).toEqual({ from: "2026-10-20T12:00:00.000Z", to: "2026-10-22T12:00:00.000Z" });
  });

  it("draws one bar per past run and per next fire, with scheduled routines apart from the rest", async () => {
    await renderPage();
    const bars = Array.from(container.querySelectorAll("[data-run-id]")).map((node) => node.getAttribute("data-run-id"));
    expect(bars).toContain("run-a");
    expect(bars).toContain("run-b");
    expect(bars.filter((id) => id?.startsWith("fire:"))).toHaveLength(1);
    const sections = Array.from(container.querySelectorAll('[data-testid="work-timeline-section"]')).map((node) => node.textContent);
    expect(sections).toEqual(["Scheduled", "No schedule · past runs only"]);
    // The gutter shortens long names; its tooltip keeps the whole name and the paused state.
    const names = Array.from(container.querySelectorAll('[data-testid="work-timeline-actor-gutter"] > g > title')).map((node) => node.textContent);
    expect(names).toEqual(["Nightly digest", "Triage on event", "Manual cleanup (paused)"]);
  });

  it("summarises the routines, the schedule and the next fire", async () => {
    await renderPage();
    const stats = Array.from(container.querySelectorAll("dl > div")).map((node) => node.textContent);
    expect(stats[0]).toBe("Routines3");
    expect(stats[1]).toBe("Scheduled1");
    expect(stats[2]).toBe("Runs in window2");
    expect(stats[3]).toContain("Next fire");
    expect(stats[3]).not.toContain("None in window");
  });

  it("opens the issue of a run, and the routine when the run made no issue", async () => {
    await renderPage();
    press('[data-run-id="run-a"]');
    expect(mockNavigate).toHaveBeenLastCalledWith("/issues/PAP-7");
    press('[data-run-id="run-b"]');
    expect(mockNavigate).toHaveBeenLastCalledWith("/routines/r2");
  });

  it("widens the window to a week each side", async () => {
    await renderPage();
    press('[aria-label="Span"] button:last-child');
    await flushReact();
    const params = mockRoutinesApi.timeline.mock.calls.at(-1)![1] as { from: string; to: string };
    expect(new Date(params.to).getTime() - new Date(params.from).getTime()).toBe(14 * 24 * HOUR);
  });

  it("moves the window by its span and back to now", async () => {
    await renderPage();
    press('[aria-label="Later"]');
    await flushReact();
    expect(mockRoutinesApi.timeline.mock.calls.at(-1)![1]).toEqual({ from: "2026-10-21T12:00:00.000Z", to: "2026-10-23T12:00:00.000Z" });
    press('[aria-label="Earlier"]');
    press('[aria-label="Earlier"]');
    await flushReact();
    expect(mockRoutinesApi.timeline.mock.calls.at(-1)![1]).toEqual({ from: "2026-10-19T12:00:00.000Z", to: "2026-10-21T12:00:00.000Z" });
  });

  it("shows the link graph in the Links view with its steps and the list of links", async () => {
    mockRouter.search = "?view=links";
    await renderPage();
    expect(container.querySelector('[data-testid="routine-timeline"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="routine-link-node-routine"]').length).toBe(3);
    expect(container.querySelector('[data-testid="routine-link-edge-event_trigger"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="routine-link-edge-step_after"]')).not.toBeNull();
    const items = Array.from(container.querySelectorAll('[data-testid="routine-link-item"]')).map((node) => node.textContent);
    expect(items).toContain("Inbound mail starts Triage on event · subject: urgent");
    expect(items).toContain("Write waits for Collect");
  });

  it("switches views from the tabs", async () => {
    await renderPage();
    expect(container.querySelector('[data-testid="routine-timeline"]')).not.toBeNull();
    press('[role="tab"][data-state="inactive"]');
    await flushReact();
    expect(container.querySelector('[data-testid="routine-links"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="routine-timeline"]')).toBeNull();
  });

  it("says when the response held back fires or runs", async () => {
    mockRoutinesApi.timeline.mockResolvedValue(
      result({ limits: { fires: { cap: 500, truncated: true }, runs: { cap: 5000, truncated: true } } }),
    );
    await renderPage();
    const note = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(note).toContain("earliest 500 next fires");
    expect(note).toContain("newest 5000 runs");
  });

  it("shows an empty state when the company has no routines", async () => {
    mockRoutinesApi.timeline.mockResolvedValue(result({ rows: [], runs: [], fires: [], nodes: [], edges: [] }));
    await renderPage();
    expect(container.textContent).toContain("No routines yet");
    expect(container.querySelector('[data-testid="routine-timeline"]')).toBeNull();
  });

  it("shows an error state when the request fails", async () => {
    mockRoutinesApi.timeline.mockRejectedValue(new Error("boom"));
    await renderPage();
    expect(container.textContent).toContain("Couldn't load the routines timeline");
  });

  it("registers its breadcrumbs", async () => {
    await renderPage();
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Routines", href: "/routines" }, { label: "Timeline" }]);
  });
});
