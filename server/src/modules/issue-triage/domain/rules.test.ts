import { describe, expect, it } from "vitest";
import { countWords, planTriage } from "./rules.js";
import type { TriageIssueFacts } from "./types.js";

function issue(overrides: Partial<TriageIssueFacts> = {}): TriageIssueFacts {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    hidden: false,
    title: "Fix the login redirect loop",
    description: null,
    ...overrides,
  };
}

describe("countWords", () => {
  it("counts runs of letters and digits", () => {
    expect(countWords("Fix bug")).toBe(2);
    expect(countWords("  Fix   the   v2 login-page ")).toBe(5);
    expect(countWords("---")).toBe(0);
  });
});

describe("planTriage", () => {
  it("asks about priority and owner for a plain new issue", () => {
    expect(planTriage(issue())).toEqual({ kind: "ask", askPriority: true, askOwner: true });
  });

  it("leaves routine-made issues alone, without a record", () => {
    expect(planTriage(issue({ originKind: "routine_execution" }))).toEqual({ kind: "ignore", reason: "routine_issue" });
    expect(planTriage(issue({ originKind: "routine_step" }))).toEqual({ kind: "ignore", reason: "routine_issue" });
  });

  it("leaves hidden and closed issues alone", () => {
    expect(planTriage(issue({ hidden: true }))).toEqual({ kind: "ignore", reason: "hidden" });
    expect(planTriage(issue({ status: "done" }))).toEqual({ kind: "ignore", reason: "closed" });
    expect(planTriage(issue({ status: "cancelled" }))).toEqual({ kind: "ignore", reason: "closed" });
  });

  it("does not send titles under three words", () => {
    expect(planTriage(issue({ title: "Fix bug", description: "A long description that has many words in it." }))).toEqual({
      kind: "skip",
      reason: "short_title",
    });
    expect(planTriage(issue({ title: "Fix login bug" })).kind).toBe("ask");
  });

  it("keeps an explicit assignee: the owner is not asked", () => {
    expect(planTriage(issue({ assigneeAgentId: "agent-1" }))).toEqual({ kind: "ask", askPriority: true, askOwner: false });
    expect(planTriage(issue({ assigneeUserId: "user-1" }))).toEqual({ kind: "ask", askPriority: true, askOwner: false });
  });

  it("keeps an explicit priority: it is not asked", () => {
    expect(planTriage(issue({ priority: "high" }))).toEqual({ kind: "ask", askPriority: false, askOwner: true });
    expect(planTriage(issue({ priority: "low", assigneeAgentId: "agent-1" }))).toEqual({
      kind: "ask",
      askPriority: false,
      askOwner: false,
    });
  });
});
