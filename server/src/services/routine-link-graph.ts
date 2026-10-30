import {
  routineStepPredecessorKeys,
  type EventMatch,
  type RoutineStep,
  type RoutineTimelineEdge,
  type RoutineTimelineNode,
} from "@paperclipai/shared";

/**
 * Nodes and edges of the routines link graph, derived from stored rows only: trigger config, routine steps,
 * goal and project links, and the issues that runs created or started on. Nothing here is inferred.
 *
 * One link is left out on purpose. A task a routine run creates never reaches the built-in `issue.created`
 * event source (the source skips tasks made inside a routine run), so a routine cannot start another routine
 * through the event source; the graph only draws the issue links that are stored.
 */

export interface LinkGraphRoutine {
  id: string;
  title: string;
  status: string;
  goalId: string | null;
  projectId: string | null;
  parentIssueId: string | null;
  steps: RoutineStep[];
}

export interface LinkGraphEventTrigger {
  id: string;
  routineId: string;
  enabled: boolean;
  eventSourceId: string | null;
  eventMatch: EventMatch | null;
}

export interface LinkGraphNamed {
  id: string;
  name: string;
}

/** An issue a routine run made, as its root or as one of its steps. */
export interface LinkGraphRoutineIssue {
  issueId: string;
  routineId: string;
}

/** A run that started on an issue (`linkedIssueId`), newest first. */
export interface LinkGraphRunOnIssue {
  runId: string;
  routineId: string;
  issueId: string;
}

export interface LinkGraphInput {
  routines: LinkGraphRoutine[];
  eventTriggers: LinkGraphEventTrigger[];
  eventSources: LinkGraphNamed[];
  goals: LinkGraphNamed[];
  projects: LinkGraphNamed[];
  routineIssues: LinkGraphRoutineIssue[];
  runsOnIssues: LinkGraphRunOnIssue[];
}

export interface LinkGraph {
  nodes: RoutineTimelineNode[];
  edges: RoutineTimelineEdge[];
}

const EDGE_LABEL_MAX = 120;

export const routineNodeId = (routineId: string) => `routine:${routineId}`;
const stepNodeId = (routineId: string, key: string) => `step:${routineId}:${key}`;
const eventSourceNodeId = (sourceId: string) => `event_source:${sourceId}`;
const goalNodeId = (goalId: string) => `goal:${goalId}`;
const projectNodeId = (projectId: string) => `project:${projectId}`;

