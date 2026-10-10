import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCommands } from "../commands/client/workspace.js";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const READINESS_URL = `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}/close-readiness`;
const WORKSPACE_URL = `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}`;

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerWorkspaceCommands(program);
  await program.parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

// Answers close readiness with `readiness` (a status code, or a body), and the
// PATCH with the archived workspace.
function respond(readiness: unknown) {
  return vi.fn().mockImplementation((url: string) => {
    if (!url.endsWith("/close-readiness")) {
      return Promise.resolve(new Response(JSON.stringify({ id: WORKSPACE_ID, status: "archived" })));
    }
    return Promise.resolve(typeof readiness === "number"
      ? new Response(JSON.stringify({ error: "unavailable" }), { status: readiness })
      : new Response(JSON.stringify(readiness)));
  });
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0], call[1]?.body ?? null]);
}

describe("workspace archive", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("checks close readiness, then archives the workspace", async () => {
    const fetchMock = respond({ state: "ready", blockingReasons: [], warnings: [] });
    vi.stubGlobal("fetch", fetchMock);

    await run(["workspace", "archive", WORKSPACE_ID]);

    expect(calls(fetchMock)).toEqual([
      ["GET", READINESS_URL, null],
      ["PATCH", WORKSPACE_URL, JSON.stringify({ status: "archived" })],
    ]);
  });

  it("refuses without a PATCH while close readiness is blocked, and names the reasons", async () => {
    const fetchMock = respond({ state: "blocked", blockingReasons: ["This workspace is still linked to an open issue."] });
    vi.stubGlobal("fetch", fetchMock);

    await expect(run(["workspace", "archive", WORKSPACE_ID])).rejects.toThrow("exit 1");

    expect(calls(fetchMock)).toEqual([["GET", READINESS_URL, null]]);
    expect(String(errors.mock.calls[0]?.[0])).toContain("This workspace is still linked to an open issue.");
  });

  it("shows the warnings and archives only with --yes", async () => {
    const readiness = { state: "ready_with_warnings", blockingReasons: [], warnings: ["The workspace has 1 untracked file."] };
    const refused = respond(readiness);
    vi.stubGlobal("fetch", refused);

    await expect(run(["workspace", "archive", WORKSPACE_ID])).rejects.toThrow("exit 1");
    expect(calls(refused)).toEqual([["GET", READINESS_URL, null]]);
    expect(String(errors.mock.calls[0]?.[0])).toContain("The workspace has 1 untracked file.");

    const accepted = respond(readiness);
    vi.stubGlobal("fetch", accepted);
    await run(["workspace", "archive", WORKSPACE_ID, "--yes"]);
    expect(calls(accepted).map((call) => call[0])).toEqual(["GET", "PATCH"]);
  });

  it.each([
    ["an error", 503],
    ["no readiness", {}],
  ] as const)("archives nothing when close readiness returns %s", async (_label, readiness) => {
    const fetchMock = respond(readiness);
    vi.stubGlobal("fetch", fetchMock);

    await expect(run(["workspace", "archive", WORKSPACE_ID, "--yes"])).rejects.toThrow("exit 1");

    expect(calls(fetchMock)).toEqual([["GET", READINESS_URL, null]]);
  });
});
