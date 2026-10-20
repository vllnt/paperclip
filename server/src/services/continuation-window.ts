import {
  CONTINUATION_OBJECTIVE_MAX_CHARS,
  THREAD_WINDOW_DEFAULTS,
  cutText,
  sliceWhole,
  type ExecutionContinuationEnvelope,
  type ThreadWindowLimits,
} from "@paperclipai/shared";

type ContinuationMessage = ExecutionContinuationEnvelope["messages"][number];
type OlderMessage = NonNullable<ExecutionContinuationEnvelope["olderMessages"]>[number];
/** The envelope before its resume delta is attached. The delta is taken from the final window. */
export type WindowedContinuation = Omit<ExecutionContinuationEnvelope, "resumeDelta">;

/** Characters kept of a pinned comment: one that woke the run, or the latest human request. */
export const CONTINUATION_PINNED_COMMENT_MAX_CHARS = 16_000;
/** Characters of the one-line preview of an indexed older comment. */
export const CONTINUATION_INDEX_PREVIEW_CHARS = 120;
/**
 * Ceiling of the serialized envelope without its resume delta, with the
 * objective at its rendered size: about 74K tokens. Human responses, recovery
 * outcomes and the trigger outcome are never removed, so they alone can exceed it.
 */
export const CONTINUATION_ENVELOPE_MAX_CHARS = 160_000;
/** Characters kept of the completed-work summary. */
export const CONTINUATION_COMPLETED_WORK_MAX_CHARS = 16_000;
/** Most issue documents listed in the document index. */
export const CONTINUATION_DOCUMENT_INDEX_MAX_ENTRIES = 20;
/** A body is left out rather than cut below this, unless it is pinned. */
const MIN_CUT_BODY_CHARS = 200;
/** What the size guard keeps of a pinned body or the summary when nothing else can go. */
const GUARD_STUB_CHARS = 2_000;
/** Room the guard leaves for the `window` metadata that is added after it. */
const WINDOW_METADATA_RESERVE_CHARS = 1_000;
const OBJECTIVE_READ_HINT = "read the issue and its latest comment";

function preview(message: ContinuationMessage): string {
  if (message.deleted) return "";
  const line = message.body.replace(/\s+/g, " ").trim();
  return line.length > CONTINUATION_INDEX_PREVIEW_CHARS
    ? `${sliceWhole(line, CONTINUATION_INDEX_PREVIEW_CHARS)}…`
    : line;
}

/**
 * The one-line index entry of a comment.
 *
 * @param message The comment, with its body already sanitized for the reader.
 * @returns Its id, author, time, full length and a preview of {@link CONTINUATION_INDEX_PREVIEW_CHARS} characters.
 */
export function toIndexEntry(message: ContinuationMessage): OlderMessage {
  return {
    id: message.id,
    authorType: message.authorType,
    authorId: message.authorId,
    createdAt: message.createdAt,
    chars: message.body.length,
    deleted: message.deleted,
    preview: preview(message),
    sourceTrust: message.sourceTrust,
  };
}

/**
 * Pick the comments a wake carries. Pinned comments are always kept, each cut
 * at {@link CONTINUATION_PINNED_COMMENT_MAX_CHARS}: the latest human request
 * first, then the comments that woke the run, newest first. They count toward
 * `maxTotalChars`; once it is used up, each further pinned comment keeps
 * {@link MIN_CUT_BODY_CHARS} characters. Then the newest other comments are
 * kept, each cut at `maxCommentChars`, until `maxComments` comments or
 * `maxTotalChars` body characters. The window stops at the first comment that
 * does not fit, so the kept recent comments are contiguous. Every other
 * comment goes to the older index; only the newest `maxIndexEntries` of them
 * are listed.
 *
 * @param messages Every comment of the issue, oldest first.
 * @param input.pinnedIds Comments that must stay in the window.
 * @param input.requestId The latest human request, budgeted before the other pinned comments.
 * @param input.limits Window bounds.
 * @returns The kept comments and the older index, both oldest first.
 */
