import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { routineRuns, routines, routineTriggers, type Db } from "@paperclipai/db";
import { ROUTINE_GATE_LIMITS, type RoutineGateResult } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { sampleGateText } from "./command.js";
import { createSemaphore, type Semaphore } from "../event-sources/semaphore.js";
import type { GateRunner } from "./runner.js";
import {
  GATE_CLAIM_MARGIN_SEC,
  GATE_MAX_ATTEMPTS,
  decideGateOutcome,
  gateClaimStalenessSec,
  type GateDecision,
  type GateSourceKind,
} from "./outcome.js";

type RoutineRunRow = typeof routineRuns.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

const GATE_INSTANCE_CONCURRENCY = 8;
const GATE_ENVIRONMENT_CONCURRENCY = 2;
const SWEEP_BATCH = 100;
/** How long a failed commit waits before the next claim may try it again. */
const COMMIT_RETRY_DELAY_SEC = 60;

export interface GateCommitRequest {
  /** The claimed row: still `gating`, with `gateAttempts` counting this claim. */
  run: RoutineRunRow;
  routine: RoutineRow;
  trigger: RoutineTriggerRow | null;
  /** Null only when the routine lost its gate while the run was gating. */
  gateResult: RoutineGateResult | null;
  decision: GateDecision;
}

export interface GateWorkerHandlers {
  /** Applies the decision to the gating row. A throw is a transient failure: the claim is released for a later retry. */
  commit(request: GateCommitRequest): Promise<void>;
  /** The claim budget is spent and the commit still cannot be applied; the row must reach a terminal state. */
  abandon(request: { run: RoutineRunRow; routine: RoutineRow | null; error: unknown }): Promise<void>;
}

export interface GateProcessContext {
  runner: GateRunner;
  handlers: GateWorkerHandlers;
}

interface WorkerState {
  inFlight: Map<string, Promise<void>>;
  instance: Semaphore;
  environments: Map<string, Semaphore>;
}

// One worker state per database handle: `routineService` is instantiated in many places, and
// the in-flight set and the semaphores must be shared by all of them for the limits to hold.
const states = new WeakMap<object, WorkerState>();

function stateFor(db: Db): WorkerState {
  let state = states.get(db);
  if (!state) {
    state = {
      inFlight: new Map(),
      instance: createSemaphore(GATE_INSTANCE_CONCURRENCY),
      environments: new Map(),
    };
    states.set(db, state);
  }
  return state;
}

function environmentSemaphore(state: WorkerState, key: string): Semaphore {
  let semaphore = state.environments.get(key);
  if (!semaphore) {
    semaphore = createSemaphore(GATE_ENVIRONMENT_CONCURRENCY);
    state.environments.set(key, semaphore);
  }
  return semaphore;
}

function gateSourceKind(source: string): GateSourceKind {
  return source === "event" ? "event" : source === "webhook" ? "webhook" : "schedule";
}

/**
 * The in-process gate worker. A run is picked up by `kick` right after the trigger inserted it,
 * and by `sweep` every 30 seconds for anything a restart or a crash left behind. Both go through
 * one compare-and-set claim, so several processes (or two racing sweepers) never run the same
 * gate twice.
 */
