import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { BACKGROUND_TASK_RECHECK_MONITOR_SERVICE_NAME, ISSUE_WAIT_MONITOR_MAX_ATTEMPTS } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { logActivity } from "./activity-log.js";
import { scheduleIssueWaitMonitor, type IssueWaitMonitorIssuesService } from "./issue-waits.js";

const MINUTE_MS = 60_000;
const MAX_DELAY_MS = 24 * 60 * MINUTE_MS;
const MAX_ATTEMPTS_CAP = 10;

/** Default re-check backoff after a stopped background task: 5, 10, then 20 minutes. */
export const BACKGROUND_TASK_RECHECK_DEFAULT_DELAYS_MS: readonly number[] = [
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  20 * MINUTE_MS,
];

export const BACKGROUND_TASK_RECHECK_NOTES =
  "Waiting: re-check after background task stop. You left a background wait running at the end of your turn; " +
  "Paperclip stopped it. Re-check what you were waiting for and continue. " +
  "To wait again, end your turn with `paperclipai issue wait <issueId> --in <duration> --reason <text>` instead of a background process.";

export interface BackgroundTaskRecheckPolicy {
  enabled: boolean;
  delaysMs: number[];
  maxAttempts: number;
}

export interface BackgroundTaskRecheckIssue {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  monitorNextCheckAt: Date | null;
  monitorAttemptCount?: number | null;
}

export type BackgroundTaskRecheckDecision =
  | { kind: "schedule"; attempt: number; delayMs: number; nextCheckAt: Date }
  | {
      kind: "skip";
      reason:
        | "disabled"
        | "issue_not_waitable"
        | "not_assigned_to_run_agent"
        | "wait_already_scheduled"
        | "wait_chain_exhausted"
        | "max_attempts_exhausted";
    };

function clampDelayMs(seconds: unknown): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return Math.min(MAX_DELAY_MS, Math.max(MINUTE_MS, Math.floor(seconds) * 1_000));
}

/**
 * Reads `runtimeConfig.heartbeat.backgroundTaskRecheck` with safe defaults.
 *
 * @param runtimeConfig - The agent's runtime config.
 * @returns The clamped policy: delays within [1 min, 24 h], at most 10 attempts.
 */
export function parseBackgroundTaskRecheckPolicy(runtimeConfig: unknown): BackgroundTaskRecheckPolicy {
  const configured = parseObject(parseObject(parseObject(runtimeConfig).heartbeat).backgroundTaskRecheck);
  const delaysMs = Array.isArray(configured.delaysSec)
    ? configured.delaysSec.map(clampDelayMs).filter((value): value is number => value !== null)
    : [];
  const rawMaxAttempts = configured.maxAttempts;
  const maxAttempts =
    typeof rawMaxAttempts === "number" && Number.isFinite(rawMaxAttempts)
      ? Math.max(0, Math.min(MAX_ATTEMPTS_CAP, Math.floor(rawMaxAttempts)))
      : BACKGROUND_TASK_RECHECK_DEFAULT_DELAYS_MS.length;
  return {
    enabled: configured.enabled !== false,
    delaysMs: delaysMs.length > 0 ? delaysMs : [...BACKGROUND_TASK_RECHECK_DEFAULT_DELAYS_MS],
    maxAttempts,
  };
}

/**
 * Counts the newest consecutive runs that ended with a stopped background task.
 *
 * @param runsNewestFirst - Finished runs of one agent on one issue, newest first.
 * @returns The length of the leading `backgroundTaskStopped` streak.
 */
export function countBackgroundTaskStopStreak(runsNewestFirst: ReadonlyArray<{ resultJson: unknown }>): number {
  let streak = 0;
  for (const run of runsNewestFirst) {
    if (parseObject(run.resultJson).backgroundTaskStopped !== true) break;
    streak += 1;
  }
  return streak;
}

/**
 * Decides whether to schedule a re-check monitor after a successful run whose
 * background task Paperclip stopped. Only an open issue that is still assigned
 * to the run's agent, in `in_progress` or `in_review`, gets one.
 */