export function selectThreadWindow(
  messages: readonly ContinuationMessage[],
  input: { pinnedIds: ReadonlySet<string>; requestId?: string | null; limits: ThreadWindowLimits },
): { messages: ContinuationMessage[]; olderMessages: OlderMessage[] } {
  const { limits, pinnedIds } = input;
  const kept = new Map<number, ContinuationMessage>();
  let remaining = limits.maxTotalChars;
  const keep = (index: number, cap: number) => {
    const message = messages[index]!;
    const body = cutText(message.body, cap, `read comment ${message.id}`);
    kept.set(index, body === message.body ? message : { ...message, body });
    remaining -= Math.min(message.body.length, cap);
  };
  const newestFirst = messages.map((_, offset) => messages.length - 1 - offset);
  const pinnedOrder = newestFirst
    .filter((index) => pinnedIds.has(messages[index]!.id))
    .sort((a, b) => Number(messages[b]!.id === input.requestId) - Number(messages[a]!.id === input.requestId));
  for (const index of pinnedOrder) {
    keep(index, Math.min(CONTINUATION_PINNED_COMMENT_MAX_CHARS, Math.max(remaining, MIN_CUT_BODY_CHARS)));
  }
  for (const index of newestFirst) {
    if (kept.has(index)) continue;
    if (kept.size >= limits.maxComments) break;
    const cap = Math.min(limits.maxCommentChars, remaining);
    if (messages[index]!.body.length > cap && cap < MIN_CUT_BODY_CHARS) break;
    keep(index, cap);
  }
  const older = messages.filter((_, index) => !kept.has(index));
  const indexed = limits.maxIndexEntries > 0 ? older.slice(-limits.maxIndexEntries) : [];
  return {
    messages: [...kept.entries()].sort(([a], [b]) => a - b).map(([, message]) => message),
    olderMessages: indexed.map(toIndexEntry),
  };
}

const jsonLength = (value: unknown): number => JSON.stringify(value).length;

/**
 * Shrink an envelope until it serializes to at most `maxChars`. Order: older
 * index entries (oldest first), unpinned comments (oldest first), completed
 * actions and interaction outcomes (oldest first; the outcome of the trigger
 * interaction stays), then the completed-work summary and the pinned comments
 * are cut to a stub. Human responses and recovery outcomes are never removed.
 *
 * @returns The shrunk envelope and how many evidence entries were removed.
 */
export function guardContinuationSize(
  envelope: WindowedContinuation,
  input: { pinnedIds: ReadonlySet<string>; maxChars?: number },
): { envelope: WindowedContinuation; droppedEvidenceEntries: number } {
  const maxChars = input.maxChars ?? CONTINUATION_ENVELOPE_MAX_CHARS;
  let size = jsonLength(envelope);
  if (size <= maxChars) return { envelope, droppedEvidenceEntries: 0 };
  const result: WindowedContinuation = {
    ...envelope,
    messages: [...envelope.messages],
    olderMessages: [...(envelope.olderMessages ?? [])],
    completedActions: [...(envelope.completedActions ?? [])],
    interactionOutcomes: [...envelope.interactionOutcomes],
  };
  let droppedEvidenceEntries = 0;
  const removeAt = <T>(list: T[], index: number) => {
    size -= jsonLength(list[index]) + 1;
    list.splice(index, 1);
  };
  while (size > maxChars && result.olderMessages!.length > 0) removeAt(result.olderMessages!, 0);
  while (size > maxChars) {
    const index = result.messages.findIndex((message) => !input.pinnedIds.has(message.id));
    if (index < 0) break;
    removeAt(result.messages, index);
  }
  while (size > maxChars && result.completedActions!.length > 0) {
    removeAt(result.completedActions!, 0);
    droppedEvidenceEntries += 1;
  }
  while (size > maxChars) {
    const index = result.interactionOutcomes.findIndex((outcome) => outcome.id !== result.trigger.interactionId);
    if (index < 0) break;
    removeAt(result.interactionOutcomes, index);
    droppedEvidenceEntries += 1;
  }
  if (jsonLength(result) > maxChars && result.completedWork) {
    result.completedWork = cutText(result.completedWork, GUARD_STUB_CHARS, "read the issue continuation summary document");
  }
  if (jsonLength(result) > maxChars) {
    result.messages = result.messages.map((message) => {
      const body = cutText(message.body, GUARD_STUB_CHARS, `read comment ${message.id}`);
      return body === message.body ? message : { ...message, body };
    });
  }
  return { envelope: result, droppedEvidenceEntries };
}

