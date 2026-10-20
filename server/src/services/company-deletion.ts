import { agentObservabilityService } from "./agent-observability.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import type { Db } from "@paperclipai/db";
import { count, eq, getTableName } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { createAgentLifecycle, scheduleAgentLifecycle } from "./agent-lifecycle.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import {
  companies,
  agents,
  companyLogos,
  assets,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  runIdentityContexts,
  heartbeatRunEvents,
  runUsageRecords,
  costEvents,
  decisionInvocations,
  fastResponseRequests,
  financeEvents,
  budgetPolicies,
  budgetIncidents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  documents,
  routineRuns,
  routineTriggers,
  routineRevisions,
  routines,
  browserUseBrowsers,
  browserUseRuns,
  browserUseSessions,
  browserUseSettings,
  chatEndpoints,
  completionContracts,
  decisionArchiveNotificationOutbox,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTriage,
  decisionTriageEvents,
  decisions,
  grokBotRoutines,
  inboxDismissals,
  nativeRunFinalizations,
  nativeRunResults,
  secretAccessEvents,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  workspaceRuntimeServices,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatGitHubReviews,
  chatMessageLinks,
  chatPublications,
  chatTeamsFileTransfers,
  chatVoiceInboundCalls,
  chatVoiceReplies,
  chatVoiceSessions,
  chatVoiceToolCalls,
  companySkillTestRuns,
  managedAgentProfiles,
  toolMcpGateways,
  issueDuplicatePairs,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { explainBlockedCompanyRemoval } from "./company-removal-conflict.js";
import { assertNoCrossCompanyReferences, lockCompanyForRemoval } from "./company-removal-cross-company.js";

/** Who asked for a company delete, and how long it waits for locks. */
export interface CompanyRemovalOptions {
  /** The user that the request authenticated as. An identifier, never a credential. */
  actorUserId?: string | null;
  /** The id of the board key record that the request used, when it used one. An identifier, never a credential. */
  actorKeyId?: string | null;
  /** The longest wait for one lock, in milliseconds. Defaults to 5 seconds. */
  lockTimeoutMs?: number;
}

type DeletionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Reads how many rows a delete without `returning` removed. The postgres.js driver puts it
 * on the result as `count`. Another driver may not, and then the log entry lists no rows.
 */
function affectedRows(result: unknown): number {
  if (typeof result !== "object" || result === null) return 0;
  const total: unknown = Reflect.get(result, "count");
  return typeof total === "number" ? total : 0;
}

/**
 * Deletes a company and every row it owns, in one transaction. Each table is
 * deleted only by its own `company_id`, so no delete here names another company's rows.
 *
 * Two kinds of reference can still reach another company. A cascade or set-null key
 * would delete a row of another company, or clear its reference, when it points at a
 * row of this company: `assertNoCrossCompanyReferences` finds these first, before any
 * delete, and the call fails with a 409 and the code
 * `company_delete_cross_company_references`. A key that blocks the delete is stopped by
 * the database: the call fails with a 409 that names the blocking table. Either way
 * nothing is deleted.
 *
 * The check only holds if no such row can appear after it. So the transaction first
 * locks the company row and the rows of this company that other rows could point at
 * (`lockCompanyForRemoval`). A write that would add such a reference waits, and fails
 * with a foreign-key error once the delete commits. If a lock cannot be had within the
 * limit, or Postgres ends the transaction to break a deadlock, the call fails with a 409
 * and the code `company_delete_busy`, and trying again can work.
 *
 * External cleanup runs before that transaction: agents are terminated through the
 * agent lifecycle, and only after the same locks and check have passed once, so a refused
 * delete stops no agent. The transaction runs under the account-home secret mutation lock,
 * which is taken before any database lock. It purges agents through the lifecycle, which
 * refuses an agent whose termination has not completed.
 *
 * After the commit it writes one `company_deleted` log entry with the actor and the
 * number of rows removed per table. It holds no names and no content.
 *
 * The order below is checked against the live foreign keys by
 * `company-removal-coverage.test.ts`: a table with a blocking key to any row
 * that this function deletes must be deleted here before that row.
 */
