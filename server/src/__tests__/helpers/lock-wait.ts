import { sql } from "drizzle-orm";
import type { createDb } from "@paperclipai/db";

/**
 * Resolves once a statement waits for a lock that another transaction holds, so a test can let the
 * holder go on at exactly that point of a race.
 * @throws Error when nothing waits within `timeoutMs`.
 */
export async function untilAStatementWaitsForALock(db: ReturnType<typeof createDb>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await db.execute(sql`select 1 from pg_locks where not granted limit 1`)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No statement waited for a lock");
}