/**
 * Bound the history of a continuation envelope: apply the thread window to its
 * messages, cut the completed-work summary, then apply the size guard. The
 * objective stays whole, because server checks read it; the guard counts it at
 * the {@link CONTINUATION_OBJECTIVE_MAX_CHARS} that a prompt shows. A thread
 * that fits keeps `full_task_history` and gains no `window` or `olderMessages`
 * field.
 *
 * @param envelope The envelope with every comment of the issue in `messages`.
 * @param input.pinnedIds Comments that must stay in the window.
 * @param input.requestId The latest human request, budgeted first among the pinned comments.
 * @param input.limits Window bounds; defaults to {@link THREAD_WINDOW_DEFAULTS}.
 * @returns The bounded envelope, still without a resume delta.
 */
export function applyContinuationWindow(
  envelope: WindowedContinuation,
  input: {
    pinnedIds: ReadonlySet<string>;
    requestId?: string | null;
    limits?: ThreadWindowLimits;
    maxEnvelopeChars?: number;
  },
): WindowedContinuation {
  const limits = input.limits ?? THREAD_WINDOW_DEFAULTS;
  const maxEnvelopeChars = input.maxEnvelopeChars ?? CONTINUATION_ENVELOPE_MAX_CHARS;
  const totalMessages = envelope.messages.length;
  const window = selectThreadWindow(envelope.messages, { pinnedIds: input.pinnedIds, requestId: input.requestId, limits });
  const completedWork = envelope.completedWork === null
    ? null
    : cutText(envelope.completedWork, CONTINUATION_COMPLETED_WORK_MAX_CHARS, "read the issue continuation summary document");
  const guarded = guardContinuationSize(
    {
      ...envelope,
      objective: cutText(envelope.objective, CONTINUATION_OBJECTIVE_MAX_CHARS, OBJECTIVE_READ_HINT),
      completedWork,
      messages: window.messages,
      olderMessages: window.olderMessages,
    },
    { pinnedIds: input.pinnedIds, maxChars: maxEnvelopeChars - WINDOW_METADATA_RESERVE_CHARS },
  );
  const { olderMessages = [], ...guardedRest } = guarded.envelope;
  const result: WindowedContinuation = { ...guardedRest, objective: envelope.objective };
  const originalBodies = new Map(envelope.messages.map((message) => [message.id, message.body]));
  const truncatedMessages = result.messages.filter((message) => originalBodies.get(message.id) !== message.body).length;
  const bounded =
    result.messages.length < totalMessages ||
    truncatedMessages > 0 ||
    guarded.droppedEvidenceEntries > 0 ||
    result.completedWork !== envelope.completedWork;
  if (!bounded) return result;
  const keptIds = new Set(result.messages.map((message) => message.id));
  let oldestIncludedCommentId: string | null = null;
  for (let index = envelope.messages.length - 1; index >= 0; index -= 1) {
    const id = envelope.messages[index]!.id;
    if (!keptIds.has(id)) break;
    oldestIncludedCommentId = id;
  }
  return {
    ...result,
    olderMessages,
    window: {
      totalMessages,
      includedMessages: result.messages.length,
      truncatedMessages,
      indexedMessages: olderMessages.length,
      unindexedMessages: totalMessages - result.messages.length - olderMessages.length,
      oldestIncludedCommentId,
      droppedEvidenceEntries: guarded.droppedEvidenceEntries,
      limits: {
        ...limits,
        maxPinnedCommentChars: CONTINUATION_PINNED_COMMENT_MAX_CHARS,
        maxEnvelopeChars,
      },
    },
    coverage: { ...envelope.coverage, kind: "bounded_task_history" },
  };
}
