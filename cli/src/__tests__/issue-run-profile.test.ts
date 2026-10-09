import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";
import { buildRunProfileOverrides } from "../commands/client/run-profile-options.js";

const ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("buildRunProfileOverrides", () => {
  it("builds a tier or an explicit profile and rejects mixing them", () => {
    expect(buildRunProfileOverrides({ runProfile: "fast" }, null)).toEqual({ runProfile: { tier: "fast" } });
    expect(buildRunProfileOverrides({ adapterType: "codex_local", model: "gpt-5.5", effort: "low" }, null)).toEqual({
      runProfile: { adapterType: "codex_local", model: "gpt-5.5", effort: "low" },
    });
    expect(buildRunProfileOverrides({ model: "claude-sonnet-5-5" }, null)).toEqual({ runProfile: { model: "claude-sonnet-5-5" } });
    expect(() => buildRunProfileOverrides({ runProfile: "fast", model: "gpt-5.5" }, null)).toThrow(/either --run-profile <tier> or/);
    expect(() => buildRunProfileOverrides({ clearRunProfile: true, runProfile: "fast" }, null)).toThrow(/--clear-run-profile/);
  });

  it("keeps the issue's other overrides and replaces only the profile", () => {
    const existing = { useProjectWorkspace: true, adapterConfig: { cwd: "/x" }, runProfile: { tier: "standard" } };
    expect(buildRunProfileOverrides({ runProfile: "fast" }, existing)).toEqual({
      useProjectWorkspace: true, adapterConfig: { cwd: "/x" }, runProfile: { tier: "fast" },
    });
    expect(buildRunProfileOverrides({ clearRunProfile: true }, existing)).toEqual({ useProjectWorkspace: true, adapterConfig: { cwd: "/x" } });
    expect(buildRunProfileOverrides({ clearRunProfile: true }, { runProfile: { tier: "fast" } })).toBeNull();
  });

  it("returns undefined when no run profile flag is given", () => {
    expect(buildRunProfileOverrides({}, { runProfile: { tier: "fast" } })).toBeUndefined();
  });

  it("rejects an Anthropic model on Codex before calling the API", () => {
    expect(() => buildRunProfileOverrides({ adapterType: "codex_local", model: "claude-opus-5-5" }, null)).toThrow(/Anthropic models never run through codex_local/);
  });
});

describe("issue run profile flags", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets a tier on update, merging with the overrides the issue already has", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(json(init?.method === "PATCH" ? { id: ISSUE_ID } : { id: ISSUE_ID, assigneeAdapterOverrides: { useProjectWorkspace: true } })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--run-profile", "fast"]);

    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0], call[1]?.body ? JSON.parse(String(call[1].body)) : null]);
    expect(calls).toEqual([
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}`, null],
      ["PATCH", `http://localhost:3100/api/issues/${ISSUE_ID}`, { assigneeAdapterOverrides: { useProjectWorkspace: true, runProfile: { tier: "fast" } } }],
    ]);
  });

  it("sets an explicit target on create without reading anything first", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ id: ISSUE_ID })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "create", "-C", COMPANY_ID, "--title", "Chore", "--adapter-type", "codex_local", "--model", "grok-4.7", "--effort", "low"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method, JSON.parse(String(call[1]?.body)).assigneeAdapterOverrides])).toEqual([
      ["POST", { runProfile: { adapterType: "codex_local", model: "grok-4.7", effort: "low" } }],
    ]);
  });

  it("clears the profile", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(json(init?.method === "PATCH" ? { id: ISSUE_ID } : { id: ISSUE_ID, assigneeAdapterOverrides: { runProfile: { tier: "fast" } } })));
    vi.stubGlobal("fetch", fetchMock);
    await run(["issue", "update", ISSUE_ID, "--clear-run-profile"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ assigneeAdapterOverrides: null });
  });

  it("leaves an update without profile flags alone: no extra read, no overrides key", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ id: ISSUE_ID })));
    vi.stubGlobal("fetch", fetchMock);
    await run(["issue", "update", ISSUE_ID, "--title", "New title"]);
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: "New title" });
  });
});
