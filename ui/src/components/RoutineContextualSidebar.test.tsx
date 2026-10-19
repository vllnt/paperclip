// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routinesApi } from "@/api/routines";
import { queryKeys } from "@/lib/queryKeys";
import {
  RoutineContextualSidebar,
  resolveRoutineDetailDestination,
  routineDetailHref,
} from "./RoutineContextualSidebar";

vi.mock("@/lib/router", () => ({
  useParams: () => ({ routineId: "routine-route" }),
}));

vi.mock("@/api/routines", () => ({
  routinesApi: { get: vi.fn() },
}));

vi.mock("./ContextualSidebarFrame", () => ({
  ContextualSidebarFrame: ({
    surface,
    title,
    fallbackTo,
    showHeader,
    className,
    children,
  }: {
    surface: string;
    title: string;
    fallbackTo: string;
    showHeader?: boolean;
    className?: string;
    children: ReactNode;
  }) => (
    <aside
      className={className}
      data-surface={surface}
      data-title={title}
      data-fallback={fallbackTo}
      data-show-header={String(showHeader)}
    >
      {children}
    </aside>
  ),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: ({ to, label }: { to: string; label: string }) => <a href={to}>{label}</a>,
}));

describe("routine contextual navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("builds stable routine detail destinations", () => {
    expect(routineDetailHref("routine-1")).toBe("/routines/routine-1/overview");
    expect(routineDetailHref("routine-1", "triggers")).toBe("/routines/routine-1/triggers");
    expect(routineDetailHref("routine-1", "runs")).toBe(
      "/routines/routine-1/runs",
    );
    expect(routineDetailHref("routine-1", "activity")).toBe(
      "/routines/routine-1/activity",
    );
  });

  it("defaults and resolves legacy operation routes locally without remembering a prior section", () => {
    expect(resolveRoutineDetailDestination({ routineId: "routine-1" }))
      .toBe("/routines/routine-1/overview");
    expect(resolveRoutineDetailDestination({ routineId: "routine-1", section: "unknown" }))
      .toBe("/routines/routine-1/overview");
    expect(resolveRoutineDetailDestination({ routineId: "routine-1", section: "runs" }))
      .toBe("/routines/routine-1/runs");
    expect(resolveRoutineDetailDestination({ routineId: "routine-1", legacyTab: "activity" }))
      .toBe("/routines/routine-1/activity");
  });

  it("renders the routine contextual sidebar with configuration and operation links", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => root.render(
      <QueryClientProvider client={queryClient}>
        <RoutineContextualSidebar routineId="routine-1" title="Weekly release review" />
      </QueryClientProvider>,
    ));

    const frame = container.querySelector("aside");
    expect(frame?.getAttribute("data-surface")).toBe("routine");
    expect(frame?.getAttribute("data-title")).toBe("Weekly release review");
    expect(frame?.getAttribute("data-fallback")).toBe("/routines");
    expect(frame?.getAttribute("data-show-header")).toBe("false");
    expect(frame?.classList).toContain("bg-background");
    expect(frame?.classList).toContain("border-r");
    expect(container.querySelector('a[href="/routines/routine-1/overview"]')?.textContent).toBe("Overview");
    expect(container.querySelector('a[href="/routines/routine-1/triggers"]')?.textContent).toBe("Triggers");
    expect(container.querySelector('a[href="/routines/routine-1/runs"]'))
      .not.toBeNull();
    expect(container.querySelector('a[href="/routines/routine-1/activity"]'))
      .not.toBeNull();
    expect(container.textContent).not.toContain("History");
  });
  async function renderWithRoutine(triggers: Array<{ id: string; kind: string }>) {
    vi.mocked(routinesApi.get).mockResolvedValue({ id: "routine-1", title: "Alerts", triggers } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => root.render(
      <QueryClientProvider client={queryClient}>
        <RoutineContextualSidebar routineId="routine-1" />
      </QueryClientProvider>,
    ));
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.routines.detail("routine-1"))).toBeDefined(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("links Event groups only for routines with an Event trigger", async () => {
    await renderWithRoutine([{ id: "t1", kind: "event" }]);
    await vi.waitFor(() =>
      expect(container.querySelector('a[href="/routines/routine-1/event-groups"]')?.textContent).toBe("Event groups"),
    );
  });

  it("omits Event groups for routines without an Event trigger", async () => {
    await renderWithRoutine([{ id: "t1", kind: "schedule" }]);
    expect(container.querySelector('a[href="/routines/routine-1/event-groups"]')).toBeNull();
  });
});
