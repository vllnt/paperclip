import { sql, type AnyColumn, type SQL } from "drizzle-orm";

// The text Postgres gives a uuid (`id::text`): lowercase and hyphenated.
// Not `isUuidLike` from @paperclipai/shared: it ignores case and trims, so it
// would let through text that `id::text` comparisons never matched.
const CANONICAL_UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `value` can equal some uuid column's `::text`. Any other string never does. */
export function isCanonicalUuidText(value: string): boolean {
  return CANONICAL_UUID_TEXT.test(value);
}

/** `column::text = text`, written so an index on the uuid column serves it.
 * Text in any other form matches no row, as the text comparison would, and is
 * never cast, so malformed text cannot raise a uuid cast error.
 */
export function uuidColumnEqualsText(column: AnyColumn, text: SQL): SQL {
  return sql`${column} = case when (${text}) ~ ${CANONICAL_UUID_TEXT.source} then (${text})::uuid end`;
}
