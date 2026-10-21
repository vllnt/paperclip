import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routineRuns } from "@paperclipai/db";
import {
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  countRoutineStepSendBackRounds,
  readRoutineStepsRunPayload,
  routineStepMaxSendBacks,
  routineStepSendBackLoopKeys,
  type IssueComment,
  type RoutineStepSendBack,
  type RoutineStepSendBackResult,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "./issues.js";

/** Statuses a step may send its work back from: it is being worked on or waits. */
const SENDABLE_STEP_STATUSES: readonly string[] = ["todo", "in_progress", "blocked"];

type IssueRow = typeof issues.$inferSelect;

/** Who sends the work back: the sending step's agent, from its run, or a board user. */
export type RoutineStepSendBackActor =
  | { actorType: "agent"; agentId: string; runId: string | null }
  | { actorType: "user"; userId: string };

export interface SendBackRoutineStepInput {
  companyId: string;
  /** The step that sends its work back. */
  issueId: string;
  toStepKey: string;
  comment: string;
  actor: RoutineStepSendBackActor;
}

export interface RoutineStepSendBackOutcome {
  result: RoutineStepSendBackResult;
  /** The target when the work was sent back, the sending step when the cap refused. */
  issue: IssueRow;
  comment: IssueComment;
}

function actorFields(actor: RoutineStepSendBackActor) {
  return actor.actorType === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId }
    : { actorType: "user" as const, actorId: actor.userId, agentId: null, runId: null };
}

function updateActor(actor: RoutineStepSendBackActor) {
  return actor.actorType === "agent"
    ? { actorAgentId: actor.agentId, actorRunId: actor.runId }
    : { actorUserId: actor.userId };
}

function commentAuthor(actor: RoutineStepSendBackActor) {
  return actor.actorType === "agent"
    ? { author: { agentId: actor.agentId, runId: actor.runId }, options: {} }
    : { author: { userId: actor.userId, runId: null }, options: { authorType: "user" as const } };
}

/** The board-facing text of the block a capped send-back leaves on the sending step. */
export function routineStepSendBackCapAction(fromStepKey: string, toStepKey: string, maxSendBacks: number): string {
  return `"${fromStepKey}" reached its limit of ${maxSendBacks} send-backs to "${toStepKey}". Send it back again, finish "${fromStepKey}", or cancel the run.`;
}

/**
 * Sends the work of a routine step back to an earlier step of the same run.
 *
 * In one transaction, holding the routine run row and then the rows of the loop in id order: the
 * target goes from `done` to `todo` with its assignee kept, and every other step of the loop
 * ({@link routineStepSendBackLoopKeys}), the sender included, goes to `blocked` with a new blocked
 * cycle, so each wakes again through `issue_blockers_resolved` when its blockers are done again.
 * Execution state is cleared on all of them, so their review stages run again. The comment is posted
 * on the target and the send-back is recorded on the run. It wakes nobody: the caller wakes the
 * target's agent once this has committed.
 *
 * When an agent has used up the edge's rounds, nothing is sent back. The sending step is set to a
 * board-owned block instead, the comment is posted on it, and the outcome is `cap_reached`; the caller
 * answers 409. A board send-back is never capped and resets the edge's count.
 * @throws HttpError 404, 422, 403 or 409 for a refused send-back; nothing is written then.
 */
