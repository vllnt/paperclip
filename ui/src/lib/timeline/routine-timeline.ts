/**
 * Routines timeline — a pure adapter from the `RoutineTimelineResult` endpoint contract to what the shared
 * Work Timeline chart draws. One routine is one actor row; a past run is a bar from its start to its end,
 * coloured by outcome; a projected fire is a short hollow bar. Nothing here reads the DOM.
 */
import type {
  RoutineTimelineResult,
  RoutineTimelineRow,
  WorkTimelineActor,
  WorkTimelineResult,
  WorkTimelineSpan,
} from "@paperclipai/shared";
import type { TimelineBarStyle } from "@/components/timeline/WorkTimelineChart";
import type { LayoutOptions } from "./layout";

export const SECTION_SCHEDULED = "Scheduled";
export const SECTION_UNSCHEDULED = "No schedule · past runs only";

/** How a run ended, for its colour. */
export type RoutineRunOutcome = "success" | "failure" | "running" | "skipped" | "scheduled";

const SUCCESS_STATUSES = new Set(["completed", "grouped", "recovered"]);
const RUNNING_STATUSES = new Set(["received", "gating", "issue_created"]);

export function routineRunOutcome(status: string, end: string | null): RoutineRunOutcome {
  if (status === "scheduled") return "scheduled";
  if (status === "failed") return "failure";
  if (SUCCESS_STATUSES.has(status)) return "success";
  if (RUNNING_STATUSES.has(status)) return end === null ? "running" : "success";
  return "skipped"; // coalesced, skipped, or a status this page does not know
}

export const ROUTINE_OUTCOME_LABEL: Record<RoutineRunOutcome, string> = {
  success: "Completed",
  failure: "Failed",
  running: "Running",
  skipped: "Skipped or merged",
  scheduled: "Next fire",
};

/** Bar styles by outcome; colours are the design tokens, so light and dark themes both read. */
export const ROUTINE_OUTCOME_STYLE: Record<RoutineRunOutcome, TimelineBarStyle> = {
  success: { fill: "var(--status-task-done)" },
  failure: { fill: "var(--status-task-blocked)" },
  running: { fill: "var(--status-task-in_progress)" },
  skipped: { fill: "none", stroke: "var(--status-neutral)", dashed: true },
  scheduled: { fill: "none", stroke: "var(--color-primary)", dashed: true },
};

const FIRE_PREFIX = "fire:";
const RUN_ISSUE_PLACEHOLDER = "run:";

/** A projected fire is drawn at least this wide so it can be seen and hovered. */
export const FIRE_MIN_BAR_PX = 10;

export type RoutineSpanTarget = { kind: "issue"; id: string } | { kind: "routine"; id: string };

export interface RoutineTimelineChartModel {
  result: WorkTimelineResult;
  /** pass to `WorkTimelineChart.layoutOptions`; stable for one `data`. */
  layoutOptions: Pick<LayoutOptions, "keepEmptyActors" | "compareActors" | "sectionOf" | "minBarPx">;
  barStyle: (span: WorkTimelineSpan) => TimelineBarStyle | null;
  spanHint: (span: WorkTimelineSpan) => string | null;
  /** where a click on a bar goes: the run's issue tree, or the routine when the run made no issue. */
  targetOf: (span: WorkTimelineSpan) => RoutineSpanTarget;
  runCount: number;
  fireCount: number;
}

/** The routine's id behind a row id (`routine:<id>`). */
export function routineIdOfRow(rowId: string): string {
  return rowId.startsWith("routine:") ? rowId.slice("routine:".length) : rowId;
}

function actorOf(row: RoutineTimelineRow): WorkTimelineActor {
  return {
    id: row.id,
    type: "system",
    name: row.status === "active" ? row.title : `${row.title} (${row.status})`,
  };
}

function triggerText(row: RoutineTimelineRow | undefined, triggerId: string | null): string | null {
  const trigger = row?.triggers.find((candidate) => candidate.id === triggerId);
  if (!trigger) return null;
  if (trigger.cronExpression) return `${trigger.cronExpression} (${trigger.timezone ?? "UTC"})`;
  return trigger.label ?? trigger.kind;
}

