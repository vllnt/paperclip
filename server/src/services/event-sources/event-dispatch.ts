import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routineEventGroups, routineRuns, routines, routineTriggers } from "@paperclipai/db";
import {
  DEFAULT_EVENT_GROUPING,
  ROUTINE_GATE_SKIP_REASON,
  ROUTINE_GATE_TRIGGER_INACTIVE_REASON,
  eventGroupingSchema,
  renderEventGroupKey,
  type EventDryRunAction,
  type EventGrouping,
  type EventRoutineOutcome,
  type NormalizedEvent,
  type RoutineGateResult,
} from "@paperclipai/shared";
import { HttpError, conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import type { issueService } from "../issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";
import {
  renderGateDecisionBlock,
  type GateDecision,
  type GateEventDispatchInput,
} from "../routine-gates/outcome.js";
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
  /** Whether the routine has a gate script that applies to event triggers. */
  gateApplies?(routine: RoutineRow): boolean;
  /** Called after a run was parked as `gating`, so the gate worker can pick it up. */
  onGating?(runId: string): void;
}

/** What the gate worker hands back to commit a run it parked: the same row is finalized. */
export interface EventGatedCommit {
  runId: string;
  gateResult: RoutineGateResult | null;
  decision: GateDecision;
}

export interface EventDispatchInput {
  routine: RoutineRow;
  /** The oldest matching trigger of the routine; its grouping config applies. */
  trigger: RoutineTriggerRow;
  event: NormalizedEvent;
  deliveryId: string | null;
  /** Atomically takes one of the source's new-issues-per-hour slots; false means the budget is spent. */
  consumeStormSlot: () => Promise<boolean>;
  /** Gives back the slot taken by this dispatch, when the group it was for never opened. */
  releaseStormSlot?: () => Promise<void>;
  now?: Date;
  /** Set only when the gate worker commits a parked run. */
  gated?: EventGatedCommit;
}

/**
 * A comment the event path already posted to an issue. It is written to the run
 * right after the comment commits, so a sender retry after a failed wake wakes
 * for this comment instead of posting it again.
 */
interface PostedComment {
  commentId: string;
  issueId: string;
  kind: "comment" | "recovery" | "append";
  wake: boolean;
  storm: boolean;
  fingerprint: string;
}

