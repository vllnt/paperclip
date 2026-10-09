import { sql, type SQL } from "drizzle-orm";
import { issueWorkProducts } from "@paperclipai/db";

/**
 * Leaves out pull requests a person unlinked from a task. The row stays stored so that
 * automatic matching keeps it unlinked, but the task no longer counts it as its own.
 */
export function linkedWorkProductCondition(): SQL {
  return sql`coalesce(${issueWorkProducts.metadata} #>> '{git,suppressed}', 'false') <> 'true'`;
}
