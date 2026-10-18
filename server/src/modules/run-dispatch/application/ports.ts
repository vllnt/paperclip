import type { GateDecision } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
  /** Runs a sweep already decided to leave scheduled; keeps them from filling later pages. */
  excludeRunIds?: string[];
};

export type EvaluateScheduledRetryGateInput = {
  runId: string;
  companyId: string;
  retryReasonOverride: string;
  now: Date;
};

/** Read-only scheduled-retry operations exposed to application use cases. */
export interface ScheduledRetryReader {
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
}

/**
 * Caller policy evaluated inside the promotion transaction, after the retry's locks
 * are held and just before it would be promoted. `tx` is the adapter's transaction handle.
 * A hold moves the retry's due time to `holdUntil`, so it leaves the due list until it can be
 * admitted. Admission records `admittedAt` (read after the caller's locks) as its admission time.
 */
export type RetryAdmissionPolicy = (input: {
  tx: unknown;
  run: { id: string; companyId: string; agentId: string; contextSnapshot: Record<string, unknown> };
  now: Date;
}) => Promise<{ hold: true; holdUntil: Date } | { hold: false; admittedAt?: Date }>;

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
  admission?: RetryAdmissionPolicy;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
};

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}
