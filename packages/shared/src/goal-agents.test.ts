import { describe, expect, it } from "vitest";
import { goalAgentLinks } from "./goal-agents.js";

describe("goalAgentLinks", () => {
  it("links the owner, the assignees of open tasks and the agents of routines that are not archived", () => {
    expect(goalAgentLinks({
      ownerAgentId: "owner",
      tasks: [
        { assigneeAgentId: "builder", status: "in_progress" },
        { assigneeAgentId: "reviewer", status: "blocked" },
        { assigneeAgentId: "finished", status: "done" },
        { assigneeAgentId: "dropped", status: "cancelled" },
        { assigneeAgentId: null, status: "todo" },
      ],
      routines: [
        { assigneeAgentId: "scheduler", status: "active" },
        { assigneeAgentId: "builder", status: "paused" },
        { assigneeAgentId: "retired", status: "archived" },
        { assigneeAgentId: null, status: "active" },
      ],
    })).toEqual([
      { agentId: "owner", reasons: ["owner"] },
      { agentId: "builder", reasons: ["task", "routine"] },
      { agentId: "reviewer", reasons: ["task"] },
      { agentId: "scheduler", reasons: ["routine"] },
    ]);
  });

  it("lists an agent once with each reason once", () => {
    expect(goalAgentLinks({
      ownerAgentId: "builder",
      tasks: [
        { assigneeAgentId: "builder", status: "todo" },
        { assigneeAgentId: "builder", status: "in_review" },
      ],
      routines: [{ assigneeAgentId: "builder", status: "active" }],
    })).toEqual([{ agentId: "builder", reasons: ["owner", "task", "routine"] }]);
  });

  it("is empty for a goal with no owner and no open work", () => {
    expect(goalAgentLinks({ ownerAgentId: null, tasks: [{ assigneeAgentId: "a", status: "done" }], routines: [] })).toEqual([]);
  });
});