export async function sendBackRoutineStep(db: Db, input: SendBackRoutineStepInput): Promise<RoutineStepSendBackOutcome> {
  const svc = issueService(db);
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const activityActor = actorFields(input.actor);
  const { author, options: commentOptions } = commentAuthor(input.actor);

  const outcome = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const sender = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!sender || sender.hiddenAt) throw notFound("Issue not found");
    if (sender.originKind !== "routine_step" || !sender.originRunId || !sender.parentId) {
      throw unprocessable("Only a step of a routine run can send its work back");
    }
    const run = await tx
      .select()
      .from(routineRuns)
      .where(and(eq(routineRuns.id, sender.originRunId), eq(routineRuns.companyId, input.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    const recorded = run ? readRoutineStepsRunPayload(run.triggerPayload) : null;
    const fromStepKey = recorded
      ? Object.entries(recorded.stepIssueIds).find(([, issueId]) => issueId === sender.id)?.[0]
      : undefined;
    const fromStep = fromStepKey ? recorded?.steps.find((step) => step.key === fromStepKey) : undefined;
    if (!run || !recorded || !fromStepKey || !fromStep) {
      throw unprocessable("Only a step of a routine run can send its work back");
    }
    const { toStepKey } = input;
    const sendBackTo = fromStep.sendBackTo ?? [];
    const toIssueId = recorded.stepIssueIds[toStepKey];
    if (!sendBackTo.includes(toStepKey) || !toIssueId) {
      throw unprocessable(
        sendBackTo.length > 0
          ? `Step "${fromStepKey}" can send work back to ${sendBackTo.map((key) => `"${key}"`).join(", ")}, not to "${toStepKey}"`
          : `Step "${fromStepKey}" cannot send work back; its routine names no sendBackTo for it`,
        { fromStepKey, toStepKey, sendBackTo },
      );
    }
    if (input.actor.actorType === "agent" && sender.assigneeAgentId !== input.actor.agentId) {
      throw forbidden("Only the agent of this step can send its work back", {
        issueId: sender.id,
        assigneeAgentId: sender.assigneeAgentId,
        actorAgentId: input.actor.agentId,
      });
    }

    const loopKeys = routineStepSendBackLoopKeys(recorded.steps, fromStepKey, toStepKey);
    const loopIssueIds = loopKeys.flatMap((key) => {
      const issueId = recorded.stepIssueIds[key];
      return issueId ? [issueId] : [];
    });
    const locked = await tx
      .select()
      .from(issues)
      .where(
        and(eq(issues.companyId, input.companyId), inArray(issues.id, [sender.parentId, toIssueId, ...loopIssueIds])),
      )
      .orderBy(asc(issues.id))
      .for("update");
    const byId = new Map(locked.map((row) => [row.id, row]));
    const root = byId.get(sender.parentId);
    const lockedSender = byId.get(sender.id);
    const target = byId.get(toIssueId);
    if (!root || root.status === "done" || root.status === "cancelled") {
      throw conflict("The run of this step is closed", { rootIssueId: sender.parentId, status: root?.status ?? null });
    }
    if (!lockedSender || !SENDABLE_STEP_STATUSES.includes(lockedSender.status)) {
      throw conflict(
        `Step "${fromStepKey}" is ${lockedSender?.status ?? "gone"}; a step sends work back while it is ${SENDABLE_STEP_STATUSES.join(", ")}`,
        { stepKey: fromStepKey, status: lockedSender?.status ?? null },
      );
    }
    for (const key of [toStepKey, ...loopKeys.filter((key) => key !== fromStepKey)]) {
      const status = byId.get(recorded.stepIssueIds[key] ?? "")?.status ?? null;
      if (status !== "done") {
        throw conflict(`Step "${key}" is ${status ?? "gone"}; work can only be sent back over finished steps`, {
          stepKey: key,
          status,
        });
      }
    }
    if (!target) throw conflict(`Step "${toStepKey}" is gone`, { stepKey: toStepKey });

    const maxSendBacks = routineStepMaxSendBacks(fromStep);
    const priorRounds = countRoutineStepSendBackRounds(recorded.sendBacks, fromStepKey, toStepKey);
    const capReached = input.actor.actorType === "agent" && priorRounds >= maxSendBacks;
    const at = new Date();

    const record = async (outcome: RoutineStepSendBack["outcome"], commentId: string) => {
      const entry: RoutineStepSendBack = {
        fromStepKey,
        toStepKey,
        actorType: activityActor.actorType,
        actorId: activityActor.actorId,
        commentId,
        at: at.toISOString(),
        outcome,
      };
      await tx
        .update(routineRuns)
        .set({
          triggerPayload: sql`jsonb_set(${routineRuns.triggerPayload}, ${`{${ROUTINE_STEPS_RUN_PAYLOAD_KEY},sendBacks}`}::text[], ${JSON.stringify([...recorded.sendBacks, entry])}::jsonb, true)`,
          updatedAt: at,
        })
        .where(eq(routineRuns.id, run.id));
    };
    const commentOn = async (issueId: string) => {
      const comment = await svc.addComment(issueId, input.comment, author, commentOptions, tx);
      await logActivity(
        txDb,
        {
          companyId: input.companyId,
          ...activityActor,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: issueId,
          issueId,
          details: { commentId: comment.id, source: "routine_step_send_back" },
        },
        publications,
      );
      return comment;
    };
    const baseDetails = {
      routineId: run.routineId,
      routineRunId: run.id,
      fromStepKey,
      toStepKey,
      fromIssueId: sender.id,
      toIssueId,
      maxSendBacks,
    };

    if (capReached) {
      const comment = await commentOn(lockedSender.id);
      const blocked = await svc.update(
        lockedSender.id,
        {
          status: "blocked",
          unblockDescriptor: { owner: "board", action: routineStepSendBackCapAction(fromStepKey, toStepKey, maxSendBacks) },
          companyGuard: input.companyId,
          ...updateActor(input.actor),
        },
        tx,
        publications,
        postCommitActions,
      );
      if (!blocked) throw notFound("Issue not found");
      await record("cap_reached", comment.id);
      await logActivity(
        txDb,
        {
          companyId: input.companyId,
          ...activityActor,
          action: "issue.routine_step_send_back_capped",
          entityType: "issue",
          entityId: lockedSender.id,
          issueId: lockedSender.id,
          details: { ...baseDetails, rounds: priorRounds, commentId: comment.id, _previous: { status: lockedSender.status } },
        },
        publications,
      );
      const result: RoutineStepSendBackResult = {
        outcome: "cap_reached",
        ...baseDetails,
        rounds: priorRounds,
        reblockedIssueIds: [],
        commentId: comment.id,
      };
      return { result, issue: blocked, comment };
    }

    const comment = await commentOn(target.id);
    const reopened = await svc.update(
      target.id,
      { status: "todo", executionState: null, companyGuard: input.companyId, ...updateActor(input.actor) },
      tx,
      publications,
      postCommitActions,
    );
    if (!reopened) throw notFound("Issue not found");
    await logActivity(
      txDb,
      {
        companyId: input.companyId,
        ...activityActor,
        action: "issue.updated",
        entityType: "issue",
        entityId: target.id,
        issueId: target.id,
        details: { status: "todo", _previous: { status: target.status }, source: "routine_step_send_back", ...baseDetails },
      },
      publications,
    );
    const reblockedIssueIds: string[] = [];
    for (const issueId of loopIssueIds) {
      const before = byId.get(issueId);
      if (!before) continue;
      const updated = await svc.update(
        issueId,
        {
          status: "blocked",
          blockedTransitionAt: at,
          unblockDescriptor: null,
          executionState: null,
          companyGuard: input.companyId,
          ...updateActor(input.actor),
        },
        tx,
        publications,
        postCommitActions,
      );
      if (!updated) throw notFound("Issue not found");
      reblockedIssueIds.push(issueId);
      await logActivity(
        txDb,
        {
          companyId: input.companyId,
          ...activityActor,
          action: "issue.updated",
          entityType: "issue",
          entityId: issueId,
          issueId,
          details: { status: "blocked", _previous: { status: before.status }, source: "routine_step_send_back", ...baseDetails },
        },
        publications,
      );
    }
    await record("sent_back", comment.id);
    // A board send-back resets the edge, as countRoutineStepSendBackRounds reads it.
    const rounds = input.actor.actorType === "agent" ? priorRounds + 1 : 0;
    await logActivity(
      txDb,
      {
        companyId: input.companyId,
        ...activityActor,
        action: "issue.routine_step_sent_back",
        entityType: "issue",
        entityId: sender.id,
        issueId: sender.id,
        details: { ...baseDetails, rounds, reblockedIssueIds, commentId: comment.id },
      },
      publications,
    );
    const result: RoutineStepSendBackResult = {
      outcome: "sent_back",
      ...baseDetails,
      rounds,
      reblockedIssueIds,
      commentId: comment.id,
    };
    return { result, issue: reopened, comment };
  });

  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  return outcome;
}
