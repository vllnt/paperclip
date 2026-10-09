import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAdapterOverridesOption, registerIssueCommands } from "../commands/client/issue.js";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OVERRIDES = { adapterConfig: { model: "gpt-5", effort: "high" }, useProjectWorkspace: true };

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], {
    from: "user",
  });
}

function jsonResponse(body: unknown = { id: ISSUE_ID }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("parseAdapterOverridesOption", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paperclip-overrides-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when neither option is given", async () => {
    await expect(parseAdapterOverridesOption({})).resolves.toBeUndefined();
  });

  it("parses inline JSON, a file, and null to clear", async () => {
    await expect(parseAdapterOverridesOption({ adapterOverridesJson: JSON.stringify(OVERRIDES) })).resolves.toEqual(OVERRIDES);
    const file = join(dir, "overrides.json");
    await writeFile(file, JSON.stringify(OVERRIDES), "utf8");
    await expect(parseAdapterOverridesOption({ adapterOverridesFile: file })).resolves.toEqual(OVERRIDES);
    await expect(parseAdapterOverridesOption({ adapterOverridesJson: "null" })).resolves.toBeNull();
  });

  it("rejects both options together and non-object values", async () => {
    await expect(
      parseAdapterOverridesOption({ adapterOverridesJson: "{}", adapterOverridesFile: "x.json" }),
    ).rejects.toThrow(/only one of/);
    await expect(parseAdapterOverridesOption({ adapterOverridesJson: "[1]" })).rejects.toThrow(/JSON object/);
    await expect(parseAdapterOverridesOption({ adapterOverridesJson: '"fast"' })).rejects.toThrow(/JSON object/);
  });
});

describe("issue commands with adapter overrides", () => {
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

  it("sends the overrides on issue update, and null to clear them", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--adapter-overrides-json", JSON.stringify(OVERRIDES)]);
    await run(["issue", "update", ISSUE_ID, "--adapter-overrides-json", "null"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method, JSON.parse(String(call[1]?.body))])).toEqual([
      ["PATCH", { assigneeAdapterOverrides: OVERRIDES }],
      ["PATCH", { assigneeAdapterOverrides: null }],
    ]);
  });

  it("sends the overrides on issue create", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "issue", "create", "-C", COMPANY_ID, "--title", "Deep review",
      "--adapter-overrides-json", JSON.stringify(OVERRIDES),
    ]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: "Deep review",
      assigneeAdapterOverrides: OVERRIDES,
    });
  });

  it("omits the field when the option is not given", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--title", "New title"]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: "New title" });
  });

  it("rejects an unknown overrides key before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await run(["issue", "update", ISSUE_ID, "--adapter-overrides-json", '{"model":"gpt-5"}']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