export function decideBackgroundTaskRecheck(input: {
  issue: BackgroundTaskRecheckIssue;
  runAgentId: string;
  streak: number;
  policy: BackgroundTaskRecheckPolicy;
  now: Date;
}): BackgroundTaskRecheckDecision {
  const { issue, policy } = input;
  if (!policy.enabled) return { kind: "skip", reason: "disabled" };
  if (issue.status !== "in_progress" && issue.status !== "in_review") {
    return { kind: "skip", reason: "issue_not_waitable" };
  }
  if (issue.assigneeUserId || issue.assigneeAgentId !== input.runAgentId) {
    return { kind: "skip", reason: "not_assigned_to_run_agent" };
  }
  if (issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > input.now.getTime()) {
    return { kind: "skip", reason: "wait_already_scheduled" };
  }
  if ((issue.monitorAttemptCount ?? 0) >= ISSUE_WAIT_MONITOR_MAX_ATTEMPTS) {
    return { kind: "skip", reason: "wait_chain_exhausted" };
  }
  const attempt = Math.max(1, input.streak);
  if (attempt > policy.maxAttempts) return { kind: "skip", reason: "max_attempts_exhausted" };
  const delayMs = policy.delaysMs[Math.min(attempt, policy.delaysMs.length) - 1] ?? BACKGROUND_TASK_RECHECK_DEFAULT_DELAYS_MS[0];
  return { kind: "schedule", attempt, delayMs, nextCheckAt: new Date(input.now.getTime() + delayMs) };
}

/**
 * After a succeeded run flagged `backgroundTaskStopped`, records the stop on
 * the issue and, when eligible, schedules a re-check monitor so the agent is
 * woken later instead of re-run immediately. The issue keeps its status.
 */
export async function scheduleBackgroundTaskRecheck(
  db: Db,
  issuesSvc: IssueWaitMonitorIssuesService,
  input: {
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "agentId" | "status" | "resultJson" | "contextSnapshot" | "exitCode" | "signal"
    >;
    agentRuntimeConfig: unknown;
    now?: Date;
  },
): Promise<BackgroundTaskRecheckDecision | null> {
  const { run } = input;
  if (run.status !== "succeeded" || parseObject(run.resultJson).backgroundTaskStopped !== true) return null;
  const context = parseObject(run.contextSnapshot);
  const issueId =
    (typeof context.issueId === "string" && context.issueId) ||
    (typeof context.taskId === "string" && context.taskId) ||
    null;
  if (!issueId) return null;

  const issue = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;

  const policy = parseBackgroundTaskRecheckPolicy(input.agentRuntimeConfig);
  const recentRuns = await db
    .select({ resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.agentId, run.agentId),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled"]),
        sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id} or ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id})`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(policy.maxAttempts + 1);
  const now = input.now ?? new Date();
  const decision = decideBackgroundTaskRecheck({
    issue,
    runAgentId: run.agentId,
    streak: countBackgroundTaskStopStreak(recentRuns),
    policy,
    now,
  });

  let scheduled = false;
  if (decision.kind === "schedule") {
    scheduled = Boolean(
      await scheduleIssueWaitMonitor(db, issuesSvc, {
        issue,
        nextCheckAt: decision.nextCheckAt,
        notes: BACKGROUND_TASK_RECHECK_NOTES,
        serviceName: BACKGROUND_TASK_RECHECK_MONITOR_SERVICE_NAME,
        externalRef: run.id,
        activity: {
          actorType: "system",
          actorId: "heartbeat",
          agentId: null,
          runId: run.id,
          source: "heartbeat.background_task_stopped",
          details: { attempt: decision.attempt, delayMs: decision.delayMs },
        },
      }),
    );
  }

  await logActivity(db, {
    companyId: issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    agentId: run.agentId,
    runId: run.id,
    action: "issue.run_background_task_stopped",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      runId: run.id,
      exitCode: run.exitCode ?? null,
      signal: run.signal ?? null,
      recheck:
        decision.kind === "schedule" && scheduled
          ? { scheduled: true, nextCheckAt: decision.nextCheckAt.toISOString(), attempt: decision.attempt }
          : { scheduled: false, reason: decision.kind === "skip" ? decision.reason : "update_failed" },
    },
  });
  return decision;
}
