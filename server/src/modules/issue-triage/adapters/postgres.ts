import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, issueTriages } from "@paperclipai/db";
import { logActivity } from "../../../services/activity-log.js";
import type {
  TriageActivityPort,
  TriageAgentsPort,
  TriageIssuePort,
  TriageRecordPort,
  TriageSettingsPort,
} from "../application/ports.js";

export const TRIAGE_ACTOR_ID = "issue-triage";

/** Agents in these states cannot take an assignment. */
export const UNASSIGNABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"] as const;

/** Upper bound on agents read per triage; the grouping then keeps at most 60 groups anyway. */
const MAX_CANDIDATE_AGENTS = 500;

export function createPostgresTriageSettings(db: Db): TriageSettingsPort {
  return {
    async getMode(companyId) {
      const [row] = await db
        .select({ mode: companies.issueTriageMode })
        .from(companies)
        .where(eq(companies.id, companyId));
      return row?.mode ?? "off";
    },
  };
}

export function createPostgresTriageIssues(db: Db): TriageIssuePort {
  return {
    async load(ref) {
      const [row] = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          originKind: issues.originKind,
          hiddenAt: issues.hiddenAt,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(and(eq(issues.id, ref.id), eq(issues.companyId, ref.companyId)));
      if (!row) return null;
      const { hiddenAt, ...facts } = row;
      return { ...facts, hidden: hiddenAt !== null };
    },
  };
}

export function createPostgresTriageAgents(db: Db): TriageAgentsPort {
  return {
    async listCandidates(companyId) {
      return db
        .select({
          id: agents.id,
          role: agents.role,
          title: agents.title,
          openIssues: sql<number>`(
            SELECT count(*)::int FROM ${issues}
            WHERE ${issues.assigneeAgentId} = ${agents.id}
              AND ${issues.companyId} = ${agents.companyId}
              AND ${issues.status} IN ('todo', 'in_progress', 'in_review', 'blocked')
          )`,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), notInArray(agents.status, [...UNASSIGNABLE_AGENT_STATUSES])))
        .orderBy(agents.id)
        .limit(MAX_CANDIDATE_AGENTS);
    },
  };
}

export function createPostgresTriageRecords(db: Db): TriageRecordPort {
  return {
    async find(companyId, issueId) {
      const [row] = await db
        .select()
        .from(issueTriages)
        .where(and(eq(issueTriages.companyId, companyId), eq(issueTriages.issueId, issueId)));
      return row ?? null;
    },
    async save(companyId, issueId, draft) {
      const [row] = await db
        .insert(issueTriages)
        .values({ companyId, issueId, ...draft })
        .onConflictDoUpdate({
          target: [issueTriages.companyId, issueTriages.issueId],
          set: { ...draft, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error("issue triage upsert returned no row");
      return row;
    },
  };
}

export function createPostgresTriageActivity(db: Db): TriageActivityPort {
  return {
    async recorded({ issue, triage }) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: TRIAGE_ACTOR_ID,
        action: "issue.triage_recorded",
        entityType: "issue",
        entityId: issue.id,
        details: {
          triageId: triage.id,
          status: triage.status,
          reason: triage.reason,
          mode: triage.mode,
          suggestedPriority: triage.suggestedPriority,
          category: triage.category,
          suggestedAssigneeAgentId: triage.suggestedAssigneeAgentId,
          applyOutcome: triage.applyOutcome,
          modelId: triage.modelId,
          modelCalls: triage.modelCalls,
        },
      });
    },
  };
}