export function buildRoutineTimelineChartModel(data: RoutineTimelineResult): RoutineTimelineChartModel {
  const rowById = new Map(data.rows.map((row) => [row.id, row]));
  const runById = new Map(data.runs.map((run) => [run.id, run]));

  const runSpans: WorkTimelineSpan[] = data.runs.map((run) => ({
    actorId: run.rowId,
    laneHint: null,
    runId: run.id,
    // A span needs an issue key; a run that made none gets one of its own and opens its routine instead.
    issueId: run.linkedIssueId ?? `${RUN_ISSUE_PLACEHOLDER}${run.id}`,
    issueIdentifier: run.linkedIssue?.identifier ?? null,
    issueTitle: run.linkedIssue?.title ?? rowById.get(run.rowId)?.title ?? null,
    start: run.start,
    end: run.end,
    status: run.status,
    invocationSource: run.source,
  }));
  const fireSpans: WorkTimelineSpan[] = data.fires.map((fire) => {
    const key = `${FIRE_PREFIX}${fire.triggerId}:${fire.at}`;
    return {
      actorId: fire.rowId,
      laneHint: null,
      runId: key,
      issueId: key,
      issueIdentifier: null,
      issueTitle: `Next fire: ${rowById.get(fire.rowId)?.title ?? "routine"}`,
      start: fire.at,
      end: fire.at,
      status: "scheduled",
      invocationSource: "schedule",
    };
  });

  const result: WorkTimelineResult = {
    actors: data.rows.map(actorOf),
    spans: [...runSpans, ...fireSpans],
    events: [],
    edges: [],
    pagination: { limit: data.runs.length + data.fires.length, offset: 0, totalIssues: 0, hasMore: false },
    window: { from: data.window.from, to: data.window.to, capped: data.limits.fires.truncated || data.limits.runs.truncated },
  };

  const scheduled = new Set(data.rows.filter((row) => row.scheduled).map((row) => row.id));
  const order = new Map(data.rows.map((row, index) => [row.id, index]));
  const layoutOptions: RoutineTimelineChartModel["layoutOptions"] = {
    keepEmptyActors: true,
    minBarPx: FIRE_MIN_BAR_PX,
    sectionOf: (actor) => (scheduled.has(actor.id) ? SECTION_SCHEDULED : SECTION_UNSCHEDULED),
    // Scheduled routines first, each group in the order the server sent (by title).
    compareActors: (a, b) =>
      Number(scheduled.has(b.id)) - Number(scheduled.has(a.id)) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  };

  const isFire = (span: WorkTimelineSpan) => span.runId.startsWith(FIRE_PREFIX);

  return {
    result,
    layoutOptions,
    runCount: runSpans.length,
    fireCount: fireSpans.length,
    barStyle: (span) => ROUTINE_OUTCOME_STYLE[routineRunOutcome(span.status, span.end)],
    spanHint: (span) => {
      const row = rowById.get(span.actorId);
      if (isFire(span)) {
        const fire = data.fires.find((candidate) => `${FIRE_PREFIX}${candidate.triggerId}:${candidate.at}` === span.runId);
        const text = triggerText(row, fire?.triggerId ?? null);
        return text ? `Scheduled · ${text}` : "Scheduled";
      }
      const run = runById.get(span.runId);
      const trigger = triggerText(row, run?.triggerId ?? null);
      const outcome = ROUTINE_OUTCOME_LABEL[routineRunOutcome(span.status, span.end)];
      return `${outcome} · ${run?.source ?? "run"}${trigger ? ` · ${trigger}` : ""}`;
    },
    targetOf: (span) => {
      if (!isFire(span) && !span.issueId.startsWith(RUN_ISSUE_PLACEHOLDER)) return { kind: "issue", id: span.issueId };
      return { kind: "routine", id: routineIdOfRow(span.actorId) };
    },
  };
}

/** Where the next fire of any routine falls, for the page's summary; null when nothing is scheduled. */
export function nextFireAt(data: Pick<RoutineTimelineResult, "fires">): string | null {
  return data.fires.reduce<string | null>((first, fire) => (first === null || fire.at < first ? fire.at : first), null);
}

/** The latest projected fire, to tell the reader how far a capped list reaches; null when there is none. */
export function lastFireAt(data: Pick<RoutineTimelineResult, "fires">): string | null {
  return data.fires.reduce<string | null>((last, fire) => (last === null || fire.at > last ? fire.at : last), null);
}
