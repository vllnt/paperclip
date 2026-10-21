import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { registerEventSourceApiCommands } from "../commands/client/event-source-api.js";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const BASE = "http://localhost:3100";

type Reply = { status?: number; body: unknown };

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  registerEventSourceApiCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", BASE, "--api-key", "board-token"], { from: "user" });
}

describe("starting routine steps on a task", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let replies: Map<string, Reply>;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    replies = new Map();
    fetchMock = vi.fn().mockImplementation((url: unknown, init?: { method?: string }) => {
      const key = `${init?.method ?? "GET"} ${String(url)}`;
      const reply = replies.get(key) ?? { body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function requests(): Array<{ method: string; url: string; body: unknown }> {
    return fetchMock.mock.calls.map(([url, init]) => ({
      method: String(init?.method ?? "GET"),
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
  }

  function stderrLines(): string[] {
    return errorSpy.mock.calls.map((call) => String(call[0]));
  }

  describe("routine run --target-issue", () => {
    const RUN_URL = `${BASE}/api/routines/${ROUTINE_ID}/run`;

    it("sends a task UUID as targetIssueId without looking it up", async () => {
      await run(["routine", "run", ROUTINE_ID, "--target-issue", ISSUE_ID]);

      expect(requests()).toEqual([{ method: "POST", url: RUN_URL, body: { targetIssueId: ISSUE_ID } }]);
    });

    it("looks up a task identifier with the issue GET and sends the id it returns", async () => {
      replies.set(`GET ${BASE}/api/issues/PC-12`, { body: { id: ISSUE_ID, identifier: "PC-12" } });

      await run(["routine", "run", ROUTINE_ID, "--target-issue", "PC-12"]);

      expect(requests()).toEqual([
        { method: "GET", url: `${BASE}/api/issues/PC-12`, body: undefined },
        { method: "POST", url: RUN_URL, body: { targetIssueId: ISSUE_ID } },
      ]);
    });

    it("keeps the other payload fields next to targetIssueId", async () => {
      await run([
        "routine",
        "run",
        ROUTINE_ID,
        "--target-issue",
        ISSUE_ID,
        "--payload-json",
        '{"idempotencyKey":"release-1","source":"api"}',
      ]);

      expect(requests().at(-1)?.body).toEqual({ idempotencyKey: "release-1", source: "api", targetIssueId: ISSUE_ID });
    });

    it("sends the payload unchanged when no task is given", async () => {
      await run(["routine", "run", ROUTINE_ID]);
      expect(requests()).toEqual([{ method: "POST", url: RUN_URL, body: {} }]);

      await run(["routine", "run", ROUTINE_ID, "--payload-json", '{"targetIssueId":"' + ISSUE_ID + '"}']);
      expect(requests().at(-1)?.body).toEqual({ targetIssueId: ISSUE_ID });
    });

    it("refuses the task in both the flag and the payload, and sends nothing", async () => {
      await expect(
        run(["routine", "run", ROUTINE_ID, "--target-issue", ISSUE_ID, "--payload-json", `{"targetIssueId":"${ISSUE_ID}"}`]),
      ).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(stderrLines().join("\n")).toContain("not both");
    });

    it("refuses a payload that is not an object when a task is given", async () => {
      await expect(run(["routine", "run", ROUTINE_ID, "--target-issue", ISSUE_ID, "--payload-json", "[]"])).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not run the routine when the identifier cannot be found", async () => {
      replies.set(`GET ${BASE}/api/issues/PC-404`, { status: 404, body: { error: "Issue not found" } });

      await expect(run(["routine", "run", ROUTINE_ID, "--target-issue", "PC-404"])).rejects.toThrow();

      expect(requests().map((request) => request.method)).toEqual(["GET"]);
      expect(stderrLines().join("\n")).toContain("Issue not found");
    });

    it("does not run the routine when the lookup returns no id", async () => {
      replies.set(`GET ${BASE}/api/issues/PC-7`, { body: { identifier: "PC-7" } });

      await expect(run(["routine", "run", ROUTINE_ID, "--target-issue", "PC-7"])).rejects.toThrow();

      expect(requests().map((request) => request.method)).toEqual(["GET"]);
      expect(stderrLines().join("\n")).toContain('Could not find the task "PC-7"');
    });

    it("shows the server's 409 and 422 reasons and exits non-zero", async () => {
      replies.set(`POST ${RUN_URL}`, { status: 409, body: { error: "This task is in progress." } });

      await expect(run(["routine", "run", ROUTINE_ID, "--target-issue", ISSUE_ID])).rejects.toThrow();

      expect(stderrLines().join("\n")).toContain("API error 409: This task is in progress.");
    });
  });

  describe("step warnings", () => {
    const WARNINGS = [
      { code: "step_agent_unavailable", stepKey: "build", agentId: "agent-1", reason: "paused" },
      { code: "step_agent_unavailable", stepKey: "ship", agentId: "agent-2", reason: "pending_approval" },
    ];

    it("prints each warning of a run to stderr and keeps the response on stdout", async () => {
      replies.set(`POST ${BASE}/api/routines/${ROUTINE_ID}/run`, { status: 202, body: { id: "run-1", warnings: WARNINGS } });

      await run(["routine", "run", ROUTINE_ID, "--target-issue", ISSUE_ID, "--json"]);

      expect(stderrLines()).toEqual([
        'warning: step "build": agent agent-1 is paused',
        'warning: step "ship": agent agent-2 is pending_approval',
      ]);
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({ id: "run-1", warnings: WARNINGS });
    });

    it("prints the warnings of a routine create and update", async () => {
      replies.set(`POST ${BASE}/api/companies/${COMPANY_ID}/routines`, { status: 201, body: { id: ROUTINE_ID, warnings: [WARNINGS[0]] } });
      replies.set(`PATCH ${BASE}/api/routines/${ROUTINE_ID}`, { body: { id: ROUTINE_ID, warnings: [WARNINGS[1]] } });

      await run(["routine", "create", "--company-id", COMPANY_ID, "--payload-json", '{"title":"Release"}']);
      await run(["routine", "update", ROUTINE_ID, "--payload-json", '{"title":"Renamed"}']);

      expect(stderrLines()).toEqual([
        'warning: step "build": agent agent-1 is paused',
        'warning: step "ship": agent agent-2 is pending_approval',
      ]);
    });

    it("prints nothing when there are no warnings, or when the field is not a warning list", async () => {
      replies.set(`POST ${BASE}/api/routines/${ROUTINE_ID}/run`, { body: { id: "run-1", warnings: [] } });
      await run(["routine", "run", ROUTINE_ID]);

      replies.set(`POST ${BASE}/api/routines/${ROUTINE_ID}/run`, { body: { id: "run-2", warnings: [{ code: "other" }, "text", null] } });
      await run(["routine", "run", ROUTINE_ID]);

      replies.set(`POST ${BASE}/api/routines/${ROUTINE_ID}/run`, { body: { id: "run-3" } });
      await run(["routine", "run", ROUTINE_ID]);

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("event-sources ensure-paperclip", () => {
    const URL = `${BASE}/api/companies/${COMPANY_ID}/event-sources/paperclip`;

    it("posts to the company's built-in source endpoint and prints the source", async () => {
      replies.set(`POST ${URL}`, {
        body: { id: "src-1", name: "Paperclip (built-in)", normalizer: "paperclip_v1", ingressUrl: null },
      });

      await run(["event-sources", "ensure-paperclip", "--company-id", COMPANY_ID, "--json"]);

      expect(requests()).toEqual([{ method: "POST", url: URL, body: {} }]);
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        id: "src-1",
        normalizer: "paperclip_v1",
        ingressUrl: null,
      });
    });

    it("can be repeated: every call hits the same endpoint", async () => {
      await run(["event-sources", "ensure-paperclip", "--company-id", COMPANY_ID]);
      await run(["event-sources", "ensure-paperclip", "--company-id", COMPANY_ID]);

      expect(requests().map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${URL}`, `POST ${URL}`]);
    });

    it("needs a company", async () => {
      await expect(run(["event-sources", "ensure-paperclip"])).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
