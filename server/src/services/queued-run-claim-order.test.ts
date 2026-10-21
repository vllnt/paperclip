import { describe, expect, it } from "vitest";
import {
  orderQueuedRunsForClaim,
  QUEUED_RUN_PRIORITY_AGING_STEP_MS,
  type QueuedRunIssueFacts,
} from "./queued-run-claim-order.js";
import { PLANNED_RESTART_RESUME_RETRY_REASON } from "./execution-recovery-attempt.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const MINUTE = 60_000;
const STEP = QUEUED_RUN_PRIORITY_AGING_STEP_MS;

type Run = {
  id: string;
  createdAt: Date;
  scheduledRetryAt: Date | null;
  scheduledRetryReason?: string | null;
  issue: QueuedRunIssueFacts | null;
};

function run(
  id: string,
  waitedMs: number,
  issue: Partial<QueuedRunIssueFacts> | null,
  scheduledRetryAt: Date | null = null,
  scheduledRetryReason: string | null = null,
): Run {
  return {
    id,
    createdAt: new Date(NOW.getTime() - waitedMs),
    scheduledRetryAt,
    scheduledRetryReason,
    issue: issue ? { priority: "medium", inProgress: false, dependencyReady: true, routineRunsFirst: false, ...issue } : null,
  };
}

function order(runs: Run[]) {
  return orderQueuedRunsForClaim(runs, (r) => r.issue, NOW).map((r) => r.id);
}

