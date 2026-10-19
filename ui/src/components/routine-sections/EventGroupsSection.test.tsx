// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventGroup } from "@/api/eventSources";
import { EventGroupsSection } from "./EventGroupsSection";
import { RoutineDetailContext, type RoutineDetailContextValue } from "./context";

const routineEventGroups = vi.hoisted(() => vi.fn());
vi.mock("@/api/eventSources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/eventSources")>()),
  eventSourcesApi: { routineEventGroups },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

function group(overrides: Partial<EventGroup> = {}): EventGroup {
  return {
    id: "g1",
    companyId: "company-1",
    routineId: "routine-1",
    fingerprint: "upkeep:example-host/disk.usage:/",
    issueId: "issue-uuid-1",
    issueIdentifier: "EXAMPLE-123",
    issueTitle: "example-worker: / at 93%",
    issueStatus: "in_progress",
    firstSeenAt: "2026-10-18T08:00:00Z",
    lastSeenAt: "2026-10-18T11:55:00Z",
    lastCommentAt: "2026-10-18T10:00:00Z",
    repeatCount: 14,
    lastSeverity: "critical",
    lastState: "problem",
    ...overrides,
  };
}

function render(kinds: string[] = ["event"]) {
  const context = {
    companyId: "company-1",
    routine: { id: "routine-1", triggers: kinds.map((kind, index) => ({ id: `t${index}`, kind })) },
  } as unknown as RoutineDetailContextValue;
  return act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RoutineDetailContext.Provider value={context}>
          <EventGroupsSection />
        </RoutineDetailContext.Provider>
      </QueryClientProvider>,
    ),
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("EventGroupsSection", () => {
  it("lists open groups with repeat count, last seen and a link to the issue", async () => {
    routineEventGroups.mockResolvedValue([group()]);
    await render();
    await flush();

    expect(routineEventGroups).toHaveBeenCalledWith("routine-1", { open: true });
    const row = container.querySelector("tbody tr")!;
    expect(row.textContent).toContain("EXAMPLE-123");
    expect(row.textContent).toContain("example-worker: / at 93%");
    expect(row.textContent).toContain("upkeep:example-host/disk.usage:/");
    expect(row.textContent).toContain("14");
    expect(row.textContent).toContain("in progress");
    expect(row.textContent).toContain("critical");
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/issues/EXAMPLE-123");
    expect(row.querySelectorAll("time")).toHaveLength(3);
  });

  it("falls back to the issue ID when the group has no identifier", async () => {
    routineEventGroups.mockResolvedValue([group({ issueIdentifier: null, lastCommentAt: null })]);
    await render();
    await flush();
    expect(container.querySelector("tbody a")?.getAttribute("href")).toBe("/issues/issue-uuid-1");
    expect(container.querySelector("tbody tr")?.textContent).toContain("None");
  });

  it("marks recovered groups", async () => {
    routineEventGroups.mockResolvedValue([group({ lastState: "recovery", lastSeverity: "info" })]);
    await render();
    await flush();
    expect(container.textContent).toContain("recovered");
  });

  it("includes closed groups when 'Open issues only' is switched off", async () => {
    routineEventGroups.mockResolvedValue([group()]);
    await render();
    await flush();
    await act(async () => {
      container.querySelector<HTMLElement>("#" + CSS.escape(container.querySelector("label")!.htmlFor))!.click();
    });
    await flush();
    expect(routineEventGroups).toHaveBeenLastCalledWith("routine-1", { open: false });
  });

  it("shows an empty state for a routine with an Event trigger", async () => {
    routineEventGroups.mockResolvedValue([]);
    await render();
    await flush();
    expect(container.textContent).toContain("No open event groups.");
  });

  it("tells a routine without an Event trigger how to get one", async () => {
    routineEventGroups.mockResolvedValue([]);
    await render(["schedule"]);
    await flush();
    expect(container.textContent).toContain("This routine has no Event trigger.");
    expect(container.textContent).toContain("Triggers tab");
  });

  it("surfaces a load failure", async () => {
    routineEventGroups.mockRejectedValue(new Error("Event groups unavailable"));
    await render();
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Event groups unavailable");
  });
});
