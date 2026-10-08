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

/**
 * Retry only an explicitly idempotent operation, such as a known read-only
 * lookup or receipt-protected synchronization. Neither a SQL prefix nor a
 * connection error message proves replay safety: a disconnected write may
 * already have committed. Callers own this proof for the entire callback.
 *
 * Two replays allow for a pool-wide recycle where the first replay draws
 * another stale socket. The pauses give the driver time to replace them.
 * Persistent failures still propagate after three total attempts.
 */
export async function retryIdempotentDatabaseOperation<T>(
  run: () => Promise<T>,
  options: { isTransient?: (error: unknown) => boolean } = {},
): Promise<T> {
  const isTransient = options.isTransient ?? isTransientDbConnectionError;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 2 || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
