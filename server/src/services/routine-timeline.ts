import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { eventSources, goals, issues, projects, routineRuns, routineTriggers, routines } from "@paperclipai/db";
import {
  isRoutineRunIssueOriginKind,
  ROUTINE_TIMELINE_MAX_FIRES,
  ROUTINE_TIMELINE_MAX_RUNS,
  type RoutineTimelineFire,
  type RoutineTimelineResult,
  type RoutineTimelineRow,
  type RoutineTimelineRun,
  type RoutineTimelineTrigger,
  type RoutineTimelineWindow,
} from "@paperclipai/shared";
import { buildRoutineLinkGraph, routineNodeId, type LinkGraphEventTrigger } from "./routine-link-graph.js";
import { projectCronFires } from "./routine-fire-projection.js";

/**
 * A run that started before the window still shows when it is open or ended inside it, but only this far back:
 * the lookup rides the `(company, routine, created_at)` index, and a run open longer than this is stale.
 */
const RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface RoutineTimelineInput {
  companyId: string;
  window: RoutineTimelineWindow;
  /** Reference "now" for the projection; defaults to the clock. */
  now?: Date;
  /**
   * Which of these issues the caller may read. A run keeps its `linkedIssueId` but shows the issue's title and
   * status only when it is readable. Omitted for callers that read every issue of the company.
   */
  readableIssueIds?: (issueIds: string[]) => Promise<Set<string>>;
}