/** A short line for the filter of an event trigger, or null when it takes every event of its source. */
export function describeEventMatch(match: EventMatch | null | undefined): string | null {
  if (!match) return null;
  const parts: string[] = [];
  if (match.sources?.length) parts.push(`source ${match.sources.join(", ")}`);
  if (match.types?.length) parts.push(`type ${match.types.join(", ")}`);
  if (match.minSeverity) parts.push(`min ${match.minSeverity}`);
  for (const [key, value] of Object.entries(match.labels ?? {})) {
    parts.push(`${key}=${Array.isArray(value) ? value.join("|") : value}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.length > EDGE_LABEL_MAX ? `${text.slice(0, EDGE_LABEL_MAX - 1)}…` : text;
}

/** Builds the graph for the routines given; the caller leaves archived routines out. */
export function buildRoutineLinkGraph(input: LinkGraphInput): LinkGraph {
  const nodes: RoutineTimelineNode[] = [];
  const edges: RoutineTimelineEdge[] = [];
  const routineIds = new Set(input.routines.map((routine) => routine.id));
  const sourceById = new Map(input.eventSources.map((source) => [source.id, source]));
  const goalById = new Map(input.goals.map((goal) => [goal.id, goal]));
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const routineOfIssue = new Map(input.routineIssues.map((issue) => [issue.issueId, issue.routineId]));
  const edgeIds = new Set<string>();

  const addEdge = (edge: Omit<RoutineTimelineEdge, "id"> & { discriminator?: string }) => {
    const { discriminator, ...rest } = edge;
    const id = `${rest.kind}:${rest.from}>${rest.to}${discriminator ? `:${discriminator}` : ""}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, ...rest });
  };
  const noRefs = { triggerId: null, issueId: null, runId: null } as const;
  const addedNodes = new Set<string>();
  const addNode = (node: RoutineTimelineNode) => {
    if (addedNodes.has(node.id)) return;
    addedNodes.add(node.id);
    nodes.push(node);
  };

  for (const routine of input.routines) {
    const routineNode = routineNodeId(routine.id);
    addNode({ id: routineNode, kind: "routine", refId: routine.id, label: routine.title, parentId: null, status: routine.status });

    const stepKeys = new Set(routine.steps.map((step) => step.key));
    for (const step of routine.steps) {
      addNode({
        id: stepNodeId(routine.id, step.key),
        kind: "step",
        refId: step.key,
        label: step.title,
        parentId: routineNode,
        status: null,
      });
      for (const predecessor of routineStepPredecessorKeys(step)) {
        if (!stepKeys.has(predecessor)) continue;
        addEdge({
          kind: "step_after",
          from: stepNodeId(routine.id, predecessor),
          to: stepNodeId(routine.id, step.key),
          label: null,
          enabled: true,
          ...noRefs,
        });
      }
    }

    const goal = routine.goalId ? goalById.get(routine.goalId) : undefined;
    if (goal) {
      addNode({ id: goalNodeId(goal.id), kind: "goal", refId: goal.id, label: goal.name, parentId: null, status: null });
      addEdge({ kind: "serves_goal", from: routineNode, to: goalNodeId(goal.id), label: null, enabled: true, ...noRefs });
    }
    const project = routine.projectId ? projectById.get(routine.projectId) : undefined;
    if (project) {
      addNode({ id: projectNodeId(project.id), kind: "project", refId: project.id, label: project.name, parentId: null, status: null });
      addEdge({ kind: "serves_project", from: routineNode, to: projectNodeId(project.id), label: null, enabled: true, ...noRefs });
    }

    // The routine files its runs under an issue that another routine's run made.
    const parentOwner = routine.parentIssueId ? routineOfIssue.get(routine.parentIssueId) : undefined;
    if (routine.parentIssueId && parentOwner && parentOwner !== routine.id && routineIds.has(parentOwner)) {
      addEdge({
        kind: "parent_issue",
        from: routineNodeId(parentOwner),
        to: routineNode,
        label: null,
        enabled: true,
        triggerId: null,
        issueId: routine.parentIssueId,
        runId: null,
        discriminator: routine.parentIssueId,
      });
    }
  }

  for (const trigger of input.eventTriggers) {
    const source = trigger.eventSourceId ? sourceById.get(trigger.eventSourceId) : undefined;
    if (!source || !routineIds.has(trigger.routineId)) continue;
    addNode({
      id: eventSourceNodeId(source.id),
      kind: "event_source",
      refId: source.id,
      label: source.name,
      parentId: null,
      status: null,
    });
    addEdge({
      kind: "event_trigger",
      from: eventSourceNodeId(source.id),
      to: routineNodeId(trigger.routineId),
      label: describeEventMatch(trigger.eventMatch),
      enabled: trigger.enabled,
      triggerId: trigger.id,
      issueId: null,
      runId: null,
      discriminator: trigger.id,
    });
  }

  // Runs come newest first, so the first run seen for a pair of routines and an issue is the latest one.
  for (const run of input.runsOnIssues) {
    const owner = routineOfIssue.get(run.issueId);
    if (!owner || owner === run.routineId || !routineIds.has(owner) || !routineIds.has(run.routineId)) continue;
    addEdge({
      kind: "targets_issue",
      from: routineNodeId(owner),
      to: routineNodeId(run.routineId),
      label: null,
      enabled: true,
      triggerId: null,
      issueId: run.issueId,
      runId: run.runId,
      discriminator: run.issueId,
    });
  }

  return { nodes, edges };
}
