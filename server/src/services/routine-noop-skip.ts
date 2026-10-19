import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, routineRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  routineNoopSkipSettingsSchema,
  type RoutineNoopSkipSettings,
} from "@paperclipai/shared";

type SettingsLayer = RoutineNoopSkipSettings | null | undefined;

/** Run status the scheduler gives a run it skipped because nothing changed. */
export const ROUTINE_RUN_UNCHANGED_SKIP_REASON = "unchanged_since_last_run";

/**
 * Activity an agent may leave on its own issue and still count as "no changes":
 * checking the issue out, reporting on it and closing it. Any other action, or any
 * action on another entity, means the run changed something.
 */
const BOOKKEEPING_ISSUE_ACTIONS = [
  "issue.created",
  "issue.updated",
  "issue.comment_added",
  "issue.checked_out",
  "issue.checkout",
  "issue.checkout_lock_adopted",
  "issue.assignment_wakeup_requested",
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
  "issue.inbox_touched",
];

/** Bookkeeping a person or system may leave on the issue without a run attached. */
const RUNLESS_BOOKKEEPING_ISSUE_ACTIONS = [
  "issue.created",
  "issue.assignment_wakeup_requested",
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
  "issue.inbox_touched",
];

/** Reads the agent layer from `runtimeConfig.heartbeat`; invalid settings mean off. */
export function readAgentRoutineNoopSkipSettings(runtimeConfig: unknown): RoutineNoopSkipSettings {
  const heartbeat =
    runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      ? (runtimeConfig as Record<string, unknown>).heartbeat
      : null;
  const raw =
    heartbeat && typeof heartbeat === "object" && !Array.isArray(heartbeat)
      ? (heartbeat as Record<string, unknown>).routineNoopSkipSettings
      : null;
  const parsed = routineNoopSkipSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Resolves whether a run from `source` may be skipped when unchanged. Layers, least to
 * most specific: company < agent < routine < wake type. The wake-type value comes from
 * the most specific scope that sets one for this source; otherwise the level-wide value
 * of the most specific scope that sets one applies. Unset everywhere means off.
 */
export function resolveRoutineNoopSkip(input: {
  source: string;
  company?: SettingsLayer;
  agent?: SettingsLayer;
  routine?: SettingsLayer;
}): boolean {
  const mostSpecificFirst = [input.routine, input.agent, input.company];
  for (const layer of mostSpecificFirst) {
    const bySource: Partial<Record<string, boolean>> = layer?.bySource ?? {};
    const value = bySource[input.source];
    if (typeof value === "boolean") return value;
  }
  for (const layer of mostSpecificFirst) {
    if (typeof layer?.skipUnchanged === "boolean") return layer.skipUnchanged;
  }
  return false;
}


/**
 * True when the last real run of the routine used the same input digest (its dispatch
 * fingerprint: revision, rendered title and description, variables, assignee, workspace
 * and environment) and its issue closed `done` having left only bookkeeping activity.
 * Fails closed: no earlier run, a failed one, or any doubt means "changed".
 */
export async function lastRunLeftNothingChanged(
  db: Db,
  input: { companyId: string; routineId: string; assigneeAgentId: string; dispatchFingerprint: string },
): Promise<boolean> {
  const last = await db
    .select({
      status: routineRuns.status,
      fingerprint: routineRuns.dispatchFingerprint,
      triggeredAt: routineRuns.triggeredAt,
      issueId: routineRuns.linkedIssueId,
    })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.companyId, input.companyId),
        eq(routineRuns.routineId, input.routineId),
        sql`${routineRuns.status} not in ('skipped', 'coalesced', 'received')`,
        // Event runs belong to external alerts; they must not decide whether a schedule run repeats.
        sql`${routineRuns.source} <> 'event'`,
      ),
    )
    .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!last?.issueId || last.fingerprint !== input.dispatchFingerprint) return false;
  if (last.status !== "issue_created" && last.status !== "completed") return false;

  // The fingerprint does not cover the agent's prompt, config or instructions, so any
  // change to the assignee since the last run means the same inputs may now do new work.
  const agentChanged = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, input.assigneeAgentId),
        gt(activityLog.createdAt, last.triggeredAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (agentChanged) return false;

  const issueId = last.issueId;
  const issue = await db.query.issues.findFirst({
    columns: { status: true },
    where: (table, { and: all, eq: is }) => all(is(table.id, issueId), is(table.companyId, input.companyId)),
  });
  if (issue?.status !== "done") return false;

  const runIds = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .then((rows) => rows.map((row) => row.id));
  if (runIds.length === 0) return false;

  const changed = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        or(
          inArray(activityLog.runId, runIds),
          and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId)),
        ),
        or(
          and(
            inArray(activityLog.runId, runIds),
            or(
              sql`${activityLog.action} not in (${sql.join(BOOKKEEPING_ISSUE_ACTIONS.map((action) => sql`${action}`), sql`, `)})`,
              sql`not (${activityLog.entityType} = 'issue' and ${activityLog.entityId} = ${issueId})`,
            ),
          ),
          and(
            or(isNull(activityLog.runId), notInArray(activityLog.runId, runIds)),
            sql`${activityLog.action} not in (${sql.join(RUNLESS_BOOKKEEPING_ISSUE_ACTIONS.map((action) => sql`${action}`), sql`, `)})`,
          ),
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return changed === null;
}

/** Reads the company and agent layers for a dispatch. */
export async function loadRoutineNoopSkipLayers(
  db: Db,
  input: { companyId: string; assigneeAgentId: string },
): Promise<{ company: RoutineNoopSkipSettings | null; agent: RoutineNoopSkipSettings }> {
  const company = await db.query.companies.findFirst({
    columns: { routineNoopSkipSettings: true },
    where: (table, { eq: is }) => is(table.id, input.companyId),
  });
  const agent = await db.query.agents.findFirst({
    columns: { runtimeConfig: true },
    where: (table, { and: all, eq: is }) => all(is(table.id, input.assigneeAgentId), is(table.companyId, input.companyId)),
  });
  return {
    company: company?.routineNoopSkipSettings ?? null,
    agent: readAgentRoutineNoopSkipSettings(agent?.runtimeConfig),
  };
}

