import { z } from "zod";

/**
 * Routines timeline: every routine of a company on one page. `GET /api/companies/:companyId/routines/timeline`
 * returns the past runs in a window, the fires each schedule trigger will make next, and the links between
 * routines, steps, event sources, goals and projects. Everything comes from stored data; nothing is inferred.
 *
 * The shape is generic on purpose: a row, a node and an edge each carry a `kind`, so workflows (workflows that
 * start workflows, nested steps) can join as new kinds later without a breaking change.
 */

/** Most projected fires one response carries, across all triggers; the earliest fires win. */
export const ROUTINE_TIMELINE_MAX_FIRES = 500;
/** Most runs one response carries; the newest runs win. */
export const ROUTINE_TIMELINE_MAX_RUNS = 5000;
/** Longest window a request may ask for. */
export const ROUTINE_TIMELINE_MAX_WINDOW_DAYS = 31;
/** Window used when a request names neither bound: a day back and a day ahead. */
export const ROUTINE_TIMELINE_DEFAULT_SPAN_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ROUTINE_TIMELINE_ROW_KINDS = ["routine"] as const;
export type RoutineTimelineRowKind = (typeof ROUTINE_TIMELINE_ROW_KINDS)[number];

export const ROUTINE_TIMELINE_NODE_KINDS = ["routine", "step", "event_source", "goal", "project"] as const;
export type RoutineTimelineNodeKind = (typeof ROUTINE_TIMELINE_NODE_KINDS)[number];

/**
 * - `event_trigger`: an event source fires a routine (an `event` trigger).
 * - `step_after`: a routine step waits for another step of the same routine (`steps[].after`).
 * - `parent_issue`: a routine files its runs under an issue that a run of another routine created.
 * - `targets_issue`: a run of a routine started on an issue that a run of another routine created.
 * - `serves_goal` and `serves_project`: the goal or project the routine belongs to.
 */
export const ROUTINE_TIMELINE_EDGE_KINDS = [
  "event_trigger",
  "step_after",
  "parent_issue",
  "targets_issue",
  "serves_goal",
  "serves_project",
] as const;
export type RoutineTimelineEdgeKind = (typeof ROUTINE_TIMELINE_EDGE_KINDS)[number];

/** `from` and `to` are ISO instants with an offset; both are optional, see `resolveRoutineTimelineWindow`. */
export const routineTimelineQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();
export type RoutineTimelineQuery = z.infer<typeof routineTimelineQuerySchema>;

export interface RoutineTimelineWindow {
  /** ISO instant. */
  from: string;
  /** ISO instant. */
  to: string;
}

/**
 * Picks the window of a request. With no bounds it is a day back and a day ahead of `now`; one bound alone
 * gets the default span on the other side.
 * @throws Error when `to` is not after `from`, or the window is longer than `ROUTINE_TIMELINE_MAX_WINDOW_DAYS`.
 */
export function resolveRoutineTimelineWindow(
  query: Pick<RoutineTimelineQuery, "from" | "to">,
  now: Date,
): RoutineTimelineWindow {
  const span = ROUTINE_TIMELINE_DEFAULT_SPAN_HOURS * HOUR_MS;
  const requestedFrom = query.from ? new Date(query.from).getTime() : null;
  const requestedTo = query.to ? new Date(query.to).getTime() : null;
  let from: number;
  let to: number;
  if (requestedFrom !== null && requestedTo !== null) {
    from = requestedFrom;
    to = requestedTo;
  } else if (requestedFrom !== null) {
    from = requestedFrom;
    to = requestedFrom + 2 * span;
  } else if (requestedTo !== null) {
    to = requestedTo;
    from = requestedTo - 2 * span;
  } else {
    from = now.getTime() - span;
    to = now.getTime() + span;
  }
  if (!(to > from)) throw new Error("`to` must be after `from`");
  if (to - from > ROUTINE_TIMELINE_MAX_WINDOW_DAYS * DAY_MS) {
    throw new Error(`The window may be at most ${ROUTINE_TIMELINE_MAX_WINDOW_DAYS} days`);
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** The trigger of a row, as far as the timeline needs it. */
export interface RoutineTimelineTrigger {
  id: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  /** ISO instant of the next scheduled fire; null when the trigger has none. */
  nextRunAt: string | null;
  /** `event` triggers: the source that fires the routine. */
  eventSourceId: string | null;
}

export interface RoutineTimelineRow {
  /** Namespaced, `routine:<id>`; the id of the node that stands for the same routine. */
  id: string;
  kind: RoutineTimelineRowKind;
  /** The id of the routine itself. */
  refId: string;
  title: string;
  status: string;
  /** True when an enabled schedule trigger can fire it; the page shows these apart from the rest. */
  scheduled: boolean;
  triggers: RoutineTimelineTrigger[];
}

export interface RoutineTimelineLinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

export interface RoutineTimelineRun {
  id: string;
  rowId: string;
  triggerId: string | null;
  source: string;
  status: string;
  /** ISO instant the run was triggered. */
  start: string;
  /** ISO instant the run finished; null while it is still going. */
  end: string | null;
  linkedIssueId: string | null;
  /** Set when the issue exists and the caller may read it. */
  linkedIssue: RoutineTimelineLinkedIssue | null;
}

/** A fire a schedule trigger will make; it is a projection from `nextRunAt` and the cron expression. */
export interface RoutineTimelineFire {
  rowId: string;
  triggerId: string;
  /** ISO instant. */
  at: string;
}

export interface RoutineTimelineNode {
  /** Namespaced by kind: `routine:<id>`, `step:<routineId>:<key>`, `event_source:<id>`, `goal:<id>`, `project:<id>`. */
  id: string;
  kind: RoutineTimelineNodeKind;
  refId: string;
  label: string;
  /** The node that holds this one: a step's routine. */
  parentId: string | null;
  status: string | null;
}

export interface RoutineTimelineEdge {
  id: string;
  kind: RoutineTimelineEdgeKind;
  from: string;
  to: string;
  label: string | null;
  /** False when the trigger behind the edge is switched off. */
  enabled: boolean;
  triggerId: string | null;
  /** `parent_issue` and `targets_issue`: the issue that joins the two routines. */
  issueId: string | null;
  /** `targets_issue`: the run that started on the issue. */
  runId: string | null;
}

export interface RoutineTimelineLimit {
  cap: number;
  /** True when more existed than the response holds. */
  truncated: boolean;
}

export interface RoutineTimelineResult {
  window: RoutineTimelineWindow;
  /** ISO instant the response was built; projected fires start no earlier than this. */
  generatedAt: string;
  rows: RoutineTimelineRow[];
  runs: RoutineTimelineRun[];
  fires: RoutineTimelineFire[];
  nodes: RoutineTimelineNode[];
  edges: RoutineTimelineEdge[];
  limits: {
    fires: RoutineTimelineLimit;
    runs: RoutineTimelineLimit;
  };
}
