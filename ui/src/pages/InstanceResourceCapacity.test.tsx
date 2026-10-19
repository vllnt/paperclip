// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResourceCapacitySnapshot } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { InstanceResourceCapacity } from "./InstanceResourceCapacity";

const mockResourceCapacityApi = vi.hoisted(() => ({
  instance: vi.fn(),
  company: vi.fn(),
}));

vi.mock("@/api/resourceCapacity", () => ({
  resourceCapacityApi: mockResourceCapacityApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GIB = 1024 ** 3;

function snapshot(overrides: Partial<ResourceCapacitySnapshot> = {}): ResourceCapacitySnapshot {
  return {
    level: "ok",
    metricLevels: { "disk:workspaces": "ok", memory: "ok", load: "ok" },
    sampledAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    readingStatus: "ok",
    cpuCount: 8,
    load1: 1,
    load5: 2,
    load15: 3,
    loadPerCore: 0.25,
    memTotalBytes: 16 * GIB,
    memAvailableBytes: 8 * GIB,
    disks: [{ labels: ["workspaces"], totalBytes: 100 * GIB, freeBytes: 40 * GIB, freePercent: 40 }],
    ...overrides,
  };
}

describe("InstanceResourceCapacity", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceResourceCapacity />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("lists every server host and environment with its level and numbers", async () => {
    mockResourceCapacityApi.instance.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      hosts: [{ ...snapshot(), targetKey: "instance:abc", hostLabel: "server-1", current: true }],
      environments: [
        {
          ...snapshot({
            level: "critical",
            disks: [{ labels: ["workspaces"], totalBytes: 100 * GIB, freeBytes: 3 * GIB, freePercent: 3 }],
          }),
          environmentId: "env-1",
          environmentName: "Worker",
          driver: "ssh",
          sampling: "sampled",
        },
        {
          ...snapshot({ level: "unknown" }),
          environmentId: "env-2",
          environmentName: "Cloud sandbox",
          driver: "sandbox",
          sampling: "unsupported",
        },
      ],
    });

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("server-1 · this server");
    expect(text).toContain("disk workspaces 40.0 GiB free (40%)");
    expect(text).toContain("Worker · ssh");
    expect(text).toContain("Critical");
    expect(text).toContain("disk workspaces 3.0 GiB free (3%) · memory 8.0 GiB of 16.0 GiB available · load 0.25/core");
    expect(text).toContain("Cloud sandbox · sandbox");
    expect(text).toContain("Capacity is not measured for this driver.");
  });

  it("explains that the page is for instance admins when the server answers 403", async () => {
    mockResourceCapacityApi.instance.mockRejectedValue(new ApiError("Instance admin required", 403, null));

    await render();

    expect(container.textContent).toContain("Instance admin access is required to view resource capacity.");
  });

  it("says so when nothing has reported yet", async () => {
    mockResourceCapacityApi.instance.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      hosts: [],
      environments: [],
    });

    await render();

    expect(container.textContent).toContain("No host has reported yet.");
    expect(container.textContent).toContain("No environments.");
  });
});
