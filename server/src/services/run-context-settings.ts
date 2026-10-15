import { and, eq } from "drizzle-orm";
import { agents, companies, issues, routines, type Db } from "@paperclipai/db";
import { resolveRunContextSettings, type ResolvedRunContextSettings } from "@paperclipai/shared";

/**
 * Load the company, agent and routine run-context policies that apply to a run
 * and resolve them with the wake reason. The routine is the one that created
 * the run's issue (`routine_execution` origin). Unset levels fall back to the
 * pre-setting behavior.
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
  const company = await db
    .select({ policy: companies.runContextPolicy })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const agent = agentId
    ? await db
        .select({ runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const origin = issueId
    ? await db
        .select({ originKind: issues.originKind, originId: issues.originId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const routine =
    origin?.originKind === "routine_execution" && origin.originId
      ? await db
          .select({ policy: routines.runContextPolicy })
          .from(routines)
          .where(and(eq(routines.id, origin.originId), eq(routines.companyId, companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
  return resolveRunContextSettings(
    {
      company: company?.policy,
      agent: agent?.runtimeConfig?.runContext,
      routine: routine?.policy,
    },
    input.wakeReason,
  );
}
