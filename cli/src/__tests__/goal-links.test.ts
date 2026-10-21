import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../commands/client/goal.js";
import { registerIssueCommands } from "../commands/client/issue.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_ID = "55555555-5555-4555-8555-555555555555";
const API = "http://localhost:3100/api";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerGoalCommands(program);
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

const goal = { id: GOAL_ID, companyId: COMPANY_ID, title: "Ship the beta", ownerAgentId: "agent-owner" };
const responses: Record<string, unknown> = {
  [`/api/goals/${GOAL_ID}`]: goal,
  [`/api/companies/${COMPANY_ID}/goals/progress`]: { [GOAL_ID]: { total: 3, done: 1, open: 2 }, other: { total: 1, done: 0, open: 1 } },
  [`/api/companies/${COMPANY_ID}/projects`]: [
    { id: "project-1", name: "Beta", status: "in_progress", goalIds: ["other", GOAL_ID] },
    { id: "project-2", name: "Unrelated", status: "planned", goalIds: ["other"] },
  ],
  [`/api/companies/${COMPANY_ID}/issues`]: [
    { id: "issue-1", identifier: "PAP-1", title: "Write the docs", status: "todo", assigneeAgentId: "agent-writer", description: "long" },
  ],
  [`/api/companies/${COMPANY_ID}/routines`]: [
    { id: "routine-1", title: "Nightly build", status: "active", assigneeAgentId: "agent-builder", projectId: "project-1", triggers: [] },
    { id: "routine-2", title: "Old report", status: "archived", assigneeAgentId: "agent-retired", projectId: null, triggers: [] },
  ],
  [`/api/companies/${COMPANY_ID}/agents`]: [
    { id: "agent-owner", name: "Owner" },
    { id: "agent-writer", name: "Writer" },
    { id: "agent-builder", name: "Builder" },
  ],
  [`/api/companies/${COMPANY_ID}/goals`]: [goal, { id: "other", title: "Other goal" }, { id: "no-progress", title: "Empty" }],
};

describe("goal links and goal filters", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logged: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    fetchMock = vi.fn().mockImplementation((url: string) => json(responses[new URL(url).pathname] ?? []));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function requested(): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
  }

  it("composes a goal's projects, open tasks, routines and agents from the list APIs", async () => {
    await run(["goal", "links", GOAL_ID, "--json"]);

    expect(requested()).toEqual(expect.arrayContaining([
      `${API}/goals/${GOAL_ID}`,
      `${API}/companies/${COMPANY_ID}/issues?goalId=${GOAL_ID}&status=backlog%2Ctodo%2Cin_progress%2Cin_review%2Cblocked&limit=500&sortField=id&sortDir=asc`,
      `${API}/companies/${COMPANY_ID}/routines?goalId=${GOAL_ID}`,
    ]));
    expect(JSON.parse(logged.join("\n"))).toEqual({
      goal,
      progress: { total: 3, done: 1, open: 2 },
      projects: [{ id: "project-1", name: "Beta", status: "in_progress" }],
      tasks: [{ id: "issue-1", identifier: "PAP-1", title: "Write the docs", status: "todo", assigneeAgentId: "agent-writer" }],
      routines: [
        { id: "routine-1", title: "Nightly build", status: "active", assigneeAgentId: "agent-builder", projectId: "project-1" },
        { id: "routine-2", title: "Old report", status: "archived", assigneeAgentId: "agent-retired", projectId: null },
      ],
      agents: [
        { agentId: "agent-owner", reasons: ["owner"], name: "Owner" },
        { agentId: "agent-writer", reasons: ["task"], name: "Writer" },
        { agentId: "agent-builder", reasons: ["routine"], name: "Builder" },
      ],
    });
  });

  it("reads every page of a goal's open tasks", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `issue-${String(index).padStart(3, "0")}`, status: "todo", assigneeAgentId: null }));
    const secondPage = [{ id: "issue-500", status: "todo", assigneeAgentId: "agent-late" }];
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/issues")) return json(parsed.searchParams.get("afterId") === "issue-499" ? secondPage : firstPage);
      return json(responses[parsed.pathname] ?? []);
    });

    await run(["goal", "links", GOAL_ID, "--json"]);

    const links = JSON.parse(logged.join("\n"));
    expect(links.tasks).toHaveLength(501);
    expect(links.agents.map((agent: { agentId: string }) => agent.agentId)).toContain("agent-late");
  });

  it("prints each goal's progress", async () => {
    await run(["goal", "progress", "--company-id", COMPANY_ID]);

    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("Ship the beta");
    expect(logged[0]).toContain("done=1");
    expect(logged[1]).toContain("Other goal");
  });

  it("filters the task list by goal", async () => {
    await run(["issue", "list", "--company-id", COMPANY_ID, "--goal-id", GOAL_ID]);

    expect(requested()).toEqual([`${API}/companies/${COMPANY_ID}/issues?goalId=${GOAL_ID}`]);
  });
});
