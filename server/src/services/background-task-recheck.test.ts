import { describe, expect, it } from "vitest";
import {
  BACKGROUND_TASK_RECHECK_DEFAULT_DELAYS_MS,
  countBackgroundTaskStopStreak,
  decideBackgroundTaskRecheck,
  parseBackgroundTaskRecheckPolicy,
} from "./background-task-recheck.js";

const MINUTE_MS = 60_000;
const now = new Date("2026-10-09T00:00:00.000Z");
const agentId = "agent-1";

function issue(overrides: Partial<Parameters<typeof decideBackgroundTaskRecheck>[0]["issue"]> = {}) {
  return {
    status: "in_progress",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    monitorNextCheckAt: null,
    ...overrides,
  };
}

describe("background task re-check policy", () => {
  it("defaults to 5, 10 and 20 minutes with three attempts", () => {
    expect(BACKGROUND_TASK_RECHECK_DEFAULT_DELAYS_MS).toEqual([5 * MINUTE_MS, 10 * MINUTE_MS, 20 * MINUTE_MS]);
    expect(parseBackgroundTaskRecheckPolicy(null)).toEqual({
      enabled: true,
      delaysMs: [5 * MINUTE_MS, 10 * MINUTE_MS, 20 * MINUTE_MS],
      maxAttempts: 3,
    });
  });

  it("reads and clamps the per-agent configuration", () => {
    expect(parseBackgroundTaskRecheckPolicy({
      heartbeat: { backgroundTaskRecheck: { delaysSec: [1, 120, 999_999], maxAttempts: 50 } },
    })).toEqual({
      enabled: true,
      // Delays are clamped to [1 min, 24 h]; attempts to at most 10.
      delaysMs: [MINUTE_MS, 2 * MINUTE_MS, 24 * 60 * MINUTE_MS],
      maxAttempts: 10,
    });
    expect(parseBackgroundTaskRecheckPolicy({
      heartbeat: { backgroundTaskRecheck: { enabled: false } },
    }).enabled).toBe(false);
    expect(parseBackgroundTaskRecheckPolicy({
      heartbeat: { backgroundTaskRecheck: { delaysSec: "nope", maxAttempts: -2 } },
    })).toEqual({
      enabled: true,
      delaysMs: [5 * MINUTE_MS, 10 * MINUTE_MS, 20 * MINUTE_MS],
      maxAttempts: 0,
    });
  });
});

describe("background task stop streak", () => {
  it("counts consecutive flagged runs from the newest", () => {
    expect(countBackgroundTaskStopStreak([
      { resultJson: { backgroundTaskStopped: true } },
      { resultJson: { backgroundTaskStopped: true } },
      { resultJson: { stopReason: "completed" } },
      { resultJson: { backgroundTaskStopped: true } },
    ])).toBe(2);
    expect(countBackgroundTaskStopStreak([{ resultJson: null }])).toBe(0);
  });
});

describe("background task re-check decision", () => {
  const policy = parseBackgroundTaskRecheckPolicy(null);

  it("backs off 5, 10 then 20 minutes and stops after the cap", () => {
    const delays = [1, 2, 3].map((streak) => {
      const decision = decideBackgroundTaskRecheck({ issue: issue(), runAgentId: agentId, streak, policy, now });
      expect(decision.kind).toBe("schedule");
      return decision.kind === "schedule" ? decision.nextCheckAt.getTime() - now.getTime() : null;
    });
    expect(delays).toEqual([5 * MINUTE_MS, 10 * MINUTE_MS, 20 * MINUTE_MS]);
    expect(decideBackgroundTaskRecheck({ issue: issue(), runAgentId: agentId, streak: 4, policy, now }))
      .toEqual({ kind: "skip", reason: "max_attempts_exhausted" });
  });

  it("schedules for in_review issues assigned to the run's agent", () => {
    expect(decideBackgroundTaskRecheck({
      issue: issue({ status: "in_review" }), runAgentId: agentId, streak: 1, policy, now,
    }).kind).toBe("schedule");
  });

  it.each([
    ["blocked", issue({ status: "blocked" }), "issue_not_waitable"],
    ["done", issue({ status: "done" }), "issue_not_waitable"],
    ["todo", issue({ status: "todo" }), "issue_not_waitable"],
    ["unassigned", issue({ assigneeAgentId: null }), "not_assigned_to_run_agent"],
    ["another agent", issue({ assigneeAgentId: "agent-2" }), "not_assigned_to_run_agent"],
    ["a user assignee", issue({ assigneeUserId: "user-1" }), "not_assigned_to_run_agent"],
  ])("skips a %s issue", (_label, candidate, reason) => {
    expect(decideBackgroundTaskRecheck({ issue: candidate, runAgentId: agentId, streak: 1, policy, now }))
      .toEqual({ kind: "skip", reason });
  });

  it("keeps a wait the agent already scheduled", () => {
    expect(decideBackgroundTaskRecheck({
      issue: issue({ monitorNextCheckAt: new Date(now.getTime() + MINUTE_MS) }),
      runAgentId: agentId,
      streak: 1,
      policy,
      now,
    })).toEqual({ kind: "skip", reason: "wait_already_scheduled" });
  });

  it("does nothing when the policy is disabled", () => {
    expect(decideBackgroundTaskRecheck({
      issue: issue(), runAgentId: agentId, streak: 1, policy: { ...policy, enabled: false }, now,
    })).toEqual({ kind: "skip", reason: "disabled" });
  });
});
