import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { runPeriodicHeartbeatRecovery } from "../services/periodic-heartbeat-recovery.ts";

const steps = [
  "reapOrphanedRuns",
  "promoteDueScheduledRetries",
  "resumeQueuedRuns",
  "reconcileStrandedAssignedIssues",
  "reconcileResolvedDependencyWakes",
  "reconcileTaskWatchdogs",
  "scanSilentActiveRuns",
  "sweepStaleIssueLocks",
] as const;

function stubHeartbeat() {
  return {
    reapOrphanedRuns: vi.fn(async () => ({})),
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      assignmentDispatched: 0, dispatchRequeued: 0, continuationRequeued: 0,
      successfulRunHandoffEscalated: 0, successfulRunHandoffRetried: 0, escalated: 0,
      dispatchDeferredForCapacity: 0, failed: 0,
    })),
    reconcileResolvedDependencyWakes: vi.fn(async () => ({ healed: 0 })),
    reconcileTaskWatchdogs: vi.fn(async () => ({ triggered: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    sweepStaleIssueLocks: vi.fn(async () => ({ cleared: 0 })),
  };
}

describe("runPeriodicHeartbeatRecovery", () => {
  it.each(["dispatchDeferredForCapacity", "failed"] as const)("reports stranded recovery %s", async (counter) => {
    const heartbeat = stubHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    result[counter] = 1;
    heartbeat.reconcileStrandedAssignedIssues.mockResolvedValue(result);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await runPeriodicHeartbeatRecovery(heartbeat as never);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ [counter]: 1 }),
        "periodic heartbeat recovery changed assigned issue state",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("runs every step once on a healthy tick, in order", async () => {
    const heartbeat = stubHeartbeat();
    const order: string[] = [];
    for (const name of steps) heartbeat[name].mockImplementation((async () => { order.push(name); return stubHeartbeat()[name](); }) as never);
    await runPeriodicHeartbeatRecovery(heartbeat as never);
    expect(order).toEqual([...steps]);
  });

  it.each(steps)("a failure in %s is contained and every other step still runs", async (failing) => {
    const heartbeat = stubHeartbeat();
    heartbeat[failing].mockRejectedValue(new Error("boom"));

    await expect(runPeriodicHeartbeatRecovery(heartbeat as never)).resolves.toBeUndefined();

    for (const name of steps) expect(heartbeat[name]).toHaveBeenCalledTimes(1);
  });

  it("the stale-lock sweep still runs when the queued-run resume throws", async () => {
    const heartbeat = stubHeartbeat();
    heartbeat.resumeQueuedRuns.mockRejectedValue(new Error('duplicate key value violates unique constraint "issues_open_routine_execution_uq"'));
    await runPeriodicHeartbeatRecovery(heartbeat as never);
    expect(heartbeat.sweepStaleIssueLocks).toHaveBeenCalledTimes(1);
  });
});

describe("runPeriodicHeartbeatRecovery routine step conditions", () => {
  const backstop = (counts: Partial<Record<"checked" | "skipped" | "released" | "woken" | "failed", number>> = {}) => ({
    reconcileOpenRuns: vi.fn(async () => ({ checked: 0, skipped: 0, released: 0, woken: 0, failed: 0, ...counts })),
  });

  it("reconciles the step conditions just before the dependency wakes, so a released step is woken in the same pass", async () => {
    const heartbeat = stubHeartbeat();
    const conditions = backstop();
    const order: string[] = [];
    for (const name of steps) heartbeat[name].mockImplementation((async () => { order.push(name); return stubHeartbeat()[name](); }) as never);
    conditions.reconcileOpenRuns.mockImplementation(async () => {
      order.push("routineStepConditions");
      return { checked: 0, skipped: 0, released: 0, woken: 0, failed: 0 };
    });

    await runPeriodicHeartbeatRecovery(heartbeat as never, conditions);

    const expected: string[] = [...steps];
    expected.splice(expected.indexOf("reconcileResolvedDependencyWakes"), 0, "routineStepConditions");
    expect(order).toEqual(expected);
  });

  it("runs as before when no step condition backstop is given", async () => {
    const heartbeat = stubHeartbeat();
    await runPeriodicHeartbeatRecovery(heartbeat as never);
    for (const name of steps) expect(heartbeat[name]).toHaveBeenCalledTimes(1);
  });

  it("contains a failure of the backstop and still runs every other step", async () => {
    const heartbeat = stubHeartbeat();
    const conditions = backstop();
    conditions.reconcileOpenRuns.mockRejectedValue(new Error("boom"));

    await expect(runPeriodicHeartbeatRecovery(heartbeat as never, conditions)).resolves.toBeUndefined();

    for (const name of steps) expect(heartbeat[name]).toHaveBeenCalledTimes(1);
  });

  it.each(["skipped", "released", "failed"] as const)("reports a pass that changed step state (%s)", async (counter) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await runPeriodicHeartbeatRecovery(stubHeartbeat() as never, backstop({ checked: 3, [counter]: 1 }));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ checked: 3, [counter]: 1 }),
        "periodic routine step condition reconciliation changed step state",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when the pass found nothing to change", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await runPeriodicHeartbeatRecovery(stubHeartbeat() as never, backstop({ checked: 5 }));
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), "periodic routine step condition reconciliation changed step state");
    } finally {
      warn.mockRestore();
    }
  });
});

