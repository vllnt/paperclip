import { and, eq, sql } from "drizzle-orm";
import { agents, companies, issues, routines, type Db } from "@paperclipai/db";
import { resolveRunContextSettings, type ResolvedRunContextSettings } from "@paperclipai/shared";

/**
 * Load the company, agent and routine run-context policies that apply to a run
 * and resolve them with the wake reason. The routine is the one that created
 * the run's issue (`routine_execution` origin). Unset levels fall back to the
 * pre-setting behavior. The levels load in a single query.
 *
 * @param input.db Database handle.
 * @param input.companyId Company that owns the run.
 * @param input.agentId Agent being woken, if known.
 * @param input.issueId Issue in the wake context, if any.
 * @param input.wakeReason The run's wake reason, if any.
 * @returns Effective settings for the run.
 */
export async function loadRunContextSettings(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  issueId?: string | null;
  wakeReason?: string | null;
}): Promise<ResolvedRunContextSettings> {
  const { db, companyId, agentId, issueId } = input;
  // One round trip for every level: the agent, the issue and its originating
  // routine are left-joined to the company, each pinned to the company so a
  // foreign id resolves to nothing. The routine joins only for issues that a
  // routine execution created.
  const row = await db
    .select({
      companyPolicy: companies.runContextPolicy,
      agentRuntimeConfig: agents.runtimeConfig,
      routinePolicy: routines.runContextPolicy,
    })
    .from(companies)
    .leftJoin(
      agents,
      agentId ? and(eq(agents.id, agentId), eq(agents.companyId, companyId)) : sql`false`,
    )
    .leftJoin(
      issues,
      issueId ? and(eq(issues.id, issueId), eq(issues.companyId, companyId)) : sql`false`,
    )
    .leftJoin(
      routines,
      and(
        eq(issues.originKind, "routine_execution"),
        sql`${routines.id}::text = ${issues.originId}`,
        eq(routines.companyId, companyId),
      ),
    )
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return resolveRunContextSettings(
    {
      company: row?.companyPolicy,
      agent: row?.agentRuntimeConfig?.runContext,
      routine: row?.routinePolicy,
    },
    input.wakeReason,
  );
}
