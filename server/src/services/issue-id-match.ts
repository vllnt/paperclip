import { sql, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

const CANONICAL_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * `issues.id = <text expression>` as a typed uuid comparison, so the primary key
 * index is usable (`issues.id::text = ...` is not). It matches exactly the same
 * rows: only canonical lowercase uuid text can equal `id::text`, and any other
 * value (including text that is not a uuid) becomes NULL instead of raising.
 */
export function issueIdEqualsText(textExpr: SQL | string): SQL {
  return sql`${issues.id} = (CASE WHEN ${textExpr} ~ ${CANONICAL_UUID_PATTERN} THEN (${textExpr})::uuid END)`;
}
