import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const URL_BASE = `http://localhost:3100/api/companies/${COMPANY_ID}/routines/timeline`;

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [...args, "--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

describe("routine timeline", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks the company route, with the window as query parameters only when given", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["routine", "timeline"]);
    await run(["routine", "timeline", "--from", "2026-10-21T00:00:00Z"]);
    await run(["routine", "timeline", "--from", "2026-10-21T00:00:00+02:00", "--to", "2026-10-23T00:00:00Z"]);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      URL_BASE,
      `${URL_BASE}?from=2026-10-21T00%3A00%3A00Z`,
      `${URL_BASE}?from=2026-10-21T00%3A00%3A00%2B02%3A00&to=2026-10-23T00%3A00%3A00Z`,
    ]);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method ?? "GET").toBe("GET");
    }
  });

  it("prints the full result with --json", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = { rows: [], runs: [], fires: [], nodes: [], edges: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })),
      ),
    );

    await run(["routine", "timeline", "--json"]);

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(result);
  });
});
