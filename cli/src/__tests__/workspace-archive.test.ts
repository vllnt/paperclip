import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCommands } from "../commands/client/workspace.js";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";

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

function respond(readiness: unknown) {
  return vi.fn().mockImplementation((url: string) =>
    Promise.resolve(new Response(JSON.stringify(url.endsWith("/close-readiness") ? readiness : { id: WORKSPACE_ID, status: "archived" }))));
}

describe("workspace archive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("checks close readiness, then archives the workspace", async () => {
    const fetchMock = respond({ state: "ready", blockingReasons: [] });
    vi.stubGlobal("fetch", fetchMock);

    await run(["workspace", "archive", WORKSPACE_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0], call[1]?.body ?? null])).toEqual([
      ["GET", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}/close-readiness`, null],
      ["PATCH", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}`, JSON.stringify({ status: "archived" })],
    ]);
  });

  it("refuses without a PATCH while close readiness is blocked, and names the reasons", async () => {
    const fetchMock = respond({ state: "blocked", blockingReasons: ["This workspace is still linked to an open issue."] });
    vi.stubGlobal("fetch", fetchMock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(run(["workspace", "archive", WORKSPACE_ID])).rejects.toThrow("exit 1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("This workspace is still linked to an open issue.");
  });
});
