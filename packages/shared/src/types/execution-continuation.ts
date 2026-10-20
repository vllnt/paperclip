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
  /** Whole, because server checks read it. A prompt shows at most `CONTINUATION_OBJECTIVE_MAX_CHARS` of it. */
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
    /** Comments of the current window that are new or edited since the named run. */
    messages: ExecutionContinuationEnvelope["messages"];
    /**
     * The newest of the new or edited comments outside the current window,
     * listed with a one-line preview only, oldest first. Their bodies must be read.
     * An edit is seen only for a comment that the named run had in `messages`.
     */
    olderMessages?: ExecutionContinuationEnvelope["olderMessages"];
    /** New or edited comments outside the current window that `olderMessages` does not list. */
    unlistedMessages?: number;
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
  /** Index of the issue documents, without system documents. Bodies are read with the documents API. */
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
    /**
     * Oldest comment of the unbroken run of newest comments in `messages`;
     * page further back from here. Older pinned comments can come before it.
     * Null when the newest comment of the issue is not in `messages`.
     */
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
