import { and, asc, eq, exists, gt, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  labels,
  routineRuns,
} from "@paperclipai/db";
import {
  OPEN_ISSUE_STATUSES,
  ROUTINE_STEP_SKIPPED_COMMENT,
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  evaluateRoutineStepRun,
  interpolateRoutineTemplate,
  orderRoutineStepsTopologically,
  readRoutineStepsRunPayload,
  routineStartingSteps,
  routineStepPredecessorKeys,
  routineStepsHaveConditions,
  type RoutineStep,
  type RoutineStepWarning,
  type RoutineStepsRunPayload,
} from "@paperclipai/shared";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { authorizationDeniedDetails, type AuthorizationActor, type authorizationService } from "./authorization.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueExecutionWorkspaceModeForPersistedWorkspace } from "./execution-workspace-policy.js";
import {
  CLOSED_EXECUTION_WORKSPACE_STATUSES,
  acquireExecutionWorkspaceLifecycleLock,
  isClosedExecutionWorkspaceStatus,
} from "./execution-workspaces.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "./issue-dependency-wakeups.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import {
  MAX_CHILD_ISSUES_CREATED_BY_HELPER,
  type DbTransaction,
  type IssuePostCommitAction,
  type issueService,
} from "./issues.js";
import { isHumanOwnedBlock } from "./routable-blocked.js";

/** Actor id on the activity rows a run writes for its step issues; the activity gate ignores it. */
export const ROUTINE_STEP_ACTOR_ID = "routine-steps";

/** Heartbeat run statuses in which a run still owns, or is about to own, the task it works on. */
export const LIVE_HEARTBEAT_RUN_STATUSES: readonly string[] = ["queued", "running", "scheduled_retry"];

/**
 * Statuses of a task that steps can be attached to. A task in any other status is being worked on or
 * is finished; blocking it would clear a live checkout or reopen finished work.
 */
const ATTACHABLE_TASK_STATUSES: readonly string[] = ["backlog", "todo", "blocked"];

/** Origins whose tasks belong to a routine run or a conversation and never take steps from outside. */
const UNATTACHABLE_TASK_ORIGIN_KINDS: readonly string[] = ["routine_execution", "routine_step", "chat_channel"];

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
 * @throws HttpError (404 for an unknown agent, else 422 or 409) whose message starts with the key of the first step that cannot run.
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

/**
 * Names the steps whose agent cannot take work right now (paused, waiting for approval, terminated,
 * missing, or under a manager whose chain is broken). It refuses nothing: the board is told on save and
 * on run, and the step starts once the agent is back. The rule is the one the assignment wake applies;
 * all agents of the company are read once.
 * @param defaultAssigneeAgentId The agent a step without `assigneeAgentId` runs as.
 * @returns one warning per affected step, in written order; empty when every agent can start.
 */
export async function routineStepWarnings(
  db: Db,
  companyId: string,
  steps: RoutineStep[],
  defaultAssigneeAgentId: string | null,
): Promise<RoutineStepWarning[]> {
  if (!steps.some((step) => step.assigneeAgentId ?? defaultAssigneeAgentId)) return [];
  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const agentsById = new Map(companyAgents.map((agent) => [agent.id, agent]));
  return steps.flatMap((step): RoutineStepWarning[] => {
    const agentId = step.assigneeAgentId ?? defaultAssigneeAgentId;
    if (!agentId) return [];
    const invokability = evaluateAgentInvokability(agentsById.get(agentId), companyAgents);
    return invokability.invokable
      ? []
      : [{ code: "step_agent_unavailable", stepKey: step.key, agentId, reason: invokability.reason }];
  });
}

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
        inArray(issues.status, OPEN_ISSUE_STATUSES),
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

/**
 * Asks, for each agent the steps go to, the `tasks:assign` decision under the task: the task or its
 * project can block an assignment for any actor, so a person who could not assign the steps there
 * cannot have them attached either. Manual runs ask it for the caller and event dispatch for the
 * author of the trigger.
 * @param input.defaultAssigneeAgentId The agent a step without `assigneeAgentId` runs as.
 * @throws HttpError 403 on the first assignment that is denied.
 */
