import { logger } from "../middleware/logger.js";
import type { heartbeatService } from "./heartbeat.js";

type RecoveryHeartbeat = Pick<
  ReturnType<typeof heartbeatService>,
  | "reapOrphanedRuns"
  | "promoteDueScheduledRetries"
  | "resumeQueuedRuns"
  | "reconcileStrandedAssignedIssues"
  | "reconcileResolvedDependencyWakes"
  | "reconcileTaskWatchdogs"
  | "scanSilentActiveRuns"
  | "sweepStaleIssueLocks"
>;

/**
 * One pass of the periodic heartbeat recovery. Every step runs under its own
 * catch, so a step that throws is logged and the later steps still run. The
 * stale-lock sweep is the last step and frees the slot that an earlier step
 * may have failed on, so it must not depend on the steps before it.
 */
export async function runPeriodicHeartbeatRecovery(heartbeat: RecoveryHeartbeat) {
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (err) {
      logger.error({ err, step: name }, "periodic heartbeat recovery step failed");
      return undefined;
    }
  };

  await step("reapOrphanedRuns", () => heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 }));
  const promotion = await step("promoteDueScheduledRetries", () => heartbeat.promoteDueScheduledRetries());
  await step("resumeQueuedRuns", () => heartbeat.resumeQueuedRuns());
  await step("reconcileStrandedAssignedIssues", async () => {
    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    if (
      (promotion?.promoted ?? 0) > 0 ||
      reconciled.assignmentDispatched > 0 ||
      reconciled.dispatchRequeued > 0 ||
      reconciled.continuationRequeued > 0 ||
      reconciled.successfulRunHandoffEscalated > 0 ||
      reconciled.successfulRunHandoffRetried > 0 ||
      reconciled.escalated > 0
    ) {
      logger.warn(
        { promotedScheduledRetries: promotion?.promoted ?? 0, promotedScheduledRetryRunIds: promotion?.runIds ?? [], ...reconciled },
        "periodic heartbeat recovery changed assigned issue state",
      );
    }
  });
  await step("reconcileResolvedDependencyWakes", async () => {
    const reconciled = await heartbeat.reconcileResolvedDependencyWakes();
    if (reconciled.healed > 0) {
      logger.warn({ ...reconciled }, "periodic dependency-wake reconciliation restored task execution paths");
    }
  });
  await step("reconcileTaskWatchdogs", async () => {
    const reconciled = await heartbeat.reconcileTaskWatchdogs();
    if (reconciled.triggered > 0) {
      logger.warn({ ...reconciled }, "periodic task-watchdog reconciliation triggered watchdog work");
    }
  });
  await step("scanSilentActiveRuns", async () => {
    const scanned = await heartbeat.scanSilentActiveRuns();
    if (scanned.created > 0 || scanned.escalated > 0) {
      logger.warn({ ...scanned }, "periodic active-run output watchdog created review work");
    }
  });
  await step("sweepStaleIssueLocks", async () => {
    const swept = await heartbeat.sweepStaleIssueLocks();
    if (swept.cleared > 0) {
      logger.warn({ ...swept }, "periodic stale-lock sweeper cleared issue locks");
    }
  });
}
