import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../commands/client/goal.js";
import { registerProjectCommands } from "../commands/client/project.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const GOAL_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerProjectCommands(program);
  registerGoalCommands(program);
  return program;
}

describe("project and goal commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    process.env.PAPERCLIP_CONTEXT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-project-goal-")), "context.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_CONTEXT;
  });

  it("creates and updates projects with shared schemas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Launch Site",
        status: "planned",
        goalIds: [GOAL_ID],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Launch Site",
        status: "in_progress",
        goalIds: [GOAL_ID],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "project", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "Launch Site",
      "--status", "planned",
      "--goal-ids", GOAL_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "project", "update", PROJECT_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--status", "in_progress",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/projects`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "Launch Site",
      status: "planned",
      goalIds: [GOAL_ID],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
  });

  it("lists and deletes projects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: PROJECT_ID, companyId: COMPANY_ID, name: "Launch Site", status: "planned", goalIds: [] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: PROJECT_ID, companyId: COMPANY_ID, name: "Launch Site" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "project", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "project", "delete", PROJECT_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--yes",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/projects`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("creates, updates, lists, and deletes goals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow", level: "company", status: "active" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster", level: "company", status: "active" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster", level: "company", status: "active" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "goal", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--title", "Grow",
      "--level", "company",
      "--status", "active",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "update", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--title", "Grow faster",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "delete", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--yes",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals`);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}`);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });
  it("sets horizon, kind, target date and success criteria on goals and milestones", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: GOAL_ID }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "goal", "create",
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--title", "Land open PRs",
      "--kind", "milestone",
      "--horizon", "short",
      "--target-date", "2026-10-16",
      "--success-criteria", "Open PRs = 0",
      "--parent-id", GOAL_ID,
    ], { from: "user" });
    await createProgram().parseAsync([
      "goal", "update", GOAL_ID,
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
      "--horizon", "null",
      "--target-date", "null",
    ], { from: "user" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: "Land open PRs", kind: "milestone", horizon: "short", targetDate: "2026-10-16", successCriteria: "Open PRs = 0", parentId: GOAL_ID,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ horizon: null, targetDate: null });
  });

  it("rejects a bad target date before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);

    await expect(createProgram().parseAsync([
      "goal", "create",
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
      "--company-id", COMPANY_ID, "--title", "x", "--target-date", "16/10/2026",
    ], { from: "user" })).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("prints the company focus", async () => {
    const focus = {
      guidance: "Pick work that serves the focus first.",
      goals: [{
        id: GOAL_ID, title: "Land open PRs", kind: "goal", level: "company", targetDate: "2026-10-16", daysLeft: 7,
        successCriteria: "Open PRs = 0", ownerAgentId: null, progress: { total: 4, done: 1, open: 3 },
        milestones: [{ id: PROJECT_ID, title: "First half", status: "active", targetDate: "2026-10-12", daysLeft: 3, progress: { total: 2, done: 1, open: 1 } }],
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(focus), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });

    await createProgram().parseAsync([
      "goal", "focus",
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals/focus`);
    const text = lines.join("\n");
    expect(text).toContain("Land open PRs");
    expect(text).toContain("1/4 done");
    expect(text).toContain("7 days left");
    expect(text).toContain("Open PRs = 0");
    expect(text).toContain("First half");
    expect(text).toContain("Pick work that serves the focus first.");
  });
});