export async function assertActorMayAssignSteps(input: {
  authorization: Pick<ReturnType<typeof authorizationService>, "decide">;
  actor: AuthorizationActor;
  task: { id: string; companyId: string; projectId: string | null };
  steps: RoutineStep[];
  defaultAssigneeAgentId: string | null;
}): Promise<void> {
  const { authorization, actor, task } = input;
  const assigneeAgentIds = new Set(input.steps.map((step) => step.assigneeAgentId ?? input.defaultAssigneeAgentId));
  for (const assigneeAgentId of assigneeAgentIds) {
    const scope = { projectId: task.projectId, parentIssueId: task.id, assigneeAgentId, assigneeUserId: null };
    const decision = await authorization.decide({
      actor,
      action: "tasks:assign",
      resource: { type: "issue", companyId: task.companyId, issueId: null, ...scope },
      scope,
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}

/** What the steps hang under: the root issue of a routine run. */
export interface RoutineRunRoot {
  id: string;
  companyId: string;
  responsibleUserId: string | null;
}

/**
 * Who asked for a run. The activity rows of its steps keep the system as their actor, so the activity
 * gate still leaves them out, and name the requester in `details.requestedBy`.
 */
export interface RoutineStepsRequester {
  actorType: "agent" | "user";
  actorId: string;
  runId: string | null;
}

export interface CreateRoutineRunIssuesInput<TRoot extends RoutineRunRoot> {
  /** The dispatch transaction; the root and the steps are created in one savepoint of it. */
  tx: Db;
  issueSvc: Pick<IssueService, "createChild" | "addBlockedByIssueIds">;
  /** Creates the root issue, in status `blocked`, on the savepoint it is given. */
  createRoot: (savepoint: DbTransaction) => Promise<TRoot>;
  /** The routine run that owns the steps. */
  run: { id: string };
  routine: { id: string; priority: string };
  steps: RoutineStep[];
  /** Agent for steps without `assigneeAgentId`. */
  defaultAssigneeAgentId: string | null;
  /**
   * Values for `{{variable}}` placeholders in step text. A function receives the root once it exists,
   * for values that come from it.
   */
  variables: Record<string, unknown> | ((root: TRoot) => Record<string, unknown>);
  /** Recorded on the steps' activity rows when set. */
  requestedBy?: RoutineStepsRequester | null;
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
 * Steps are created in layers: those with nothing to wait for first, then those whose predecessors are
 * all created, and so on, each layer in written order. Each waits (`blockedByIssueIds`) for the steps in its `after`,
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
  const { tx, issueSvc, createRoot, run, routine, steps, defaultAssigneeAgentId } = input;
  return tx.transaction(async (savepoint) => {
    const savepointDb = savepoint as unknown as Db;
    const root = await createRoot(savepoint);
    const variables = typeof input.variables === "function" ? input.variables(root) : input.variables;
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
            // The root waits for every step; its blockers are set once after the loop.
            blockParentUntilDone: false,
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
            ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
          },
        },
        activityPublications,
      );
    }

    // One blocker write for the root, not one per step: each write replaces all of the root's blocker
    // rows and checks the company's blockers for cycles while the issue-counter lock is held.
    await issueSvc.addBlockedByIssueIds(root.id, root.companyId, Object.values(stepIssueIds), savepoint);

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

/** A task as the attach function reads it under lock. */
export type RoutineStepTargetIssue = typeof issues.$inferSelect;

export interface AttachRoutineStepsToIssueInput {
  /** The dispatch transaction; the lock, the guards and the steps are one savepoint of it. */
  tx: Db;
  issueSvc: Pick<IssueService, "createChild" | "addBlockedByIssueIds">;
  companyId: string;
  /** The existing task the steps go under. */
  issueId: string;
  /** The routine run that owns the steps. */
  run: { id: string };
  routine: { id: string; priority: string };
  steps: RoutineStep[];
  /** Agent for steps without `assigneeAgentId`. */
  defaultAssigneeAgentId: string | null;
  /** Values for `{{variable}}` placeholders; `issue.title` and `issue.identifier` come from the task. */
  variables: Record<string, unknown>;
  /**
   * The caller's permission check on the task. It runs first under the locks, on the task row as
   * locked and before any guard that tells the state of the task, so a change that landed after the
   * caller's own read cannot slip through; throw to refuse. It reads on `executor`, the savepoint the
   * attach runs in.
   */
  authorize?: (issue: RoutineStepTargetIssue, executor: Db) => Promise<void>;
  /**
   * Runs once the guards pass and before anything is created; throw to refuse the task. It reads on
   * `executor`, the savepoint the attach runs in.
   */
  assertCanStart?: (issue: RoutineStepTargetIssue, executor: Db) => Promise<void>;
  /** Recorded on the activity rows of the task and of the steps when set; an event start has none. */
  requestedBy?: RoutineStepsRequester | null;
}

/** Whether a heartbeat run that has not finished is working on the task. */
async function hasLiveHeartbeatRun(executor: Db, companyId: string, issueId: string): Promise<boolean> {
  const rows = await executor
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Attaches the steps of a routine to a task that already exists, instead of to a new root: the task
 * waits for every step, as the root of a routine run does.
 *
 * The company's issue counter row and then the task row are locked first, in the order issue creation
 * takes them, so two attaches on one task (an event and a manual run, say) take turns and the second
 * sees the first one's steps. Under that lock a task is refused when it is
 * hidden or in another company (404), when the caller's `authorize` check refuses it, when it belongs
 * to a routine run or a conversation (422), is not in
 * backlog, todo or blocked (409), has a run in progress (409), already has routine steps in
 * progress (409), or would end up with more subtasks than a helper may create (422). A task an agent
 * owns is then set to `blocked`, so that agent does not start on it while the steps run; a task no
 * agent owns keeps its status and only gains the blocker edges. Everything is one savepoint of `tx`:
 * if a step fails, the steps are gone, the status is back and the task itself is untouched. It never
 * wakes anyone; the caller wakes `attached.startingIssues` once its own transaction commits.
 * @throws HttpError for a refused task, or the one {@link createRoutineRunIssues} names.
 */
export async function attachRoutineStepsToIssue(
  input: AttachRoutineStepsToIssueInput,
): Promise<{ root: RoutineStepTargetIssue; attached: AttachedRoutineSteps }> {
  const { tx, companyId, issueId, run, routine, steps, authorize, assertCanStart } = input;
  const rootPublications: ActivityPublication[] = [];
  const created = await createRoutineRunIssues({
    tx,
    issueSvc: input.issueSvc,
    requestedBy: input.requestedBy,
    run,
    routine,
    steps,
    defaultAssigneeAgentId: input.defaultAssigneeAgentId,
    variables: (root: RoutineStepTargetIssue) => ({
      ...input.variables,
      "issue.title": root.title,
      "issue.identifier": root.identifier ?? "",
    }),
    createRoot: async (savepoint) => {
      const savepointDb = savepoint as unknown as Db;
      // Issue creation takes the company issue counter before it locks a parent or a blocker, so the
      // attach takes the counter row first too: holding the task while it waited for the counter would
      // deadlock with a create that holds the counter and waits for the task.
      await savepoint.execute(
        sql`select ${companies.id} from ${companies} where ${companies.id} = ${companyId} for no key update`,
      );
      const locked = await savepoint
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked || locked.hiddenAt) throw notFound("Task not found");
      await authorize?.(locked, savepointDb);
      if (
        (locked.originKind && UNATTACHABLE_TASK_ORIGIN_KINDS.includes(locked.originKind)) ||
        locked.conversationAgentId
      ) {
        throw unprocessable("Routine steps cannot be attached to a routine run or a conversation");
      }
      if (!ATTACHABLE_TASK_STATUSES.includes(locked.status)) {
        throw conflict(
          `Routine steps can only be attached to a task in ${ATTACHABLE_TASK_STATUSES.join(", ")}; this task is ${locked.status}`,
          { status: locked.status },
        );
      }
      if (
        locked.checkoutRunId ||
        locked.executionRunId ||
        (await hasLiveHeartbeatRun(savepointDb, companyId, locked.id))
      ) {
        throw conflict("The task has a run in progress; attach the steps once it has finished");
      }
      if (await hasOpenRoutineSteps(savepointDb, companyId, locked.id)) {
        throw conflict("The task already has routine steps in progress");
      }
      const [{ childCount }] = await savepoint
        .select({ childCount: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.parentId, locked.id)));
      if (childCount + steps.length > MAX_CHILD_ISSUES_CREATED_BY_HELPER) {
        throw unprocessable(
          `The task has ${childCount} subtasks; adding ${steps.length} steps would pass the limit of ${MAX_CHILD_ISSUES_CREATED_BY_HELPER}`,
          { childCount, stepCount: steps.length, limit: MAX_CHILD_ISSUES_CREATED_BY_HELPER },
        );
      }
      await assertCanStart?.(locked, savepointDb);

      if (!locked.assigneeAgentId || locked.status === "blocked") return locked;
      const [blocked] = await savepoint
        .update(issues)
        .set({ status: "blocked", updatedAt: new Date() })
        .where(eq(issues.id, locked.id))
        .returning();
      await logActivity(
        savepointDb,
        {
          companyId,
          actorType: "system",
          actorId: ROUTINE_STEP_ACTOR_ID,
          action: "issue.updated",
          entityType: "issue",
          entityId: locked.id,
          details: {
            status: "blocked",
            _previous: { status: locked.status },
            routineId: routine.id,
            routineRunId: run.id,
            ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
          },
        },
        rootPublications,
      );
      return blocked ?? locked;
    },
  });
  created.attached.activityPublications.unshift(...rootPublications);
  return created;
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
 * checkout; branches woken at the same time queue on a per-run advisory lock, so exactly one takes it.
 * The step row is read by the caller, so a plain issue costs no query here.
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
        eq(issues.companyId, companyId),
        eq(issues.originKind, "routine_step"),
        // Only a step of the same run: a blocker added by hand from another run must not hand over its checkout.
        step.originRunId ? eq(issues.originRunId, step.originRunId) : undefined,
        step.projectId ? eq(issues.projectId, step.projectId) : undefined,
      ),
    )
    .orderBy(asc(issues.issueNumber), asc(issues.id));
  const open = predecessors.filter(
    ({ workspace }) => workspace.closedAt === null && !isClosedExecutionWorkspaceStatus(workspace.status),
  );
  if (open.length === 0) return false;

  // The sibling check and the update are one unit: two branches woken together would otherwise both
  // see a predecessor's workspace as free and both take it. The lock is per run, held to the end of the
  // transaction, and every read below uses the transaction, so the second branch sees the first one's claim.
  return db.transaction(async (tx) => {
    if (step.originRunId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`routine-step-workspace:${step.originRunId}`}, 0))`,
      );
    }
    const heldBySiblings = step.originRunId
      ? new Set(
          (
            await tx
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
    // An archive holds this lock until it commits, so the open check in the update sees its result.
    await acquireExecutionWorkspaceLifecycleLock(tx, predecessor.executionWorkspaceId);

    const updated = await tx
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
      .where(
        and(
          eq(issues.id, step.id),
          eq(issues.companyId, companyId),
          isNull(issues.executionWorkspaceId),
          // The workspace was read as open before the locks: it must still be open now.
          exists(
            tx
              .select({ one: sql`1` })
              .from(executionWorkspaces)
              .where(
                and(
                  eq(executionWorkspaces.id, predecessor.executionWorkspaceId),
                  isNull(executionWorkspaces.closedAt),
                  notInArray(executionWorkspaces.status, [...CLOSED_EXECUTION_WORKSPACE_STATUSES]),
                ),
              ),
          ),
        ),
      )
      .returning({ id: issues.id });
    return updated.length > 0;
  });
}

/** The run whose step conditions to apply: the root its steps hang under and the routine run that made them. */
export interface RoutineStepRunTarget {
  companyId: string;
  rootIssueId: string;
  routineRunId: string;
}

/** What one reconcile of a run's conditions changed. */
export interface RoutineStepRunReconcileResult {
  /** Steps cancelled as skipped. */
  skippedIssueIds: string[];
  /** Issues (steps or the root) whose blocker set lost a cancelled or skipped step. */
  releasedIssueIds: string[];
  /** Issues whose agent got an `issue_blockers_resolved` wake. */
  wokenIssueIds: string[];
}

export interface RoutineStepRunReconcileDeps {
  issueSvc: Pick<IssueService, "update" | "addComment" | "listDependencyReadiness">;
  heartbeat: IssueAssignmentWakeupDeps;
  /** Runs the side effects that the cancels of skipped steps queued, once the reconcile has committed. */
  executePostCommitActions: (actions: IssuePostCommitAction[]) => Promise<void>;
}

/** The `source` on the activity rows and wakes that the step conditions write. */
const ROUTINE_STEP_CONDITIONS_SOURCE = "routine_step_conditions";

const NOTHING_RECONCILED: RoutineStepRunReconcileResult = {
  skippedIssueIds: [],
  releasedIssueIds: [],
  wokenIssueIds: [],
};

type LockedIssue = Pick<typeof issues.$inferSelect, "id" | "status" | "unblockDescriptor">;

/**
 * Applies the step conditions of one routine run ({@link evaluateRoutineStepRun}): cancels the
 * blocked steps whose edges are all dead, with the comment {@link ROUTINE_STEP_SKIPPED_COMMENT}; drops
 * cancelled and skipped steps from the blocker sets that should no longer wait for them, the root's
 * too; and moves an issue whose blocker set became empty from `blocked` to `todo`. Once that has
 * committed, it wakes the agents of the issues that became ready with `issue_blockers_resolved`.
 *
 * It is idempotent: it locks the root row, then the step rows, re-reads the statuses and re-derives
 * everything from the steps the run recorded, so the post-commit action and the periodic backstop can
 * race and still give one result. It changes nothing for a run without conditions, a root that is
 * finished, or a block that a person owns (only that person may end it).
 */
export async function reconcileRoutineStepRun(
  db: Db,
  target: RoutineStepRunTarget,
  deps: RoutineStepRunReconcileDeps,
): Promise<RoutineStepRunReconcileResult> {
  const { companyId, rootIssueId, routineRunId } = target;
  const run = await db
    .select({ triggerPayload: routineRuns.triggerPayload })
    .from(routineRuns)
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  const recorded = run ? readRoutineStepsRunPayload(run.triggerPayload) : null;
  if (!recorded || !routineStepsHaveConditions(recorded.steps)) return NOTHING_RECONCILED;

  const publications: ActivityPublication[] = [];
  const queuedActions: IssuePostCommitAction[] = [];
  const changed = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const root: LockedIssue | null = await tx
      .select({ id: issues.id, status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!root || root.status === "done" || root.status === "cancelled") return null;

    const stepRows: LockedIssue[] = await tx
      .select({ id: issues.id, status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.parentId, root.id),
          eq(issues.originKind, "routine_step"),
          eq(issues.originRunId, routineRunId),
          inArray(issues.id, Object.values(recorded.stepIssueIds)),
        ),
      )
      .orderBy(asc(issues.id))
      .for("update");
    const rowById = new Map(stepRows.map((row) => [row.id, row]));
    const statusesByKey: Record<string, string> = {};
    const heldByPeople = new Set<string>();
    for (const [key, id] of Object.entries(recorded.stepIssueIds)) {
      const row = rowById.get(id);
      if (!row) continue;
      statusesByKey[key] = row.status;
      if (isHumanOwnedBlock(row)) heldByPeople.add(key);
    }
    const evaluation = evaluateRoutineStepRun(recorded.steps, statusesByKey, { heldByPeople });
    const rowOf = (key: string): LockedIssue | null => {
      const id = recorded.stepIssueIds[key];
      return (id && rowById.get(id)) || null;
    };

    const skippedIssueIds: string[] = [];
    for (const key of evaluation.skip) {
      const row = rowOf(key);
      if (!row) continue;
      await deps.issueSvc.update(row.id, { status: "cancelled" }, tx, publications, queuedActions);
      await deps.issueSvc.addComment(row.id, ROUTINE_STEP_SKIPPED_COMMENT, {}, { authorType: "system" }, tx);
      await logActivity(
        txDb,
        {
          companyId,
          actorType: "system",
          actorId: ROUTINE_STEP_ACTOR_ID,
          action: "issue.updated",
          entityType: "issue",
          entityId: row.id,
          details: {
            source: ROUTINE_STEP_CONDITIONS_SOURCE,
            status: "cancelled",
            previousStatus: row.status,
            routineStepSkipped: true,
            routineRunId,
            stepKey: key,
          },
        },
        publications,
      );
      skippedIssueIds.push(row.id);
    }

    const releases: Array<{ issue: LockedIssue; stepKey: string | null; sourceKeys: string[] }> = [
      ...Object.entries(evaluation.release).flatMap(([key, sourceKeys]) => {
        const row = rowOf(key);
        return row ? [{ issue: row, stepKey: key, sourceKeys }] : [];
      }),
      { issue: root, stepKey: null, sourceKeys: evaluation.releaseFromRoot },
    ];
    const releasedSourceById = new Map<string, string>();
    for (const { issue, stepKey, sourceKeys } of releases) {
      const sourceIds = new Set(sourceKeys.flatMap((key) => rowOf(key)?.id ?? []));
      if (sourceIds.size === 0) continue;
      const current = await tx
        .select({ blockerIssueId: issueRelations.issueId })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issueRelations.type, "blocks"),
          ),
        )
        .then((rows) => rows.map((row) => row.blockerIssueId));
      const [firstReleased] = current.filter((blockerIssueId) => sourceIds.has(blockerIssueId));
      if (!firstReleased) continue;
      const next = current.filter((blockerIssueId) => !sourceIds.has(blockerIssueId));
      const becomesTodo = next.length === 0 && issue.status === "blocked" && !isHumanOwnedBlock(issue);
      await deps.issueSvc.update(
        issue.id,
        { blockedByIssueIds: next, ...(becomesTodo ? { status: "todo" } : {}) },
        tx,
        publications,
        queuedActions,
      );
      await logActivity(
        txDb,
        {
          companyId,
          actorType: "system",
          actorId: ROUTINE_STEP_ACTOR_ID,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            source: ROUTINE_STEP_CONDITIONS_SOURCE,
            routineRunId,
            stepKey,
            blockedByIssueIds: { from: current, to: next },
            ...(becomesTodo ? { status: "todo", previousStatus: "blocked" } : {}),
          },
        },
        publications,
      );
      releasedSourceById.set(issue.id, firstReleased);
    }
    return { skippedIssueIds, releasedSourceById };
  });
  if (!changed) return NOTHING_RECONCILED;

  for (const publication of publications) {
    try {
      publishActivity(publication);
    } catch (error) {
      logger.warn({ err: error }, "failed to publish the activity of a routine step condition");
    }
  }
  // Each skipped step's cancel queued another reconcile of this run; this one already applied every change.
  const sideEffects = queuedActions.filter((action) => action.type !== "reconcile_routine_steps");
  if (sideEffects.length > 0) await deps.executePostCommitActions(sideEffects);

  const wokenIssueIds = await wakeReleasedRoutineIssues(db, companyId, changed.releasedSourceById, deps);
  return {
    skippedIssueIds: changed.skippedIssueIds,
    releasedIssueIds: [...changed.releasedSourceById.keys()],
    wokenIssueIds,
  };
}

/**
 * Wakes the agents of released issues that are now ready, the way a done blocker wakes its
 * dependents: `issue_blockers_resolved`, keyed by the ready state, so the hook, the backstop and the
 * dependency sweep never wake one twice. A wake that fails is logged and left to the dependency
 * backstop (an issue that still has blockers) or to the stranded-issue sweep (a `todo` issue).
 */
async function wakeReleasedRoutineIssues(
  db: Db,
  companyId: string,
  releasedSourceById: ReadonlyMap<string, string>,
  deps: Pick<RoutineStepRunReconcileDeps, "issueSvc" | "heartbeat">,
): Promise<string[]> {
  const issueIds = [...releasedSourceById.keys()];
  if (issueIds.length === 0) return [];
  const readiness = await deps.issueSvc.listDependencyReadiness(companyId, issueIds);
  const rows = await db
    .select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      blockedTransitionAt: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  const woken: string[] = [];
  for (const row of rows) {
    const ready = readiness.get(row.id);
    if (!row.assigneeAgentId || !ready?.isDependencyReady) continue;
    if (row.status !== "blocked" && row.status !== "todo") continue;
    const blockerIssueIds = ready.blockerIssueIds;
    const resolvedBlockerIssueId = releasedSourceById.get(row.id) ?? null;
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: row.id,
      blockerIssueIds,
      blockedTransitionAt: row.blockedTransitionAt,
    });
    try {
      const existing = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
        companyId,
        dependentIssueId: row.id,
        blockerIssueIds,
        blockedTransitionAt: row.blockedTransitionAt,
      });
      if (existing) continue;
      await deps.heartbeat.wakeup(row.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        payload: {
          issueId: row.id,
          resolvedBlockerIssueId,
          blockerIssueIds,
          mutation: ROUTINE_STEP_CONDITIONS_SOURCE,
        },
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: ROUTINE_STEP_ACTOR_ID,
        contextSnapshot: {
          issueId: row.id,
          taskId: row.id,
          wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
          source: ROUTINE_STEP_CONDITIONS_SOURCE,
          resolvedBlockerIssueId,
          blockerIssueIds,
        },
      });
      woken.push(row.id);
    } catch (error) {
      logger.warn(
        { err: error, issueId: row.id, idempotencyKey },
        "failed to wake an issue that a routine step condition released; the sweeps retry it",
      );
    }
  }
  return woken;
}

/** Most runs one pass of the periodic backstop reconciles. */
export const ROUTINE_STEP_CONDITIONS_BACKSTOP_LIMIT = 25;

/** What one pass of the step-condition backstop did. */
export interface RoutineStepConditionsBackstopResult {
  checked: number;
  skipped: number;
  released: number;
  woken: number;
  failed: number;
}

/**
 * The periodic backstop for step conditions. A step can end on a path that drops the post-commit
 * action (an update inside another transaction without a queue, or a process that stopped between
 * the commit and the action), so each pass reconciles runs that have conditions and whose root is still
 * open (a new run root or a task that the steps were attached to), at most `limit` runs per pass. A cursor on the run id moves through the rest on later passes,
 * so runs that stay blocked for good (a plain edge from a cancelled step) never starve the others.
 * Create it once per process: the cursor lives in the returned object.
 */
export function routineStepConditionsBackstop(
  db: Db,
  deps: RoutineStepRunReconcileDeps,
  options: { limit?: number } = {},
): { reconcileOpenRuns: () => Promise<RoutineStepConditionsBackstopResult> } {
  const limit = options.limit ?? ROUTINE_STEP_CONDITIONS_BACKSTOP_LIMIT;
  const root = alias(issues, "routine_step_root");
  let cursor: string | null = null;
  // `issues.origin_run_id` is text and `routine_runs.id` is a uuid. Casting the issue side keeps the lookup on
  // the primary key; the shape check means a malformed value joins nothing instead of failing every pass.
  const originRunUuid = sql<string>`(case when ${issues.originRunId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then ${issues.originRunId}::uuid end)`;

  const candidates = (after: string | null) =>
    db
      .selectDistinct({ companyId: issues.companyId, rootIssueId: issues.parentId, routineRunId: issues.originRunId })
      .from(issues)
      .innerJoin(root, and(eq(root.id, issues.parentId), eq(root.companyId, issues.companyId)))
      .innerJoin(routineRuns, and(eq(routineRuns.id, originRunUuid), eq(routineRuns.companyId, issues.companyId)))
      .where(
        and(
          eq(issues.originKind, "routine_step"),
          // The root's own origin does not matter: a task that steps were attached to keeps its origin, and
          // a task that no agent owns keeps its status, so `blocked` would miss it.
          notInArray(root.status, ["done", "cancelled"]),
          sql`jsonb_path_exists(${routineRuns.triggerPayload}, ${`$.${ROUTINE_STEPS_RUN_PAYLOAD_KEY}.steps[*].after[*].when`}::jsonpath)`,
          after ? gt(issues.originRunId, after) : undefined,
        ),
      )
      .orderBy(asc(issues.originRunId))
      .limit(limit);

  return {
    reconcileOpenRuns: async () => {
      let rows = await candidates(cursor);
      if (rows.length === 0 && cursor) {
        cursor = null;
        rows = await candidates(null);
      }
      cursor = rows.length === limit ? (rows[rows.length - 1]?.routineRunId ?? null) : null;
      const result: RoutineStepConditionsBackstopResult = { checked: 0, skipped: 0, released: 0, woken: 0, failed: 0 };
      for (const row of rows) {
        if (!row.rootIssueId || !row.routineRunId) continue;
        result.checked += 1;
        try {
          const reconciled = await reconcileRoutineStepRun(
            db,
            { companyId: row.companyId, rootIssueId: row.rootIssueId, routineRunId: row.routineRunId },
            deps,
          );
          result.skipped += reconciled.skippedIssueIds.length;
          result.released += reconciled.releasedIssueIds.length;
          result.woken += reconciled.wokenIssueIds.length;
        } catch (error) {
          result.failed += 1;
          logger.warn(
            { err: error, rootIssueId: row.rootIssueId, routineRunId: row.routineRunId },
            "routine step condition backstop failed for one run; continuing with the rest",
          );
        }
      }
      return result;
    },
  };
}
