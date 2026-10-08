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

export async function queueIssueAssignmentWakeup<TRun>(input: {
  heartbeat: IssueAssignmentWakeupDeps<TRun>;
  issue: { id: string; assigneeAgentId: string | null; status: string; statusVersion: number };
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

  const assignmentGeneration = input.issue.statusVersion;
  if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 0) {
    throw new Error("Assignment wake requires the server issue status version");
  }
  const idempotencyKey = buildIssueAssignmentIdempotencyKey({
    issueId: input.issue.id,
    assigneeAgentId,
    assignmentGeneration,
  });
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
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload: { ...basePayload, ...(override.payload ?? {}) },
    contextSnapshot: { ...baseContextSnapshot, ...(override.contextSnapshot ?? {}) },
  };

  const deliver = () => input.heartbeat.wakeup(assigneeAgentId, options);
  try {
    return await retryIdempotentDatabaseOperation(deliver, { isTransient: isTransientDatabaseError });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id },
      "failed to wake assignee on issue assignment",
    );
    if (input.rethrowOnError) throw err;
    return null;
  }
}
