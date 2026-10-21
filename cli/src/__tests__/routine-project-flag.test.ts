import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

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

describe("routine --project-id on create and update", () => {
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

  it("creates the routine in the project", async () => {
    await run(["routine", "create", "--payload-json", '{"title":"Nightly triage"}', "--project-id", PROJECT_ID]);

    expect(lastRequest()).toEqual({
      url: `http://localhost:3100/api/companies/${COMPANY_ID}/routines`,
      method: "POST",
      body: { title: "Nightly triage", projectId: PROJECT_ID },
    });
  });

  it("moves a routine to a project, or out of any project with none", async () => {
    await run(["routine", "update", ROUTINE_ID, "--project-id", PROJECT_ID]);
    expect(lastRequest()).toEqual({
      url: `http://localhost:3100/api/routines/${ROUTINE_ID}`,
      method: "PATCH",
      body: { projectId: PROJECT_ID },
    });

    await run(["routine", "update", ROUTINE_ID, "--payload-json", '{"title":"Renamed"}', "--project-id", "none"]);
    expect(lastRequest().body).toEqual({ title: "Renamed", projectId: null });
  });

  it("leaves the payload unchanged without the flag", async () => {
    await run(["routine", "update", ROUTINE_ID, "--payload-json", '{"projectId":null}']);
    expect(lastRequest().body).toEqual({ projectId: null });
  });

  async function refusal(args: string[]): Promise<string> {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(run(args)).rejects.toThrow("exit 1");
    expect(fetchMock).not.toHaveBeenCalled();
    return errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
  }

  it("refuses a project in both the payload and the flag", async () => {
    const message = await refusal([
      "routine", "update", ROUTINE_ID, "--payload-json", `{"projectId":"${PROJECT_ID}"}`, "--project-id", "none",
    ]);
    expect(message).toContain("Pass projectId either in --payload-json or with --project-id, not both.");
  });

  it("refuses the flag with a payload that is not a JSON object", async () => {
    const message = await refusal(["routine", "update", ROUTINE_ID, "--payload-json", "[]", "--project-id", PROJECT_ID]);
    expect(message).toContain("--payload-json must be a JSON object when --project-id is used.");
  });
});
