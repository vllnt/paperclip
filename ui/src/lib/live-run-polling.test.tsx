// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_RUN_FAST_POLL_MS,
  LIVE_RUN_IDLE_POLL_MS,
  TASK_BROWSER_ACTIVE_POLL_MS,
  liveRunsRefetchInterval,
  taskBrowsersRefetchInterval,
} from "./live-run-polling";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("liveRunsRefetchInterval", () => {
  it("polls fast while runs are listed", () => {
    const interval = liveRunsRefetchInterval(false);
    expect(interval({ state: { data: [{ id: "run-1" }] } })).toBe(LIVE_RUN_FAST_POLL_MS);
  });

  it("polls fast while a run is expected even if none is listed yet", () => {
    expect(liveRunsRefetchInterval(true)({ state: { data: [] } })).toBe(LIVE_RUN_FAST_POLL_MS);
    expect(liveRunsRefetchInterval(true)({ state: { data: undefined } })).toBe(LIVE_RUN_FAST_POLL_MS);
  });

  it("falls back to the safety poll when nothing is running", () => {
    expect(liveRunsRefetchInterval(false)({ state: { data: [] } })).toBe(LIVE_RUN_IDLE_POLL_MS);
    expect(liveRunsRefetchInterval(false)({ state: { data: undefined } })).toBe(LIVE_RUN_IDLE_POLL_MS);
  });

  it("honours a custom active cadence", () => {
    expect(liveRunsRefetchInterval(true, 3000)({ state: { data: [] } })).toBe(3000);
  });
});

describe("taskBrowsersRefetchInterval", () => {
  it("polls fast while a run is expected", () => {
    expect(taskBrowsersRefetchInterval(true)({ state: { data: [] } })).toBe(TASK_BROWSER_ACTIVE_POLL_MS);
  });

  it("keeps a visible running or idle session fresh", () => {
    const interval = taskBrowsersRefetchInterval(false);
    expect(interval({ state: { data: [{ status: "running" }] } })).toBe(TASK_BROWSER_ACTIVE_POLL_MS);
    expect(interval({ state: { data: [{ status: "idle" }] } })).toBe(TASK_BROWSER_ACTIVE_POLL_MS);
  });

  it("falls back to the safety poll with no run and no live session", () => {
    const interval = taskBrowsersRefetchInterval(false);
    expect(interval({ state: { data: [] } })).toBe(LIVE_RUN_IDLE_POLL_MS);
    expect(interval({ state: { data: [{ status: "closed" }] } })).toBe(LIVE_RUN_IDLE_POLL_MS);
    expect(interval({ state: { data: undefined } })).toBe(LIVE_RUN_IDLE_POLL_MS);
  });
});

describe("liveRunsRefetchInterval with React Query", () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;

  function Probe({ fetchRuns, runExpected }: { fetchRuns: () => Promise<{ id: string }[]>; runExpected: boolean }) {
    useQuery({
      queryKey: ["live-runs-probe"],
      queryFn: fetchRuns,
      refetchInterval: liveRunsRefetchInterval(runExpected),
    });
    return null;
  }

  async function mount(fetchRuns: () => Promise<{ id: string }[]>, runExpected: boolean) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe fetchRuns={fetchRuns} runExpected={runExpected} />
        </QueryClientProvider>,
      );
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    queryClient.clear();
    vi.useRealTimers();
  });

  it("makes at most a few requests in 30 s while the issue is idle", async () => {
    const fetchRuns = vi.fn(async () => []);
    await mount(fetchRuns, false);
    await advance(30_000);
    expect(fetchRuns.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps the fast poll while a run is listed", async () => {
    const fetchRuns = vi.fn(async () => [{ id: "run-1" }]);
    await mount(fetchRuns, false);
    await advance(10_000);
    expect(fetchRuns.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("keeps the fast poll while a run is expected", async () => {
    const fetchRuns = vi.fn(async () => []);
    await mount(fetchRuns, true);
    await advance(10_000);
    expect(fetchRuns.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("speeds up as soon as a run becomes expected", async () => {
    const fetchRuns = vi.fn(async () => []);
    await mount(fetchRuns, false);
    await advance(2_000);
    const before = fetchRuns.mock.calls.length;
    await mount(fetchRuns, true);
    await advance(5_000);
    expect(fetchRuns.mock.calls.length - before).toBeGreaterThanOrEqual(4);
  });
});
