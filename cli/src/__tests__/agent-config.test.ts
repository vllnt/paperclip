import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentConfigMergePatch, readConfigPath } from "../commands/client/agent-config.js";
import { registerAgentCommands } from "../commands/client/agent.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAgentCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], {
    from: "user",
  });
}

function jsonResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("buildAgentConfigMergePatch", () => {
  it("builds nested merge patches from dotted assignments and unsets", () => {
    expect(
      buildAgentConfigMergePatch(
        ["runtimeConfig.heartbeat.maxDailyRuns=64", "adapterConfig.model=gpt-5", "adapterConfig.fastMode=true"],
        ["adapterConfig.env.DEBUG"],
      ),
    ).toEqual({
      runtimeConfig: { heartbeat: { maxDailyRuns: 64 } },
      adapterConfig: { model: "gpt-5", fastMode: true, env: { DEBUG: null } },
    });
  });

  it("keeps a JSON-quoted value as text and accepts objects", () => {
    expect(buildAgentConfigMergePatch(['adapterConfig.effort="64"', 'adapterConfig.env.TOKEN={"type":"secret_ref","secretId":"s1"}'])).toEqual({
      adapterConfig: { effort: "64", env: { TOKEN: { type: "secret_ref", secretId: "s1" } } },
    });
  });

  it("rejects paths outside adapterConfig and runtimeConfig, malformed assignments and empty patches", () => {
    expect(() => buildAgentConfigMergePatch(["budgetMonthlyCents=100"])).toThrow(/adapterConfig\.<key> or runtimeConfig\.<key>/);
    expect(() => buildAgentConfigMergePatch(["runtimeConfig"])).toThrow(/path=value/);
    expect(() => buildAgentConfigMergePatch(["runtimeConfig=1"])).toThrow(/Invalid config path/);
    expect(() => buildAgentConfigMergePatch([])).toThrow(/Nothing to change/);
    expect(() => buildAgentConfigMergePatch([], ["adapterConfig.env.X", "adapterConfig.model=gpt-5"])).toThrow(
      /--unset takes paths, not assignments/,
    );
    expect(() => buildAgentConfigMergePatch(["adapterConfig.__proto__.polluted=1"])).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads a dotted path from an agent", () => {
    const agent = { adapterConfig: { model: "gpt-5" }, runtimeConfig: { heartbeat: { maxDailyRuns: 10 } } };
    expect(readConfigPath(agent, "runtimeConfig.heartbeat.maxDailyRuns")).toBe(10);
    expect(readConfigPath(agent, "runtimeConfig")).toEqual({ heartbeat: { maxDailyRuns: 10 } });
    expect(readConfigPath(agent, "adapterConfig.missing.key")).toBeUndefined();
    expect(readConfigPath(agent, undefined)).toEqual(agent);
  });
});

describe("agent config commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a merge patch for config set", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: AGENT_ID })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["agent", "config", "set", AGENT_ID, "runtimeConfig.heartbeat.maxDailyRuns=64", "--unset", "adapterConfig.env.DEBUG"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3100/api/agents/${AGENT_ID}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      mergeConfig: true,
      runtimeConfig: { heartbeat: { maxDailyRuns: 64 } },
      adapterConfig: { env: { DEBUG: null } },
    });
  });

  it("prints the patch without sending it on --dry-run", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(["agent", "config", "set", AGENT_ID, "adapterConfig.model=gpt-5", "--dry-run"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ mergeConfig: true, adapterConfig: { model: "gpt-5" } });
  });

  it("reads one dotted path for config get", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ id: AGENT_ID, adapterConfig: {}, runtimeConfig: { heartbeat: { maxDailyRuns: 10 } } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(["agent", "config", "get", AGENT_ID, "runtimeConfig.heartbeat"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}`);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ maxDailyRuns: 10 });
  });

  it("validates merge-mode payloads for agent update with the merge schema", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: AGENT_ID })));
    vi.stubGlobal("fetch", fetchMock);
    const payload = { mergeConfig: true, adapterConfig: { env: { DEBUG: null } }, runtimeConfig: { debug: null } };

    await run(["agent", "update", AGENT_ID, "--payload-json", JSON.stringify(payload)]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(payload);
  });
});
