import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const STEPS = [
  { key: "build", title: "Build" },
  { key: "ship", title: "Ship", after: ["build"] },
];

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  const company = args[1] === "create" ? ["--company-id", COMPANY_ID] : [];
  await createProgram().parseAsync(
    [...args, ...company, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

describe("routine --steps-file", () => {
  let dir: string;
  let stepsPath: string;
  let notAnArrayPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-routine-steps-"));
    stepsPath = path.join(dir, "steps.json");
    notAnArrayPath = path.join(dir, "not-an-array.json");
    writeFileSync(stepsPath, JSON.stringify(STEPS));
    writeFileSync(notAnArrayPath, JSON.stringify({ key: "build" }));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function lastRequest(): { url: string; method: string; body: unknown } {
    const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
    return { url: String(url), method: String(init?.method), body: JSON.parse(String(init?.body)) };
  }

  it("adds the steps from the file to the create payload", async () => {
    await run(["routine", "create", "--payload-json", '{"title":"Release","assigneeAgentId":"a1"}', "--steps-file", stepsPath]);

    expect(lastRequest()).toEqual({
      url: `http://localhost:3100/api/companies/${COMPANY_ID}/routines`,
      method: "POST",
      body: { title: "Release", assigneeAgentId: "a1", steps: STEPS },
    });
  });

  it("updates only the steps when no payload is given", async () => {
    await run(["routine", "update", ROUTINE_ID, "--steps-file", stepsPath]);

    expect(lastRequest()).toEqual({
      url: `http://localhost:3100/api/routines/${ROUTINE_ID}`,
      method: "PATCH",
      body: { steps: STEPS },
    });
  });

  it("keeps sending the payload unchanged without a steps file, and lets the payload clear steps", async () => {
    await run(["routine", "update", ROUTINE_ID, "--payload-json", '{"title":"Renamed"}']);
    expect(lastRequest().body).toEqual({ title: "Renamed" });

    await run(["routine", "update", ROUTINE_ID, "--payload-json", '{"steps":[]}']);
    expect(lastRequest().body).toEqual({ steps: [] });
  });

  it("refuses steps in both the payload and the file", async () => {
    await expect(
      run(["routine", "update", ROUTINE_ID, "--payload-json", '{"steps":[]}', "--steps-file", stepsPath]),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a steps file that is not an array", async () => {
    await expect(run(["routine", "update", ROUTINE_ID, "--steps-file", notAnArrayPath])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