describe("orderQueuedRunsForClaim", () => {
  it("starts a critical run before earlier low runs of in-progress issues", () => {
    const lows = Array.from({ length: 10 }, (_, i) => run(`low-${i}`, (20 - i) * MINUTE, { priority: "low", inProgress: true }));
    const critical = run("critical", MINUTE, { priority: "critical" });
    expect(order([...lows, critical])).toEqual(["critical", ...lows.map((r) => r.id)]);
  });

  it("orders by priority, then oldest first", () => {
    expect(order([
      run("low-old", 9 * MINUTE, { priority: "low" }),
      run("high-new", 1 * MINUTE, { priority: "high" }),
      run("high-old", 2 * MINUTE, { priority: "high" }),
      run("medium", 3 * MINUTE, { priority: "medium" }),
      run("critical", 1 * MINUTE, { priority: "critical" }),
    ])).toEqual(["critical", "high-old", "high-new", "medium", "low-old"]);
  });

  it("ranks a run without an issue as medium: after high, before low", () => {
    expect(order([
      run("no-issue", 5 * MINUTE, null),
      run("low", 6 * MINUTE, { priority: "low" }),
      run("high", 1 * MINUTE, { priority: "high" }),
      run("medium-newer", 4 * MINUTE, { priority: "medium" }),
    ])).toEqual(["high", "no-issue", "medium-newer", "low"]);
  });

  it("ranks an unknown priority (issue gone) as medium", () => {
    expect(order([
      run("low", 5 * MINUTE, { priority: "low" }),
      run("missing", 1 * MINUTE, { priority: undefined }),
    ])).toEqual(["missing", "low"]);
  });

  it("starts runs whose issue is dependency-blocked last, whatever their priority or age", () => {
    expect(order([
      run("blocked-critical", 4 * STEP, { priority: "critical", dependencyReady: false }),
      run("low", MINUTE, { priority: "low" }),
    ])).toEqual(["low", "blocked-critical"]);
  });

  it("prefers a fresh in-progress issue run at equal priority, as before", () => {
    expect(order([
      run("todo-older", 10 * MINUTE, { priority: "medium" }),
      run("in-progress-newer", 1 * MINUTE, { priority: "medium", inProgress: true }),
    ])).toEqual(["in-progress-newer", "todo-older"]);
  });

  describe("routine slot priority", () => {
    it("starts a routine run set to first before older, aged and more urgent work", () => {
      expect(order([
        run("critical-old", 4 * STEP, { priority: "critical", inProgress: true }),
        run("high-aged", 2 * STEP, { priority: "high" }),
        run("routine-tick", MINUTE, { priority: "low", routineRunsFirst: true }),
        run("no-issue", 3 * STEP, null),
      ])).toEqual(["routine-tick", "critical-old", "no-issue", "high-aged"]);
    });

    it("keeps the usual order among several routine runs set to first", () => {
      expect(order([
        run("first-low-new", MINUTE, { priority: "low", routineRunsFirst: true }),
        run("first-high", 2 * MINUTE, { priority: "high", routineRunsFirst: true }),
        run("first-low-old", 3 * MINUTE, { priority: "low", routineRunsFirst: true }),
        run("medium", 4 * MINUTE, { priority: "medium" }),
      ])).toEqual(["first-high", "first-low-old", "first-low-new", "medium"]);
    });

    it("still starts a dependency-blocked routine run last", () => {
      expect(order([
        run("blocked-routine", 5 * MINUTE, { priority: "critical", routineRunsFirst: true, dependencyReady: false }),
        run("low", MINUTE, { priority: "low" }),
      ])).toEqual(["low", "blocked-routine"]);
    });

    it("leaves the order unchanged for a routine at the default", () => {
      const queue = [
        run("routine-tick", MINUTE, { priority: "medium" }),
        run("medium-old", 2 * MINUTE, { priority: "medium" }),
        run("high", MINUTE, { priority: "high" }),
      ];
      expect(order(queue)).toEqual(["high", "medium-old", "routine-tick"]);
    });
  });

  describe("restart resume", () => {
    const resume = PLANNED_RESTART_RESUME_RETRY_REASON;
    const dueNow = NOW;

    it("starts a resume before older and higher-priority queued runs", () => {
      expect(order([
        run("critical-old", 20 * MINUTE, { priority: "critical" }),
        run("high-in-progress", 10 * MINUTE, { priority: "high", inProgress: true }),
        run("resume-low", 2 * MINUTE, { priority: "low" }, dueNow, resume),
      ])).toEqual(["resume-low", "critical-old", "high-in-progress"]);
    });

    it("starts a resume before a run that aged past it", () => {
      expect(order([
        run("aged-low", 4 * STEP, { priority: "low" }),
        run("resume-medium", 0, { priority: "medium" }, dueNow, resume),
      ])).toEqual(["resume-medium", "aged-low"]);
    });

    it("keeps the usual order among several resumes", () => {
      expect(order([
        run("resume-low", 5 * MINUTE, { priority: "low" }, dueNow, resume),
        run("resume-high-new", 1 * MINUTE, { priority: "high" }, dueNow, resume),
        run("resume-high-old", 3 * MINUTE, { priority: "high" }, new Date(NOW.getTime() - 3 * MINUTE), resume),
      ])).toEqual(["resume-high-old", "resume-high-new", "resume-low"]);
    });

    it("still starts a resume whose issue is dependency-blocked after unblocked runs", () => {
      expect(order([
        run("blocked-resume", 0, { priority: "critical", dependencyReady: false }, dueNow, resume),
        run("low", MINUTE, { priority: "low" }),
      ])).toEqual(["low", "blocked-resume"]);
    });

    it("starts a resume before a routine run set to first", () => {
      expect(order([
        run("routine-first", 5 * MINUTE, { priority: "critical", routineRunsFirst: true }),
        run("resume-low", 0, { priority: "low" }, dueNow, resume),
      ])).toEqual(["resume-low", "routine-first"]);
    });

    it("gives no priority to an ordinary scheduled retry", () => {
      expect(order([
        run("critical", MINUTE, { priority: "critical" }),
        run("transient-retry", 0, { priority: "low" }, dueNow, "transient_failure"),
      ])).toEqual(["critical", "transient-retry"]);
    });
  });

  describe("aging", () => {
    it("keeps a low run behind a fresh critical run just before three steps", () => {
      expect(order([
        run("low", 3 * STEP - 1, { priority: "low" }),
        run("critical", 0, { priority: "critical" }),
      ])).toEqual(["critical", "low"]);
    });

    it("starts a low run that waited three steps before a fresh critical run", () => {
      expect(order([
        run("critical", 0, { priority: "critical" }),
        run("low", 3 * STEP, { priority: "low" }),
      ])).toEqual(["low", "critical"]);
    });

    it("raises one level per step: a low run waiting one step ties medium and wins on age", () => {
      expect(order([
        run("medium", 5 * MINUTE, { priority: "medium" }),
        run("low", STEP, { priority: "low" }),
        run("high", 0, { priority: "high" }),
      ])).toEqual(["high", "low", "medium"]);
    });

    it("lets an aged run pass a fresh in-progress run of the same effective priority", () => {
      expect(order([
        run("critical-in-progress", 0, { priority: "critical", inProgress: true }),
        run("low-aged", 4 * STEP, { priority: "low" }),
      ])).toEqual(["low-aged", "critical-in-progress"]);
    });

    it("counts a promoted scheduled retry's wait from when it became due", () => {
      const dueOneMinuteAgo = new Date(NOW.getTime() - MINUTE);
      expect(order([
        run("retry-low", 5 * STEP, { priority: "low" }, dueOneMinuteAgo),
        run("critical", 0, { priority: "critical" }),
      ])).toEqual(["critical", "retry-low"]);
    });

    it("lines up a promoted scheduled retry from when it became due, not from its creation", () => {
      // The retry was created 110 minutes ago and became due 10 minutes ago.
      // The other run was queued 12 minutes ago, so it has waited longer.
      const dueTenMinutesAgo = new Date(NOW.getTime() - 10 * MINUTE);
      expect(order([
        run("retry", 110 * MINUTE, { priority: "medium" }, dueTenMinutesAgo),
        run("waited-longer", 12 * MINUTE, { priority: "medium" }),
      ])).toEqual(["waited-longer", "retry"]);
    });

    it("bounds the wait of a low run behind a steady stream of critical runs", () => {
      // A new critical run arrives every 10 minutes and one run starts every
      // 10 minutes. Without aging the low run would never start.
      const queue: Run[] = [run("low", 0, { priority: "low" })];
      let startedAtMinute: number | null = null;
      for (let minute = 0; minute <= 24 * 60 && startedAtMinute === null; minute += 10) {
        const now = new Date(NOW.getTime() + minute * MINUTE);
        queue.push({ ...run(`critical-${minute}`, 0, { priority: "critical" }), createdAt: now });
        const [next] = orderQueuedRunsForClaim(queue, (r) => r.issue, now);
        queue.splice(queue.indexOf(next!), 1);
        if (next!.id === "low") startedAtMinute = minute;
      }
      expect(startedAtMinute).toBe(90);
    });
  });
});
