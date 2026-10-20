import { logger } from "./middleware/logger.js";

/** postgres.js transient connection codes, including wrapped Drizzle errors. */
const transientDbConnectionCodes = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** Node socket failures under the database connection. */
const transientSocketCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Postgres SQLSTATEs for a transaction that the server aborted or never
 * started, through no fault of the request: serialization failure, deadlock,
 * lock not available, server shutdown/startup, too many connections, and the
 * connection-exception class. Constraint, permission and data errors are not
 * here: replaying the same request cannot change their outcome.
 */
const transientPostgresSqlStates = new Set([
  "40001",
  "40P01",
  "55P03",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
]);

export function isTransientDbConnectionError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && transientDbConnectionCodes.has(code)) return true;
  }
  return false;
}

/**
 * A connection failure or a server-aborted transaction. Everything else
 * (authorization, validation, policy denials, constraint violations, bugs)
 * is permanent for the same request and must not be retried.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (isTransientDbConnectionError(error)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (transientPostgresSqlStates.has(code) || transientSocketCodes.has(code))) {
      return true;
    }
  }
  return false;
}

/** Retries after the first attempt: 6 attempts in all. */
const MAX_RETRIES = 5;
/** The sleep before retry n is 50 × 2^(n-1) ms (50, 100, 200, 400, 800), jittered. */
const BASE_DELAY_MS = 50;
/** Each sleep is scaled by a random factor in [0.8, 1.2), as Effect's `Schedule.jittered`. */
const JITTER_MIN = 0.8;
const JITTER_SPREAD = 0.4;
/**
 * From this attempt on, an attempt that itself ran longer than
 * `SLOW_ATTEMPT_MS` ends the retries, so a hung database costs at most three
 * slow attempts. Fast failures keep every retry.
 */
const SLOW_ATTEMPT_CAP_FROM = 3;
const SLOW_ATTEMPT_MS = 2_000;

/** The retry budget: a sliding window of ten one-second slots, shared by the process. */
const BUDGET_SLOTS = 10;
const BUDGET_SLOT_MS = 1_000;
/** Retries the window allows beyond its calls, so that a quiet process can still ride out a blip. */
const BUDGET_RESERVE = 100;
const BUDGET_WARNING_INTERVAL_MS = 10_000;

/**
 * Process-wide retry budget. A retry is allowed only while the retries of the
 * last 10 s are fewer than the calls of the last 10 s plus `BUDGET_RESERVE`,
 * so a sustained outage cannot multiply the statements sent to the database.
 */
const budget = {
  slotSecond: new Array<number>(BUDGET_SLOTS).fill(-1),
  calls: new Array<number>(BUDGET_SLOTS).fill(0),
  retries: new Array<number>(BUDGET_SLOTS).fill(0),
  refusedSinceWarning: 0,
  lastWarningAt: Number.NEGATIVE_INFINITY,
};

function budgetSlot(now: number): number {
  const second = Math.floor(now / BUDGET_SLOT_MS);
  const slot = second % BUDGET_SLOTS;
  if (budget.slotSecond[slot] !== second) {
    budget.slotSecond[slot] = second;
    budget.calls[slot] = 0;
    budget.retries[slot] = 0;
  }
  return slot;
}

/**
 * The calls and retries counted in the current 10 s window.
 *
 * @returns The window totals, for tests and diagnostics.
 */
export function databaseRetryBudgetUsage(now: number = performance.now()): { calls: number; retries: number } {
  const oldest = Math.floor(now / BUDGET_SLOT_MS) - BUDGET_SLOTS;
  let calls = 0;
  let retries = 0;
  for (let slot = 0; slot < BUDGET_SLOTS; slot += 1) {
    if (budget.slotSecond[slot] > oldest) {
      calls += budget.calls[slot];
      retries += budget.retries[slot];
    }
  }
  return { calls, retries };
}

/** Clears the process-wide retry budget. Tests and fault runs call it between trials. */
export function resetDatabaseRetryBudget(): void {
  budget.slotSecond.fill(-1);
  budget.calls.fill(0);
  budget.retries.fill(0);
  budget.refusedSinceWarning = 0;
  budget.lastWarningAt = Number.NEGATIVE_INFINITY;
}

function takeRetryToken(now: number): boolean {
  const { calls, retries } = databaseRetryBudgetUsage(now);
  if (retries < calls + BUDGET_RESERVE) {
    budget.retries[budgetSlot(now)] += 1;
    return true;
  }
  budget.refusedSinceWarning += 1;
  if (now - budget.lastWarningAt >= BUDGET_WARNING_INTERVAL_MS) {
    logger.warn(
      { refusedRetries: budget.refusedSinceWarning, windowCalls: calls, windowRetries: retries },
      "database retry budget refused retries",
    );
    budget.refusedSinceWarning = 0;
    budget.lastWarningAt = now;
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry only an explicitly idempotent operation, such as a known read-only
 * lookup or receipt-protected synchronization. Neither a SQL prefix nor a
 * connection error message proves replay safety: a disconnected write may
 * already have committed. Callers own this proof for the entire callback.
 *
 * A transient failure is retried up to five times (six attempts) after
 * jittered sleeps that start at 50 ms and double, about 1.9 s at most, which
 * outlasts a pool-wide recycle and a short failover. From the third attempt
 * on, an attempt slower than 2 s ends the retries, so a hung database costs at
 * most three slow attempts. Every retry takes a token from a process-wide
 * budget; a refused retry throws the last error at once. An abort of `signal`
 * stops the wait and rejects with the abort reason. Persistent failures
 * propagate the original error.
 *
 * @param run The idempotent operation; it is called once per attempt.
 * @param options `isTransient` picks the retryable errors (default: the
 *   postgres.js connection codes); `signal` stops further attempts.
 * @returns The first successful result.
 */
export async function retryIdempotentDatabaseOperation<T>(
  run: () => Promise<T>,
  options: { isTransient?: (error: unknown) => boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const isTransient = options.isTransient ?? isTransientDbConnectionError;
  const { signal } = options;
  signal?.throwIfAborted();
  budget.calls[budgetSlot(performance.now())] += 1;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = performance.now();
    try {
      return await run();
    } catch (error) {
      const now = performance.now();
      if (attempt > MAX_RETRIES || !isTransient(error)) throw error;
      if (attempt >= SLOW_ATTEMPT_CAP_FROM && now - startedAt > SLOW_ATTEMPT_MS) throw error;
      if (signal?.aborted) throw signal.reason;
      if (!takeRetryToken(now)) throw error;
      const jitter = JITTER_MIN + Math.random() * JITTER_SPREAD;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) * jitter, signal);
    }
  }
}
