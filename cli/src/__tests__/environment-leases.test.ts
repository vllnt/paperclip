import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCommands } from "../commands/client/workspace.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ENV_ID = "33333333-3333-4333-8333-333333333333";

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

describe("environment lease commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists one environment's leases with an optional status filter", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("[]")));
    vi.stubGlobal("fetch", fetchMock);

    await run(["environment", "leases", ENV_ID]);
    await run(["environment", "leases", ENV_ID, "--status", "released,failed"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/environments/${ENV_ID}/leases`],
      ["GET", `http://localhost:3100/api/environments/${ENV_ID}/leases?status=released%2Cfailed`],
    ]);
  });

  it("lists a company's leases across environments", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("[]")));
    vi.stubGlobal("fetch", fetchMock);

    await run(["environment", "leases:list", "--company-id", COMPANY_ID]);
    await run(["environment", "leases:list", "-C", COMPANY_ID, "--status", "active,expired"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/environment-leases`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/environment-leases?status=active%2Cexpired`],
    ]);
  });
});
