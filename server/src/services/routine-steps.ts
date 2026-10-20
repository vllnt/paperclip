import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces, issueRelations, issues, labels, routineRuns } from "@paperclipai/db";
import {
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  interpolateRoutineTemplate,
  orderRoutineStepsTopologically,
  routineStartingSteps,
  routineStepPredecessorKeys,
  type RoutineStep,
  type RoutineStepsRunPayload,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueExecutionWorkspaceModeForPersistedWorkspace } from "./execution-workspace-policy.js";
import { isClosedExecutionWorkspaceStatus } from "./execution-workspaces.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import type { DbTransaction, issueService } from "./issues.js";

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

/** The refusal to throw for a step: an HttpError keeps its status and details and names the step. */
function withStepKey(error: unknown, stepKey: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  return new HttpError(error.status, `Step "${stepKey}": ${error.message}`, { ...details, stepKey });
}

/**
 * Checks what a step list refers to inside one company. Every step needs an
 * agent (its own or the default), and that agent must be assignable work; the
 * agents named in review stages and the labels must belong to the company.
 * @param defaultAssigneeAgentId The agent a step without `assigneeAgentId` runs as.
 * @throws HttpError (422 or 409) whose message starts with the key of the first step that cannot run.
 */
export async function assertRoutineStepReferences(
  db: Db,
  companyId: string,
  steps: RoutineStep[],
  defaultAssigneeAgentId: string | null,
): Promise<void> {
  if (steps.length === 0) return;
  const checkedAgentIds = new Set<string>();
  for (const step of steps) {
    const agentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
    if (!agentId) {
      throw unprocessable(
        `Step "${step.key}" needs an agent: set assigneeAgentId on the step or a default agent on the routine`,
        { stepKey: step.key },
      );
    }
    if (checkedAgentIds.has(agentId)) continue;
    try {
      await assertAssignableAgent(db, companyId, agentId, { kind: "work" });
    } catch (error) {
      throw withStepKey(error, step.key);
    }
    checkedAgentIds.add(agentId);
  }

  const stageAgentIds = [...new Set(steps.flatMap(stepStageAgentIds))];
  if (stageAgentIds.length > 0) {
    const found = new Set(
      (
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, stageAgentIds)))
      ).map((row) => row.id),
    );
    const step = steps.find((candidate) => stepStageAgentIds(candidate).some((id) => !found.has(id)));
    if (step) {
      throw unprocessable(`Step "${step.key}": agents in review stages must belong to this company`, {
        stepKey: step.key,
      });
    }
  }

  const labelIds = [...new Set(steps.flatMap((step) => step.labelIds ?? []))];
  if (labelIds.length > 0) {
    const found = new Set(
      (
        await db
          .select({ id: labels.id })
          .from(labels)
          .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)))
      ).map((row) => row.id),
    );
    const step = steps.find((candidate) => (candidate.labelIds ?? []).some((id) => !found.has(id)));
    if (step) {
      throw unprocessable(`Step "${step.key}": labels must belong to this company`, { stepKey: step.key });
    }
  }
}

const OPEN_STEP_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

/**
 * Whether a routine run's root still has a step that has not finished. A blocked step counts: it is
 * waiting for its predecessors, not done. Callers hold the root back while this is true.
 * @param executor The connection to read on; pass the open transaction to see its own writes.
 */
export async function hasOpenRoutineSteps(executor: Db, companyId: string, rootIssueId: string): Promise<boolean> {
  const rows = await executor
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.parentId, rootIssueId),
        eq(issues.originKind, "routine_step"),
        inArray(issues.status, OPEN_STEP_STATUSES),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The agents that must be able to start now: those of the steps with nothing to wait for. */
export function routineStartingStepAgentIds(steps: RoutineStep[], defaultAssigneeAgentId: string | null): string[] {
  const ids = routineStartingSteps(steps).flatMap((step) => {
    const agentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
    return agentId ? [agentId] : [];
  });
  return [...new Set(ids)];
}

/** What the steps hang under: the root issue of a routine run. */
export interface RoutineRunRoot {
  id: string;
  companyId: string;
  responsibleUserId: string | null;
}

