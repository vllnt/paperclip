import { describe, expect, it } from "vitest";
import {
  compareDeferredWakes,
  DEFERRED_WAKE_SWEEP_MAX_PER_PASS,
  issuePriorityRank,
  selectDeferredWakesToPromote,
  sweepPromotionBudget,
  type OrphanedDeferredWake,
} from "./deferred-wake-sweep.js";

function wake(
  id: string,
  input: { agent?: string; issue?: string; minutesAgo: number; priority?: string | null },
): OrphanedDeferredWake {
  return {
    wakeId: id,
    companyId: "company",
    agentId: input.agent ?? "agent-a",
    issueId: input.issue ?? `issue-${id}`,
    requestedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0) - input.minutesAgo * 60_000),
    issuePriority: input.priority === undefined ? "medium" : input.priority,
  };
}

const ids = (wakes: readonly OrphanedDeferredWake[]) => wakes.map((entry) => entry.wakeId);
const slots = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe("sweepPromotionBudget", () => {
  it("bounds a pass to the cap, so the first pass after a deploy cannot start a burst of runs", () => {
    expect(DEFERRED_WAKE_SWEEP_MAX_PER_PASS).toBe(20);
    expect(sweepPromotionBudget()).toBe(20);
    expect(sweepPromotionBudget(1_000)).toBe(20);
  });

  it("lets a caller ask for fewer, never a negative number", () => {
    expect(sweepPromotionBudget(5)).toBe(5);
    expect(sweepPromotionBudget(0)).toBe(0);
    expect(sweepPromotionBudget(-3)).toBe(0);
  });

  it("drains a stranded backlog over several passes", () => {
    const backlog = Array.from({ length: 45 }, (_, index) => wake(`w${index}`, { minutesAgo: 100 - index }));
    const remaining = new Set(backlog.map((entry) => entry.wakeId));
    let passes = 0;
    while (remaining.size > 0) {
      const pass = selectDeferredWakesToPromote(
        backlog.filter((entry) => remaining.has(entry.wakeId)),
        slots({ "agent-a": 1_000 }),
        { maxTotal: sweepPromotionBudget() },
      );
      expect(pass.length).toBeGreaterThan(0);
      expect(pass.length).toBeLessThanOrEqual(DEFERRED_WAKE_SWEEP_MAX_PER_PASS);
      for (const entry of pass) remaining.delete(entry.wakeId);
      passes += 1;
    }
    expect(passes).toBe(3);
  });
});

describe("issuePriorityRank", () => {
  it("ranks critical before high before medium before low", () => {
    expect(["low", "critical", "medium", "high"].sort((a, b) => issuePriorityRank(a) - issuePriorityRank(b))).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });

  it("treats a missing or unknown priority as medium", () => {
    expect(issuePriorityRank(null)).toBe(issuePriorityRank("medium"));
    expect(issuePriorityRank(undefined)).toBe(issuePriorityRank("medium"));
    expect(issuePriorityRank("urgent")).toBe(issuePriorityRank("medium"));
  });
});

describe("compareDeferredWakes", () => {
  it("puts the more urgent issue first even when its wake is newer", () => {
    const older = wake("older-low", { minutesAgo: 60, priority: "low" });
    const newer = wake("newer-critical", { minutesAgo: 1, priority: "critical" });
    expect(ids([older, newer].sort(compareDeferredWakes))).toEqual(["newer-critical", "older-low"]);
  });

  it("orders equal priorities oldest first, then by id so the order is total", () => {
    const first = wake("b", { minutesAgo: 10 });
    const second = wake("a", { minutesAgo: 5 });
    const tieB = wake("tie-b", { minutesAgo: 3 });
    const tieA = wake("tie-a", { minutesAgo: 3 });
    expect(ids([second, tieB, first, tieA].sort(compareDeferredWakes))).toEqual(["b", "a", "tie-a", "tie-b"]);
  });
});

