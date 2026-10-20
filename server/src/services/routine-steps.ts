import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces, issueRelations, issues, labels, routineRuns } from "@paperclipai/db";
import {
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  interpolateRoutineTemplate,
  orderRoutineStepsTopologically,
  routineStepPredecessorKeys,
  type RoutineStep,
  type RoutineStepsRunPayload,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueExecutionWorkspaceModeForPersistedWorkspace } from "./execution-workspace-policy.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import type { issueService } from "./issues.js";

/** Actor id on the activity rows a run writes for its step issues; the activity gate ignores it. */
export const ROUTINE_STEP_ACTOR_ID = "routine-steps";

type IssueService = ReturnType<typeof issueService>;
type StepIssue = Awaited<ReturnType<IssueService["createChild"]>>["issue"];

/** Agent ids a step names in its review and approval stages. */
function stepStageAgentIds(step: RoutineStep): string[] {
  const stages = step.executionPolicy?.stages ?? [];
  return stages.flatMap((stage) =>
    stage.participants.flatMap((participant) =>
      participant.type === "agent" && participant.agentId ? [participant.agentId] : [],
    ),
  );
}

/**
 * Checks what a step list refers to inside one company. Every step needs an
 * agent (its own or the default), and that agent must be assignable work; the
 * agents named in review stages and the labels must belong to the company.
 * @param defaultAssigneeAgentId The agent a step without `assigneeAgentId` runs as.
 * @throws HttpError (422 or 409) naming the first step that cannot run.
 */
export async function assertRoutineStepReferences(
  db: Db,
  companyId: string,
  steps: RoutineStep[],
  defaultAssigneeAgentId: string | null,
): Promise<void> {
  if (steps.length === 0) return;
  const assigneeIds = new Set<string>();
  const stageAgentIds = new Set<string>();
  const labelIds = new Set<string>();
  for (const step of steps) {
    const agentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
    if (!agentId) {
      throw unprocessable(
        `Step "${step.key}" needs an agent: set assigneeAgentId on the step or a default agent on the routine`,
      );
    }
    assigneeIds.add(agentId);
    for (const id of stepStageAgentIds(step)) stageAgentIds.add(id);
    for (const id of step.labelIds ?? []) labelIds.add(id);
  }
  for (const agentId of assigneeIds) {
    await assertAssignableAgent(db, companyId, agentId, { kind: "work" });
  }
  if (stageAgentIds.size > 0) {
    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...stageAgentIds])));
    if (found.length !== stageAgentIds.size) {
      throw unprocessable("Agents in step review stages must belong to this company");
    }
  }
  if (labelIds.size > 0) {
    const found = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, [...labelIds])));
    if (found.length !== labelIds.size) {
      throw unprocessable("Step labels must belong to this company");
    }
  }
}

/** The agents that must be able to start now: those of the steps with nothing to wait for. */
export function routineStartingStepAgentIds(steps: RoutineStep[], defaultAssigneeAgentId: string | null): string[] {
  const ids = steps
    .filter((step) => step.after.length === 0)
    .flatMap((step) => {
      const agentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
      return agentId ? [agentId] : [];
    });
  return [...new Set(ids)];
}

export interface AttachRoutineStepsInput {
  /** The dispatch transaction (or any executor); the steps are created in a savepoint of it. */
  tx: Db;
  issueSvc: Pick<IssueService, "createChild">;
  /** The issue the steps hang under. Its status is the caller's concern. */
  root: { id: string; companyId: string; responsibleUserId: string | null };
  /** The routine run that owns the steps. */
  run: { id: string };
  routine: { id: string; priority: string };
  steps: RoutineStep[];
  /** Agent for steps without `assigneeAgentId`. */
  defaultAssigneeAgentId: string | null;
  /** Values for `{{variable}}` placeholders in step text. */
  variables: Record<string, unknown>;
}

export interface AttachedRoutineSteps {
  /** Issue id by step key. */
  stepIssueIds: Record<string, string>;
  /** Steps with nothing to wait for. The caller wakes their agents after its transaction commits. */
  startingIssues: StepIssue[];
  /** Live events for the activity rows written; publish them after the transaction commits. */
  activityPublications: ActivityPublication[];
}

function interpolateText(text: string, variables: Record<string, unknown>): string {
  return interpolateRoutineTemplate(text, variables) ?? text;
}

/**
 * Creates one child issue per step under `root` and records them on the run.
 *
 * Steps are created in dependency order. Each waits (`blockedByIssueIds`) for the steps in its `after`,
 * and the root waits for every step. A step with nothing to wait for starts in `todo`; the others start
 * `blocked` and are woken by the usual blocker-resolved wake. All of it runs in one savepoint of `tx`:
 * if any step fails, no step, blocker, activity row or payload change is kept and the error propagates.
 * It never wakes anyone; the caller wakes `startingIssues` once its own transaction commits.
 */
