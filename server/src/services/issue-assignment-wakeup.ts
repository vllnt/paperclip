import { logger } from "../middleware/logger.js";
import type { DurableChatWakeupRequest } from "./durable-chat-wakeup.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

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
  durableChatRequest?: DurableChatWakeupRequest;
};

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: IssueAssignmentWakeupOptions,
  ) => Promise<unknown>;
}

export async function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
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
  /** Exact wake options from an issue update, retained while adding retry/idempotency. */
  wakeupOptions?: IssueAssignmentWakeupOptions;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  const baseOptions: IssueAssignmentWakeupOptions = {
    source: "assignment",
    triggerDetail: "system",
    reason: input.reason,
    idempotencyKey: `issue-assignment:${input.issue.id}:${input.reason}`,
    payload: {
      issueId: input.issue.id,
      mutation: input.mutation,
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
    },
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId ?? null,
    ...(input.durableChatRequest
      ? { durableChatRequest: input.durableChatRequest }
      : {}),
    contextSnapshot: {
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
    },
  };
  const override = input.wakeupOptions ?? {};
  const options: IssueAssignmentWakeupOptions = {
    ...baseOptions,
    ...override,
    idempotencyKey: override.idempotencyKey ?? baseOptions.idempotencyKey,
    payload: { ...baseOptions.payload, ...(override.payload ?? {}) },
    contextSnapshot: { ...baseOptions.contextSnapshot, ...(override.contextSnapshot ?? {}) },
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await input.heartbeat.wakeup(input.issue.assigneeAgentId, options);
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 500));
      }
    }
  }

  logger.warn(
    { err: lastError, issueId: input.issue.id },
    "failed to wake assignee on issue assignment after retries",
  );
  if (input.rethrowOnError) throw lastError;
  return null;
}
