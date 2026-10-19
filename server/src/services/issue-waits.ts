import type { Db } from "@paperclipai/db";
import type { issues } from "@paperclipai/db";
import { ISSUE_WAIT_MONITOR_MAX_ATTEMPTS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { applyIssueMonitorPolicyTransition, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import type { issueService } from "./issues.js";

export type IssueWaitMonitorIssuesService = Pick<ReturnType<typeof issueService>, "update">;

/**
 * True while the issue holds a wait that is not yet due. A wait past its due
 * time is no longer a live path: the monitor wake owns it.
 */
export function hasActiveIssueWait(
  issue: { monitorNextCheckAt?: Date | null },
  now: Date = new Date(),
): boolean {
  return Boolean(issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > now.getTime());
}

/**
 * Schedules the issue's one-shot monitor for a wait. It goes through the same
 * execution-policy transition as an issue PATCH, so the existing status and
 * assignee rules (agent-assigned, `in_progress` or `in_review`) apply and the
 * issue keeps its status. Returns the updated issue, or null when it vanished.
 */
export async function scheduleIssueWaitMonitor(
  db: Db,
  issuesSvc: IssueWaitMonitorIssuesService,
  input: {
    issue: typeof issues.$inferSelect;
    nextCheckAt: Date;
    notes: string;
    serviceName: string | null;
    externalRef: string | null;
    activity: {
      actorType: "agent" | "user" | "system";
      actorId: string;
      agentId: string | null;
      runId: string | null;
      source: string;
      details?: Record<string, unknown>;
    };
  },
) {
  const previousPolicy = normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
  const policy = {
    ...(previousPolicy ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
    monitor: {
      nextCheckAt: input.nextCheckAt.toISOString(),
      notes: input.notes,
      scheduledBy: "assignee" as const,
      kind: "external_service" as const,
      serviceName: input.serviceName,
      externalRef: input.externalRef,
      timeoutAt: null,
      maxAttempts: ISSUE_WAIT_MONITOR_MAX_ATTEMPTS,
      recoveryPolicy: "wake_owner" as const,
    },
  };
  const transition = applyIssueMonitorPolicyTransition({
    issue: input.issue,
    policy,
    previousPolicy,
    requestedStatus: input.issue.status,
    requestedAssigneePatch: {},
    actor: { agentId: input.activity.agentId, userId: null },
    monitorExplicitlyUpdated: true,
  });
  const updated = await issuesSvc.update(input.issue.id, {
    ...transition.patch,
    executionPolicy: policy,
  });
  if (!updated) return null;

  await logActivity(db, {
    companyId: input.issue.companyId,
    actorType: input.activity.actorType,
    actorId: input.activity.actorId,
    agentId: input.activity.agentId,
    runId: input.activity.runId,
    action: "issue.monitor_scheduled",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      identifier: input.issue.identifier,
      source: input.activity.source,
      nextCheckAt: input.nextCheckAt.toISOString(),
      notes: input.notes,
      serviceName: input.serviceName,
      ...(input.activity.details ?? {}),
    },
  });
  return updated;
}
