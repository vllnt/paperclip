import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";
import { registerIssueGitCommands } from "../commands/client/issue-git.js";

const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const PRODUCT_ID = "77777777-7777-4777-8777-777777777777";

const view = {
  issueId: ISSUE_ID,
  identifier: "PAP-12",
  branch: { name: "PAP-12-fix-login", command: "git switch -c PAP-12-fix-login", template: "{{issue.identifier}}-{{slug}}", source: "default" },
  pullRequests: [
    {
      workProductId: PRODUCT_ID, provider: "github", repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7",
      title: "Fix login", state: "open", headRef: "pap-12-fix-login", baseRef: "main", closes: true, verified: true,
      linkedBy: "head_ref", automation: { applied: null, deferred: "disabled", suspended: null }, updatedAt: "2026-10-09T10:00:00.000Z",
    },
  ],
  statusAutomation: { enabled: false },
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  registerIssueGitCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function jsonResponse(body: unknown = view, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("issue git commands", () => {
  let logs: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the git view of an issue by identifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "git", "PAP-12"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([["GET", "http://localhost:3100/api/issues/PAP-12/git"]]);
    const text = logs.join("\n");
    expect(text).toContain("PAP-12-fix-login");
    expect(text).toContain("git switch -c PAP-12-fix-login");
    expect(text).toContain("acme/app#7");
    expect(text).toContain("open");
  });

  it("prints only the branch name for scripts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));

    await run(["issue", "git", ISSUE_ID, "--branch"]);

    expect(logs).toEqual(["PAP-12-fix-login"]);
  });

  it("prints the raw view with --json", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));

    await run(["issue", "git", ISSUE_ID, "--json"]);

    expect(JSON.parse(logs.join("\n"))).toEqual(view);
  });

  it("links a pull request by URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(view, 201));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "git:link", ISSUE_ID, "https://github.com/acme/app/pull/7"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/issues/${ISSUE_ID}/git/pull-requests`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ url: "https://github.com/acme/app/pull/7" });
  });

  it("links a pull request by owner/repo#number and can mark it refs-only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "git:link", ISSUE_ID, "acme/app#7", "--refs-only"]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ repository: "acme/app", number: 7, closes: false });
  });

  it("rejects something that is not a pull request reference without calling the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run(["issue", "git:link", ISSUE_ID, "not a pull request"])).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("unlinks a pull request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, 204));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "git:unlink", ISSUE_ID, PRODUCT_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method, call[0]])).toEqual([
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}/git/pull-requests/${PRODUCT_ID}`],
    ]);
  });
});
