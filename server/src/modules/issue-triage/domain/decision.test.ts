import { describe, expect, it } from "vitest";
import { decideOwner, readCategory, readPriority, readProbabilities } from "./decision.js";
import type { TriageCandidateGroup, TriageOwnerPage } from "./types.js";

function group(key: string, agentId = `agent-${key}`): TriageCandidateGroup {
  return { key, role: `role-${key}`, title: null, agentId, size: 1 };
}

function page(groups: TriageCandidateGroup[], probabilities: Record<string, number> | null, choice: string | null = null): TriageOwnerPage {
  return { groups, answer: { choice, probabilities, abstained: false } };
}

describe("readProbabilities", () => {
  it("keeps known options only, clamped to [0, 1]", () => {
    expect(readProbabilities(["a", "b"], { a: 1.4, b: -0.2, c: 0.5, d: Number.NaN })).toEqual({ a: 1, b: 0 });
  });

  it("gives null when nothing usable is left", () => {
    expect(readProbabilities(["a"], null)).toBeNull();
    expect(readProbabilities(["a"], { z: 0.9 })).toBeNull();
  });
});

describe("readPriority and readCategory", () => {
  it("takes the model's own pick when it is a known option", () => {
    const read = readPriority({ choice: "high", probabilities: { high: 0.6, medium: 0.3 }, abstained: false });
    expect(read.value).toBe("high");
    expect(read.probabilities).toEqual({ high: 0.6, medium: 0.3 });
  });

  it("falls back to the most probable option when the pick is unknown", () => {
    expect(readPriority({ choice: "urgent", probabilities: { low: 0.1, critical: 0.7 }, abstained: true }).value).toBe("critical");
  });

  it("gives null without a pick or probabilities", () => {
    expect(readCategory({ choice: null, probabilities: null, abstained: true }).value).toBeNull();
    expect(readCategory(undefined).value).toBeNull();
  });

  it("reads a category", () => {
    expect(readCategory({ choice: "bug", probabilities: { bug: 0.9 }, abstained: false }).value).toBe("bug");
  });
});

describe("decideOwner", () => {
  const groups = [group("a1"), group("a2"), group("a3")];

  it("may apply a top owner at 0.8 that leads by 0.2", () => {
    const decision = decideOwner([page(groups, { a1: 0.8, a2: 0.6, a3: 0, none: 0 })]);
    // 0.8 - 0.6 is 0.2 up to floating-point noise.
    expect(decision.suggestedAgentId).toBe("agent-a1");
    expect(decision.blockedBy).toBeNull();
  });

  it("may apply 0.9 over 0.7 despite floating-point noise", () => {
    expect(decideOwner([page(groups, { a1: 0.9, a2: 0.7, none: 0.05 })]).blockedBy).toBeNull();
  });

  it("blocks a top owner under 0.8 and still suggests it", () => {
    const decision = decideOwner([page(groups, { a1: 0.79, a2: 0.1, a3: 0.05, none: 0.01 })]);
    expect(decision.suggestedAgentId).toBe("agent-a1");
    expect(decision.blockedBy).toBe("below_threshold");
  });

  it("blocks a lead under 0.2", () => {
    const decision = decideOwner([page(groups, { a1: 0.85, a2: 0.66, a3: 0, none: 0 })]);
    expect(decision.blockedBy).toBe("narrow_margin");
  });

  it("counts the none option as the next option", () => {
    const decision = decideOwner([page(groups, { a1: 0.82, a2: 0, a3: 0, none: 0.7 })]);
    expect(decision.blockedBy).toBe("narrow_margin");
  });

  it("suggests nothing when the model prefers none", () => {
    const decision = decideOwner([page(groups, { a1: 0.3, a2: 0.1, a3: 0.1, none: 0.5 })]);
    expect(decision.suggestedAgentId).toBeNull();
    expect(decision.blockedBy).toBe("none_preferred");
  });

  it("never applies without probabilities, and suggests the pick of a single page", () => {
    const decision = decideOwner([page(groups, null, "a2")]);
    expect(decision.suggestedAgentId).toBe("agent-a2");
    expect(decision.blockedBy).toBe("no_probabilities");
    expect(decideOwner([page(groups, null, "none")]).suggestedAgentId).toBeNull();
  });

  it("suggests nothing without candidates", () => {
    const decision = decideOwner([]);
    expect(decision.suggestedAgentId).toBeNull();
    expect(decision.blockedBy).toBe("no_suggestion");
    expect(decision.options).toEqual([]);
  });

  it("takes the best group across pages and ignores another page's none option", () => {
    const first = page([group("a1"), group("a2")], { a1: 0.1, a2: 0.1, none: 0.8 });
    const second = page([group("a11"), group("a12")], { a11: 0.9, a12: 0.05, none: 0.05 });
    const decision = decideOwner([first, second]);
    expect(decision.suggestedAgentId).toBe("agent-a11");
    // next best is a1 or a2 at 0.1, not the first page's none at 0.8
    expect(decision.blockedBy).toBeNull();
  });

  it("blocks when two pages both have a strong owner", () => {
    const first = page([group("a1")], { a1: 0.85, none: 0.15 });
    const second = page([group("a11")], { a11: 0.8, none: 0.2 });
    expect(decideOwner([first, second]).blockedBy).toBe("narrow_margin");
  });

  it("lists every option with its probability, including each none option", () => {
    const decision = decideOwner([page(groups, { a1: 0.8, a2: 0.1, a3: 0.05, none: 0.05 })]);
    expect(decision.options).toHaveLength(4);
    expect(decision.options?.[3]).toMatchObject({ agentId: null, role: "none", probability: 0.05 });
    expect(decision.options?.[0]).toMatchObject({ agentId: "agent-a1", probability: 0.8, groupSize: 1 });
  });
});
