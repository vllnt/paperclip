import { describe, expect, it } from "vitest";
import type { RoutineTimelineResult } from "@paperclipai/shared";
import {
  FIRE_MIN_BAR_PX,
  ROUTINE_OUTCOME_STYLE,
  SECTION_SCHEDULED,
  SECTION_UNSCHEDULED,
  buildRoutineTimelineChartModel,
  lastFireAt,
  nextFireAt,
  routineRunOutcome,
} from "./routine-timeline";

const t = (hhmm: string) => `2026-10-21T${hhmm}:00.000Z`;

function data(overrides: Partial<RoutineTimelineResult> = {}): RoutineTimelineResult {
  return {
    window: { from: t("00:00"), to: t("23:59") },
    generatedAt: t("12:00"),
    rows: [
      {
        id: "routine:hook", kind: "routine", refId: "hook", title: "On deploy", status: "active", scheduled: false,
        triggers: [{ id: "tw", kind: "webhook", label: "GitHub push", enabled: true, cronExpression: null, timezone: null, nextRunAt: null, eventSourceId: null }],
      },
      {
        id: "routine:daily", kind: "routine", refId: "daily", title: "Daily digest", status: "paused", scheduled: true,
        triggers: [{ id: "ts", kind: "schedule", label: null, enabled: true, cronExpression: "0 9 * * *", timezone: "Europe/Paris", nextRunAt: t("07:00"), eventSourceId: null }],
      },
      { id: "routine:idle", kind: "routine", refId: "idle", title: "Idle", status: "active", scheduled: false, triggers: [] },
    ],
    runs: [
      { id: "r1", rowId: "routine:daily", triggerId: "ts", source: "schedule", status: "completed", start: t("07:00"), end: t("07:20"), linkedIssueId: "i1", linkedIssue: { id: "i1", identifier: "T-1", title: "Digest 21 Oct", status: "done" } },
      { id: "r2", rowId: "routine:hook", triggerId: "tw", source: "webhook", status: "failed", start: t("08:00"), end: t("08:05"), linkedIssueId: null, linkedIssue: null },
      { id: "r3", rowId: "routine:hook", triggerId: null, source: "manual", status: "issue_created", start: t("11:00"), end: null, linkedIssueId: "i3", linkedIssue: null },
    ],
    fires: [
      { rowId: "routine:daily", triggerId: "ts", at: t("21:00") },
      { rowId: "routine:daily", triggerId: "ts", at: t("13:00") },
    ],
    nodes: [],
    edges: [],
    limits: { fires: { cap: 500, truncated: false }, runs: { cap: 5000, truncated: false } },
    ...overrides,
  };
}

describe("routineRunOutcome", () => {
  it("classes a run by how it ended", () => {
    expect(routineRunOutcome("completed", "x")).toBe("success");
    expect(routineRunOutcome("recovered", "x")).toBe("success");
    expect(routineRunOutcome("grouped", "x")).toBe("success");
    expect(routineRunOutcome("failed", "x")).toBe("failure");
    expect(routineRunOutcome("issue_created", null)).toBe("running");
    expect(routineRunOutcome("gating", null)).toBe("running");
    expect(routineRunOutcome("skipped", "x")).toBe("skipped");
    expect(routineRunOutcome("coalesced", "x")).toBe("skipped");
    expect(routineRunOutcome("something_new", "x")).toBe("skipped");
    expect(routineRunOutcome("scheduled", null)).toBe("scheduled");
  });

  it("gives every outcome its own style, and projected fires a hollow one", () => {
    const fills = Object.values(ROUTINE_OUTCOME_STYLE).map((style) => `${style.fill}|${style.stroke ?? ""}`);
    expect(new Set(fills).size).toBe(fills.length);
    expect(ROUTINE_OUTCOME_STYLE.scheduled).toMatchObject({ fill: "none", dashed: true });
  });
});