export function routineTimelineService(db: Db) {
  /** The fires one schedule trigger makes in the window: its `nextRunAt`, then the expression from there on. */
  function projectTriggerFires(
    trigger: { cronExpression: string | null; timezone: string | null; nextRunAt: Date | null },
    window: { from: Date; to: Date },
    now: Date,
  ): Date[] {
    if (!trigger.cronExpression || !trigger.nextRunAt) return [];
    const first = trigger.nextRunAt;
    const fires: Date[] = [];
    if (first >= window.from && first <= window.to) fires.push(first);
    // The scheduler works out the fire after `nextRunAt` from the later of `nextRunAt` and now.
    const after = new Date(Math.max(first.getTime(), now.getTime(), window.from.getTime() - 1));
    const { fires: later } = projectCronFires({
      expression: trigger.cronExpression,
      timeZone: trigger.timezone ?? "UTC",
      after,
      until: window.to,
      limit: ROUTINE_TIMELINE_MAX_FIRES + 1,
    });
    return [...fires, ...later];
  }

  return {
    get: async (input: RoutineTimelineInput): Promise<RoutineTimelineResult> => {
      const { companyId } = input;
      const now = input.now ?? new Date();
      const from = new Date(input.window.from);
      const to = new Date(input.window.to);

      const routineRows = await db
        .select({
          id: routines.id,
          title: routines.title,
          status: routines.status,
          goalId: routines.goalId,
          projectId: routines.projectId,
          parentIssueId: routines.parentIssueId,
          steps: routines.steps,
        })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), ne(routines.status, "archived")))
        .orderBy(asc(routines.title), asc(routines.id));
      const routineIds = routineRows.map((routine) => routine.id);
      if (routineIds.length === 0) return emptyResult(input.window, now);

      const [triggerRows, runRows] = await Promise.all([
        db
          .select({
            id: routineTriggers.id,
            routineId: routineTriggers.routineId,
            kind: routineTriggers.kind,
            label: routineTriggers.label,
            enabled: routineTriggers.enabled,
            cronExpression: routineTriggers.cronExpression,
            timezone: routineTriggers.timezone,
            nextRunAt: routineTriggers.nextRunAt,
            eventSourceId: routineTriggers.eventSourceId,
            eventMatch: routineTriggers.eventMatch,
          })
          .from(routineTriggers)
          .where(and(
            eq(routineTriggers.companyId, companyId),
            eq(routineTriggers.archived, false),
            inArray(routineTriggers.routineId, routineIds),
          ))
          .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id)),
        db
          .select({
            id: routineRuns.id,
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            source: routineRuns.source,
            status: routineRuns.status,
            triggeredAt: routineRuns.triggeredAt,
            completedAt: routineRuns.completedAt,
            linkedIssueId: routineRuns.linkedIssueId,
          })
          .from(routineRuns)
          .where(and(
            eq(routineRuns.companyId, companyId),
            inArray(routineRuns.routineId, routineIds),
            gte(routineRuns.createdAt, new Date(from.getTime() - RUN_LOOKBACK_MS)),
            lte(routineRuns.triggeredAt, to),
            or(isNull(routineRuns.completedAt), gte(routineRuns.completedAt, from)),
          ))
          .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.id))
          .limit(ROUTINE_TIMELINE_MAX_RUNS + 1),
      ]);
      const runsTruncated = runRows.length > ROUTINE_TIMELINE_MAX_RUNS;
      const windowRuns = runsTruncated ? runRows.slice(0, ROUTINE_TIMELINE_MAX_RUNS) : runRows;

      const eventTriggers = triggerRows.filter((trigger) => trigger.kind === "event");
      const sourceIds = [...new Set(eventTriggers.flatMap((trigger) => trigger.eventSourceId ?? []))];
      const goalIds = [...new Set(routineRows.flatMap((routine) => routine.goalId ?? []))];
      const projectIds = [...new Set(routineRows.flatMap((routine) => routine.projectId ?? []))];
      const issueIds = [...new Set([
        ...windowRuns.flatMap((run) => run.linkedIssueId ?? []),
        ...routineRows.flatMap((routine) => routine.parentIssueId ?? []),
      ])];

      const [sourceRows, goalRows, projectRows, issueRows] = await Promise.all([
        sourceIds.length === 0
          ? []
          : db
            .select({ id: eventSources.id, name: eventSources.name })
            .from(eventSources)
            .where(and(eq(eventSources.companyId, companyId), inArray(eventSources.id, sourceIds))),
        goalIds.length === 0
          ? []
          : db
            .select({ id: goals.id, name: goals.title })
            .from(goals)
            .where(and(eq(goals.companyId, companyId), inArray(goals.id, goalIds))),
        projectIds.length === 0
          ? []
          : db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))),
        issueIds.length === 0
          ? []
          : db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              originKind: issues.originKind,
              originId: issues.originId,
              hiddenAt: issues.hiddenAt,
            })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds))),
      ]);

      const visibleIssues = issueRows.filter((issue) => !issue.hiddenAt);
      const readable = input.readableIssueIds
        ? await input.readableIssueIds(visibleIssues.map((issue) => issue.id))
        : new Set(visibleIssues.map((issue) => issue.id));
      const issueById = new Map(visibleIssues.map((issue) => [issue.id, issue]));

      const triggersByRoutine = new Map<string, RoutineTimelineTrigger[]>();
      for (const trigger of triggerRows) {
        const list = triggersByRoutine.get(trigger.routineId) ?? [];
        list.push({
          id: trigger.id,
          kind: trigger.kind,
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
          eventSourceId: trigger.eventSourceId,
        });
        triggersByRoutine.set(trigger.routineId, list);
      }

      const rows: RoutineTimelineRow[] = routineRows.map((routine) => {
        const triggers = triggersByRoutine.get(routine.id) ?? [];
        return {
          id: routineNodeId(routine.id),
          kind: "routine",
          refId: routine.id,
          title: routine.title,
          status: routine.status,
          scheduled: triggers.some((trigger) => trigger.kind === "schedule" && trigger.cronExpression !== null),
          triggers,
        };
      });

      const runs: RoutineTimelineRun[] = windowRuns.map((run) => {
        const issue = run.linkedIssueId ? issueById.get(run.linkedIssueId) : undefined;
        return {
          id: run.id,
          rowId: routineNodeId(run.routineId),
          triggerId: run.triggerId,
          source: run.source,
          status: run.status,
          start: run.triggeredAt.toISOString(),
          end: run.completedAt?.toISOString() ?? null,
          // A hidden or missing issue has nothing to open.
          linkedIssueId: issue ? issue.id : null,
          linkedIssue: issue && readable.has(issue.id)
            ? { id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status }
            : null,
        };
      });

      const activeRoutineIds = new Set(routineRows.filter((routine) => routine.status === "active").map((routine) => routine.id));
      const allFires: RoutineTimelineFire[] = [];
      for (const trigger of triggerRows) {
        if (trigger.kind !== "schedule" || !trigger.enabled || !activeRoutineIds.has(trigger.routineId)) continue;
        for (const at of projectTriggerFires(trigger, { from, to }, now)) {
          allFires.push({ rowId: routineNodeId(trigger.routineId), triggerId: trigger.id, at: at.toISOString() });
        }
      }
      allFires.sort((a, b) => a.at.localeCompare(b.at) || a.triggerId.localeCompare(b.triggerId));
      const firesTruncated = allFires.length > ROUTINE_TIMELINE_MAX_FIRES;

      const linkTriggers: LinkGraphEventTrigger[] = eventTriggers.map((trigger) => ({
        id: trigger.id,
        routineId: trigger.routineId,
        enabled: trigger.enabled,
        eventSourceId: trigger.eventSourceId,
        eventMatch: trigger.eventMatch,
      }));
      const { nodes, edges } = buildRoutineLinkGraph({
        routines: routineRows,
        eventTriggers: linkTriggers,
        eventSources: sourceRows,
        goals: goalRows,
        projects: projectRows,
        routineIssues: visibleIssues.flatMap((issue) =>
          isRoutineRunIssueOriginKind(issue.originKind) && issue.originId
            ? [{ issueId: issue.id, routineId: issue.originId }]
            : []),
        runsOnIssues: windowRuns.flatMap((run) =>
          run.linkedIssueId && issueById.has(run.linkedIssueId)
            ? [{ runId: run.id, routineId: run.routineId, issueId: run.linkedIssueId }]
            : []),
      });

      return {
        window: input.window,
        generatedAt: now.toISOString(),
        rows,
        runs,
        fires: firesTruncated ? allFires.slice(0, ROUTINE_TIMELINE_MAX_FIRES) : allFires,
        nodes,
        edges,
        limits: {
          fires: { cap: ROUTINE_TIMELINE_MAX_FIRES, truncated: firesTruncated },
          runs: { cap: ROUTINE_TIMELINE_MAX_RUNS, truncated: runsTruncated },
        },
      };
    },
  };
}

function emptyResult(window: RoutineTimelineWindow, now: Date): RoutineTimelineResult {
  return {
    window,
    generatedAt: now.toISOString(),
    rows: [],
    runs: [],
    fires: [],
    nodes: [],
    edges: [],
    limits: {
      fires: { cap: ROUTINE_TIMELINE_MAX_FIRES, truncated: false },
      runs: { cap: ROUTINE_TIMELINE_MAX_RUNS, truncated: false },
    },
  };
}