describe("selectDeferredWakesToPromote", () => {
  it("promotes in priority then FIFO order", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("low-old", { minutesAgo: 90, priority: "low" }),
        wake("medium-old", { minutesAgo: 80 }),
        wake("critical-new", { minutesAgo: 2, priority: "critical" }),
        wake("medium-new", { minutesAgo: 5 }),
      ],
      slots({ "agent-a": 10 }),
    );
    expect(ids(selected)).toEqual(["critical-new", "medium-old", "medium-new", "low-old"]);
  });

  it("gives an agent at most its free slots", () => {
    const selected = selectDeferredWakesToPromote(
      [wake("one", { minutesAgo: 30 }), wake("two", { minutesAgo: 20 }), wake("three", { minutesAgo: 10 })],
      slots({ "agent-a": 2 }),
    );
    expect(ids(selected)).toEqual(["one", "two"]);
  });

  it("budgets each agent separately and leaves a full or unknown agent parked", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("a1", { agent: "agent-a", minutesAgo: 30 }),
        wake("b1", { agent: "agent-b", minutesAgo: 25 }),
        wake("full", { agent: "agent-full", minutesAgo: 20 }),
        wake("unknown", { agent: "agent-unknown", minutesAgo: 15 }),
        wake("a2", { agent: "agent-a", minutesAgo: 10 }),
      ],
      slots({ "agent-a": 1, "agent-b": 1, "agent-full": 0 }),
    );
    expect(ids(selected)).toEqual(["a1", "b1"]);
  });

  it("takes only the oldest wake of an issue; the rest wait for its run to release", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("younger", { issue: "issue-1", minutesAgo: 5 }),
        wake("oldest", { issue: "issue-1", minutesAgo: 40 }),
        wake("middle", { issue: "issue-1", minutesAgo: 20 }),
      ],
      slots({ "agent-a": 10 }),
    );
    expect(ids(selected)).toEqual(["oldest"]);
  });

  it("never serves an issue through a younger wake when the oldest wake's agent is full", () => {
    // The drain promotes the issue's oldest wake whoever asked, so waking the
    // issue through agent-b's younger wake would start agent-a's wake over its cap.
    const selected = selectDeferredWakesToPromote(
      [
        wake("oldest-full-agent", { agent: "agent-full", issue: "issue-1", minutesAgo: 40 }),
        wake("younger-free-agent", { agent: "agent-b", issue: "issue-1", minutesAgo: 5 }),
      ],
      slots({ "agent-full": 0, "agent-b": 3 }),
    );
    expect(selected).toEqual([]);
  });

  it("does not spend a slot on an issue it skips", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("shadowed", { issue: "issue-1", minutesAgo: 5 }),
        wake("head", { issue: "issue-1", minutesAgo: 30 }),
        wake("other-issue", { issue: "issue-2", minutesAgo: 10 }),
      ],
      slots({ "agent-a": 2 }),
    );
    expect(ids(selected)).toEqual(["head", "other-issue"]);
  });

  it("honours a total cap", () => {
    const selected = selectDeferredWakesToPromote(
      [wake("one", { minutesAgo: 30 }), wake("two", { minutesAgo: 20 }), wake("three", { minutesAgo: 10 })],
      slots({ "agent-a": 5 }),
      { maxTotal: 1 },
    );
    expect(ids(selected)).toEqual(["one"]);
  });

  it("does not mutate its inputs", () => {
    const candidates = [wake("late", { minutesAgo: 1 }), wake("early", { minutesAgo: 9 })];
    const budget = slots({ "agent-a": 1 });
    selectDeferredWakesToPromote(candidates, budget);
    expect(ids(candidates)).toEqual(["late", "early"]);
    expect(budget.get("agent-a")).toBe(1);
  });

  it("returns nothing for no candidates", () => {
    expect(selectDeferredWakesToPromote([], slots({ "agent-a": 3 }))).toEqual([]);
  });
});
