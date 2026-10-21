import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPolicyCommands } from "../commands/client/policy.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const BASE = "http://localhost:3100";
const COMMON = ["--api-base", BASE, "--api-key", "board-token", "--company-id", COMPANY_ID];

const policy = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: COMPANY_ID,
  projectId: null,
  key: "code-review",
  title: "Code review",
  summary: "Every change gets a review.",
  body: "# Review",
  status: "draft",
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPolicyCommands(program);
  return program;
}

function respond(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("policy commands", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-policy-cli-"));
    process.env.PAPERCLIP_CONTEXT = path.join(tempDir, "context.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PAPERCLIP_CONTEXT;
  });

  it("creates a project policy with a body read from a file", async () => {
    const bodyFile = path.join(tempDir, "body.md");
    fs.writeFileSync(bodyFile, "# From file\n");
    const fetchMock = respond({ ...policy, projectId: PROJECT_ID });

    await createProgram().parseAsync([
      "policy", "create", ...COMMON,
      "--key", "code-review",
      "--title", "Code review",
      "--summary", "Every change gets a review.",
      "--body-file", bodyFile,
      "--status", "active",
      "--project-id", PROJECT_ID,
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/companies/${COMPANY_ID}/policies`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      key: "code-review",
      title: "Code review",
      summary: "Every change gets a review.",
      body: "# From file\n",
      status: "active",
      projectId: PROJECT_ID,
    });
  });

  it("rejects an invalid key before calling the API", async () => {
    const fetchMock = respond();
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createProgram().parseAsync(["policy", "create", ...COMMON, "--key", "Bad Key", "--title", "x"], { from: "user" }),
    ).rejects.toThrow("exit 1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("lists with filters, gets one, and lists its history", async () => {
    const fetchMock = respond([policy], policy, [{ id: "r2", revisionNumber: 2 }, { id: "r1", revisionNumber: 1 }]);

    await createProgram().parseAsync(
      ["policy", "list", ...COMMON, "--scope", "project", "--status", "active"],
      { from: "user" },
    );
    await createProgram().parseAsync(["policy", "get", "code-review", ...COMMON], { from: "user" });
    await createProgram().parseAsync(["policy", "history", "code-review", ...COMMON], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/companies/${COMPANY_ID}/policies?scope=project&status=active`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE}/api/companies/${COMPANY_ID}/policies/code-review`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`${BASE}/api/companies/${COMPANY_ID}/policies/code-review/revisions`);
  });

  it("archives with update and clears a field with null", async () => {
    const fetchMock = respond({ ...policy, status: "archived" });

    await createProgram().parseAsync(
      ["policy", "update", "code-review", ...COMMON, "--status", "archived", "--summary", "null", "--change-summary", "Retire"],
      { from: "user" },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/companies/${COMPANY_ID}/policies/code-review`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      status: "archived",
      summary: null,
      changeSummary: "Retire",
    });
  });

  it("deletes only with --yes", async () => {
    const fetchMock = respond({ ...policy, status: "archived" });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createProgram().parseAsync(["policy", "delete", "code-review", ...COMMON], { from: "user" }),
    ).rejects.toThrow("exit 1");
    expect(fetchMock).not.toHaveBeenCalled();

    await createProgram().parseAsync(["policy", "delete", "code-review", ...COMMON, "--yes"], { from: "user" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/api/companies/${COMPANY_ID}/policies/code-review`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
