import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routineEventGroups, routineRuns, routines, routineTriggers } from "@paperclipai/db";
import {
  DEFAULT_EVENT_GROUPING,
  eventGroupingSchema,
  renderEventGroupKey,
  type EventDryRunAction,
  type EventGrouping,
  type EventRoutineOutcome,
  type NormalizedEvent,
} from "@paperclipai/shared";
import { HttpError, conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import type { issueService } from "../issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";
import {
  decideEventGroupAction,
  eventGroupFingerprint,
  eventStormGroupKey,
  higherEventSeverity,
  type EventGroupDecision,
  type EventGroupState,
} from "./grouping.js";
import {
  renderEventDigestComment,
  renderEventIssueDescription,
  renderEventIssueTitle,
  renderEventRecoveryComment,
  renderStormIssueDescription,
  renderStormIssueTitle,
} from "./render.js";

type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;
type RoutineRunRow = typeof routineRuns.$inferSelect;
type GroupRow = typeof routineEventGroups.$inferSelect;

/** Statuses of an issue that still absorbs repeats. Mirrors the open set of `issues_open_routine_execution_uq`. */
const OPEN_GROUP_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const OUTCOME_ERROR_MAX_LENGTH = 500;

export type EventFailureClass = "permanent" | "transient";

/** A failure the dispatcher already knows the class of. */
export class EventDispatchError extends Error {
  constructor(message: string, readonly failureClass: EventFailureClass) {
    super(message);
  }
}

/**
 * Permanent failures cannot succeed on a sender retry (the agent is terminated,
 * the routine is paused, a validation rule no longer holds), so the fallback may
 * take over. Everything else (database errors, timeouts, a wake that could not
 * be enqueued) is transient: the sender must retry and nothing falls back.
 */
export function classifyEventDispatchError(err: unknown): EventFailureClass {
  if (err instanceof EventDispatchError) return err.failureClass;
  if (err instanceof HttpError && err.status >= 400 && err.status < 500) return "permanent";
  return "transient";
}

function failedOutcome(err: unknown, extra: Partial<EventRoutineOutcome> = {}): EventRoutineOutcome {
  const failureClass = classifyEventDispatchError(err);
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...extra,
    status: failureClass === "permanent" ? "failed_permanent" : "failed_transient",
    failureClass,
    error: message.slice(0, OUTCOME_ERROR_MAX_LENGTH),
  };
}

export interface EventDispatchDeps {
  db: Db;
  issueSvc: ReturnType<typeof issueService>;
  heartbeat: IssueAssignmentWakeupDeps;
  finalizeRun(runId: string, patch: Partial<typeof routineRuns.$inferInsert>, executor: Db): Promise<RoutineRunRow | null>;
  updateRoutineTouchedState(
    input: { routineId: string; triggerId?: string | null; triggeredAt: Date; status: string; issueId?: string | null },
    executor: Db,
  ): Promise<void>;
  /**
   * Re-validates that the routine can take event work right now and returns what
   * dispatch needs. Throws a classified error (permanent for a terminated agent,
   * a plugin-managed routine, required variables without defaults).
   */
  prepareRoutine(routine: RoutineRow): Promise<{ assigneeAgentId: string; routineDescription: string | null }>;
  resolveResponsibleUserId(executor: Db, routine: RoutineRow): Promise<string | null>;
}

export interface EventDispatchInput {
  routine: RoutineRow;
  /** The oldest matching trigger of the routine; its grouping config applies. */
  trigger: RoutineTriggerRow;
  event: NormalizedEvent;
  deliveryId: string | null;
  /** Atomically takes one of the source's new-issues-per-hour slots; false means the budget is spent. */
  consumeStormSlot: () => Promise<boolean>;
  now?: Date;
}

interface OpenGroup {
  group: GroupRow;
  issueStatus: string;
  issueAssigneeAgentId: string | null;
}

function groupState(group: GroupRow): EventGroupState {
  return {
    firstSeenAt: group.firstSeenAt,
    lastCommentAt: group.lastCommentAt,
    lastSeverity: group.lastSeverity as EventGroupState["lastSeverity"],
    lastState: group.lastState as EventGroupState["lastState"],
    repeatCount: group.repeatCount,
  };
}

