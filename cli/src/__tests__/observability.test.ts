import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerObservabilityCommands } from "../commands/client/observability.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerObservabilityCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("observability commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads collector health for the company and prints it", async () => {
    const health = { schemaVersion: 1, terminalRuns24h: 3, derivedRuns24h: 3, pendingRuns: 0 };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(health), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(["observability", "health", "--company-id", COMPANY_ID, "--json"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/observability/health`],
    ]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(health);
  });

  const AGENT_ID = "33333333-3333-4333-8333-333333333333";
  const emptyReport = (groupBy: string) => ({
    groupBy,
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-08T00:00:00.000Z",
    rows: [],
    totals: { key: null, label: null, runs: 0 },
    truncated: false,
  });

  function stubFetch(body: unknown) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends every usage flag as a query parameter and sends none that were not given", async () => {
    const fetchMock = stubFetch(emptyReport("model"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run([
      "observability", "usage", "--company-id", COMPANY_ID, "--json",
      "--group-by", "model", "--since", "2026-10-01", "--until", "2026-10-08",
      "--agent-id", AGENT_ID, "--adapter-type", "claude_local", "--status", "failed", "--limit", "5",
    ]);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/companies/${COMPANY_ID}/observability/usage`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      groupBy: "model",
      since: "2026-10-01",
      until: "2026-10-08",
      agentId: AGENT_ID,
      adapterType: "claude_local",
      status: "failed",
      limit: "5",
    });
  });

  it("calls the usage report with no query string when no flag is given", async () => {
    const fetchMock = stubFetch(emptyReport("agent"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run(["observability", "usage", "--company-id", COMPANY_ID, "--json"]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/observability/usage`);
  });

  it("sends the cause filter to the failures report", async () => {
    const fetchMock = stubFetch(emptyReport("cause"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run(["observability", "failures", "--company-id", COMPANY_ID, "--json", "--cause", "timeout", "--group-by", "agent"]);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/companies/${COMPANY_ID}/observability/failures`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ cause: "timeout", groupBy: "agent" });
  });

  it("prints a readable report with the window and totals when --json is not set", async () => {
    stubFetch({
      ...emptyReport("agent"),
      rows: [{ key: AGENT_ID, label: "Builder", runs: 2, inputTokens: 10, outputTokens: 4, costMicros: 2500 }],
      totals: { key: null, label: null, runs: 2, inputTokens: 10 },
      truncated: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(["observability", "usage", "--company-id", COMPANY_ID]);

    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("2026-10-01T00:00:00.000Z");
    expect(printed).toContain("Builder");
    expect(printed).toContain("totals");
    expect(printed).toContain("more groups");
  });

  it("shows the server's 400 message for a bad window and does not retry", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "'since' must be before 'until'" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    await expect(run(["observability", "usage", "--company-id", COMPANY_ID, "--since", "2026-10-09", "--until", "2026-10-01"])).rejects.toThrow("exit");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("'since' must be before 'until'");
    exit.mockRestore();
  });
});
