import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerPluginCommands } from "../commands/client/plugin.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BNT_OWNER = "bnt" + "vllnt";

function program(): Command {
  const root = new Command();
  root.exitOverride();
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPluginCommands(root);
  return root;
}

describe("plugin action/data CLI commands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "paperclip-plugin-cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("requires a company for action and data commands when none is set anywhere", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const previous = { context: process.env.PAPERCLIP_CONTEXT, company: process.env.PAPERCLIP_COMPANY_ID };
    process.env.PAPERCLIP_CONTEXT = path.join(dir, "missing-context.json");
    delete process.env.PAPERCLIP_COMPANY_ID;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      for (const args of [
        ["plugin", "action", "vllnt.paperclip-github", "company-app.status"],
        ["plugin", "data", "vllnt.paperclip-github", "allowed-owners.get"],
      ]) {
        await program().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
      }
      expect(exit).toHaveBeenCalledTimes(2);
      expect(String(vi.mocked(console.error).mock.calls.flat().join(" "))).toMatch(/Company ID is required/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous.context === undefined) delete process.env.PAPERCLIP_CONTEXT;
      else process.env.PAPERCLIP_CONTEXT = previous.context;
      if (previous.company !== undefined) process.env.PAPERCLIP_COMPANY_ID = previous.company;
    }
  });

  it("takes the company from PAPERCLIP_COMPANY_ID when -C is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const previous = process.env.PAPERCLIP_COMPANY_ID;
    process.env.PAPERCLIP_COMPANY_ID = COMPANY_ID;
    try {
      await program().parseAsync([
        "plugin", "action", "vllnt.paperclip-github", "write-identity.get", "--params-json", "{}",
        "--api-base", "http://localhost:3100", "--api-key", "board-token",
      ], { from: "user" });
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ companyId: COMPANY_ID, params: {} });
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_COMPANY_ID;
      else process.env.PAPERCLIP_COMPANY_ID = previous;
    }
  });

  it("rejects a legacy payload whose company differs from -C", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit unexpectedly called with "${code}"`); }) as never);
    await expect(program().parseAsync([
      "plugin", "action", "vllnt.paperclip-github", "company-app.status", "-C", COMPANY_ID,
      "--payload-json", JSON.stringify({ companyId: "other-company" }),
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
    ], { from: "user" })).rejects.toThrow(/process\.exit/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("payload companyId must match"));
    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("sends company scope and params-json to plugin actions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { configured: false } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync([
      "plugin", "action", "vllnt.paperclip-github", "company-app.status", "-C", COMPANY_ID,
      "--params-json", '{"refresh":true}', "--api-base", "http://localhost:3100", "--api-key", "board-token",
    ], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3100/api/plugins/vllnt.paperclip-github/actions/company-app.status`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ companyId: COMPANY_ID, params: { refresh: true } }) }),
    );
  });

  it("adds company scope when params are omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { configured: false } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync([
      "plugin", "action", "vllnt.paperclip-github", "company-app.status", "-C", COMPANY_ID,
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
    ], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3100/api/plugins/vllnt.paperclip-github/actions/company-app.status`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ companyId: COMPANY_ID }) }),
    );
  });

  it("sends config:set as the configJson body the config route requires", async () => {
    const configJson = { appId: "5203754", appSlug: "v-agents", appName: "v-agents", privateKey: { type: "secret_ref", secretId: "secret-id", version: "latest" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ configJson }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync([
      "plugin", "config:set", "vllnt.paperclip-github", "-C", COMPANY_ID,
      "--payload-json", JSON.stringify({ configJson }), "--api-base", "http://localhost:3100", "--api-key", "board-token",
    ], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3100/api/plugins/vllnt.paperclip-github/config`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ configJson, companyId: COMPANY_ID }) }),
    );
  });

  it("reads params-file without putting the JSON on the command line payload", async () => {
    const paramsPath = path.join(dir, "owners.json");
    writeFileSync(paramsPath, JSON.stringify({ owners: ["vllnt", "maiaos", BNT_OWNER] }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { owners: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync([
      "plugin", "data", "vllnt.paperclip-github", "allowed-owners.get", "-C", COMPANY_ID,
      "--params-file", paramsPath, "--api-base", "http://localhost:3100", "--api-key", "board-token",
    ], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3100/api/plugins/vllnt.paperclip-github/data/allowed-owners.get`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ companyId: COMPANY_ID, params: { owners: ["vllnt", "maiaos", BNT_OWNER] } }) }),
    );
  });
});
