import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompanyCommands } from "../commands/client/company.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCompanyCommands(program);
  await program.parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("company run tier commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads and sets a company's tiers", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const tiers = { tiers: { fast: { adapterType: "codex_local", model: "grok-4.7" } }, agentAllowlist: ["fast"] };
    await run(["company", "run-tiers", COMPANY_ID]);
    await run(["company", "run-tiers:set", COMPANY_ID, "--tiers-json", JSON.stringify(tiers)]);
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0], call[1]?.body ? JSON.parse(String(call[1].body)) : null])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/run-tiers`, null],
      ["PUT", `http://localhost:3100/api/companies/${COMPANY_ID}/run-tiers`, tiers],
    ]);
  });

  it("rejects an Anthropic model on Codex before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(["company", "run-tiers:set", COMPANY_ID, "--tiers-json", JSON.stringify({ tiers: { fast: { adapterType: "codex_local", model: "claude-opus-5-5" } }, agentAllowlist: [] })])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("Anthropic models never run through codex_local");
  });
});
