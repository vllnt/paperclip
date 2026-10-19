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
