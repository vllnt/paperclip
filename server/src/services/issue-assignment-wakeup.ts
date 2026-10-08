import { logger } from "../middleware/logger.js";
import { isTransientDatabaseError, retryIdempotentDatabaseOperation } from "../database-retry.js";
import type { DurableChatWakeupRequest } from "./durable-chat-wakeup.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

/** Heartbeat admission deduplicates keys with this prefix (one live receipt per key). */
export const ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX = "issue-assignment:";

/**
 * One assignment wake per issue, assignee and assignment generation. The
 * generation is the issue's `statusVersion` after the assignment, which every
 * assignee change advances, so A -> B -> A yields three distinct keys while a
 * retry of the same assignment reuses its key.
 */
export function buildIssueAssignmentIdempotencyKey(input: {
  issueId: string;
  assigneeAgentId: string;
  assignmentGeneration: number;
}) {
  return `${ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX}${input.issueId}:${input.assigneeAgentId}:${input.assignmentGeneration}`;
}

export function parseIssueAssignmentIdempotencyKey(key: string): {
  issueId: string;
  assigneeAgentId: string;
  assignmentGeneration: number;
} | null {
  const match = new RegExp(`^${ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX}([^:]+):([^:]+):(\\d+)$`).exec(key);
  if (!match) return null;
  const assignmentGeneration = Number(match[3]);
  if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 0) return null;
  return { issueId: match[1], assigneeAgentId: match[2], assignmentGeneration };
}

/** Receipt reason when heartbeat admission refuses an assignment-keyed wake. */
export const ISSUE_ASSIGNMENT_WAKE_REFUSED_REASON = "issue_assignment_wake_refused";

export type IssueAssignmentWakeRefusal =
  | "malformed_key"
  | "assignee_mismatch"
  | "generation_ahead"
  | "superseded";

/**
 * A stale wake after a quick reassignment (`assignee_mismatch`, `superseded`)
 * is expected and only warns. A key that names a generation the issue never
 * reached, or is not a valid key at all, means a server bug and is an error.
 */
export const ISSUE_ASSIGNMENT_WAKE_REFUSAL_LOG_LEVEL: Record<IssueAssignmentWakeRefusal, "warn" | "error"> = {
  assignee_mismatch: "warn",
  superseded: "warn",
  generation_ahead: "error",
  malformed_key: "error",
};

/**
 * Admission rule for an assignment-keyed wake, evaluated under the issue lock.
 * The wake may run only for the issue's current agent assignee, for a
 * generation the issue has reached, and when no newer assignment has been
 * recorded. A status-only change after the assignment advances `statusVersion`
 * but records no assignment, so it never refuses the wake; A -> B -> A records
 * B's and A's newer generations, so A's first key is superseded.
 */
export function decideIssueAssignmentWakeRefusal(input: {
  key: { issueId: string; assigneeAgentId: string; assignmentGeneration: number } | null;
  wakeAgentId: string;
  lockedIssue: { id: string; assigneeAgentId: string | null; statusVersion: number } | null;
  /** Newest generation among this issue's assignment receipts, refusals excluded. */
  newestRecordedGeneration: number | null;
}): IssueAssignmentWakeRefusal | null {
  const { key, lockedIssue } = input;
  if (!key) return "malformed_key";
  if (
    !lockedIssue ||
    key.issueId !== lockedIssue.id ||
    key.assigneeAgentId !== input.wakeAgentId ||
    key.assigneeAgentId !== lockedIssue.assigneeAgentId
  ) {
    return "assignee_mismatch";
  }
  if (key.assignmentGeneration > lockedIssue.statusVersion) return "generation_ahead";
  if (input.newestRecordedGeneration !== null && input.newestRecordedGeneration > key.assignmentGeneration) {
    return "superseded";
  }
  return null;
}

export type IssueAssignmentWakeupOptions = {
  source?: WakeupSource;
  triggerDetail?: WakeupTriggerDetail;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  allowRunCoalescing?: boolean;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
  issueStateGuard?: {
    statuses: string[];
    assigneeAgentId: string;
    statusVersion?: number;
  };
  durableChatRequest?: DurableChatWakeupRequest;
};

export interface IssueAssignmentWakeupDeps<TRun = unknown> {
  wakeup: (
    agentId: string,
    opts: IssueAssignmentWakeupOptions,
  ) => Promise<TRun>;
}

