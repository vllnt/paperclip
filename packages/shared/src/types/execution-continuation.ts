/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  objectiveSource?: {
    kind: "comment" | "description" | "title";
    id: string;
    revision: string | null;
  };
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
    /** Older-index entries that the named run did not deliver. */
    olderMessages?: ExecutionContinuationEnvelope["olderMessages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  /**
   * One-line index of the earlier comments that the history window left out of
   * `messages`, oldest first. Only the newest entries are kept; `window` counts the rest.
   */
  olderMessages?: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    createdAt: string;
    /** Length of the full body in characters. */
    chars: number;
    deleted: boolean;
    preview: string;
    sourceTrust: unknown;
  }>;
  /** Index of the issue documents. Bodies are read with the documents API. */
  documents?: Array<{
    key: string;
    title: string | null;
    revisionNumber: number;
    updatedAt: string;
    chars: number;
  }>;
  /** What the history window and the size guard kept and left out. */
  window?: {
    totalMessages: number;
    includedMessages: number;
    truncatedMessages: number;
    indexedMessages: number;
    /** Older comments that are neither in `messages` nor in `olderMessages`. */
    unindexedMessages: number;
    /** Oldest comment in `messages`; page further back from here. */
    oldestIncludedCommentId: string | null;
    /** Entries the size guard removed from the evidence lists. */
    droppedEvidenceEntries: number;
    limits: {
      maxComments: number;
      maxCommentChars: number;
      maxTotalChars: number;
      maxIndexEntries: number;
      maxPinnedCommentChars: number;
      maxEnvelopeChars: number;
    };
  };
  coverage: {
    /** `bounded_task_history`: the window or the size guard left history out. */
    kind: "full_task_history" | "task_history_delta" | "bounded_task_history";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}
