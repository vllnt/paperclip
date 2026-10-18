import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { isLockContention, readForeignKeyViolation, type ForeignKeyViolationDetails } from "../db-errors.js";
import { conflict, type HttpError } from "../errors.js";

/** The `details.code` of the 409 that a company delete returns when it could not get its locks in time. Trying again can work. */
export const COMPANY_DELETE_BUSY = "company_delete_busy";

interface BlockingRows {
  total: number;
  ownedByOtherCompanies: boolean;
}

function readBlockingKey(row: Record<string, unknown>): {
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  childHasCompanyId: boolean;
} | null {
  const { child_column: childColumn, parent_table: parentTable, parent_column: parentColumn } = row;
  const childHasCompanyId = row.has_company_id;
  if (typeof childColumn !== "string" || typeof parentTable !== "string" || typeof parentColumn !== "string") {
    return null;
  }
  if (typeof childHasCompanyId !== "boolean") return null;
  return { childColumn, parentTable, parentColumn, childHasCompanyId };
}

/**
 * Counts the rows that block a company delete through a single-column foreign
 * key: rows of the referencing table that point at a row of the deleted company.
 * Rows that the deleted company owns are not counted, because the delete has
 * already removed them. Returns null for a composite key, for a parent without a
 * `company_id` column, and when the lookup fails.
 */
async function countBlockingRows(
  db: Db,
  companyId: string,
  violation: ForeignKeyViolationDetails,
): Promise<BlockingRows | null> {
  if (!violation.constraint || !violation.table) return null;
  try {
    const keys = await db.execute(sql`
      SELECT child_attribute.attname AS child_column,
        parent_class.relname AS parent_table,
        parent_attribute.attname AS parent_column,
        EXISTS (
          SELECT 1 FROM pg_attribute owner_attribute
          WHERE owner_attribute.attrelid = constraint_row.conrelid
            AND owner_attribute.attname = 'company_id'
            AND NOT owner_attribute.attisdropped
        ) AS has_company_id
      FROM pg_constraint constraint_row
      JOIN pg_class child_class ON child_class.oid = constraint_row.conrelid
      JOIN pg_class parent_class ON parent_class.oid = constraint_row.confrelid
      JOIN pg_attribute child_attribute
        ON child_attribute.attrelid = constraint_row.conrelid AND child_attribute.attnum = constraint_row.conkey[1]
      JOIN pg_attribute parent_attribute
        ON parent_attribute.attrelid = constraint_row.confrelid AND parent_attribute.attnum = constraint_row.confkey[1]
      WHERE constraint_row.conname = ${violation.constraint}
        AND child_class.relname = ${violation.table}
        AND array_length(constraint_row.conkey, 1) = 1
    `);
    const first = Array.from(keys)[0];
    const key = first ? readBlockingKey(first) : null;
    if (!key) return null;

    const ownerFilter = key.childHasCompanyId ? sql`AND child.company_id IS DISTINCT FROM ${companyId}` : sql``;
    const counted = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM ${sql.identifier(violation.table)} AS child
      WHERE child.${sql.identifier(key.childColumn)} IN (
        SELECT ${sql.identifier(key.parentColumn)} FROM ${sql.identifier(key.parentTable)} WHERE company_id = ${companyId}
      )
      ${ownerFilter}
    `);
    const total = Array.from(counted)[0]?.total;
    return typeof total === "number" ? { total, ownedByOtherCompanies: key.childHasCompanyId } : null;
  } catch {
    return null;
  }
}

/**
 * Turns a failure of a company delete that is the request's fault, or only a bad moment, into a 409.
 * A foreign-key failure becomes a 409 that names the blocking table and counts the blocking rows.
 * A lock timeout or a deadlock becomes a 409 with the code `company_delete_busy`, and trying again
 * can work. The delete runs in one transaction, so by the time this runs nothing has been deleted.
 *
 * @param db - A database handle outside the failed transaction.
 * @param companyId - The company whose delete failed.
 * @param error - The error thrown by the delete.
 * @returns A 409 for a foreign-key violation or lock contention, or null when the error is something else.
 */
export async function explainBlockedCompanyRemoval(
  db: Db,
  companyId: string,
  error: unknown,
): Promise<HttpError | null> {
  if (isLockContention(error)) {
    return conflict(
      "Company delete could not get the locks it needs, because other requests are writing this company's data. Nothing was deleted. Try again.",
      { code: COMPANY_DELETE_BUSY },
    );
  }
  const violation = readForeignKeyViolation(error);
  if (!violation) return null;

  const blocking = await countBlockingRows(db, companyId, violation);
  const where = violation.table ? `in ${violation.table}` : "in another table";
  const rows = blocking && blocking.total > 0 ? `${blocking.total} row(s)` : "rows";
  const owner = blocking?.ownedByOtherCompanies && blocking.total > 0 ? " that belong to other companies and" : " that";
  return conflict(
    `Company delete is blocked by ${rows} ${where}${owner} still reference this company's data. Nothing was deleted.`,
    {
      table: violation.table,
      constraint: violation.constraint,
      blockingRows: blocking?.total ?? null,
    },
  );
}