type IssueWakeTarget = {
  id: string;
  assigneeAgentId: string | null;
  status: string;
  statusVersion?: number;
};

/**
 * A wake opts in to the reserved assignment key only when it announces one
 * assignment generation and its producer sends it once per generation: an
 * issue created with its agent (issue create, child, plan decomposition,
 * interaction accept, routine, summary slot, skill-test harness, runner
 * create), an assign or reassign, and recovery's initial dispatch to the
 * agent assignee. A replay of that key is then the same wake.
 *
 * Every other producer wakes without the key, because a later wake at an
 * unchanged generation is new work, not a replay: checkout, plugin, secret
 * resolution, chat, tree resume or restore, the runner rollback, and status
 * cards (the scheduler re-wakes a deduplicated, still-open generating issue at
 * the same generation; the key would turn that re-wake into a replay).
 */
type AssignmentEventScope =
  | {
      /** `issue.statusVersion` is the assignment generation the key names. */
      assignmentEvent: true;
      issue: IssueWakeTarget & { statusVersion: number };
    }
  | { assignmentEvent?: false; issue: IssueWakeTarget };

export async function queueIssueAssignmentWakeup<TRun>(input: AssignmentEventScope & {
  heartbeat: IssueAssignmentWakeupDeps<TRun>;
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  /** Latest issue comment that caused this wakeup. Included in both payload
   * and context so the heartbeat can build the exact turn that was requested. */
  wakeCommentId?: string | null;
  /** Closed, server-derived omission counts for provider attachments on the
   * exact wake comment. These are prompt diagnostics, never authorization. */
  attachmentOmissionReasons?: Record<string, number> | null;
  rethrowOnError?: boolean;
  durableChatRequest?: DurableChatWakeupRequest;
  /** Exact wake options from an issue update; the base fields fill any gaps. */
  wakeupOptions?: IssueAssignmentWakeupOptions;
}): Promise<TRun | null | undefined> {
  const assigneeAgentId = input.issue.assigneeAgentId;
  if (!assigneeAgentId || input.issue.status === "backlog") return;

  let idempotencyKey: string | null = null;
  if (input.assignmentEvent) {
    const assignmentGeneration = input.issue.statusVersion;
    if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 0) {
      throw new Error("Assignment wake requires the server issue status version");
    }
    idempotencyKey = buildIssueAssignmentIdempotencyKey({
      issueId: input.issue.id,
      assigneeAgentId,
      assignmentGeneration,
    });
  }
  const basePayload: Record<string, unknown> = {
    issueId: input.issue.id,
    mutation: input.mutation,
    ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
  };
  const baseContextSnapshot: Record<string, unknown> = {
    issueId: input.issue.id,
    source: input.contextSource,
    ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
    ...(input.wakeCommentId && input.attachmentOmissionReasons
      ? {
          externalAttachmentOmissions: [
            {
              commentId: input.wakeCommentId,
              reasons: input.attachmentOmissionReasons,
            },
          ],
        }
      : {}),
  };
  const override = input.wakeupOptions ?? {};
  const options: IssueAssignmentWakeupOptions = {
    source: "assignment",
    triggerDetail: "system",
    reason: input.reason,
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId ?? null,
    ...(input.durableChatRequest
      ? { durableChatRequest: input.durableChatRequest }
      : {}),
    ...override,
    // An assignment event's key always wins; other wakes keep their own.
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload: { ...basePayload, ...(override.payload ?? {}) },
    contextSnapshot: { ...baseContextSnapshot, ...(override.contextSnapshot ?? {}) },
  };

  const deliver = () => input.heartbeat.wakeup(assigneeAgentId, options);
  try {
    // Only this helper mints assignment keys, and only for an assignment event.
    if (override.idempotencyKey?.startsWith(ISSUE_ASSIGNMENT_IDEMPOTENCY_PREFIX)) {
      throw new Error("Assignment idempotency keys are reserved for assignment events");
    }
    // A transient failure may hide a committed wake. Only the assignment key
    // (with its unique index) makes a replay return that wake, so only an
    // assignment event is retried.
    return idempotencyKey
      ? await retryIdempotentDatabaseOperation(deliver, { isTransient: isTransientDatabaseError })
      : await deliver();
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id },
      "failed to wake assignee on issue assignment",
    );
    if (input.rethrowOnError) throw err;
    return null;
  }
}