export async function attachRoutineSteps(input: AttachRoutineStepsInput): Promise<AttachedRoutineSteps> {
  const { tx, issueSvc, root, run, routine, steps, defaultAssigneeAgentId, variables } = input;
  return tx.transaction(async (savepoint): Promise<AttachedRoutineSteps> => {
    const savepointDb = savepoint as unknown as Db;
    const stepIssueIds: Record<string, string> = {};
    const startingIssues: StepIssue[] = [];
    const activityPublications: ActivityPublication[] = [];

    for (const step of orderRoutineStepsTopologically(steps)) {
      const assigneeAgentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
      if (!assigneeAgentId) throw unprocessable(`Step "${step.key}" needs an agent`);
      const predecessorIds = routineStepPredecessorKeys(step).map((key) => {
        const id = stepIssueIds[key];
        if (!id) throw unprocessable(`Step "${step.key}" waits for step "${key}", which was not created`);
        return id;
      });
      const policy = normalizeIssueExecutionPolicy(step.executionPolicy ?? null);
      const { issue } = await issueSvc.createChild(
        root.id,
        {
          title: interpolateText(step.title, variables),
          description: step.description ? interpolateText(step.description, variables) : null,
          acceptanceCriteria: step.acceptanceCriteria?.map((line) => interpolateText(line, variables)),
          status: predecessorIds.length === 0 ? "todo" : "blocked",
          priority: step.priority ?? routine.priority,
          assigneeAgentId,
          labelIds: step.labelIds,
          ...(policy ? { executionPolicy: { ...policy } } : {}),
          blockedByIssueIds: predecessorIds,
          blockParentUntilDone: true,
          responsibleUserId: root.responsibleUserId,
          trustExplicitResponsibleUserId: true,
          idempotencyKey: `routine-run:${run.id}:${step.key}`,
          originKind: "routine_step",
          originId: routine.id,
          originRunId: run.id,
        },
        savepoint,
      );
      stepIssueIds[step.key] = issue.id;
      if (predecessorIds.length === 0) startingIssues.push(issue);
      await logActivity(
        savepointDb,
        {
          companyId: root.companyId,
          actorType: "system",
          actorId: ROUTINE_STEP_ACTOR_ID,
          action: "issue.child_created",
          entityType: "issue",
          entityId: issue.id,
          details: {
            parentId: root.id,
            identifier: issue.identifier,
            title: issue.title,
            routineId: routine.id,
            routineRunId: run.id,
            stepKey: step.key,
            blockedByIssueIds: predecessorIds,
            parentBlockerAdded: true,
          },
        },
        activityPublications,
      );
    }

    const recorded: RoutineStepsRunPayload = { steps, stepIssueIds };
    await savepointDb
      .update(routineRuns)
      .set({
        triggerPayload: sql`coalesce(${routineRuns.triggerPayload}, '{}'::jsonb) || ${JSON.stringify({ [ROUTINE_STEPS_RUN_PAYLOAD_KEY]: recorded })}::jsonb`,
      })
      .where(eq(routineRuns.id, run.id));

    return { stepIssueIds, startingIssues, activityPublications };
  });
}

/**
 * Publishes the activity and wakes the agents of the steps that start now. Call it once the transaction
 * that ran {@link attachRoutineSteps} has committed: the wake reads the steps on other connections.
 * A wake that fails is logged and left to the stranded-issue sweep, which re-dispatches a `todo` step.
 */
export async function startAttachedRoutineSteps(
  attached: AttachedRoutineSteps,
  options: {
    heartbeat: IssueAssignmentWakeupDeps;
    contextSource: string;
    requestedByActorType?: "user" | "agent" | "system";
  },
): Promise<void> {
  for (const publication of attached.activityPublications) publishActivity(publication);
  for (const issue of attached.startingIssues) {
    await queueIssueAssignmentWakeup({
      heartbeat: options.heartbeat,
      assignmentEvent: true,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: options.contextSource,
      requestedByActorType: options.requestedByActorType,
    });
  }
}

/**
 * Lets a step reuse the workspace of the step it waited for.
 *
 * Steps are siblings under a root that never runs, so a step created up front has no workspace to
 * inherit: left alone, a reviewer would get a fresh checkout without the implementer's work. Just
 * before a step runs for the first time, this points it at the workspace of its earliest predecessor
 * that has one. It changes nothing when the issue is not a step, already has a workspace, or has no
 * predecessor with a workspace in the same project.
 * @returns whether the step now reuses a predecessor's workspace.
 */
export async function inheritRoutineStepWorkspace(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const step = await db
    .select({
      originKind: issues.originKind,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!step || step.originKind !== "routine_step" || step.executionWorkspaceId) return false;

  const predecessor = await db
    .select({
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      workspaceMode: executionWorkspaces.mode,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.issueId))
    .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, issues.executionWorkspaceId))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
        eq(issues.originKind, "routine_step"),
        step.projectId ? eq(issues.projectId, step.projectId) : undefined,
      ),
    )
    .orderBy(asc(issues.createdAt), asc(issues.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!predecessor?.executionWorkspaceId) return false;

  await db
    .update(issues)
    .set({
      executionWorkspaceId: predecessor.executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        ...(step.executionWorkspaceSettings ?? {}),
        mode: issueExecutionWorkspaceModeForPersistedWorkspace(predecessor.workspaceMode),
      },
      ...(step.projectWorkspaceId ? {} : { projectWorkspaceId: predecessor.projectWorkspaceId }),
    })
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  return true;
}
