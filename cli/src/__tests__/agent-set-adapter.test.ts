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

const codexAgent = (config: Record<string, unknown>, runtimeConfig: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  adapterType: "codex_local",
  adapterConfig: config,
  runtimeConfig,
});

const GROK_CONFIG = {
  model: "grok-4.7",
  modelReasoningEffort: "high",
  cwd: "/work/app",
  instructionsFilePath: "/work/app/AGENTS.md",
  env: {
    OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    OPENAI_BASE_URL: { type: "plain", value: "https://proxy.example/v1" },
  },
  search: true,
};

function stubApi(agent: unknown) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(jsonResponse(init?.method === "PATCH" ? { ...(agent as object), adapterType: "grok_local" } : agent)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("agent set-adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves a codex_local agent running a Grok model to grok_local through PATCH /api/agents/:id", async () => {
    const fetchMock = stubApi(codexAgent(GROK_CONFIG));
    await run(["agent", "set-adapter", AGENT_ID, "grok_local"]);

    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0], call[1]?.body ? JSON.parse(String(call[1].body)) : undefined]);
    expect(calls).toEqual([
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}`, undefined],
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}`, {
        adapterType: "grok_local",
        replaceAdapterConfig: true,
        adapterConfig: {
          model: "grok-4.7",
          reasoningEffort: "high",
          cwd: "/work/app",
          instructionsFilePath: "/work/app/AGENTS.md",
          env: {
            XAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
            GROK_XAI_API_BASE_URL: { type: "plain", value: "https://proxy.example/v1" },
          },
        },
      }],
    ]);
  });

  it("takes the gateway URL from --xai-base-url, because the API returns the Codex base URL redacted", async () => {
    const fetchMock = stubApi(codexAgent({
      model: "grok-4.7",
      env: { OPENAI_BASE_URL: { type: "plain", value: "***REDACTED***" }, OPENAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" } },
    }));
    await run(["agent", "set-adapter", AGENT_ID, "grok_local", "--xai-base-url", "https://gateway.example/v1"]);
    const patch = fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1].body)).adapterConfig.env).toEqual({
      XAI_API_KEY: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      GROK_XAI_API_BASE_URL: { type: "plain", value: "https://gateway.example/v1" },
    });
  });

  it("with --dry-run reports the plan and changes nothing", async () => {
    const fetchMock = stubApi(codexAgent(GROK_CONFIG));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["agent", "set-adapter", AGENT_ID, "grok_local", "--dry-run", "--json"]);

    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET"]);
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed.dryRun).toBe(true);
    expect(printed.patch.adapterType).toBe("grok_local");
    expect(printed.changes.join("\n")).toContain("OPENAI_API_KEY -> XAI_API_KEY");
  });

  it("refuses without calling PATCH when the agent runs a GPT model", async () => {
    const fetchMock = stubApi(codexAgent({ model: "gpt-5.5" }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(["agent", "set-adapter", AGENT_ID, "grok_local"])).rejects.toThrow();
    expect(fetchMock.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET"]);
    expect(error.mock.calls.flat().join(" ")).toContain("not an xAI model");
    exit.mockRestore();
  });

  it("supports only grok_local as the target", async () => {
    const fetchMock = stubApi(codexAgent(GROK_CONFIG));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(["agent", "set-adapter", AGENT_ID, "claude_local"])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("grok_local");
    exit.mockRestore();
  });
});
