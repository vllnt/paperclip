import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserCommands } from "../commands/client/browser.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const BROWSER_URL = `http://localhost:3100/api/companies/${COMPANY_ID}/browser`;
const PROFILE_URL = `${BROWSER_URL}/profiles/${PROFILE_ID}`;

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerBrowserCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("browser parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps every board and agent command to its API route", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["browser", "overview", "--company-id", COMPANY_ID]);
    await run(["browser", "enable", "--company-id", COMPANY_ID]);
    await run(["browser", "disable", "--company-id", COMPANY_ID]);
    await run(["browser", "profile", "create", "--company-id", COMPANY_ID, "--payload-json", "{\"name\":\"CRM\",\"allowedDomains\":[\"app.example.com\"]}"]);
    await run(["browser", "profile", "update", PROFILE_ID, "--company-id", COMPANY_ID, "--payload-json", "{\"allowedAgentIds\":[]}"]);
    await run(["browser", "profile", "suspend", PROFILE_ID, "--company-id", COMPANY_ID]);
    await run(["browser", "profile", "resume", PROFILE_ID, "--company-id", COMPANY_ID]);
    await run(["browser", "profile", "delete", PROFILE_ID, "--company-id", COMPANY_ID, "--yes"]);
    await run(["browser", "signin", "start", PROFILE_ID, "--company-id", COMPANY_ID, "--payload-json", "{\"startUrl\":\"https://app.example.com/login\"}"]);
    await run(["browser", "signin", "state", PROFILE_ID, "--company-id", COMPANY_ID]);
    await run(["browser", "signin", "input", PROFILE_ID, "--company-id", COMPANY_ID, "--payload-json", "{\"type\":\"click\",\"x\":10,\"y\":20}"]);
    await run(["browser", "signin", "end", PROFILE_ID, "--company-id", COMPANY_ID]);
    await run(["browser", "agent-profiles", "--company-id", COMPANY_ID]);
    await run(["browser", "action", PROFILE_ID, "--company-id", COMPANY_ID, "--payload-json", "{\"action\":\"snapshot\"}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0], call[1]?.body])).toEqual([
      ["GET", `${BROWSER_URL}/overview`, undefined],
      ["PUT", `${BROWSER_URL}/settings`, "{\"enabled\":true}"],
      ["PUT", `${BROWSER_URL}/settings`, "{\"enabled\":false}"],
      ["POST", `${BROWSER_URL}/profiles`, "{\"name\":\"CRM\",\"allowedDomains\":[\"app.example.com\"]}"],
      ["PATCH", PROFILE_URL, "{\"allowedAgentIds\":[]}"],
      ["POST", `${PROFILE_URL}/suspend`, undefined],
      ["POST", `${PROFILE_URL}/resume`, undefined],
      ["DELETE", PROFILE_URL, undefined],
      ["POST", `${PROFILE_URL}/signin`, "{\"startUrl\":\"https://app.example.com/login\"}"],
      ["GET", `${PROFILE_URL}/signin/state`, undefined],
      ["POST", `${PROFILE_URL}/signin/input`, "{\"type\":\"click\",\"x\":10,\"y\":20}"],
      ["POST", `${PROFILE_URL}/signin/end`, undefined],
      ["GET", `${BROWSER_URL}/agent-profiles`, undefined],
      ["POST", `${PROFILE_URL}/actions`, "{\"action\":\"snapshot\"}"],
    ]);
  });

  it("saves the sign-in page image to a file with the caller's credential", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } })));
    vi.stubGlobal("fetch", fetchMock);
    const out = path.join(await mkdtemp(path.join(tmpdir(), "paperclip-browser-cli-")), "page.jpg");

    await run(["browser", "signin", "frame", PROFILE_ID, "--company-id", COMPANY_ID, "--out", out]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${PROFILE_URL}/signin/frame`);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer board-token" });
    expect([...(await readFile(out))]).toEqual([...jpeg]);
  });

  it("refuses to delete a profile without --yes and sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    await expect(run(["browser", "profile", "delete", PROFILE_ID, "--company-id", COMPANY_ID])).rejects.toThrow("exit:1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("requires --yes"));
  });

  it("shows the server's refusal and does not retry or hide it", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "Agent access required" }, { status: 403 })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    await expect(
      run(["browser", "action", PROFILE_ID, "--company-id", COMPANY_ID, "--payload-json", "{\"action\":\"snapshot\"}"]),
    ).rejects.toThrow("exit:1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("API error 403: Agent access required"));
  });
});
