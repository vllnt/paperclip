import { describe, expect, it } from "vitest";
import {
  compareDeferredWakes,
  decideDeferredWakeDisposition,
  DEFERRED_WAKE_SWEEP_MAX_PER_AGENT_PER_PASS,
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
        { maxTotal: sweepPromotionBudget(), maxPerAgent: 1_000 },
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
      { maxPerAgent: 10 },
    );
    expect(ids(selected)).toEqual(["critical-new", "medium-old", "medium-new", "low-old"]);
  });

  it("does not hold a busy agent's wakes back: promotion queues a run, the queue claim enforces the slots", () => {
    // Before, an agent whose slots were full (as they always are while it has
    // queued work) never had a wake promoted: its queued runs took each freed slot.
    const selected = selectDeferredWakesToPromote(
      [wake("busy-1", { agent: "agent-busy", minutesAgo: 30 }), wake("busy-2", { agent: "agent-busy", minutesAgo: 20 })],
    );
    expect(ids(selected)).toEqual(["busy-1", "busy-2"]);
  });

  it("caps one agent's share of a pass, so its backlog cannot fill the pass", () => {
    expect(DEFERRED_WAKE_SWEEP_MAX_PER_AGENT_PER_PASS).toBe(3);
    const backlog = Array.from({ length: 10 }, (_, index) =>
      wake(`a${index}`, { agent: "agent-a", minutesAgo: 100 - index }));
    const selected = selectDeferredWakesToPromote(
      [...backlog, wake("b-young", { agent: "agent-b", minutesAgo: 1 })],
      { maxTotal: sweepPromotionBudget() },
    );
    expect(ids(selected)).toEqual(["a0", "a1", "a2", "b-young"]);
  });

  it("budgets each agent separately", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("a1", { agent: "agent-a", minutesAgo: 30 }),
        wake("b1", { agent: "agent-b", minutesAgo: 25 }),
        wake("a2", { agent: "agent-a", minutesAgo: 10 }),
        wake("b2", { agent: "agent-b", minutesAgo: 5 }),
      ],
      { maxPerAgent: 1 },
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
      { maxPerAgent: 10 },
    );
    expect(ids(selected)).toEqual(["oldest"]);
  });

  it("never serves an issue through a younger wake when the oldest wake's agent used its share", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("a-first", { agent: "agent-a", issue: "issue-0", minutesAgo: 50 }),
        wake("a-oldest-on-issue", { agent: "agent-a", issue: "issue-1", minutesAgo: 40 }),
        wake("b-younger-on-issue", { agent: "agent-b", issue: "issue-1", minutesAgo: 5 }),
      ],
      { maxPerAgent: 1 },
    );
    expect(ids(selected)).toEqual(["a-first"]);
  });

  it("does not spend an agent's share on an issue it skips", () => {
    const selected = selectDeferredWakesToPromote(
      [
        wake("shadowed", { issue: "issue-1", minutesAgo: 5 }),
        wake("head", { issue: "issue-1", minutesAgo: 30 }),
        wake("other-issue", { issue: "issue-2", minutesAgo: 10 }),
      ],
      { maxPerAgent: 2 },
    );
    expect(ids(selected)).toEqual(["head", "other-issue"]);
  });

  it("honours a total cap", () => {
    const selected = selectDeferredWakesToPromote(
      [wake("one", { minutesAgo: 30 }), wake("two", { minutesAgo: 20 }), wake("three", { minutesAgo: 10 })],
      { maxTotal: 1 },
    );
    expect(ids(selected)).toEqual(["one"]);
  });

  it("does not mutate its inputs", () => {
    const candidates = [wake("late", { minutesAgo: 1 }), wake("early", { minutesAgo: 9 })];
    selectDeferredWakesToPromote(candidates);
    expect(ids(candidates)).toEqual(["late", "early"]);
  });

  it("returns nothing for no candidates", () => {
    expect(selectDeferredWakesToPromote([])).toEqual([]);
  });
});

