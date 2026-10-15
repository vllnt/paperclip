import type { RetryAdmissionPolicy, RunDispatchWriter, ScheduledRetryReader } from "./ports.js";
import type { PostCommitEffect, PromoteScheduledRetryOutcome } from "./types.js";

export function createEvaluateScheduledRetryGate(deps: { reader: ScheduledRetryReader }) {
  return (input: {
    runId: string;
    companyId: string;
    retryReasonOverride: string;
    now?: Date;
  }) => deps.reader.evaluateScheduledRetryGate({ ...input, now: input.now ?? new Date() });
}

export function createPromoteScheduledRetry(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    now?: Date;
    admission?: RetryAdmissionPolicy;
  }): Promise<PromoteScheduledRetryOutcome> =>
    deps.writer.promoteOrCancelDueRetry({
      runId: input.runId,
      companyId: input.companyId,
      now: input.now ?? new Date(),
      admission: input.admission,
    });
}

const MAX_DUE_RETRIES_PER_SWEEP = 50;
/** Bounds how many retries a sweep may skip past before it stops looking. */
const MAX_SKIPPED_RETRIES_PER_SWEEP = 500;

export function createPromoteDueScheduledRetries(deps: {
  reader: ScheduledRetryReader;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
}) {
  return async function promoteDueScheduledRetries(input: {
    now?: Date;
    cutoff: Date | null;
    admission?: RetryAdmissionPolicy;
  }) {
    const now = input.now ?? new Date();
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];
    // Retries that stay scheduled (held or lost to a race) would otherwise refill every
    // page, so later pages skip them and an eligible retry behind them is still reached.
    const skippedRunIds: string[] = [];

    while (skippedRunIds.length < MAX_SKIPPED_RETRIES_PER_SWEEP) {
      const dueRuns = (
        await deps.reader.listDueRetries({
          now,
          cutoff: input.cutoff,
          limit: MAX_DUE_RETRIES_PER_SWEEP,
          excludeRunIds: skippedRunIds,
        })
      ).slice(0, MAX_DUE_RETRIES_PER_SWEEP);
      const skippedBefore = skippedRunIds.length;

      for (const dueRun of dueRuns) {
        const result = await deps.promoteScheduledRetry({ ...dueRun, now, admission: input.admission });
        if (result.outcome === "held" || result.outcome === "not_promoted") {
          skippedRunIds.push(dueRun.runId);
        }
        if (result.outcome !== "promoted") continue;
        runIds.push(dueRun.runId);
        postCommitEffects.push(...result.postCommitEffects);
      }

      // Without a skipped retry the page behaves exactly like a single bounded sweep.
      if (dueRuns.length < MAX_DUE_RETRIES_PER_SWEEP || skippedRunIds.length === skippedBefore) break;
    }

    return { promoted: runIds.length, runIds, postCommitEffects };
  };
}

export function createCancelStaleQueuedRun(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    now?: Date;
  }) => deps.writer.cancelStaleQueuedRun({ ...input, now: input.now ?? new Date() });
}

export function createDispatchResolvedInteractionIfCurrent(deps: { writer: RunDispatchWriter }) {
  return <T>(input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    dispatch: (markDispatchStarted: () => void) => Promise<T>;
    now?: Date;
  }) => deps.writer.dispatchResolvedInteractionIfCurrent({
    ...input,
    now: input.now ?? new Date(),
  });
}
