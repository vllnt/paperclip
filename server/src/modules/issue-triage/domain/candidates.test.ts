import { describe, expect, it } from "vitest";
import { groupCandidates, pageGroups } from "./candidates.js";
import { TRIAGE_MAX_MODEL_CALLS, TRIAGE_OWNER_PAGE_SIZE } from "./constants.js";
import type { TriageCandidateAgent } from "./types.js";

const text = { title: "Fix the login redirect loop", description: "" };

function agent(id: string, role: string, title: string | null, openIssues = 0): TriageCandidateAgent {
  return { id, role, title, openIssues };
}

describe("groupCandidates", () => {
  it("makes one option of agents that share a role and title, ignoring case and spacing", () => {
    const groups = groupCandidates(
      [agent("a", "engineer", "Backend Engineer"), agent("b", "Engineer", " backend engineer "), agent("c", "designer", null)],
      text,
    );
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.role.toLowerCase() === "engineer")?.size).toBe(2);
  });

  it("resolves a group to its least busy agent, then the lowest id", () => {
    const [group] = groupCandidates(
      [agent("c", "engineer", "Backend", 3), agent("b", "engineer", "Backend", 1), agent("a", "engineer", "Backend", 1)],
      text,
    );
    expect(group?.agentId).toBe("a");
  });

  it("ranks groups whose role or title shares words with the issue first", () => {
    const groups = groupCandidates(
      [agent("1", "designer", "Visual Designer"), agent("2", "engineer", "Login Engineer"), agent("3", "writer", "Docs Writer")],
      text,
    );
    expect(groups[0]?.agentId).toBe("2");
    expect(groups.map((group) => group.key)).toEqual(["a1", "a2", "a3"]);
  });

  it("orders ties by role and title so the result is stable", () => {
    const first = groupCandidates([agent("2", "writer", "Docs"), agent("1", "analyst", "Data")], text);
    const second = groupCandidates([agent("1", "analyst", "Data"), agent("2", "writer", "Docs")], text);
    expect(first).toEqual(second);
    expect(first[0]?.role).toBe("analyst");
  });

  it("cuts the tail beyond the model-call budget", () => {
    const many = Array.from({ length: 100 }, (_, index) => agent(`id-${String(index).padStart(3, "0")}`, `role-${index}`, null));
    const groups = groupCandidates(many, text);
    expect(groups).toHaveLength(TRIAGE_OWNER_PAGE_SIZE * TRIAGE_MAX_MODEL_CALLS);
  });

  it("returns nothing for no agents", () => {
    expect(groupCandidates([], text)).toEqual([]);
  });
});

describe("pageGroups", () => {
  it("splits groups into pages of the page size", () => {
    const groups = groupCandidates(
      Array.from({ length: 23 }, (_, index) => agent(`id-${index}`, `role-${index}`, null)),
      text,
    );
    const pages = pageGroups(groups);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 3]);
  });

  it("gives no pages for no groups", () => {
    expect(pageGroups([])).toEqual([]);
  });
});
