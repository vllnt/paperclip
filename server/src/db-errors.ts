const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const RESTRICT_VIOLATION = "23001";
const INVALID_TEXT_REPRESENTATION = "22P02";
const LOCK_NOT_AVAILABLE = "55P03";
const DEADLOCK_DETECTED = "40P01";
const MAX_CAUSE_DEPTH = 4;

/**
 * Recognizes a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * Drizzle wraps driver failures in its own `Failed query: ...` error, so the
 * Postgres error that carries the code and the constraint name is reachable
 * only through `cause` — inspecting the thrown error directly misses it. The
 * constraint name itself lands on `constraint_name` under postgres.js and on
 * `constraint` under node-postgres, and is not always surfaced at all, so fall
 * back to the driver message.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.code === UNIQUE_VIOLATION) {
      if (!constraintName) return true;
      const constraint = candidate.constraint ?? candidate.constraint_name;
      if (constraint === constraintName) return true;
      if (typeof candidate.message === "string" && candidate.message.includes(constraintName)) return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Recognizes a Postgres foreign-key-constraint violation: SQLSTATE 23503, or
 * 23001 for a reference declared `ON DELETE RESTRICT`.
 *
 * A delete that leaves an orphan reference raises 23503. A `RESTRICT`
 * reference raises 23001 instead, so a caller that maps only 23503 lets that
 * refusal fall through as a bare 500. Drizzle wraps the driver failure in its
 * own `Failed query: ...` error, so the Postgres error that carries the code
 * is reachable only through `cause`. This helper walks the `cause` chain, the
 * same way `isUniqueViolation` does.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPostgresCode(error, FOREIGN_KEY_VIOLATION) || hasPostgresCode(error, RESTRICT_VIOLATION);
}

/**
 * Recognizes a Postgres invalid_text_representation error (SQLSTATE 22P02).
 *
 * Postgres raises it when a value cannot be parsed as the column type, most
 * often a request path segment such as `not-a-uuid` bound to a uuid column.
 * Like the other helpers here, it walks the `cause` chain because Drizzle
 * wraps the driver error.
 */
export function isInvalidTextRepresentation(error: unknown): boolean {
  return hasPostgresCode(error, INVALID_TEXT_REPRESENTATION);
}

/**
 * Recognizes lock contention: a statement that gave up waiting for a lock because it hit
 * `lock_timeout` (SQLSTATE 55P03), or a transaction that Postgres chose to cancel to break a
 * deadlock (40P01). Both leave the transaction rolled back, and the same request can work when
 * it is tried again. Like the other helpers here, it walks the `cause` chain because Drizzle wraps
 * the driver error.
 *
 * @param error - The error thrown by a query, possibly wrapped by Drizzle.
 * @returns Whether the error is a lock timeout or a deadlock.
 */
export function isLockContention(error: unknown): boolean {
  return hasPostgresCode(error, LOCK_NOT_AVAILABLE) || hasPostgresCode(error, DEADLOCK_DETECTED);
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

/** The constraint and the referencing table of a foreign-key violation. A name is null when the driver did not surface it. */
export interface ForeignKeyViolationDetails {
  constraint: string | null;
  table: string | null;
}

const FOREIGN_KEY_MESSAGE = /violates (?:RESTRICT setting of )?foreign key constraint "([^"]+)" on table "([^"]+)"/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads the constraint name and the referencing table from a foreign-key
 * violation (SQLSTATE 23503, or 23001 for a `RESTRICT` reference), or returns
 * null for any other error.
 *
 * The names land on `constraint_name` and `table_name` under postgres.js and on
 * `constraint` and `table` under node-postgres. When the driver surfaces
 * neither, the names are read from the driver message. The walk follows `cause`
 * the same way `isForeignKeyViolation` does.
 *
 * @param error - The error thrown by a query, possibly wrapped by Drizzle.
 * @returns The names the driver reported, or null when the error is not a foreign-key violation.
 */
export function readForeignKeyViolation(error: unknown): ForeignKeyViolationDetails | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth += 1) {
    if (current.code === FOREIGN_KEY_VIOLATION || current.code === RESTRICT_VIOLATION) {
      const fromMessage = typeof current.message === "string" ? FOREIGN_KEY_MESSAGE.exec(current.message) : null;
      return {
        constraint: readName(current.constraint_name) ?? readName(current.constraint) ?? fromMessage?.[1] ?? null,
        table: readName(current.table_name) ?? readName(current.table) ?? fromMessage?.[2] ?? null,
      };
    }
    current = current.cause;
  }
  return null;
}
