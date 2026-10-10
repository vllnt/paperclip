import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const FOLDER_ID = "44444444-4444-4444-8444-444444444444";
const BASE = `http://localhost:3100/api/companies/${COMPANY_ID}/routines`;

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

describe("routine list filters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends each filter flag as its query parameter, and nothing when no flag is given", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["routine", "list"]);
    await run(["routine", "list", "--q", "weekly review"]);
    await run(["routine", "list", "--agent-id", AGENT_ID]);
    await run(["routine", "list", "--folder-id", "none"]);
    await run(["routine", "list", "--folder-id", FOLDER_ID, "--status", "paused", "--trigger", "manual"]);
    await run(["routine", "list", "--project-id", "p1", "--trigger", "schedule"]);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      BASE,
      `${BASE}?q=weekly+review`,
      `${BASE}?assigneeAgentId=${AGENT_ID}`,
      `${BASE}?folderId=none`,
      `${BASE}?folderId=${FOLDER_ID}&status=paused&trigger=manual`,
      `${BASE}?projectId=p1&trigger=schedule`,
    ]);
  });
});