export function createGateWorker(db: Db) {
  const state = stateFor(db);

  /** Takes the row if it is unclaimed or its claim is older than the gate's timeout plus a margin. */
  async function claim(runId: string, staleSec: number): Promise<RoutineRunRow | null> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - staleSec * 1000);
    const rows = await db
      .update(routineRuns)
      .set({ gateClaimedAt: now, gateAttempts: sqlIncrement(), updatedAt: now })
      .where(
        and(
          eq(routineRuns.id, runId),
          eq(routineRuns.status, "gating"),
          or(isNull(routineRuns.gateClaimedAt), lt(routineRuns.gateClaimedAt, cutoff)),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Makes the claim expire `delaySec` from now, so the sweep (or a timer) picks the row up again. */
  async function releaseClaim(runId: string, staleSec: number, delaySec: number, patch: Partial<typeof routineRuns.$inferInsert> = {}) {
    const claimedAt = new Date(Date.now() - staleSec * 1000 + delaySec * 1000);
    await db
      .update(routineRuns)
      .set({ gateClaimedAt: claimedAt, updatedAt: new Date(), ...patch })
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "gating")));
  }

  /** The most recent committed result for this trigger, which the script may compare against. */
  async function lastCommittedResult(run: RoutineRunRow) {
    return db
      .select({ fingerprint: routineRuns.gateResultFingerprint, triggeredAt: routineRuns.triggeredAt })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.routineId, run.routineId),
          run.triggerId ? eq(routineRuns.triggerId, run.triggerId) : isNull(routineRuns.triggerId),
          inArray(routineRuns.status, ["issue_created", "completed"]),
          isNotNull(routineRuns.gateResultFingerprint),
        ),
      )
      .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function gateEvent(run: RoutineRunRow): unknown {
    const payload = run.triggerPayload as Record<string, unknown> | null;
    if (!payload) return undefined;
    return run.source === "event" ? (payload.event ?? payload) : payload;
  }

  async function execute(
    run: RoutineRunRow,
    routine: RoutineRow,
    context: GateProcessContext,
    staleSec: number,
  ): Promise<void> {
    const source = gateSourceKind(run.source);
    const gate = routine.gate;
    const { runner, handlers } = context;

    const trigger = run.triggerId
      ? await db.select().from(routineTriggers).where(eq(routineTriggers.id, run.triggerId)).then((rows) => rows[0] ?? null)
      : null;

    let gateResult: RoutineGateResult | null = null;
    let decision: GateDecision;
    if (!gate) {
      // The gate was removed while the run was gating: nothing left to evaluate, so the run proceeds.
      decision = { action: "wake", stdout: "", note: null };
    } else {
      let stdout = "";
      let retryable = true;
      if (run.gateAttempts > GATE_MAX_ATTEMPTS) {
        // Claims were spent without a result (for example the process died mid-gate each time).
        gateResult = exhaustedResult();
      } else {
        const last = await lastCommittedResult(run);
        const outcome = await runner.run({
          companyId: routine.companyId,
          routine: { id: routine.id, assigneeAgentId: routine.assigneeAgentId },
          gate,
          context: {
            routineId: routine.id,
            triggerKind: run.source,
            lastResultFingerprint: last?.fingerprint ?? null,
            lastDispatchedAt: last?.triggeredAt ?? null,
            event: gateEvent(run),
          },
        }).catch((error: unknown): { result: RoutineGateResult; stdout: string; retryable: boolean } => ({
          result: {
            ...exhaustedResult(),
            detail: sampleGateText(`gate run failed: ${error instanceof Error ? error.message : String(error)}`, 200),
          },
          stdout: "",
          retryable: true,
        }));
        gateResult = outcome.result;
        stdout = outcome.stdout;
        retryable = outcome.retryable;
      }

      const verdict = decideGateOutcome({
        source,
        result: gateResult,
        stdout,
        retryable,
        attempts: run.gateAttempts,
      });
      if (verdict.action === "retry") {
        await releaseClaim(run.id, staleSec, verdict.delaySec, { gateResult });
        const timer = setTimeout(() => {
          void processRun(run.id, context).catch((error) => logger.warn({ err: error, runId: run.id }, "gate retry failed"));
        }, verdict.delaySec * 1000 + 250);
        timer.unref?.();
        return;
      }
      decision = verdict;
    }

    try {
      await handlers.commit({ run, routine, trigger, gateResult, decision });
    } catch (error) {
      logger.warn({ err: error, runId: run.id, routineId: routine.id }, "gate commit failed");
      if (run.gateAttempts >= GATE_MAX_ATTEMPTS) {
        await handlers.abandon({ run, routine, error }).catch((abandonError) =>
          logger.error({ err: abandonError, runId: run.id }, "gate abandon failed"),
        );
        return;
      }
      await releaseClaim(run.id, staleSec, COMMIT_RETRY_DELAY_SEC).catch(() => undefined);
    }
  }

  async function processClaimed(runId: string, context: GateProcessContext): Promise<void> {
    const row = await db.select().from(routineRuns).where(eq(routineRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (!row || row.status !== "gating") return;
    const routine = await db.select().from(routines).where(eq(routines.id, row.routineId)).then((rows) => rows[0] ?? null);
    let environmentKey = "unresolved";
    if (routine) {
      try {
        environmentKey = await context.runner.resolveEnvironmentId(routine.companyId, routine.assigneeAgentId);
      } catch {
        // The run reports the same failure with its own classification.
      }
    }
    // Waiting for capacity must not age a claim: only admitted execution owns a lease.
    await state.instance.run(() => environmentSemaphore(state, environmentKey).run(async () => {
      const staleSec = gateClaimStalenessSec(routine?.gate);
      const claimed = await claim(runId, staleSec);
      if (!claimed) return;
      if (!routine) {
        await context.handlers.abandon({ run: claimed, routine: null, error: new Error("Routine no longer exists") });
        return;
      }
      await execute(claimed, routine, context, staleSec);
    }));
  }

  /** Processes one gating row to a decision; safe to call twice for the same row. */
  function processRun(runId: string, context: GateProcessContext): Promise<void> {
    const existing = state.inFlight.get(runId);
    if (existing) return existing;
    const promise = processClaimed(runId, context)
      .catch((error) => {
        logger.warn({ err: error, runId }, "gate worker failed");
      })
      .finally(() => {
        state.inFlight.delete(runId);
      });
    state.inFlight.set(runId, promise);
    return promise;
  }

  return {
    /** Starts a run in the background and returns at once; the caller never waits for the gate. */
    kick(runId: string, context: GateProcessContext): void {
      void processRun(runId, context);
    },

    /**
     * Starts every gating row that is unclaimed or whose claim went stale, and returns how many
     * it started. It does not wait for the scripts; `idle` does.
     */
    async sweep(context: GateProcessContext): Promise<number> {
      const cutoff = new Date(Date.now() - (ROUTINE_GATE_LIMITS.timeoutMinSec + GATE_CLAIM_MARGIN_SEC) * 1000);
      const candidates = await db
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.status, "gating"),
            or(isNull(routineRuns.gateClaimedAt), lt(routineRuns.gateClaimedAt, cutoff)),
          ),
        )
        .orderBy(asc(routineRuns.createdAt))
        .limit(SWEEP_BATCH);
      for (const candidate of candidates) void processRun(candidate.id, context);
      return candidates.length;
    },

    /** Resolves when everything this process has in flight is done. Tests and shutdown use it. */
    async idle(): Promise<void> {
      while (state.inFlight.size > 0) {
        await Promise.all([...state.inFlight.values()]);
      }
    },
  };
}

export type GateWorker = ReturnType<typeof createGateWorker>;

function exhaustedResult(): RoutineGateResult {
  return {
    exitCode: null,
    class: "transport",
    durationMs: 0,
    scriptSha: null,
    environmentId: null,
    resultFingerprint: null,
    stdoutSample: "",
    stderrTail: "",
    detail: "gate attempts exhausted",
  };
}

function sqlIncrement() {
  return sql`${routineRuns.gateAttempts} + 1`;
}
