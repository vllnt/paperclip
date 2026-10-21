import { describe, expect, it } from "vitest";
import {
  MAX_OWNER_OPTIONS,
  buildTriageRequest,
  createCallBudget,
  judgeOwner,
  planTriage,
  shortlistCandidates,
  type OwnerCandidate,
  type TriageIssueFacts,
} from "./policy.js";

function issue(overrides: Partial<TriageIssueFacts> = {}): TriageIssueFacts {
  return {
    id: "issue-1",
    companyId: "company-1",
    title: "Fix the login redirect loop",
    description: "Users bounce between two pages after signing in.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<OwnerCandidate> = {}): OwnerCandidate {
  return { id, name: `Agent ${id}`, role: "engineer", title: null, capabilities: null, ...overrides };
}

describe("planTriage", () => {
  it("asks every question for a plain unassigned issue", () => {
    expect(planTriage(issue())).toEqual({ skip: null, askPriority: true, askOwner: true });
  });

  it("keeps a routine-created issue as it is", () => {
    expect(planTriage(issue({ originKind: "routine_execution" })).skip).toBe("routine_origin");
    expect(planTriage(issue({ originKind: "routine_step" })).skip).toBe("routine_origin");
  });

  it("does not send a title under three words", () => {
    expect(planTriage(issue({ title: "Fix login" })).skip).toBe("short_title");
    expect(planTriage(issue({ title: "  one  " })).skip).toBe("short_title");
    expect(planTriage(issue({ title: "Fix login now" })).skip).toBeNull();
  });

  it("does not ask for an owner when the issue has an assignee", () => {
    expect(planTriage(issue({ assigneeAgentId: "agent-1" })).askOwner).toBe(false);
    expect(planTriage(issue({ assigneeUserId: "user-1" })).askOwner).toBe(false);
  });

  it("does not ask for a priority that someone set on purpose", () => {
    expect(planTriage(issue({ priority: "high" })).askPriority).toBe(false);
    expect(planTriage(issue({ priority: "low" })).askPriority).toBe(false);
  });
});

describe("shortlistCandidates", () => {
  it("keeps all candidates when there are few, sorted by name", () => {
    const list = shortlistCandidates(issue(), [agent("b", { name: "Zed" }), agent("a", { name: "Amy" })]);
    expect(list.map((entry) => entry.name)).toEqual(["Amy", "Zed"]);
  });

  it("caps the list and prefers candidates whose role matches the issue", () => {
    const filler = Array.from({ length: 40 }, (_, index) => agent(`f${index}`, { role: "writer" }));
    const match = agent("match", { name: "Zoe", role: "login engineer", capabilities: "redirect and session bugs" });
    const list = shortlistCandidates(issue(), [...filler, match]);
    expect(list).toHaveLength(MAX_OWNER_OPTIONS);
    expect(list.map((entry) => entry.id)).toContain("match");
  });

  it("returns the same list for the same input", () => {
    const pool = Array.from({ length: 30 }, (_, index) => agent(`x${index}`));
    expect(shortlistCandidates(issue(), pool)).toEqual(shortlistCandidates(issue(), [...pool].reverse()));
  });
});

describe("buildTriageRequest", () => {
  it("always asks the category and asks the rest only when the plan says so", () => {
    const full = buildTriageRequest(issue(), { askPriority: true, askOwner: true }, [agent("a")]);
    expect(Object.keys(full.questions).sort()).toEqual(["category", "owner", "priority"]);
    const bare = buildTriageRequest(issue(), { askPriority: false, askOwner: false }, [agent("a")]);
    expect(Object.keys(bare.questions)).toEqual(["category"]);
  });

  it("sends opaque keys and a none option, never agent ids", () => {
    const request = buildTriageRequest(issue(), { askPriority: false, askOwner: true }, [
      agent("uuid-1", { name: "Amy" }),
      agent("uuid-2", { name: "Ben" }),
    ]);
    const options = request.questions.owner?.options ?? {};
    expect(Object.keys(options)).toEqual(["a1", "a2", "none"]);
    expect(JSON.stringify({ state: request.state, questions: request.questions })).not.toContain("uuid-");
    expect([...request.ownerKeys.entries()]).toEqual([
      ["a1", "uuid-1"],
      ["a2", "uuid-2"],
    ]);
  });

  it("skips the owner question when there is no candidate", () => {
    const request = buildTriageRequest(issue(), { askPriority: true, askOwner: true }, []);
    expect(request.questions.owner).toBeUndefined();
    expect(request.offered).toEqual([]);
  });

  it("bounds the text it sends", () => {
    const request = buildTriageRequest(
      issue({ title: "word ".repeat(200), description: "x".repeat(10_000) }),
      { askPriority: false, askOwner: false },
      [],
    );
    const sent = request.state.issue as { title: string; description: string };
    expect(sent.title.length).toBeLessThanOrEqual(300);
    expect(sent.description.length).toBeLessThanOrEqual(1_500);
  });
});

describe("judgeOwner", () => {
  const ownerKeys = new Map([
    ["a1", "agent-1"],
    ["a2", "agent-2"],
    ["a3", "agent-3"],
  ]);
  const base = { mode: "apply" as const, issueStatus: "todo", ownerKeys };

  it("is eligible when the top reaches 0.8 and beats the next by 0.2", () => {
    const judged = judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.85, a2: 0.1, a3: 0.05 } });
    expect(judged.decision).toBe("applied");
    expect(judged.suggestedAgentId).toBe("agent-1");
    expect(judged.probabilities).toEqual({ "agent-1": 0.85, "agent-2": 0.1, "agent-3": 0.05 });
  });

  it("accepts exactly 0.8 and exactly a 0.2 margin", () => {
    expect(judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.8, a2: 0.6 } }).decision).toBe("applied");
    expect(judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.8, a2: 0.2 } }).decision).toBe("applied");
    expect(judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.9, a2: 0.7 } }).margin).toBe(0.2);
    expect(judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.9, a2: 0.7 } }).decision).toBe("applied");
  });

  it("refuses a top probability under 0.8", () => {
    expect(judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.79, a2: 0.01 } }).decision).toBe(
      "below_probability",
    );
  });

  it("refuses a margin under 0.2", () => {
    expect(judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.85, a2: 0.7 } }).decision).toBe("below_margin");
  });

  it("counts the none option as a rival", () => {
    const judged = judgeOwner({ ...base, choice: "a1", probabilities: { a1: 0.85, none: 0.75 } });
    expect(judged.decision).toBe("below_margin");
  });

  it("suggests nothing when none is on top", () => {
    const judged = judgeOwner({ ...base, choice: "none", probabilities: { a1: 0.1, none: 0.9 } });
    expect(judged.suggestedAgentId).toBeNull();
    expect(judged.decision).toBe("no_owner_suggested");
  });

  it("never applies in suggest mode", () => {
    const judged = judgeOwner({ ...base, mode: "suggest", choice: "a1", probabilities: { a1: 0.99 } });
    expect(judged.decision).toBe("mode_suggest");
    expect(judged.suggestedAgentId).toBe("agent-1");
  });

  it("never applies outside todo", () => {
    expect(judgeOwner({ ...base, issueStatus: "backlog", choice: "a1", probabilities: { a1: 0.99 } }).decision).toBe(
      "not_todo",
    );
  });

  it("does not apply without probabilities", () => {
    const judged = judgeOwner({ ...base, choice: "a1", probabilities: null });
    expect(judged.suggestedAgentId).toBe("agent-1");
    expect(judged.decision).toBe("no_probabilities");
  });

  it("ignores a key the model invented", () => {
    const judged = judgeOwner({ ...base, choice: "zzz", probabilities: { zzz: 0.99 } });
    expect(judged.suggestedAgentId).toBeNull();
    expect(judged.probabilities).toBeNull();
  });
});

describe("createCallBudget", () => {
  it("refuses the call after the ceiling", () => {
    const budget = createCallBudget(6);
    const granted = Array.from({ length: 8 }, () => budget.take());
    expect(granted).toEqual([true, true, true, true, true, true, false, false]);
    expect(budget.used()).toBe(6);
  });
});