export interface CreateRoutineRunIssuesInput<TRoot extends RoutineRunRoot> {
  /** The dispatch transaction; the root and the steps are created in one savepoint of it. */
  tx: Db;
  issueSvc: Pick<IssueService, "createChild">;
  /** Creates the root issue, in status `blocked`, on the savepoint it is given. */
  createRoot: (savepoint: DbTransaction) => Promise<TRoot>;
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
 * Creates the root issue of a routine run and one child issue per step under it, and records the
 * steps on the run.
 *
 * Steps are created in dependency order. Each waits (`blockedByIssueIds`) for the steps in its `after`,
 * and the root waits for every step. A step with nothing to wait for starts in `todo`; the others start
 * `blocked` and are woken by the usual blocker-resolved wake. All of it runs in one savepoint of `tx`
 * and every read on it uses that savepoint's connection: if the root or any step fails, no issue,
 * blocker, activity row or payload change is kept and the error propagates. It never wakes anyone; the
 * caller wakes `attached.startingIssues` once its own transaction commits.
 * @throws HttpError naming the step that failed to be created.
 */
export async function createRoutineRunIssues<TRoot extends RoutineRunRoot>(
  input: CreateRoutineRunIssuesInput<TRoot>,
): Promise<{ root: TRoot; attached: AttachedRoutineSteps }> {
  const { tx, issueSvc, createRoot, run, routine, steps, defaultAssigneeAgentId, variables } = input;
  return tx.transaction(async (savepoint) => {
    const savepointDb = savepoint as unknown as Db;
    const root = await createRoot(savepoint);
    const stepIssueIds: Record<string, string> = {};
    const startingIssues: StepIssue[] = [];
    const activityPublications: ActivityPublication[] = [];

    for (const step of orderRoutineStepsTopologically(steps)) {
      const assigneeAgentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
      if (!assigneeAgentId) throw unprocessable(`Step "${step.key}" needs an agent`, { stepKey: step.key });
      const predecessorIds = routineStepPredecessorKeys(step).map((key) => {
        const id = stepIssueIds[key];
        if (!id) {
          throw unprocessable(`Step "${step.key}" waits for step "${key}", which was not created`, {
            stepKey: step.key,
          });
        }
        return id;
      });
      const policy = normalizeIssueExecutionPolicy(step.executionPolicy ?? null);
      let created: Awaited<ReturnType<IssueService["createChild"]>>;
      try {
        created = await issueSvc.createChild(
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
      } catch (error) {
        throw withStepKey(error, step.key);
      }
      const { issue } = created;
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
    await savepoint
      .update(routineRuns)
      .set({
        triggerPayload: sql`coalesce(${routineRuns.triggerPayload}, '{}'::jsonb) || ${JSON.stringify({ [ROUTINE_STEPS_RUN_PAYLOAD_KEY]: recorded })}::jsonb`,
      })
      .where(eq(routineRuns.id, run.id));

    return { root, attached: { stepIssueIds, startingIssues, activityPublications } };
  });
}

/**
 * Wakes the agents of the steps that start now, then publishes the activity. Call it once the
 * transaction that ran {@link createRoutineRunIssues} has committed: the wake reads the steps on other
 * connections. A wake that fails is logged and left to the stranded-issue sweep, which re-dispatches a
 * `todo` step. Publishing comes last and cannot throw, so a live-event failure never skips a wake or
 * turns an already committed dispatch into a failure.
 */
export async function startAttachedRoutineSteps(
  attached: AttachedRoutineSteps,
  options: {
    heartbeat: IssueAssignmentWakeupDeps;
    contextSource: string;
    requestedByActorType?: "user" | "agent" | "system";
  },
): Promise<void> {
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
  for (const publication of attached.activityPublications) {
    try {
      publishActivity(publication);
    } catch (error) {
      logger.warn({ err: error }, "failed to publish the activity of a routine step");
    }
  }
}

/** The fields of a step issue that decide whether it can reuse a predecessor's workspace. */
export interface RoutineStepWorkspaceCandidate {
  id: string;
  originKind: string | null;
  originRunId: string | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
}

/**
 * Lets a step reuse the workspace of the step it waited for.
 *
 * Steps are siblings under a root that never runs, so a step created up front has no workspace to
 * inherit: left alone, a reviewer would get a fresh checkout without the implementer's work. Just
 * before a step runs for the first time, this points it at the workspace of its earliest predecessor
 * (by issue number) that has an open one. It changes nothing when the issue is not a step, already has
 * a workspace, or has no predecessor with an open workspace in the same project. It also skips a
 * workspace that another unfinished step of the same run holds, so two parallel branches never share a
 * checkout. The step row is read by the caller, so a plain issue costs no query here.
 * @param step The step issue as the caller already read it.
 * @returns whether the step now reuses a predecessor's workspace.
 */
export async function inheritRoutineStepWorkspace(
  db: Db,
  companyId: string,
  step: RoutineStepWorkspaceCandidate,
): Promise<boolean> {
  if (step.originKind !== "routine_step" || step.executionWorkspaceId) return false;

  const predecessors = await db
    .select({
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      workspace: executionWorkspaces,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.issueId))
    .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, issues.executionWorkspaceId))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, step.id),
        eq(issueRelations.type, "blocks"),
        eq(issues.originKind, "routine_step"),
        step.projectId ? eq(issues.projectId, step.projectId) : undefined,
      ),
    )
    .orderBy(asc(issues.issueNumber), asc(issues.id));
  const open = predecessors.filter(
    ({ workspace }) => workspace.closedAt === null && !isClosedExecutionWorkspaceStatus(workspace.status),
  );
  if (open.length === 0) return false;

  const heldBySiblings = step.originRunId
    ? new Set(
        (
          await db
            .select({ executionWorkspaceId: issues.executionWorkspaceId })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                eq(issues.originKind, "routine_step"),
                eq(issues.originRunId, step.originRunId),
                ne(issues.id, step.id),
                notInArray(issues.status, ["done", "cancelled"]),
              ),
            )
        ).map((row) => row.executionWorkspaceId),
      )
    : new Set<string | null>();
  const predecessor = open.find((candidate) => !heldBySiblings.has(candidate.executionWorkspaceId));
  if (!predecessor?.executionWorkspaceId) return false;

  const updated = await db
    .update(issues)
    .set({
      executionWorkspaceId: predecessor.executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        ...(step.executionWorkspaceSettings ?? {}),
        mode: issueExecutionWorkspaceModeForPersistedWorkspace(predecessor.workspace.mode),
      },
      ...(step.projectWorkspaceId ? {} : { projectWorkspaceId: predecessor.projectWorkspaceId }),
    })
    .where(and(eq(issues.id, step.id), eq(issues.companyId, companyId), isNull(issues.executionWorkspaceId)))
    .returning({ id: issues.id });
  return updated.length > 0;
}
