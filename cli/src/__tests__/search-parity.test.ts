import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSearchCommand } from "../commands/client/search.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSearchCommand(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("search parity command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps the company search endpoint", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(() => Promise.resolve(jsonResponse(searchResponse())));
    vi.stubGlobal("fetch", fetchMock);

    await run(["search", "deploy", "failed", "--company-id", COMPANY_ID]);
    await run(["search", "PAP-12", "--company-id", COMPANY_ID, "--scope", "issues", "--limit", "5", "--offset", "10"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/search?q=deploy+failed`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/search?q=PAP-12&scope=issues&limit=5&offset=10`],
    ]);
  });

  it("prints one line per result with its type, title and link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(searchResponse([
      { id: "issue-1", type: "issue", title: "Deploy failed", href: "/PAP/issues/PAP-12" },
      { id: "agent-1", type: "agent", title: "Release bot", href: "/PAP/agents/agent-1" },
    ])))));

    await run(["search", "deploy", "--company-id", COMPANY_ID]);

    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("type=issue");
    expect(lines[0]).toContain("title=Deploy failed");
    expect(lines[0]).toContain("href=/PAP/issues/PAP-12");
    expect(lines[1]).toContain("type=agent");
  });

  it("rejects an unknown scope without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(run(["search", "deploy", "--company-id", COMPANY_ID, "--scope", "routines"])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function searchResponse(results: Array<{ id: string; type: string; title: string; href: string }> = []) {
  return {
    query: "",
    normalizedQuery: "",
    scope: "all",
    sort: "relevance",
    limit: 20,
    offset: 0,
    results: results.map((result) => ({
      ...result,
      score: 1,
      matchedFields: [],
      sourceLabel: null,
      snippet: null,
      snippets: [],
      updatedAt: null,
      previewImageUrl: null,
    })),
    countsByType: {},
    filterOptionCounts: {},
    zeroResults: null,
    hasMore: false,
  };
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
