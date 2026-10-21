import { describe, expect, it } from "vitest";
import type { RoutineStep } from "@paperclipai/shared";
import {
  buildRoutineLinkGraph,
  describeEventMatch,
  type LinkGraphInput,
  type LinkGraphRoutine,
} from "./routine-link-graph.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "11111111-1111-4111-8111-111111111111";
const GOAL = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const ISSUE_FROM_A = "44444444-4444-4444-8444-444444444444";

function routine(id: string, title: string, extra: Partial<LinkGraphRoutine> = {}): LinkGraphRoutine {
  return { id, title, status: "active", goalId: null, projectId: null, parentIssueId: null, steps: [], ...extra };
}

function step(key: string, after: string[] = []): RoutineStep {
  return { key, title: `Step ${key}`, after } as RoutineStep;
}

function graph(input: Partial<LinkGraphInput>) {
  return buildRoutineLinkGraph({
    routines: [],
    eventTriggers: [],
    eventSources: [],
    goals: [],
    projects: [],
    routineIssues: [],
    runsOnIssues: [],
    ...input,
  });
}

const edgesOf = (result: ReturnType<typeof graph>, kind: string) => result.edges.filter((edge) => edge.kind === kind);

describe("buildRoutineLinkGraph", () => {
  it("makes a node per routine and per step, with each step held by its routine", () => {
    const result = graph({ routines: [routine(A, "Weekly review", { steps: [step("draft"), step("review", ["draft"])] })] });
    expect(result.nodes.map((node) => [node.id, node.kind, node.parentId])).toEqual([
      [`routine:${A}`, "routine", null],
      [`step:${A}:draft`, "step", `routine:${A}`],
      [`step:${A}:review`, "step", `routine:${A}`],
    ]);
  });

  it("draws step_after edges from each predecessor, including a step that waits for several", () => {
    const result = graph({
      routines: [routine(A, "Pipeline", { steps: [step("a"), step("b"), step("c", ["a", "b"]), step("d", ["c", "missing"])] })],
    });
    expect(edgesOf(result, "step_after").map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      `step:${A}:a>step:${A}:c`,
      `step:${A}:b>step:${A}:c`,
      `step:${A}:c>step:${A}:d`,
    ]);
  });

  it("draws an event_trigger edge from the source to the routine, with the filter as its label", () => {
    const result = graph({
      routines: [routine(A, "On alert")],
      eventSources: [{ id: SOURCE, name: "Monitoring" }],
      eventTriggers: [{
        id: "t1",
        routineId: A,
        enabled: false,
        eventSourceId: SOURCE,
        eventMatch: { types: ["alert.fired"], minSeverity: "warning", labels: { env: ["prod", "stage"] } },
      }],
    });
    expect(result.nodes.find((node) => node.id === `event_source:${SOURCE}`)).toMatchObject({ kind: "event_source", label: "Monitoring" });
    expect(edgesOf(result, "event_trigger")).toEqual([
      expect.objectContaining({
        from: `event_source:${SOURCE}`,
        to: `routine:${A}`,
        label: "type alert.fired · min warning · env=prod|stage",
        enabled: false,
        triggerId: "t1",
      }),
    ]);
  });

  it("skips an event trigger whose source or routine is not in the graph", () => {
    const result = graph({
      routines: [routine(A, "On alert")],
      eventSources: [{ id: SOURCE, name: "Monitoring" }],
      eventTriggers: [
        { id: "t1", routineId: A, enabled: true, eventSourceId: "99999999-9999-4999-8999-999999999999", eventMatch: null },
        { id: "t2", routineId: B, enabled: true, eventSourceId: SOURCE, eventMatch: null },
        { id: "t3", routineId: A, enabled: true, eventSourceId: null, eventMatch: null },
      ],
    });
    expect(edgesOf(result, "event_trigger")).toEqual([]);
  });

  it("keeps one edge per trigger when two triggers of a routine share a source", () => {
    const result = graph({
      routines: [routine(A, "On alert")],
      eventSources: [{ id: SOURCE, name: "Monitoring" }],
      eventTriggers: [
        { id: "t1", routineId: A, enabled: true, eventSourceId: SOURCE, eventMatch: null },
        { id: "t2", routineId: A, enabled: true, eventSourceId: SOURCE, eventMatch: { minSeverity: "critical" } },
      ],
    });
    expect(edgesOf(result, "event_trigger").map((edge) => edge.triggerId)).toEqual(["t1", "t2"]);
    expect(result.nodes.filter((node) => node.kind === "event_source")).toHaveLength(1);
  });

  it("links a routine to its goal and project", () => {
    const result = graph({
      routines: [routine(A, "Report", { goalId: GOAL, projectId: PROJECT })],
      goals: [{ id: GOAL, name: "Grow" }],
      projects: [{ id: PROJECT, name: "Ops" }],
    });
    expect(edgesOf(result, "serves_goal")).toEqual([expect.objectContaining({ from: `routine:${A}`, to: `goal:${GOAL}` })]);
    expect(edgesOf(result, "serves_project")).toEqual([expect.objectContaining({ from: `routine:${A}`, to: `project:${PROJECT}` })]);
    expect(result.nodes.filter((node) => node.kind === "goal" || node.kind === "project").map((node) => node.label)).toEqual(["Grow", "Ops"]);
  });

  it("leaves out a goal or project it has no name for", () => {
    const result = graph({ routines: [routine(A, "Report", { goalId: GOAL, projectId: PROJECT })] });
    expect(result.edges).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  it("draws parent_issue from the routine whose run made the parent issue", () => {
    const result = graph({
      routines: [routine(A, "Intake"), routine(B, "Follow-up", { parentIssueId: ISSUE_FROM_A })],
      routineIssues: [{ issueId: ISSUE_FROM_A, routineId: A }],
    });
    expect(edgesOf(result, "parent_issue")).toEqual([
      expect.objectContaining({ from: `routine:${A}`, to: `routine:${B}`, issueId: ISSUE_FROM_A }),
    ]);
  });

  it("draws no parent_issue edge to itself, nor from a routine outside the graph", () => {
    const result = graph({
      routines: [routine(A, "Loop", { parentIssueId: ISSUE_FROM_A }), routine(B, "Other", { parentIssueId: "55555555-5555-4555-8555-555555555555" })],
      routineIssues: [
        { issueId: ISSUE_FROM_A, routineId: A },
        { issueId: "55555555-5555-4555-8555-555555555555", routineId: C },
      ],
    });
    expect(edgesOf(result, "parent_issue")).toEqual([]);
  });

  it("draws targets_issue from the routine that made the issue to the routine whose run started on it, once per issue", () => {
    const result = graph({
      routines: [routine(A, "Intake"), routine(B, "Triage")],
      routineIssues: [{ issueId: ISSUE_FROM_A, routineId: A }],
      runsOnIssues: [
        { runId: "run-new", routineId: B, issueId: ISSUE_FROM_A },
        { runId: "run-old", routineId: B, issueId: ISSUE_FROM_A },
        { runId: "run-self", routineId: A, issueId: ISSUE_FROM_A },
      ],
    });
    expect(edgesOf(result, "targets_issue")).toEqual([
      expect.objectContaining({ from: `routine:${A}`, to: `routine:${B}`, issueId: ISSUE_FROM_A, runId: "run-new" }),
    ]);
  });

  it("draws no issue link for an issue no routine run made", () => {
    const result = graph({
      routines: [routine(A, "Intake"), routine(B, "Triage", { parentIssueId: ISSUE_FROM_A })],
      runsOnIssues: [{ runId: "r", routineId: B, issueId: ISSUE_FROM_A }],
    });
    expect(result.edges).toEqual([]);
  });

  it("gives every edge a unique id", () => {
    const result = graph({
      routines: [routine(A, "Intake", { steps: [step("a"), step("b", ["a"])] }), routine(B, "Triage", { parentIssueId: ISSUE_FROM_A })],
      routineIssues: [{ issueId: ISSUE_FROM_A, routineId: A }],
      runsOnIssues: [{ runId: "r", routineId: B, issueId: ISSUE_FROM_A }],
    });
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(result.edges.length);
  });
});

describe("describeEventMatch", () => {
  it("is null when the trigger takes every event", () => {
    expect(describeEventMatch(null)).toBeNull();
    expect(describeEventMatch({})).toBeNull();
  });

  it("names sources, types, severity and labels", () => {
    expect(describeEventMatch({ sources: ["paperclip"], types: ["issue.created"], labels: { project: "p1" } }))
      .toBe("source paperclip · type issue.created · project=p1");
  });

  it("cuts a long filter", () => {
    const text = describeEventMatch({ types: Array.from({ length: 40 }, (_, index) => `type.number.${index}`) });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(120);
    expect(text!.endsWith("…")).toBe(true);
  });
});
