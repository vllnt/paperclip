import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEvalsCommands } from "../commands/client/evals.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";
const PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const BASE = `http://localhost:3100/api/companies/${COMPANY_ID}/evals`;

const DEFINITION = {
  inputSchema: {
    type: "object",
    properties: { title: { type: "string", maxLength: 200 } },
    required: ["title"],
  },
  questions: {
    needs_qa: { type: "predicate", instructions: "Does this pull request need a QA pass?" },
  },
};

const EVAL_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  slug: "pr-needs-qa",
  title: "PR needs QA",
  whenToUse: "Before you request a review.",
  status: "draft",
  publishedVersionId: null,
  publishedVersionNumber: null,
  latestVersionNumber: 1,
};

const VERSION_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  evalId: EVAL_ROW.id,
  versionNumber: 2,
  definitionHash: "abcdef0123456789",
  changeNote: "tighten the question",
  createdAt: "2026-10-20T10:00:00.000Z",
};

const ANSWERED_RESULT = {
  runId: RUN_ID,
  eval: { id: EVAL_ROW.id, slug: "pr-needs-qa", versionId: VERSION_ROW.id, versionNumber: 2 },
  outcome: "answered",
  failureReason: null,
  answers: { needs_qa: { type: "predicate", probability: 0.91, value: true, abstained: false } },
  cached: false,
  latencyMs: 1180,
  modelId: "typesafe-ai/jev",
  mode: "live",
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerEvalsCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [...args, "--api-base", "http://localhost:3100", "--api-key", "board-token", "--company-id", COMPANY_ID],
    { from: "user" },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("evals commands", () => {
  let logs: string[];
  let errors: string[];
  let tempDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-evals-cli-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function requests(fetchMock: ReturnType<typeof vi.fn>): Array<[string, string]> {
    return fetchMock.mock.calls.map((call) => [String(call[1]?.method ?? "GET"), String(call[0])]);
  }

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index = 0): unknown {
    return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body));
  }

  async function writeTempFile(name: string, text: string): Promise<string> {
    const filePath = path.join(tempDir, name);
    await writeFile(filePath, text, "utf8");
    return filePath;
  }

  function stubStdin(text: string): void {
    vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([Buffer.from(text)]) as unknown as typeof process.stdin);
  }

  /** Runs a command that must fail: `process.exit` becomes an exception. */
  async function failedRun(args: string[]): Promise<string> {
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    await expect(run(args)).rejects.toThrow("exit:1");
    return errors.join("\n");
  }

  it("registers the eval commands and none of the later ones", () => {
    const program = new Command();
    registerEvalsCommands(program);
    const evals = program.commands.find((command) => command.name() === "evals");
    expect(evals?.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "create",
      "edit",
      "versions",
      "publish",
      "archive",
      "run",
      "runs",
      "feedback",
    ]);
  });

  describe("list, show and versions", () => {
    it("lists evals", async () => {
      const fetchMock = stubFetch(jsonResponse({ items: [EVAL_ROW], nextCursor: null }));

      await run(["evals", "list"]);

      expect(requests(fetchMock)).toEqual([["GET", BASE]]);
      expect(logs.join("\n")).toContain("pr-needs-qa");
      expect(logs.join("\n")).not.toContain("More results");
    });

    it("sends the status, limit and cursor filters and hints at the next page", async () => {
      const fetchMock = stubFetch(jsonResponse({ items: [EVAL_ROW], nextCursor: "cursor-2" }));

      await run(["evals", "list", "--status", "published", "--limit", "10", "--cursor", "cursor-1"]);

      expect(requests(fetchMock)).toEqual([["GET", `${BASE}?status=published&limit=10&cursor=cursor-1`]]);
      expect(logs.join("\n")).toContain("--cursor cursor-2");
    });

    it("prints the raw page with --json", async () => {
      const page = { items: [EVAL_ROW], nextCursor: "cursor-2" };
      stubFetch(jsonResponse(page));

      await run(["evals", "list", "--json"]);

      expect(JSON.parse(logs.join("\n"))).toEqual(page);
    });

    it("rejects an unknown status and a bad limit before any request", async () => {
      const fetchMock = stubFetch();

      await expect(run(["evals", "list", "--status", "live"])).rejects.toThrow();
      await expect(run(["evals", "list", "--limit", "0"])).rejects.toThrow();
      await expect(run(["evals", "list", "--limit", "abc"])).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows one eval and encodes the slug in the path", async () => {
      const fetchMock = stubFetch(
        jsonResponse({ ...EVAL_ROW, publishedVersion: null, latestVersion: { ...VERSION_ROW, ...DEFINITION } }),
      );

      await run(["evals", "show", "pr needs/qa"]);

      expect(requests(fetchMock)).toEqual([["GET", `${BASE}/pr%20needs%2Fqa`]]);
      const text = logs.join("\n");
      expect(text).toContain("pr-needs-qa");
      expect(text).toContain("needs_qa (predicate)");
      expect(text).toContain("title* (string)");
    });

    it("lists the versions of an eval with paging flags", async () => {
      const fetchMock = stubFetch(jsonResponse({ items: [VERSION_ROW], nextCursor: null }));

      await run(["evals", "versions", "pr-needs-qa", "--limit", "5", "--cursor", "c1"]);

      expect(requests(fetchMock)).toEqual([["GET", `${BASE}/pr-needs-qa/versions?limit=5&cursor=c1`]]);
      expect(logs.join("\n")).toContain("tighten the question");
    });
  });

  describe("create", () => {
    it("posts the metadata and the definition file", async () => {
      const fetchMock = stubFetch(jsonResponse(EVAL_ROW, 201));
      const file = await writeTempFile("definition.json", JSON.stringify(DEFINITION));

      await run([
        "evals", "create",
        "--slug", "pr-needs-qa",
        "--title", "PR needs QA",
        "--when-to-use", "Before you request a review.",
        "--definition", file,
        "--note", "first draft",
      ]);

      expect(requests(fetchMock)).toEqual([["POST", BASE]]);
      expect(bodyOf(fetchMock)).toEqual({
        slug: "pr-needs-qa",
        title: "PR needs QA",
        whenToUse: "Before you request a review.",
        inputSchema: DEFINITION.inputSchema,
        questions: DEFINITION.questions,
        changeNote: "first draft",
      });
      expect(logs.join("\n")).toContain("Created eval");
    });

    it("leaves out changeNote when --note is not given", async () => {
      const fetchMock = stubFetch(jsonResponse(EVAL_ROW, 201));
      const file = await writeTempFile("definition.json", JSON.stringify(DEFINITION));

      await run(["evals", "create", "--slug", "pr-needs-qa", "--title", "T", "--when-to-use", "W", "--definition", file]);

      expect(bodyOf(fetchMock)).not.toHaveProperty("changeNote");
    });

    it("fails on a missing definition file and sends nothing", async () => {
      const fetchMock = stubFetch();

      const printed = await failedRun([
        "evals", "create", "--slug", "pr-needs-qa", "--title", "T", "--when-to-use", "W",
        "--definition", path.join(tempDir, "missing.json"),
      ]);

      expect(printed).toContain("file not found");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails on a definition file that is not valid JSON and sends nothing", async () => {
      const fetchMock = stubFetch();
      const file = await writeTempFile("bad.json", "{ not json");

      const printed = await failedRun([
        "evals", "create", "--slug", "pr-needs-qa", "--title", "T", "--when-to-use", "W", "--definition", file,
      ]);

      expect(printed).toContain("is not valid JSON");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails on a definition file without both parts or with extra keys", async () => {
      const fetchMock = stubFetch();
      const noQuestions = await writeTempFile("no-questions.json", JSON.stringify({ inputSchema: DEFINITION.inputSchema }));
      const extraKey = await writeTempFile("extra.json", JSON.stringify({ ...DEFINITION, title: "x" }));
      const asArray = await writeTempFile("array.json", "[]");
      const base = ["evals", "create", "--slug", "pr-needs-qa", "--title", "T", "--when-to-use", "W", "--definition"];

      expect(await failedRun([...base, noQuestions])).toContain('needs "questions"');
      errors.length = 0;
      expect(await failedRun([...base, extraKey])).toContain("unknown keys: title");
      errors.length = 0;
      expect(await failedRun([...base, asArray])).toContain("must hold a JSON object");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires the slug, title, when-to-use and definition options", async () => {
      const fetchMock = stubFetch();

      await expect(run(["evals", "create", "--slug", "pr-needs-qa"])).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("edit", () => {
    it("patches the title and when-to-use text without --definition", async () => {
      const fetchMock = stubFetch(jsonResponse(EVAL_ROW));

      await run(["evals", "edit", "pr-needs-qa", "--title", "New title", "--when-to-use", "New text"]);

      expect(requests(fetchMock)).toEqual([["PATCH", `${BASE}/pr-needs-qa`]]);
      expect(bodyOf(fetchMock)).toEqual({ title: "New title", whenToUse: "New text" });
    });

    it("posts a new version for --definition alone and says it created one", async () => {
      const fetchMock = stubFetch(
        jsonResponse({ ...EVAL_ROW, latestVersionNumber: 1 }),
        jsonResponse({ ...VERSION_ROW, versionNumber: 2 }, 201),
      );
      const file = await writeTempFile("definition.json", JSON.stringify(DEFINITION));

      await run(["evals", "edit", "pr-needs-qa", "--definition", file, "--note", "tighten the question"]);

      expect(requests(fetchMock)).toEqual([
        ["GET", `${BASE}/pr-needs-qa`],
        ["POST", `${BASE}/pr-needs-qa/versions`],
      ]);
      expect(bodyOf(fetchMock, 1)).toEqual({
        inputSchema: DEFINITION.inputSchema,
        questions: DEFINITION.questions,
        changeNote: "tighten the question",
      });
      expect(logs.join("\n")).toContain("Created version 2");
    });

    it("says no new version exists when the definition matches the latest one", async () => {
      stubFetch(
        jsonResponse({ ...EVAL_ROW, latestVersionNumber: 2 }),
        jsonResponse({ ...VERSION_ROW, versionNumber: 2 }, 200),
      );
      const file = await writeTempFile("definition.json", JSON.stringify(DEFINITION));

      await run(["evals", "edit", "pr-needs-qa", "--definition", file]);

      expect(logs.join("\n")).toContain("No new version");
      expect(logs.join("\n")).toContain("v2");
    });

    it("patches first and then posts a version when both are given", async () => {
      const fetchMock = stubFetch(
        jsonResponse({ ...EVAL_ROW, title: "New title", latestVersionNumber: 1 }),
        jsonResponse({ ...VERSION_ROW, versionNumber: 2 }, 201),
      );
      const file = await writeTempFile("definition.json", JSON.stringify(DEFINITION));

      await run(["evals", "edit", "pr-needs-qa", "--title", "New title", "--definition", file]);

      expect(requests(fetchMock)).toEqual([
        ["PATCH", `${BASE}/pr-needs-qa`],
        ["POST", `${BASE}/pr-needs-qa/versions`],
      ]);
      expect(bodyOf(fetchMock, 0)).toEqual({ title: "New title" });
      expect(bodyOf(fetchMock, 1)).not.toHaveProperty("changeNote");
      expect(logs.join("\n")).toContain("Updated eval");
      expect(logs.join("\n")).toContain("Created version 2");
    });

    it("prints both results with --json", async () => {
      stubFetch(
        jsonResponse({ ...EVAL_ROW, latestVersionNumber: 1 }),
        jsonResponse({ ...VERSION_ROW, versionNumber: 2 }, 201),
      );
      const file = await writeTempFile("definition.json", JSON.stringify(DEFINITION));

      await run(["evals", "edit", "pr-needs-qa", "--title", "T", "--definition", file, "--json"]);

      const printed = JSON.parse(logs.join("\n")) as { eval: { slug: string }; version: { versionNumber: number }; versionCreated: boolean };
      expect(printed.eval.slug).toBe("pr-needs-qa");
      expect(printed.version.versionNumber).toBe(2);
      expect(printed.versionCreated).toBe(true);
    });

    it("fails when nothing is given, and when --note has no --definition", async () => {
      const fetchMock = stubFetch();

      expect(await failedRun(["evals", "edit", "pr-needs-qa"])).toContain("Nothing to change");
      errors.length = 0;
      expect(await failedRun(["evals", "edit", "pr-needs-qa", "--title", "T", "--note", "n"])).toContain("--note needs --definition");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not patch when the definition file is bad", async () => {
      const fetchMock = stubFetch();

      const printed = await failedRun([
        "evals", "edit", "pr-needs-qa", "--title", "T", "--definition", path.join(tempDir, "missing.json"),
      ]);

      expect(printed).toContain("file not found");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("publish and archive", () => {
    it("publishes the latest version by default", async () => {
      const fetchMock = stubFetch(jsonResponse({ ...EVAL_ROW, status: "published", publishedVersionNumber: 2 }));

      await run(["evals", "publish", "pr-needs-qa"]);

      expect(requests(fetchMock)).toEqual([["POST", `${BASE}/pr-needs-qa/publish`]]);
      expect(bodyOf(fetchMock)).toEqual({});
      expect(logs.join("\n")).toContain("at version 2");
    });

    it("publishes a chosen version with --version", async () => {
      const fetchMock = stubFetch(jsonResponse({ ...EVAL_ROW, status: "published", publishedVersionNumber: 1 }));

      await run(["evals", "publish", "pr-needs-qa", "--version", "1"]);

      expect(bodyOf(fetchMock)).toEqual({ versionNumber: 1 });
    });

    it("archives an eval", async () => {
      const fetchMock = stubFetch(jsonResponse({ ...EVAL_ROW, status: "archived" }));

      await run(["evals", "archive", "pr-needs-qa"]);

      expect(requests(fetchMock)).toEqual([["POST", `${BASE}/pr-needs-qa/archive`]]);
      expect(logs.join("\n")).toContain("Archived eval");
    });
  });

  describe("run", () => {
    it("runs with --input-json and prints the answers", async () => {
      const fetchMock = stubFetch(jsonResponse(ANSWERED_RESULT));

      await run(["evals", "run", "pr-needs-qa", "--input-json", '{"title":"Fix login"}']);

      expect(requests(fetchMock)).toEqual([["POST", `${BASE}/pr-needs-qa/runs`]]);
      expect(bodyOf(fetchMock)).toEqual({ input: { title: "Fix login" } });
      const text = logs.join("\n");
      expect(text).toContain(RUN_ID);
      expect(text).toContain("needs_qa: true (p=0.91)");
      expect(text).not.toContain("Fix login");
    });

    it("reads the input from a file", async () => {
      const fetchMock = stubFetch(jsonResponse(ANSWERED_RESULT));
      const file = await writeTempFile("input.json", '{"title":"From file"}');

      await run(["evals", "run", "pr-needs-qa", "--input", file]);

      expect(bodyOf(fetchMock)).toEqual({ input: { title: "From file" } });
    });

    it("reads the input from stdin with --input -", async () => {
      const fetchMock = stubFetch(jsonResponse(ANSWERED_RESULT));
      stubStdin('{"title":"From stdin"}');

      await run(["evals", "run", "pr-needs-qa", "--input", "-"]);

      expect(bodyOf(fetchMock)).toEqual({ input: { title: "From stdin" } });
    });

    it("sends the issue id, the version and the try-it mode", async () => {
      const fetchMock = stubFetch(jsonResponse({ ...ANSWERED_RESULT, mode: "try_it" }));

      await run([
        "evals", "run", "pr-needs-qa", "--input-json", "{}", "--issue-id", ISSUE_ID, "--version", "3", "--try-it",
      ]);

      expect(bodyOf(fetchMock)).toEqual({ input: {}, issueId: ISSUE_ID, versionNumber: 3, mode: "try_it" });
    });

    it("needs exactly one of --input and --input-json", async () => {
      const fetchMock = stubFetch();
      const file = await writeTempFile("input.json", "{}");

      expect(await failedRun(["evals", "run", "pr-needs-qa"])).toContain("exactly one of --input");
      errors.length = 0;
      expect(
        await failedRun(["evals", "run", "pr-needs-qa", "--input", file, "--input-json", "{}"]),
      ).toContain("exactly one of --input");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails on a missing input file or invalid JSON without echoing the input", async () => {
      const fetchMock = stubFetch();
      const bad = await writeTempFile("bad-input.json", "secret-token-value {");

      expect(await failedRun(["evals", "run", "pr-needs-qa", "--input", path.join(tempDir, "none.json")])).toContain(
        "file not found",
      );
      errors.length = 0;
      const fileError = await failedRun(["evals", "run", "pr-needs-qa", "--input", bad]);
      expect(fileError).toContain("is not valid JSON");
      expect(fileError).not.toContain("secret-token-value");
      errors.length = 0;
      const inlineError = await failedRun(["evals", "run", "pr-needs-qa", "--input-json", "secret-token-value {"]);
      expect(inlineError).toContain("--input-json is not valid JSON");
      expect(inlineError).not.toContain("secret-token-value");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails on empty stdin", async () => {
      const fetchMock = stubFetch();
      stubStdin("");

      expect(await failedRun(["evals", "run", "pr-needs-qa", "--input", "-"])).toContain("(stdin) is empty");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("prints a failed run with its reason and hint and does not exit", async () => {
      stubFetch(
        jsonResponse({
          ...ANSWERED_RESULT,
          outcome: "failed",
          failureReason: "no_key",
          answers: null,
          modelId: null,
          hint: "Add the company secret AI_GATEWAY_API_KEY",
        }),
      );
      const exitSpy = vi.spyOn(process, "exit");

      await run(["evals", "run", "pr-needs-qa", "--input-json", "{}"]);

      const text = logs.join("\n");
      expect(text).toContain("Outcome: failed (no_key)");
      expect(text).toContain("Hint: Add the company secret AI_GATEWAY_API_KEY");
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });

    it("prints the raw result with --json, also for a failed run", async () => {
      const failed = { ...ANSWERED_RESULT, outcome: "failed", failureReason: "timeout", answers: null };
      stubFetch(jsonResponse(failed));

      await run(["evals", "run", "pr-needs-qa", "--input-json", "{}", "--json"]);

      expect(JSON.parse(logs.join("\n"))).toEqual(failed);
    });

    it("keeps the code and the run id of a 422 in the error output", async () => {
      stubFetch(
        jsonResponse(
          {
            error: "Eval input does not match the input schema",
            code: "eval_input_invalid",
            runId: RUN_ID,
            details: { errors: [{ path: "/title", message: "must be string" }] },
          },
          422,
        ),
      );

      const printed = await failedRun(["evals", "run", "pr-needs-qa", "--input-json", '{"title":1}']);

      expect(printed).toContain("API error 422");
      expect(printed).toContain("code=eval_input_invalid");
      expect(printed).toContain(`runId=${RUN_ID}`);
      expect(printed).toContain("/title");
      expect(printed).not.toContain('"title":1');
    });

    it("prints other API errors in the shared format", async () => {
      stubFetch(jsonResponse({ error: "Eval not found" }, 404));

      const printed = await failedRun(["evals", "run", "pr-needs-qa", "--input-json", "{}"]);

      expect(printed).toContain("API error 404: Eval not found");
      expect(printed).not.toContain("code=");
    });
  });

  describe("runs", () => {
    it("lists the runs of an eval", async () => {
      const fetchMock = stubFetch(
        jsonResponse({
          items: [
            {
              id: RUN_ID, createdAt: "2026-10-20T10:00:00.000Z", versionNumber: 2, mode: "live", outcome: "failed",
              failureReason: "timeout", latencyMs: 30000, callerType: "agent", callerAgentId: AGENT_ID, callerUserId: null,
            },
          ],
          nextCursor: "next-1",
        }),
      );

      await run(["evals", "runs", "pr-needs-qa"]);

      expect(requests(fetchMock)).toEqual([["GET", `${BASE}/pr-needs-qa/runs`]]);
      const text = logs.join("\n");
      expect(text).toContain(RUN_ID);
      expect(text).toContain("failed (timeout)");
      expect(text).toContain(`agent:${AGENT_ID}`);
      expect(text).toContain("--cursor next-1");
    });

    it("maps every filter to its query name", async () => {
      const fetchMock = stubFetch(jsonResponse({ items: [], nextCursor: null }));

      await run([
        "evals", "runs", "pr-needs-qa",
        "--from", "2026-10-01T00:00:00Z",
        "--to", "2026-10-20T00:00:00Z",
        "--version", "2",
        "--agent-id", AGENT_ID,
        "--project-id", PROJECT_ID,
        "--outcome", "answered",
        "--mode", "try_it",
        "--limit", "25",
        "--cursor", "c1",
      ]);

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.pathname).toBe(`/api/companies/${COMPANY_ID}/evals/pr-needs-qa/runs`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-20T00:00:00Z",
        versionNumber: "2",
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        outcome: "answered",
        mode: "try_it",
        limit: "25",
        cursor: "c1",
      });
      expect(logs.join("\n")).toContain("(empty)");
    });

    it("rejects an unknown outcome or mode before any request", async () => {
      const fetchMock = stubFetch();

      await expect(run(["evals", "runs", "pr-needs-qa", "--outcome", "maybe"])).rejects.toThrow();
      await expect(run(["evals", "runs", "pr-needs-qa", "--mode", "any"])).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("feedback", () => {
    const FEEDBACK_PATH = `${BASE}/pr-needs-qa/runs/${RUN_ID}/feedback`;

    it("puts a correct verdict", async () => {
      const fetchMock = stubFetch(jsonResponse({ verdict: "correct", questionId: null }));

      await run(["evals", "feedback", "pr-needs-qa", RUN_ID, "--correct"]);

      expect(requests(fetchMock)).toEqual([["PUT", FEEDBACK_PATH]]);
      expect(bodyOf(fetchMock)).toEqual({ verdict: "correct" });
      expect(logs.join("\n")).toContain("Recorded correct feedback");
    });

    it("puts an incorrect verdict for one question with a note", async () => {
      const fetchMock = stubFetch(jsonResponse({ verdict: "incorrect", questionId: "needs_qa" }));

      await run([
        "evals", "feedback", "pr-needs-qa", RUN_ID, "--incorrect", "--question", "needs_qa", "--note", "It was a docs change.",
      ]);

      expect(requests(fetchMock)).toEqual([["PUT", FEEDBACK_PATH]]);
      expect(bodyOf(fetchMock)).toEqual({ verdict: "incorrect", questionId: "needs_qa", note: "It was a docs change." });
      expect(logs.join("\n")).toContain("for question needs_qa");
    });

    it("needs exactly one of --correct and --incorrect", async () => {
      const fetchMock = stubFetch();

      expect(await failedRun(["evals", "feedback", "pr-needs-qa", RUN_ID])).toContain("exactly one of --correct or --incorrect");
      errors.length = 0;
      expect(
        await failedRun(["evals", "feedback", "pr-needs-qa", RUN_ID, "--correct", "--incorrect"]),
      ).toContain("exactly one of --correct or --incorrect");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("needs a company id", async () => {
    const fetchMock = stubFetch();
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(
      createProgram().parseAsync(
        ["evals", "list", "--api-base", "http://localhost:3100", "--api-key", "board-token", "--context", path.join(tempDir, "none.json")],
        { from: "user" },
      ),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("Company ID is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