describe("decideDeferredWakeDisposition", () => {
  const now = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
  const hour = 60 * 60 * 1000;
  const facts = (input: {
    hoursAgo: number;
    wakeReason?: string | null;
    assignee?: string | null;
    issueStatus?: string;
    carriesSavedInput?: boolean;
    mergedWakeCount?: number;
  }) => ({
    agentId: "agent-a",
    requestedAt: new Date(now.getTime() - input.hoursAgo * hour),
    wakeReason: input.wakeReason === undefined ? "issue_assigned" : input.wakeReason,
    issueAssigneeAgentId: input.assignee === undefined ? "agent-a" : input.assignee,
    issueStatus: input.issueStatus ?? "todo",
    carriesSavedInput: input.carriesSavedInput ?? false,
    mergedWakeCount: input.mergedWakeCount ?? 0,
  });

  it("promotes a fresh wake for the current assignee", () => {
    expect(decideDeferredWakeDisposition(facts({ hoursAgo: 1 }), { now, maxAgeMs: 24 * hour })).toBe("promote");
  });

  it("expires a wake parked longer than the max age, whatever its reason", () => {
    expect(decideDeferredWakeDisposition(facts({ hoursAgo: 25 }), { now, maxAgeMs: 24 * hour })).toBe("expired");
    expect(
      decideDeferredWakeDisposition(facts({ hoursAgo: 25, wakeReason: "issue_comment_mentioned", assignee: "agent-b" }), {
        now,
        maxAgeMs: 24 * hour,
      }),
    ).toBe("expired");
  });

  it("never expires a wake that carries saved input, so a saved message is still delivered", () => {
    expect(
      decideDeferredWakeDisposition(facts({ hoursAgo: 200, wakeReason: "issue_comment_mentioned", carriesSavedInput: true }), {
        now,
        maxAgeMs: 24 * hour,
      }),
    ).toBe("promote");
    expect(
      decideDeferredWakeDisposition(facts({ hoursAgo: 200, wakeReason: "issue_commented", assignee: "agent-b", carriesSavedInput: true }), {
        now,
        maxAgeMs: 24 * hour,
      }),
    ).toBe("superseded");
  });

  it("expires an old wake only on an issue that stranded-issue recovery dispatches again", () => {
    for (const issueStatus of ["todo", "in_progress", "in_review"]) {
      expect(decideDeferredWakeDisposition(facts({ hoursAgo: 200, issueStatus }), { now, maxAgeMs: 24 * hour })).toBe(
        "expired",
      );
    }
    for (const issueStatus of ["blocked", "backlog"]) {
      expect(decideDeferredWakeDisposition(facts({ hoursAgo: 200, issueStatus }), { now, maxAgeMs: 24 * hour })).toBe(
        "promote",
      );
    }
  });

  it("never expires a wake that later wakes were merged into, since the merged signal may be fresh", () => {
    expect(
      decideDeferredWakeDisposition(facts({ hoursAgo: 200, mergedWakeCount: 1 }), { now, maxAgeMs: 24 * hour }),
    ).toBe("promote");
  });

  it("keeps a wake exactly at the max age", () => {
    expect(decideDeferredWakeDisposition(facts({ hoursAgo: 24 }), { now, maxAgeMs: 24 * hour })).toBe("promote");
  });

  it("supersedes an assignee wake whose agent no longer holds the issue", () => {
    for (const wakeReason of ["issue_assigned", "issue_commented", "issue_reopened_via_comment", "issue_continuation_needed"]) {
      expect(
        decideDeferredWakeDisposition(facts({ hoursAgo: 1, wakeReason, assignee: "agent-b" }), { now, maxAgeMs: 24 * hour }),
      ).toBe("superseded");
    }
    expect(
      decideDeferredWakeDisposition(facts({ hoursAgo: 1, assignee: null }), { now, maxAgeMs: 24 * hour }),
    ).toBe("superseded");
  });

  it("still delivers a wake that addresses a non-assignee on purpose", () => {
    for (const wakeReason of ["issue_comment_mentioned", "execution_review_requested", "approval_approved", null]) {
      expect(
        decideDeferredWakeDisposition(facts({ hoursAgo: 1, wakeReason, assignee: "agent-b" }), { now, maxAgeMs: 24 * hour }),
      ).toBe("promote");
    }
  });
});