function parseGrouping(stored: unknown): EventGrouping {
  const parsed = eventGroupingSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : DEFAULT_EVENT_GROUPING;
}

/**
 * The open group issue for a routine and fingerprint. More than one can qualify
 * (rows are unique per issue, not per fingerprint), so this never assumes
 * uniqueness: the oldest open one wins.
 */
async function findOpenGroup(
  executor: Db,
  routine: RoutineRow,
  fingerprint: string,
  onlyIssueId: string | null,
): Promise<OpenGroup | null> {
  const rows = await executor
    .select({
      group: routineEventGroups,
      issueStatus: issues.status,
      issueAssigneeAgentId: issues.assigneeAgentId,
    })
    .from(routineEventGroups)
    .innerJoin(issues, eq(issues.id, routineEventGroups.issueId))
    .where(
      and(
        eq(routineEventGroups.companyId, routine.companyId),
        eq(routineEventGroups.routineId, routine.id),
        eq(routineEventGroups.fingerprint, fingerprint),
        isNull(issues.hiddenAt),
        inArray(issues.status, OPEN_GROUP_ISSUE_STATUSES),
        onlyIssueId ? eq(routineEventGroups.issueId, onlyIssueId) : undefined,
      ),
    )
    .orderBy(asc(routineEventGroups.firstSeenAt), asc(routineEventGroups.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `appendToIssueId` is honoured only while the target is in the routine's
 * company, open, visible and still assigned to the routine's agent. A trigger
 * therefore can never push alerts onto somebody else's issue.
 */
async function loadAppendTarget(
  executor: Db,
  routine: RoutineRow,
  issueId: string,
): Promise<{ id: string; assigneeAgentId: string | null; status: string } | null> {
  if (!routine.assigneeAgentId) return null;
  const rows = await executor
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.companyId, routine.companyId),
        eq(issues.assigneeAgentId, routine.assigneeAgentId),
        isNull(issues.hiddenAt),
        inArray(issues.status, OPEN_GROUP_ISSUE_STATUSES),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function createEventRoutineDispatcher(deps: EventDispatchDeps) {
  const { db, issueSvc, heartbeat } = deps;

  async function currentIssue(executor: Db, issueId: string) {
    return executor
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  function isOpenIssue(row: { status: string; hiddenAt: Date | null } | null): boolean {
    return !!row && row.hiddenAt === null && OPEN_GROUP_ISSUE_STATUSES.includes(row.status);
  }

  /** Wakes the issue's current agent assignee for a new comment. */
  async function wakeForComment(issueId: string, commentId: string, current: { status: string; assigneeAgentId: string | null }) {
    await queueIssueAssignmentWakeup({
      heartbeat,
      assignmentEvent: false,
      issue: { id: issueId, assigneeAgentId: current.assigneeAgentId, status: current.status },
      reason: "issue_commented",
      mutation: "comment",
      contextSource: "routine.event",
      wakeCommentId: commentId,
      requestedByActorType: "system",
      requestedByActorId: "event-source",
      rethrowOnError: true,
      wakeupOptions: {
        source: "automation",
        payload: { commentId },
        contextSnapshot: { taskId: issueId, commentId, wakeReason: "issue_commented" },
      },
    });
  }

  async function dispatch(input: EventDispatchInput): Promise<EventRoutineOutcome> {
    try {
      return await dispatchUnsafe(input);
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, deliveryId: input.deliveryId }, "event dispatch failed");
      return failedOutcome(err);
    }
  }

  async function dispatchUnsafe(input: EventDispatchInput): Promise<EventRoutineOutcome> {
    const { routine, trigger, event } = input;
    const now = input.now ?? new Date();
    const prepared = await deps.prepareRoutine(routine);
    const grouping = parseGrouping(trigger.eventGrouping);
    const primaryFingerprint = eventGroupFingerprint(renderEventGroupKey(grouping.groupKey, event));
    const appendTargetId = typeof grouping.issueMode === "object" ? grouping.issueMode.appendToIssueId : null;

    // The storm budget is taken before the transaction: the counter is its own
    // short statement, so the event_sources row is never locked while an issue
    // is being created. It is only needed when this event would open a new group.
    let stormFold = false;
    if (event.state !== "recovery") {
      const appendTarget = appendTargetId ? await loadAppendTarget(db, routine, appendTargetId) : null;
      const existing = await findOpenGroup(db, routine, primaryFingerprint, appendTarget?.id ?? null);
      // Append mode is not exempt: every new group there is a comment and a wake on a standing issue.
      if (!existing) stormFold = !(await input.consumeStormSlot());
    }

    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${routine.id} and ${routines.companyId} = ${routine.companyId} for update`,
      );

      // Under the lock, as `dispatchRoutineRun` does: the trigger and routine may have changed since matching.
      const currentTrigger = await txDb.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)).then((rows) => rows[0]);
      const currentRoutine = await txDb.select({ status: routines.status }).from(routines).where(eq(routines.id, routine.id)).then((rows) => rows[0]);
      if (!currentTrigger || currentTrigger.archived || !currentTrigger.enabled || currentTrigger.setupPending || currentRoutine?.status !== "active") {
        throw conflict("Routine trigger is not active");
      }

      // A re-claimed delivery must not comment or wake twice on a routine that already succeeded.
      if (input.deliveryId) {
        const done = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.eventDeliveryId, input.deliveryId),
              eq(routineRuns.routineId, routine.id),
              inArray(routineRuns.status, ["issue_created", "grouped", "recovered"]),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (done) {
          return {
            status: done.status as EventRoutineOutcome["status"],
            runId: done.id,
            issueId: done.linkedIssueId,
          } satisfies EventRoutineOutcome;
        }
      }

      let note: string | null = null;
      let appendTarget: Awaited<ReturnType<typeof loadAppendTarget>> = null;
      if (appendTargetId) {
        appendTarget = await loadAppendTarget(txDb, routine, appendTargetId);
        if (!appendTarget) note = "append_target_unavailable";
      }

      let effectiveGrouping = grouping;
      let fingerprint = primaryFingerprint;
      let storm = false;
      let open = await findOpenGroup(txDb, routine, fingerprint, appendTarget?.id ?? null);
      if (!open && stormFold && event.state !== "recovery") {
        // Folded into this routine's own storm group, never another agent's. An append target is left alone.
        storm = true;
        appendTarget = null;
        fingerprint = eventGroupFingerprint(eventStormGroupKey(event.source));
        effectiveGrouping = { ...grouping, rewakeOnSeverityIncrease: false, issueMode: "group" };
        open = await findOpenGroup(txDb, routine, fingerprint, null);
      }

      const decision: EventGroupDecision = decideEventGroupAction({
        event,
        grouping: effectiveGrouping,
        group: open ? groupState(open.group) : null,
        now,
      });
      const stampOutcome = <T extends EventRoutineOutcome>(outcome: T): T => (note ? { ...outcome, note } : outcome);

      if (decision.kind === "recovery_without_issue") return stampOutcome({ status: "recovery_without_issue" });
      if (decision.kind === "recovery_ignored") {
        return stampOutcome({ status: "recovery_ignored", issueId: open?.group.issueId ?? null });
      }
      if (decision.kind === "silent" && open) {
        await txDb
          .update(routineEventGroups)
          .set({
            repeatCount: sql`${routineEventGroups.repeatCount} + 1`,
            lastSeenAt: now,
            lastSeverity: higherEventSeverity(open.group.lastSeverity as EventGroupState["lastSeverity"], event.severity),
            lastState: event.state,
          })
          .where(eq(routineEventGroups.id, open.group.id));
        return stampOutcome({ status: storm ? "storm_folded" : "grouped_silent", issueId: open.group.issueId });
      }

      const responsibleUserId = await deps.resolveResponsibleUserId(txDb, routine);
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: routine.companyId,
          routineId: routine.id,
          triggerId: trigger.id,
          source: "event",
          status: "received",
          triggeredAt: now,
          eventDeliveryId: input.deliveryId,
          triggerPayload: { event, groupFingerprint: fingerprint, ...(storm ? { stormFolded: true } : {}) },
          dispatchFingerprint: fingerprint,
          routineRevisionId: routine.latestRevisionId,
          responsibleUserId,
        })
        .returning();

      let createdIssueId: string | null = null;
      try {
        // A repeat that earns a comment, or a recovery: post to the open group issue.
        if (open && (decision.kind === "comment" || decision.kind === "recovery_comment")) {
          const wake = decision.kind === "comment" ? true : decision.wake;
          const body = decision.kind === "comment"
            ? renderEventDigestComment({
              kind: storm ? "storm" : decision.reason === "cooldown_elapsed" ? "repeat" : decision.reason,
              event,
              repeatCount: open.group.repeatCount,
              severityIncreasedFrom: decision.severityIncreasedFrom,
            })
            : renderEventRecoveryComment({ event, wake });
          const comment = await issueSvc.addComment(open.group.issueId, body, {}, { authorType: "system" });
          // Re-read after the comment: the issue may have closed meanwhile, and an event never reopens one.
          const current = await currentIssue(txDb, open.group.issueId);
          if (isOpenIssue(current)) {
            if (wake && current) await wakeForComment(open.group.issueId, comment.id, current);
            await txDb
              .update(routineEventGroups)
              .set({
                repeatCount: 0,
                lastSeenAt: now,
                lastCommentAt: now,
                lastSeverity: event.state === "recovery" ? open.group.lastSeverity : event.severity,
                lastState: event.state,
              })
              .where(eq(routineEventGroups.id, open.group.id));
            const status = decision.kind === "comment" ? "grouped" : "recovered";
            await deps.finalizeRun(createdRun.id, { status, linkedIssueId: open.group.issueId, completedAt: now }, txDb);
            await deps.updateRoutineTouchedState(
              { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status, issueId: open.group.issueId },
              txDb,
            );
            return stampOutcome({
              status: storm ? "storm_folded" : status,
              runId: createdRun.id,
              issueId: open.group.issueId,
            });
          }
          if (decision.kind === "recovery_comment") {
            // Closed while the comment was posted: nothing left to wake.
            await deps.finalizeRun(
              createdRun.id,
              { status: "recovered", linkedIssueId: open.group.issueId, completedAt: now },
              txDb,
            );
            await deps.updateRoutineTouchedState(
              { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status: "recovered", issueId: open.group.issueId },
              txDb,
            );
            return stampOutcome({ status: "recovered", runId: createdRun.id, issueId: open.group.issueId });
          }
          // A problem that raced a close: fall through to the no-open-issue path, which wakes once, on a new issue.
          open = null;
          if (appendTarget) {
            appendTarget = null;
            note = "append_target_unavailable";
          }
        }

        // Append mode: the first alert of a new group is a comment on the configured issue.
        if (!open && appendTarget) {
          const comment = await issueSvc.addComment(
            appendTarget.id,
            renderEventDigestComment({ kind: "new", event }),
            {},
            { authorType: "system" },
          );
          const current = await currentIssue(txDb, appendTarget.id);
          if (isOpenIssue(current)) {
            if (current) await wakeForComment(appendTarget.id, comment.id, current);
            await txDb.insert(routineEventGroups).values({
              companyId: routine.companyId,
              routineId: routine.id,
              fingerprint,
              issueId: appendTarget.id,
              firstSeenAt: now,
              lastSeenAt: now,
              lastCommentAt: now,
              repeatCount: 0,
              lastSeverity: event.severity,
              lastState: event.state,
            });
            await deps.finalizeRun(
              createdRun.id,
              { status: "grouped", linkedIssueId: appendTarget.id, completedAt: now },
              txDb,
            );
            await deps.updateRoutineTouchedState(
              { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status: "grouped", issueId: appendTarget.id },
              txDb,
            );
            return stampOutcome({ status: "grouped", runId: createdRun.id, issueId: appendTarget.id });
          }
          note = "append_target_unavailable";
        }

        // No open group issue: open one and wake its assignee.
        const created = await issueSvc.create(routine.companyId, {
          projectId: routine.projectId,
          goalId: routine.goalId,
          parentId: routine.parentIssueId,
          title: storm ? renderStormIssueTitle(event.source) : renderEventIssueTitle(event),
          description: storm
            ? renderStormIssueDescription(prepared.routineDescription, event.source, event)
            : renderEventIssueDescription(prepared.routineDescription, event),
          status: "todo",
          priority: routine.priority,
          assigneeAgentId: prepared.assigneeAgentId,
          responsibleUserId,
          trustExplicitResponsibleUserId: true,
          originKind: "routine_execution",
          originId: routine.id,
          originRunId: createdRun.id,
          originFingerprint: fingerprint,
        });
        createdIssueId = created.id;
        await txDb.insert(routineEventGroups).values({
          companyId: routine.companyId,
          routineId: routine.id,
          fingerprint,
          issueId: created.id,
          firstSeenAt: now,
          lastSeenAt: now,
          lastCommentAt: now,
          repeatCount: 0,
          lastSeverity: event.severity,
          lastState: event.state,
        });
        // Keep the routine lock until the issue is linked to a queued heartbeat run.
        await queueIssueAssignmentWakeup({
          heartbeat,
          assignmentEvent: true,
          issue: created,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "routine.event",
          requestedByActorType: "system",
          rethrowOnError: true,
        });
        await deps.finalizeRun(createdRun.id, { status: "issue_created", linkedIssueId: created.id }, txDb);
        await deps.updateRoutineTouchedState(
          { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status: "issue_created", issueId: created.id },
          txDb,
        );
        return stampOutcome({ status: storm ? "storm_folded" : "issue_created", runId: createdRun.id, issueId: created.id });
      } catch (err) {
        if (createdIssueId) {
          // The group row cascades with the issue.
          await txDb.delete(issues).where(eq(issues.id, createdIssueId));
        }
        const failure = failedOutcome(err, { runId: createdRun.id });
        await deps.finalizeRun(
          createdRun.id,
          { status: "failed", failureReason: failure.error ?? "Event dispatch failed", completedAt: new Date() },
          txDb,
        );
        await deps.updateRoutineTouchedState(
          { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status: "failed" },
          txDb,
        );
        return stampOutcome(failure);
      }
    });
  }

  return { dispatch };
}

/**
 * What `dispatch` would do for this routine and event, read-only. Mirrors the
 * dispatcher's lookups and decision, writes nothing and consumes no storm slot:
 * `stormBudgetSpent` is the caller's read of the source counter.
 */
export async function previewEventRoutine(
  db: Db,
  input: {
    routine: RoutineRow;
    trigger: RoutineTriggerRow;
    event: NormalizedEvent;
    stormBudgetSpent: boolean;
    now?: Date;
  },
): Promise<{ groupKey: string; action: EventDryRunAction; issueId: string | null }> {
  const { routine, trigger, event } = input;
  const grouping = parseGrouping(trigger.eventGrouping);
  let groupKey = renderEventGroupKey(grouping.groupKey, event);
  const appendTargetId = typeof grouping.issueMode === "object" ? grouping.issueMode.appendToIssueId : null;
  const appendTarget = appendTargetId ? await loadAppendTarget(db, routine, appendTargetId) : null;
  let open = await findOpenGroup(db, routine, eventGroupFingerprint(groupKey), appendTarget?.id ?? null);
  let effectiveGrouping = grouping;
  const storm = !open && !appendTarget && event.state !== "recovery" && input.stormBudgetSpent;
  if (storm) {
    groupKey = eventStormGroupKey(event.source);
    effectiveGrouping = { ...grouping, rewakeOnSeverityIncrease: false, issueMode: "group" };
    open = await findOpenGroup(db, routine, eventGroupFingerprint(groupKey), null);
  }
  const decision = decideEventGroupAction({
    event,
    grouping: effectiveGrouping,
    group: open ? groupState(open.group) : null,
    now: input.now ?? new Date(),
  });
  const issueId = open?.group.issueId ?? appendTarget?.id ?? null;
  switch (decision.kind) {
    case "recovery_without_issue":
      return { groupKey, action: "recovery_without_issue", issueId: null };
    case "recovery_ignored":
      return { groupKey, action: "recovery_ignored", issueId };
    case "recovery_comment":
      return { groupKey, action: "recovery_comment", issueId };
    case "silent":
      return { groupKey, action: storm ? "storm_folded" : "silent", issueId };
    case "comment":
      return { groupKey, action: storm ? "storm_folded" : "comment_and_wake", issueId };
    default:
      return {
        groupKey,
        action: storm ? "storm_folded" : appendTarget ? "comment_and_wake" : "new_issue",
        issueId,
      };
  }
}
