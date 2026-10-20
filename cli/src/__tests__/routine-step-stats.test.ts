import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], {
    from: "user",
  });
}

describe("routine step-stats", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function requests(): Array<[string, string]> {
    return fetchMock.mock.calls.map(([url, init]) => [String(init?.method ?? "GET"), String(url)]);
  }

  it("reads the stats of the default window", async () => {
    await run(["routine", "step-stats", ROUTINE_ID]);

    expect(requests()).toEqual([["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}/step-stats`]]);
  });

  it("passes --runs as the window", async () => {
    await run(["routine", "step-stats", ROUTINE_ID, "--runs", "10"]);

    expect(requests()).toEqual([["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}/step-stats?runs=10`]]);
  });
});
