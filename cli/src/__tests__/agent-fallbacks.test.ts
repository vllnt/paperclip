import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "../commands/client/agent.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAgentCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function jsonResponse(body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("agent fallbacks commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets and clears an agent's fallback chain through PATCH /api/agents/:id", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const fallbacks = [{
      adapterType: "codex_local",
      model: "gpt-5.5",
      effort: "high",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID }, CODEX_HOME: "/srv/codex-home" },
    }];

    await run(["agent", "fallbacks:set", AGENT_ID, "--fallbacks-json", JSON.stringify(fallbacks)]);
    await run(["agent", "fallbacks:clear", AGENT_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method, call[0], JSON.parse(String(call[1]?.body))])).toEqual([
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}`, { fallbacks }],
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}`, { fallbacks: [] }],
    ]);
  });

  it("rejects an Anthropic model on Codex before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      run(["agent", "fallbacks:set", AGENT_ID, "--fallbacks-json", JSON.stringify([{ adapterType: "codex_local", model: "claude-opus-5-5" }])]),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("Anthropic models never run through codex_local");
    exit.mockRestore();
  });
});
