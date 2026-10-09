import { afterEach, describe, expect, it, vi } from "vitest";
import { observabilityApi } from "./observability";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (..._args: unknown[]) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("observabilityApi", () => {
  it("reads collector health", async () => {
    const fetchMock = stubFetch({ schemaVersion: 1 });

    await expect(observabilityApi.health("company-1")).resolves.toEqual({ schemaVersion: 1 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/companies/company-1/observability/health");
  });

  it("sends the usage filters that are set and leaves the others out", async () => {
    const fetchMock = stubFetch({ rows: [] });

    await observabilityApi.usage("company-1", { groupBy: "model", since: "2026-10-01", agentId: "agent-1", limit: 5 });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/companies/company-1/observability/usage");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      groupBy: "model",
      since: "2026-10-01",
      agentId: "agent-1",
      limit: "5",
    });
  });

  it("sends no query string when no filter is set", async () => {
    const fetchMock = stubFetch({ rows: [] });

    await observabilityApi.failures("company-1");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/companies/company-1/observability/failures");
  });

  it("sends the cause filter to the failures report", async () => {
    const fetchMock = stubFetch({ rows: [] });

    await observabilityApi.failures("company-1", { cause: "timeout" });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ cause: "timeout" });
  });
});
