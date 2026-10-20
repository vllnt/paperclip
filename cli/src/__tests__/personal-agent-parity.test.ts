import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPersonalAgentCommands } from "../commands/client/personal-agent.js";

const SKILL_ID = "44444444-4444-4444-8444-444444444444";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPersonalAgentCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("personal agent CLI parity", () => {
  let dir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    dir = await mkdtemp(path.join(tmpdir(), "personal-agent-cli-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("maps every command to one personal agent route with a validated body", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const policyFile = path.join(dir, "policy.json");
    const policy = { enabledTools: ["list_issues"], companyDefault: "deny", companies: [{ companyId: COMPANY_ID, enabled: true, tools: null }] };
    await writeFile(policyFile, JSON.stringify(policy));
    const bodyFile = path.join(dir, "instructions.md");
    await writeFile(bodyFile, "# Be brief");

    await run(["personal-agent", "get"]);
    await run(["personal-agent", "update", "--name", "Chief", "--tool-policy-file", policyFile]);
    await run(["personal-agent", "instructions:put", "--body-file", bodyFile, "--base-revision", "3", "--change-summary", "tone"]);
    await run(["personal-agent", "instructions:revisions"]);
    await run(["personal-agent", "instructions:revision", "2"]);
    await run(["personal-agent", "skills:list"]);
    await run(["personal-agent", "skills:get", SKILL_ID]);
    await run(["personal-agent", "skills:add", "--name", "Review", "--markdown", "# Review"]);
    await run(["personal-agent", "skills:add", "--catalog", "paperclipai/bundled/docs/doc-maintenance", "--disable"]);
    await run(["personal-agent", "skills:update", SKILL_ID, "--disable"]);
    await run(["personal-agent", "skills:remove", SKILL_ID]);
    await run(["personal-agent", "tools"]);
    await run(["personal-agent", "audit-log", "--limit", "5"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/personal-agent"],
      ["PATCH", "http://localhost:3100/api/personal-agent"],
      ["PUT", "http://localhost:3100/api/personal-agent/instructions"],
      ["GET", "http://localhost:3100/api/personal-agent/instructions/revisions"],
      ["GET", "http://localhost:3100/api/personal-agent/instructions/revisions/2"],
      ["GET", "http://localhost:3100/api/personal-agent/skills"],
      ["GET", `http://localhost:3100/api/personal-agent/skills/${SKILL_ID}`],
      ["POST", "http://localhost:3100/api/personal-agent/skills"],
      ["POST", "http://localhost:3100/api/personal-agent/skills"],
      ["PATCH", `http://localhost:3100/api/personal-agent/skills/${SKILL_ID}`],
      ["DELETE", `http://localhost:3100/api/personal-agent/skills/${SKILL_ID}`],
      ["GET", "http://localhost:3100/api/personal-agent/tools"],
      ["GET", "http://localhost:3100/api/personal-agent/audit-log?limit=5"],
    ]);
    const bodies = fetchMock.mock.calls.map((call) => (typeof call[1]?.body === "string" ? JSON.parse(call[1].body) : null));
    expect(bodies[1]).toEqual({ name: "Chief", toolPolicy: policy });
    expect(bodies[2]).toEqual({ body: "# Be brief", baseRevision: 3, changeSummary: "tone" });
    expect(bodies[7]).toEqual({ source: "custom", name: "Review", description: "", markdown: "# Review", enabled: true });
    expect(bodies[8]).toEqual({ source: "catalog", catalogRef: "paperclipai/bundled/docs/doc-maintenance", enabled: false });
    expect(bodies[9]).toEqual({ enabled: false });
  });

  it("refuses invalid input before calling the API", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit ${code}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(["personal-agent", "update"])).rejects.toThrow("exit 1");
    await expect(run(["personal-agent", "instructions:put"])).rejects.toThrow("exit 1");
    await expect(run(["personal-agent", "skills:update", SKILL_ID, "--enable", "--disable"])).rejects.toThrow("exit 1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