export async function deleteCompany(db: Db, id: string, audit: CompanyRemovalOptions = {}) {
  const guard = async (tx: DeletionTransaction) => {
    await lockCompanyForRemoval(tx, id, audit.lockTimeoutMs);
    await assertNoCrossCompanyReferences(tx, id);
  };
  try {
    await db.transaction(guard);
    const lifecycle = createAgentLifecycle(db);
    const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, id));
    for (const agent of companyAgents) {
      await lifecycle.terminateAgent(agent.id);
      await scheduleAgentLifecycle(db, agent.id);
    }
    const outcome = await withAccountHomeSecretMutationLock(undefined, id, () => db.transaction(async (tx) => {
      await guard(tx);
      await agentObservabilityService(tx as unknown as Db).removeForCompanyDeletion(id);
      const rowCounts: Record<string, number> = {};
      const removeOwned = async <TTable extends PgTable & { companyId: AnyPgColumn }>(table: TTable): Promise<void> => {
        const removed = affectedRows(await tx.delete(table).where(eq(table.companyId, id)));
        if (removed > 0) rowCounts[getTableName(table)] = removed;
      };
      await removeOwned(heartbeatRunEvents);
      await removeOwned(agentTaskSessions);
      await removeOwned(activityLog);
      await removeOwned(runIdentityContexts);
      await removeOwned(runUsageRecords);
      await removeOwned(financeEvents);
      await removeOwned(nativeRunFinalizations);
      await removeOwned(statusDecisionEffects);
      await removeOwned(statusDecisions);
      await removeOwned(decisionInvocations);
      await removeOwned(fastResponseRequests);
      await removeOwned(costEvents);
      await removeOwned(decisionTriageEvents);
      await removeOwned(workAssessments);
      await removeOwned(browserUseRuns);
      await removeOwned(decisionBundles);
      await removeOwned(decisionQueueItems);
      await removeOwned(decisionQueues);
      await removeOwned(decisionRetention);
      await removeOwned(decisionTriage);
      await removeOwned(decisions);
      await removeOwned(nativeRunResults);
      await removeOwned(heartbeatRuns);
      await removeOwned(agentWakeupRequests);
      await removeOwned(agentApiKeys);
      await removeOwned(agentRuntimeState);
      // Voice rows point at sessions, publications, deliveries, conversations, issues,
      // endpoints and agents without a delete action.
      await removeOwned(chatVoiceReplies);
      await removeOwned(chatVoiceToolCalls);
      await removeOwned(chatVoiceInboundCalls);
      await removeOwned(chatVoiceSessions);
      await removeOwned(chatMessageLinks);
      await removeOwned(chatPublications);
      await removeOwned(issueComments);
      await removeOwned(issueDuplicatePairs);
      await removeOwned(approvalComments);
      await removeOwned(budgetIncidents);
      await removeOwned(approvals);
      await removeOwned(managedAgentProfiles);
      await removeOwned(grokBotRoutines);
      await removeOwned(companySecrets);
      await removeOwned(joinRequests);
      await removeOwned(invites);
      await removeOwned(principalPermissionGrants);
      await removeOwned(companyMemberships);
      await removeOwned(companySkillTestRuns);
      await removeOwned(companySkills);
      await removeOwned(routineRuns);
      await removeOwned(routineTriggers);
      await removeOwned(routineRevisions);
      await removeOwned(routines);
      await removeOwned(issueReadStates);
      await removeOwned(browserUseBrowsers);
      await removeOwned(documents);
      await removeOwned(browserUseSessions);
      await removeOwned(chatActions);
      await removeOwned(chatDeliveries);
      await removeOwned(completionContracts);
      await removeOwned(chatConversations);
      await removeOwned(chatGitHubReviews);
      await removeOwned(chatTeamsFileTransfers);
      await removeOwned(issues);
      await removeOwned(companyLogos);
      await removeOwned(assets);
      await removeOwned(executionWorkspaces);
      await removeOwned(projects);
      await removeOwned(goals);
      await removeOwned(chatEndpoints);
      await removeOwned(decisionArchiveNotificationOutbox);
      // The agent lifecycle owns the agent purge; it refuses an agent whose termination is not complete.
      const [agentRows] = await tx.select({ total: count() }).from(agents).where(eq(agents.companyId, id));
      await agentLifecycleCompanyDeletion.deleteCompanyData(tx, id);
      if (agentRows && agentRows.total > 0) rowCounts[getTableName(agents)] = agentRows.total;
      await removeOwned(browserUseSettings);
      await removeOwned(budgetPolicies);
      await removeOwned(inboxDismissals);
      await removeOwned(secretAccessEvents);
      await removeOwned(workspaceRuntimeServices);
      await removeOwned(toolMcpGateways);
      const rows = await tx
        .delete(companies)
        .where(eq(companies.id, id))
        .returning();
      const company = rows[0] ?? null;
      if (company) rowCounts[getTableName(companies)] = 1;
      return { company, rowCounts };
    }));
    if (outcome.company) {
      logger.info(
        {
          event: "company_deleted",
          companyId: id,
          actorUserId: audit.actorUserId ?? null,
          actorKeyId: audit.actorKeyId ?? null,
          rowCounts: outcome.rowCounts,
        },
        "Company deleted",
      );
    }
    return outcome.company;
  } catch (error) {
    throw (await explainBlockedCompanyRemoval(db, id, error)) ?? error;
  }
}