describe("buildRoutineTimelineChartModel", () => {
  it("makes one row per routine, marks paused ones, and keeps routines with nothing in the window", () => {
    const model = buildRoutineTimelineChartModel(data());
    expect(model.result.actors.map((actor) => actor.name)).toEqual(["On deploy", "Daily digest (paused)", "Idle"]);
    expect(model.layoutOptions.keepEmptyActors).toBe(true);
  });

  it("draws each run from its start to its end and each fire as an instant", () => {
    const model = buildRoutineTimelineChartModel(data());
    const span = (id: string) => model.result.spans.find((candidate) => candidate.runId === id)!;
    expect(span("r1")).toMatchObject({ actorId: "routine:daily", start: t("07:00"), end: t("07:20"), status: "completed", issueIdentifier: "T-1", issueTitle: "Digest 21 Oct" });
    expect(span("r3")).toMatchObject({ end: null, issueTitle: "On deploy" });
    const fires = model.result.spans.filter((candidate) => candidate.status === "scheduled");
    expect(fires.map((fire) => [fire.start, fire.end])).toEqual([[t("21:00"), t("21:00")], [t("13:00"), t("13:00")]]);
    expect(new Set(fires.map((fire) => fire.runId)).size).toBe(2);
    expect(model.runCount).toBe(3);
    expect(model.fireCount).toBe(2);
    expect(model.layoutOptions.minBarPx).toBe(FIRE_MIN_BAR_PX);
  });

  it("styles a bar by outcome", () => {
    const model = buildRoutineTimelineChartModel(data());
    const style = (id: string) => model.barStyle(model.result.spans.find((candidate) => candidate.runId === id)!);
    expect(style("r1")).toEqual(ROUTINE_OUTCOME_STYLE.success);
    expect(style("r2")).toEqual(ROUTINE_OUTCOME_STYLE.failure);
    expect(style("r3")).toEqual(ROUTINE_OUTCOME_STYLE.running);
    const fire = model.result.spans.find((candidate) => candidate.status === "scheduled")!;
    expect(model.barStyle(fire)).toEqual(ROUTINE_OUTCOME_STYLE.scheduled);
  });

  it("opens the issue tree of a run that made an issue, and the routine for a run or fire that did not", () => {
    const model = buildRoutineTimelineChartModel(data());
    const span = (id: string) => model.result.spans.find((candidate) => candidate.runId === id)!;
    expect(model.targetOf(span("r1"))).toEqual({ kind: "issue", id: "i1" });
    expect(model.targetOf(span("r2"))).toEqual({ kind: "routine", id: "hook" });
    const fire = model.result.spans.find((candidate) => candidate.status === "scheduled")!;
    expect(model.targetOf(fire)).toEqual({ kind: "routine", id: "daily" });
  });

  it("describes a bar's trigger in its tooltip hint", () => {
    const model = buildRoutineTimelineChartModel(data());
    const span = (id: string) => model.result.spans.find((candidate) => candidate.runId === id)!;
    expect(model.spanHint(span("r1"))).toBe("Completed · schedule · 0 9 * * * (Europe/Paris)");
    expect(model.spanHint(span("r2"))).toBe("Failed · webhook · GitHub push");
    expect(model.spanHint(span("r3"))).toBe("Running · manual");
    const fire = model.result.spans.find((candidate) => candidate.status === "scheduled")!;
    expect(model.spanHint(fire)).toBe("Scheduled · 0 9 * * * (Europe/Paris)");
  });

  it("puts scheduled routines first, in their own section, and the rest under their own", () => {
    const model = buildRoutineTimelineChartModel(data());
    const { actors } = model.result;
    const sorted = [...actors].sort(model.layoutOptions.compareActors!);
    expect(sorted.map((actor) => actor.id)).toEqual(["routine:daily", "routine:hook", "routine:idle"]);
    const sections = sorted.map((actor) => model.layoutOptions.sectionOf!(actor));
    expect(sections).toEqual([SECTION_SCHEDULED, SECTION_UNSCHEDULED, SECTION_UNSCHEDULED]);
  });

  it("flags the window as capped when the server cut the fires or the runs", () => {
    expect(buildRoutineTimelineChartModel(data()).result.window.capped).toBe(false);
    const capped = data({ limits: { fires: { cap: 500, truncated: true }, runs: { cap: 5000, truncated: false } } });
    expect(buildRoutineTimelineChartModel(capped).result.window.capped).toBe(true);
  });
});

describe("fire times", () => {
  it("finds the first and the last projected fire", () => {
    expect(nextFireAt(data())).toBe(t("13:00"));
    expect(lastFireAt(data())).toBe(t("21:00"));
    expect(nextFireAt({ fires: [] })).toBeNull();
    expect(lastFireAt({ fires: [] })).toBeNull();
  });
});
