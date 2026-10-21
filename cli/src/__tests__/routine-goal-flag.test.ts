import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const GOAL_ID = "55555555-5555-4555-8555-555555555555";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  const company = args[1] === "create" ? ["--company-id", COMPANY_ID] : [];
  await createProgram().parseAsync(
    [...args, ...company, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

describe("routine --goal-id on create and update", () => {
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

  function lastRequest(): { url: string; method: string; body: unknown } {
    const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
    return { url: String(url), method: String(init?.method), body: JSON.parse(String(init?.body)) };
  }

  it("creates the routine for the goal, together with its project", async () => {
    await run([
      "routine", "create", "--payload-json", '{"title":"Nightly triage"}', "--project-id", PROJECT_ID, "--goal-id", GOAL_ID,
    ]);

    expect(lastRequest()).toEqual({
      url: `http://localhost:3100/api/companies/${COMPANY_ID}/routines`,
      method: "POST",
      body: { title: "Nightly triage", projectId: PROJECT_ID, goalId: GOAL_ID },
    });
  });

  it("links a routine to a goal, or unlinks it with none", async () => {
    await run(["routine", "update", ROUTINE_ID, "--goal-id", GOAL_ID]);
    expect(lastRequest()).toEqual({
      url: `http://localhost:3100/api/routines/${ROUTINE_ID}`,
      method: "PATCH",
      body: { goalId: GOAL_ID },
    });

    await run(["routine", "update", ROUTINE_ID, "--payload-json", '{"title":"Renamed"}', "--goal-id", "none"]);
    expect(lastRequest().body).toEqual({ title: "Renamed", goalId: null });
  });

  it("refuses a goal in both the payload and the flag", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(
      run(["routine", "update", ROUTINE_ID, "--payload-json", `{"goalId":"${GOAL_ID}"}`, "--goal-id", "none"]),
    ).rejects.toThrow("exit 1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Pass goalId either in --payload-json or with --goal-id, not both.",
    );
  });
});