function readPostedComment(payload: unknown): PostedComment | null {
  const posted = (payload as { postedComment?: Partial<PostedComment> } | null)?.postedComment;
  if (
    !posted ||
    typeof posted.commentId !== "string" ||
    typeof posted.issueId !== "string" ||
    typeof posted.fingerprint !== "string" ||
    (posted.kind !== "comment" && posted.kind !== "recovery" && posted.kind !== "append")
  ) {
    return null;
  }
  return {
    commentId: posted.commentId,
    issueId: posted.issueId,
    kind: posted.kind,
    wake: posted.wake !== false,
    storm: posted.storm === true,
    fingerprint: posted.fingerprint,
  };
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
    // Set once this dispatch holds one of the source's new-issue slots.
    const slot = { taken: false };
    let outcome: EventRoutineOutcome;
    try {
      outcome = await dispatchUnsafe(input, slot);
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, deliveryId: input.deliveryId }, "event dispatch failed");
      outcome = failedOutcome(err);
    }
    // The slot pays for a new group. A dispatch that failed opened none, and its retry takes a slot of its own.
    if (slot.taken && (outcome.status === "failed_transient" || outcome.status === "failed_permanent")) {
      await Promise.resolve(input.releaseStormSlot?.()).catch((err) =>
        logger.warn({ err, routineId: input.routine.id }, "failed to release event storm slot"),
      );
    }
    return outcome;
  }

  async function releaseSlotFor(input: EventDispatchInput, slot: { taken: boolean }) {
    if (!slot.taken) return;
    await Promise.resolve(input.releaseStormSlot?.()).catch((err) =>
      logger.warn({ err, routineId: input.routine.id }, "failed to release event storm slot"),
    );
  }

  /**
   * Commits a run the gate worker parked. Unlike `dispatch`, a transient failure is thrown so the
   * worker retries the claim (the row stays `gating`); a permanent one ends the parked row as
   * `failed` and is returned, so the caller can fire the source's fallback.
   */
  async function commitGated(input: EventDispatchInput & { gated: EventGatedCommit }): Promise<EventRoutineOutcome> {
    const slot = { taken: false };
    try {
      const outcome = await dispatchUnsafe(input, slot);
      if (outcome.status === "failed_transient" || outcome.status === "failed_permanent") await releaseSlotFor(input, slot);
      return outcome;
    } catch (err) {
      // The slot pays for a group that opened; this attempt opened none, and the retry takes its own.
      await releaseSlotFor(input, slot);
      if (classifyEventDispatchError(err) !== "permanent") throw err;
      const outcome = failedOutcome(err, { runId: input.gated.runId });
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
        );
        const row = await txDb
          .select({ id: routineRuns.id })
          .from(routineRuns)
          .where(and(eq(routineRuns.id, input.gated.runId), eq(routineRuns.status, "gating")))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) return;
        await deps.finalizeRun(
          row.id,
          {
            status: "failed",
            failureReason: outcome.error ?? "Event dispatch failed",
            completedAt: new Date(),
            gateResult: input.gated.gateResult,
            gateResultFingerprint: input.gated.gateResult?.resultFingerprint ?? null,
            gateDispatchInput: null,
          },
          txDb,
        );
      });
      return outcome;
    }
  }

  /** The latest failed attempt of this delivery on this routine that had already posted its comment. */
  async function findPostedComment(executor: Db, deliveryId: string, routineId: string): Promise<PostedComment | null> {
    const rows = await executor
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.eventDeliveryId, deliveryId),
          eq(routineRuns.routineId, routineId),
          eq(routineRuns.status, "failed"),
          sql`${routineRuns.triggerPayload} -> 'postedComment' is not null`,
        ),
      )
      .orderBy(desc(routineRuns.createdAt))
      .limit(1);
    return readPostedComment(rows[0]?.triggerPayload);
  }

  async function dispatchUnsafe(input: EventDispatchInput, slot: { taken: boolean }): Promise<EventRoutineOutcome> {
    const { routine, trigger, event } = input;
    const gated = input.gated ?? null;
    const gateApplies = !gated && deps.gateApplies?.(routine) === true;
    let parkedRunId: string | null = null;
    // Set when a committing run hit a transient failure: its row stays `gating` and the worker retries the claim.
    let retryError: unknown = null;
    const now = input.now ?? new Date();
    const prepared = await deps.prepareRoutine(routine);
    const grouping = parseGrouping(trigger.eventGrouping);
    const primaryFingerprint = eventGroupFingerprint(renderEventGroupKey(grouping.groupKey, event));
    const appendTargetId = typeof grouping.issueMode === "object" ? grouping.issueMode.appendToIssueId : null;

    const outcome = await db.transaction(async (tx): Promise<EventRoutineOutcome> => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${routine.id} and ${routines.companyId} = ${routine.companyId} for update`,
      );

      // The parked row being committed, locked. Someone else finalizing it first wins; this call then reports it.
      let gatingRow: RoutineRunRow | null = null;
      if (gated) {
        gatingRow = await txDb
          .select()
          .from(routineRuns)
          .where(and(eq(routineRuns.id, gated.runId), eq(routineRuns.status, "gating")))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!gatingRow) {
          const settled = await txDb.select().from(routineRuns).where(eq(routineRuns.id, gated.runId)).then((rows) => rows[0]!);
          return outcomeOfSettledRun(settled);
        }
      }
      const gateRecord: Partial<typeof routineRuns.$inferInsert> = gated
        ? {
          gateResult: gated.gateResult,
          gateResultFingerprint: gated.gateResult?.resultFingerprint ?? null,
          gateDispatchInput: null,
        }
        : {};

      // Under the lock, as `dispatchRoutineRun` does: the trigger and routine may have changed since matching.
      const currentTrigger = await txDb.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)).then((rows) => rows[0]);
      const currentRoutine = await txDb.select({ status: routines.status }).from(routines).where(eq(routines.id, routine.id)).then((rows) => rows[0]);
      if (!currentTrigger || currentTrigger.archived || !currentTrigger.enabled || currentTrigger.setupPending || currentRoutine?.status !== "active") {
        if (gatingRow) {
          // Disabled while the gate ran: the parked run ends as a skip.
          await deps.finalizeRun(
            gatingRow.id,
            { status: "skipped", failureReason: ROUTINE_GATE_TRIGGER_INACTIVE_REASON, completedAt: new Date(), ...gateRecord },
            txDb,
          );
          return { status: "gate_skipped", runId: gatingRow.id, note: ROUTINE_GATE_TRIGGER_INACTIVE_REASON } satisfies EventRoutineOutcome;
        }
        throw conflict("Routine trigger is not active");
      }

      // A re-claimed delivery must not comment or wake twice on a routine that already succeeded
      // (or is still gating). The parked row being committed is itself such a run, so it skips this.
      if (input.deliveryId && !gatingRow) {
        const done = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.eventDeliveryId, input.deliveryId),
              eq(routineRuns.routineId, routine.id),
              inArray(routineRuns.status, ["issue_created", "grouped", "recovered", "gating"]),
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

      // Resolved on first use: a silent repeat opens no run and needs none.
      let responsibleUserId: string | null | undefined;
      const resolveResponsible = async () => {
        if (responsibleUserId === undefined) responsibleUserId = await deps.resolveResponsibleUserId(txDb, routine);
        return responsibleUserId;
      };
      const startRun = async (
        fingerprint: string,
        extraPayload: Record<string, unknown> = {},
        parkAs?: GateEventDispatchInput,
      ) => {
        const runResponsibleUserId = await resolveResponsible();
        const values = {
          companyId: routine.companyId,
          routineId: routine.id,
          triggerId: trigger.id,
          source: "event" as const,
          triggeredAt: now,
          eventDeliveryId: input.deliveryId,
          triggerPayload: { event, groupFingerprint: fingerprint, ...extraPayload },
          dispatchFingerprint: fingerprint,
          routineRevisionId: routine.latestRevisionId,
          responsibleUserId: runResponsibleUserId,
        };
        // The parked row being committed is finalized in place, keeping the time the event arrived.
        if (gatingRow) {
          return (await deps.finalizeRun(gatingRow.id, { ...values, triggeredAt: gatingRow.triggeredAt }, txDb)) ?? gatingRow;
        }
        const [run] = await txDb
          .insert(routineRuns)
          .values(parkAs ? { ...values, status: "gating", gateDispatchInput: parkAs } : { ...values, status: "received" })
          .returning();
        return run!;
      };
      const completeRun = async (
        run: RoutineRunRow,
        status: "grouped" | "recovered",
        issueId: string,
      ) => {
        await deps.finalizeRun(run.id, { status, linkedIssueId: issueId, completedAt: now, ...gateRecord }, txDb);
        await deps.updateRoutineTouchedState(
          { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status, issueId },
          txDb,
        );
      };
      const failRun = async (run: RoutineRunRow, err: unknown, extra: Partial<EventRoutineOutcome>) => {
        const failure = failedOutcome(err, { ...extra, runId: run.id });
        await deps.finalizeRun(
          run.id,
          { status: "failed", failureReason: failure.error ?? "Event dispatch failed", completedAt: new Date(), ...gateRecord },
          txDb,
        );
        await deps.updateRoutineTouchedState(
          { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status: "failed" },
          txDb,
        );
        return failure;
      };
      /** A committing run keeps its `gating` row on a transient failure: the worker retries the claim later. */
      const failOrRetry = async (run: RoutineRunRow, err: unknown, extra: Partial<EventRoutineOutcome>) => {
        if (gatingRow && classifyEventDispatchError(err) === "transient") {
          retryError = err;
          return failedOutcome(err, { ...extra, runId: run.id });
        }
        return failRun(run, err, extra);
      };
      /** Remembers a committed comment on the run, so a retry after a failed wake does not post it again. */
      const recordPostedComment = async (run: RoutineRunRow, posted: PostedComment) => {
        await txDb
          .update(routineRuns)
          .set({ triggerPayload: { ...(run.triggerPayload ?? {}), postedComment: posted } })
          .where(eq(routineRuns.id, run.id));
      };

      // A retry of a delivery whose comment landed but whose wake failed: only the wake is left to do.
      const posted = gatingRow
        ? readPostedComment(gatingRow.triggerPayload)
        : input.deliveryId
          ? await findPostedComment(txDb, input.deliveryId, routine.id)
          : null;
      if (posted) {
        const run = await startRun(posted.fingerprint, { postedComment: posted, resumedWake: true });
        try {
          const current = await currentIssue(txDb, posted.issueId);
          if (posted.wake && current && isOpenIssue(current)) await wakeForComment(posted.issueId, posted.commentId, current);
          const status = posted.kind === "recovery" ? "recovered" : "grouped";
          await completeRun(run, status, posted.issueId);
          return { status: posted.storm ? "storm_folded" : status, runId: run.id, issueId: posted.issueId };
        } catch (err) {
          return failOrRetry(run, err, {});
        }
      }

      let note: string | null = null;
      let appendTarget: Awaited<ReturnType<typeof loadAppendTarget>> = null;
      if (appendTargetId) {
        appendTarget = await loadAppendTarget(txDb, routine, appendTargetId);
        if (!appendTarget) note = "append_target_unavailable";
      }

      if (gatingRow && gated && gated.decision.action !== "wake") {
        // The gate said skip (exit 1): nothing is posted, nothing wakes, and no storm slot is spent.
        await deps.finalizeRun(
          gatingRow.id,
          { status: "skipped", failureReason: ROUTINE_GATE_SKIP_REASON, completedAt: now, ...gateRecord },
          txDb,
        );
        await deps.updateRoutineTouchedState(
          { routineId: routine.id, triggerId: trigger.id, triggeredAt: gatingRow.triggeredAt, status: "skipped_gate" },
          txDb,
        );
        return { status: "gate_skipped", runId: gatingRow.id, ...(note ? { note } : {}) } satisfies EventRoutineOutcome;
      }

      let effectiveGrouping = grouping;
      let fingerprint = primaryFingerprint;
      let storm = false;
      let open = await findOpenGroup(txDb, routine, fingerprint, appendTarget?.id ?? null);
      // A run about to be parked spends no slot: the gate may skip it, and the slot is taken when it commits.
      if (!open && event.state !== "recovery" && !gateApplies) {
        // Only now is a new group about to open, so only now is a slot spent: concurrent repeats of one alert
        // find the group the first of them opened and cost nothing. The counter is its own short statement on
        // the root connection, so the event_sources row is never locked while an issue is created. Append
        // mode is not exempt: every new group there is a comment and a wake on a standing issue.
        slot.taken = await input.consumeStormSlot();
        if (!slot.taken) {
          // Folded into this routine's own storm group, never another agent's. An append target is left alone.
          storm = true;
          appendTarget = null;
          fingerprint = eventGroupFingerprint(eventStormGroupKey(event.source));
          effectiveGrouping = { ...grouping, rewakeOnSeverityIncrease: false, issueMode: "group" };
          open = await findOpenGroup(txDb, routine, fingerprint, null);
        }
      }

      const decision: EventGroupDecision = decideEventGroupAction({
        event,
        grouping: effectiveGrouping,
        group: open ? groupState(open.group) : null,
        now,
      });
      const stampOutcome = <T extends EventRoutineOutcome>(outcome: T): T => (note ? { ...outcome, note } : outcome);

      // A committing run whose group state turned quiet while the gate ran still has its row to close.
      const settleQuiet = async (quiet: EventRoutineOutcome, reason: string): Promise<EventRoutineOutcome> => {
        if (!gatingRow) return quiet;
        await deps.finalizeRun(gatingRow.id, { status: "skipped", failureReason: reason, completedAt: now, ...gateRecord }, txDb);
        return { ...quiet, runId: gatingRow.id };
      };

      if (decision.kind === "recovery_without_issue") {
        return settleQuiet(stampOutcome({ status: "recovery_without_issue" }), decision.kind);
      }
      if (decision.kind === "recovery_ignored") {
        return settleQuiet(stampOutcome({ status: "recovery_ignored", issueId: open?.group.issueId ?? null }), decision.kind);
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
        return settleQuiet(
          stampOutcome({ status: storm ? "storm_folded" : "grouped_silent", issueId: open.group.issueId }),
          decision.kind,
        );
      }

      // Only a decision that would comment or wake needs the gate; the cheap checks above ran first.
      if (
        gateApplies &&
        (decision.kind === "new_issue" || decision.kind === "comment" || (decision.kind === "recovery_comment" && decision.wake))
      ) {
        // Single-flight per group, never per routine: a repeat of the same group joins the in-flight gate,
        // a different group always gets its own, and `always_enqueue` never joins.
        const inFlight = routine.concurrencyPolicy === "always_enqueue"
          ? null
          : await txDb
            .select({ id: routineRuns.id })
            .from(routineRuns)
            .where(
              and(
                eq(routineRuns.companyId, routine.companyId),
                eq(routineRuns.routineId, routine.id),
                eq(routineRuns.triggerId, trigger.id),
                eq(routineRuns.status, "gating"),
                eq(routineRuns.dispatchFingerprint, fingerprint),
              ),
            )
            .orderBy(asc(routineRuns.createdAt), asc(routineRuns.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
        if (inFlight) return stampOutcome({ status: "gating", runId: inFlight.id });

        const parked = await startRun(fingerprint, {}, { v: 1, kind: "event", eventDeliveryId: input.deliveryId });
        await deps.updateRoutineTouchedState(
          { routineId: routine.id, triggerId: trigger.id, triggeredAt: now, status: "gating" },
          txDb,
        );
        parkedRunId = parked.id;
        return stampOutcome({ status: "gating", runId: parked.id });
      }

      const createdRun = await startRun(fingerprint, storm ? { stormFolded: true } : {});
      const gateBlock = gated ? renderGateDecisionBlock(gated.decision) : null;
      const withGateBlock = (body: string) => (gateBlock ? `${body}\n\n${gateBlock}` : body);

      let createdIssueId: string | null = null;
      try {
        // A repeat that earns a comment, or a recovery: post to the open group issue.
        if (open && (decision.kind === "comment" || decision.kind === "recovery_comment")) {
          const wake = decision.kind === "comment" ? true : decision.wake;
          const body = withGateBlock(decision.kind === "comment"
            ? renderEventDigestComment({
              kind: storm ? "storm" : decision.reason === "cooldown_elapsed" ? "repeat" : decision.reason,
              event,
              repeatCount: open.group.repeatCount,
              severityIncreasedFrom: decision.severityIncreasedFrom,
            })
            : renderEventRecoveryComment({ event, wake }));
          const comment = await issueSvc.addComment(open.group.issueId, body, {}, { authorType: "system" });
          await recordPostedComment(createdRun, {
            commentId: comment.id,
            issueId: open.group.issueId,
            kind: decision.kind === "comment" ? "comment" : "recovery",
            wake,
            storm,
            fingerprint,
          });
          // Re-read after the comment: the issue may have closed meanwhile, and an event never reopens one.
          const current = await currentIssue(txDb, open.group.issueId);
          if (isOpenIssue(current)) {
            // The group moves on before the wake, so a failed wake does not reopen the cooldown for the next repeat.
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
            if (wake && current) await wakeForComment(open.group.issueId, comment.id, current);
            const status = decision.kind === "comment" ? "grouped" : "recovered";
            await completeRun(createdRun, status, open.group.issueId);
            return stampOutcome({
              status: storm ? "storm_folded" : status,
              runId: createdRun.id,
              issueId: open.group.issueId,
            });
          }
          if (decision.kind === "recovery_comment") {
            // Closed while the comment was posted: nothing left to wake.
            await completeRun(createdRun, "recovered", open.group.issueId);
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
            withGateBlock(renderEventDigestComment({ kind: "new", event })),
            {},
            { authorType: "system" },
          );
          await recordPostedComment(createdRun, {
            commentId: comment.id,
            issueId: appendTarget.id,
            kind: "append",
            wake: true,
            storm: false,
            fingerprint,
          });
          const current = await currentIssue(txDb, appendTarget.id);
          if (isOpenIssue(current)) {
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
            if (current) await wakeForComment(appendTarget.id, comment.id, current);
            await completeRun(createdRun, "grouped", appendTarget.id);
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
          description: withGateBlock(
            storm
              ? renderStormIssueDescription(prepared.routineDescription, event.source, event)
              : renderEventIssueDescription(prepared.routineDescription, event),
          ),
          status: "todo",
          priority: routine.priority,
          assigneeAgentId: prepared.assigneeAgentId,
          responsibleUserId: await resolveResponsible(),
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
        await deps.finalizeRun(createdRun.id, { status: "issue_created", linkedIssueId: created.id, ...gateRecord }, txDb);
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
        return stampOutcome(await failOrRetry(createdRun, err, {}));
      }
    });
    if (retryError) throw retryError;
    if (parkedRunId) deps.onGating?.(parkedRunId);
    return outcome;
  }

  return { dispatch, commitGated };
}

/** What a finished run reports when a second commit finds it already settled. */
function outcomeOfSettledRun(run: RoutineRunRow): EventRoutineOutcome {
  switch (run.status) {
    case "issue_created":
    case "grouped":
    case "recovered":
      return { status: run.status, runId: run.id, issueId: run.linkedIssueId };
    case "failed":
      return { status: "failed_permanent", runId: run.id, failureClass: "permanent", error: run.failureReason };
    case "gating":
      return { status: "gating", runId: run.id };
    default:
      return { status: "gate_skipped", runId: run.id, note: run.failureReason };
  }
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
