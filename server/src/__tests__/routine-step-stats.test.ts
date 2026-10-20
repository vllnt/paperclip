import { describe, expect, it } from "vitest";
import {
  MAX_ROUTINE_STEPS,
  ROUTINE_STEP_STATS_MAX_RUNS,
  routineStepStatsQuerySchema,
  routineStepStatsSchema,
} from "@paperclipai/shared";
import {
  parseRoutineStepStatsRow,
  summarizeRoutineStepStats,
  type RoutineStepStatsIssue,
  type RoutineStepStatsRow,
} from "../services/routine-step-stats.js";

const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const MINUTE = 60_000;

function stepIssue(stepKey: string, overrides: Partial<RoutineStepStatsIssue> = {}): RoutineStepStatsIssue {
  return {
    stepKey,
    status: "todo",
    createdAt: new Date(T0),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    agentRuns: 0,
    inputTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    costMicros: null,
    agentDurationMs: null,
    reviewRounds: 0,
    changesRequested: 0,
    ...overrides,
  };
}

function row(runId: string, issue: RoutineStepStatsIssue | null, runMinute = 0): RoutineStepStatsRow {
  return { runId, runCreatedAt: new Date(T0 + runMinute * MINUTE), issue };
}

describe("summarizeRoutineStepStats", () => {
  it("returns empty figures and the current steps when no run was read", () => {
    const stats = summarizeRoutineStepStats({
      routineId: ROUTINE_ID,
      runs: 50,
      currentSteps: [{ key: "build", title: "Build" }],
      rows: [],
    });

    expect(routineStepStatsSchema.parse(stats)).toEqual(stats);
    expect(stats.window).toEqual({ runs: 50, scannedRuns: 0, since: null });
    expect(stats.routine).toMatchObject({ runs: 0, finishedRuns: 0, medianDurationMs: null, cancelledRate: null });
    expect(stats.steps).toEqual([
      expect.objectContaining({ key: "build", title: "Build", runs: 0, medianDurationMs: null, agentRuns: 0, inputTokens: null }),
    ]);
  });

  it("counts a run without steps in the window only", () => {
    const stats = summarizeRoutineStepStats({
      routineId: ROUTINE_ID,
      runs: 50,
      currentSteps: [],
      rows: [row("run-1", null, 0), row("run-2", null, 5)],
    });

    expect(stats.window).toEqual({ runs: 50, scannedRuns: 2, since: new Date(T0).toISOString() });
    expect(stats.routine.runs).toBe(0);
    expect(stats.steps).toEqual([]);
  });

  it("keeps a sum null until a run reports it, and counts a zero as reported", () => {
    const stats = summarizeRoutineStepStats({
      routineId: ROUTINE_ID,
      runs: 50,
      currentSteps: [{ key: "build", title: "Build" }],
      rows: [
        row("run-1", stepIssue("build", { agentRuns: 1, inputTokens: null, costMicros: 0 })),
        row("run-2", stepIssue("build", { agentRuns: 1, inputTokens: null, costMicros: null })),
      ],
    });

    expect(stats.steps[0]).toMatchObject({ agentRuns: 2, inputTokens: null, costMicros: 0 });
  });

  it("measures a done step from its first start, or from its creation when it never started", () => {
    const stats = summarizeRoutineStepStats({
      routineId: ROUTINE_ID,
      runs: 50,
      currentSteps: [{ key: "build", title: "Build" }],
      rows: [
        row(
          "run-1",
          stepIssue("build", {
            status: "done",
            startedAt: new Date(T0 + 10 * MINUTE),
            completedAt: new Date(T0 + 14 * MINUTE),
          }),
        ),
        row("run-2", stepIssue("build", { status: "done", completedAt: new Date(T0 + 6 * MINUTE) })),
        row("run-3", stepIssue("build", { status: "cancelled", cancelledAt: new Date(T0 + 99 * MINUTE) })),
      ],
    });

    expect(stats.steps[0]).toMatchObject({ runs: 3, done: 2, cancelled: 1, medianDurationMs: 5 * MINUTE });
    expect(stats.routine).toMatchObject({ runs: 3, finishedRuns: 3, medianDurationMs: 14 * MINUTE });
  });

  it("covers the largest window: every step of the most runs", () => {
    const keys = Array.from({ length: MAX_ROUTINE_STEPS }, (_, index) => `step-${index}`);
    const rows: RoutineStepStatsRow[] = [];
    for (let run = 0; run < ROUTINE_STEP_STATS_MAX_RUNS; run += 1) {
      for (const [index, key] of keys.entries()) {
        const cancelled = run % 10 === 0 && index === 0;
        rows.push(
          row(
            `run-${run}`,
            stepIssue(key, {
              status: cancelled ? "cancelled" : "done",
              startedAt: new Date(T0 + run * MINUTE),
              completedAt: cancelled ? null : new Date(T0 + (run + 2) * MINUTE),
              cancelledAt: cancelled ? new Date(T0 + (run + 1) * MINUTE) : null,
              agentRuns: 1,
              inputTokens: 1_000,
              outputTokens: 100,
              costMicros: 10,
              agentDurationMs: MINUTE,
              reviewRounds: 2,
              changesRequested: 1,
            }),
            run,
          ),
        );
      }
    }

    const started = performance.now();
    const stats = summarizeRoutineStepStats({
      routineId: ROUTINE_ID,
      runs: ROUTINE_STEP_STATS_MAX_RUNS,
      currentSteps: keys.map((key) => ({ key, title: key.toUpperCase() })),
      rows,
    });
    const elapsedMs = performance.now() - started;

    const instances = ROUTINE_STEP_STATS_MAX_RUNS * MAX_ROUTINE_STEPS;
    expect(routineStepStatsSchema.parse(stats)).toEqual(stats);
    expect(stats.window.scannedRuns).toBe(ROUTINE_STEP_STATS_MAX_RUNS);
    expect(stats.routine).toMatchObject({
      runs: ROUTINE_STEP_STATS_MAX_RUNS,
      finishedRuns: ROUTINE_STEP_STATS_MAX_RUNS,
      done: instances - 10,
      cancelled: 10,
      open: 0,
      agentRuns: instances,
      inputTokens: instances * 1_000,
      costMicros: instances * 10,
      reviewRounds: instances * 2,
      changesRequestedRate: 0.5,
    });
    expect(stats.steps).toHaveLength(MAX_ROUTINE_STEPS);
    expect(stats.steps[0]).toMatchObject({ key: "step-0", title: "STEP-0", runs: 100, cancelled: 10, cancelledRate: 0.1 });
    expect(stats.steps[1]).toMatchObject({ runs: 100, cancelled: 0, cancelledRate: 0, medianDurationMs: 2 * MINUTE });
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("parseRoutineStepStatsRow", () => {
  it("reads the driver's strings and dates and keeps a run without a step issue", () => {
    expect(
      parseRoutineStepStatsRow({
        run_id: "run-1",
        run_created_at: new Date(T0),
        step_key: "build",
        status: "done",
        created_at: new Date(T0),
        started_at: null,
        completed_at: "2026-10-20T10:05:00.000Z",
        cancelled_at: null,
        agent_runs: "2",
        input_tokens: "1500",
        cache_read_tokens: null,
        output_tokens: "20",
        cost_micros: "300",
        agent_duration_ms: "60000",
        review_rounds: "1",
        changes_requested: "0",
      }).issue,
    ).toMatchObject({ stepKey: "build", agentRuns: 2, inputTokens: 1_500, completedAt: new Date(T0 + 5 * MINUTE) });

    const withoutStep = parseRoutineStepStatsRow({
      run_id: "run-2",
      run_created_at: new Date(T0),
      step_key: null,
      status: null,
      created_at: null,
      started_at: null,
      completed_at: null,
      cancelled_at: null,
      agent_runs: "0",
      input_tokens: null,
      cache_read_tokens: null,
      output_tokens: null,
      cost_micros: null,
      agent_duration_ms: null,
      review_rounds: "0",
      changes_requested: "0",
    });
    expect(withoutStep).toEqual({ runId: "run-2", runCreatedAt: new Date(T0), issue: null });
  });
});

describe("routineStepStatsQuerySchema", () => {
  it("defaults the window and bounds it", () => {
    expect(routineStepStatsQuerySchema.parse({})).toEqual({ runs: 50 });
    expect(routineStepStatsQuerySchema.parse({ runs: "100" })).toEqual({ runs: 100 });
    for (const runs of ["0", "101", "1.5", "x"]) {
      expect(routineStepStatsQuerySchema.safeParse({ runs }).success, runs).toBe(false);
    }
    expect(routineStepStatsQuerySchema.safeParse({ limit: "5" }).success).toBe(false);
  });
});
