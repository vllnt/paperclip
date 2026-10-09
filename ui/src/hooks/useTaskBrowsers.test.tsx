// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { useTaskBrowsers } from "./useTaskBrowsers";

vi.mock("@/api/browser-use", () => ({
  browserUseApi: { list: vi.fn(async () => []) },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const listMock = vi.mocked(browserUseApi.list);

const runningBrowser: TaskBrowser = {
  id: "browser-1",
  sessionId: "session-1",
  issueId: "issue-1",
  status: "running",
  runStatus: null,
  progress: null,
  costCents: 0,
  idleDeadline: null,
  expiresAt: null,
  error: null,
  createdAt: "2026-10-09T12:00:00.000Z",
};

function Probe({ runExpected }: { runExpected?: boolean }) {
  useTaskBrowsers("issue-1", runExpected);
  return null;
}

describe("useTaskBrowsers polling", () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;

  async function render(runExpected?: boolean) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe runExpected={runExpected} />
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
    listMock.mockReset();
    listMock.mockResolvedValue([]);
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

  it("polls every few seconds by default", async () => {
    await render();
    await advance(30_000);
    expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("polls every few seconds while a run is expected", async () => {
    await render(true);
    await advance(30_000);
    expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("slows to a safety poll when no run is expected and no session is listed", async () => {
    await render(false);
    await advance(30_000);
    expect(listMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps the fast poll while a running session is listed", async () => {
    listMock.mockResolvedValue([runningBrowser]);
    await render(false);
    await advance(30_000);
    expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("speeds up as soon as a run becomes expected", async () => {
    await render(false);
    await advance(2_000);
    const before = listMock.mock.calls.length;
    await render(true);
    await advance(7_000);
    expect(listMock.mock.calls.length - before).toBeGreaterThanOrEqual(2);
  });
});
