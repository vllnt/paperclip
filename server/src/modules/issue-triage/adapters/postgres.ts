import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, issues } from "@paperclipai/db";
import {
  ISSUE_PRIORITIES,
  ISSUE_TRIAGE_ACTIVITY_ACTION,
  isAgentInvokable,
  issueTriageEntrySchema,
} from "@paperclipai/shared";
import { redactSensitiveText } from "../../../redaction.js";
import { logActivity } from "../../../services/activity-log.js";
import { assertAssignableAgent } from "../../../services/agent-assignability.js";
import { prepareIssueText } from "../../../services/duplicate-lexical.js";
import type { TriageRecordInput, TriageRow, TriageStore } from "../application/ports.js";

export const TRIAGE_ACTOR_ID = "issue-triage";

/** An entry that does not match the schema (an older or foreign shape) is ignored, not guessed at. */
function readEntry(details: unknown): TriageRecordInput | null {
  const parsed = issueTriageEntrySchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}

/** Postgres store for issue triage. Every statement is scoped by `company_id`. */
export function createPostgresTriageStore(db: Db): TriageStore {
  return {
    async getMode(companyId) {
      const [row] = await db
        .select({ mode: companies.issueTriageMode })
        .from(companies)
        .where(eq(companies.id, companyId));
      return row?.mode ?? "off";
    },

    async loadIssue(ref) {
      const [row] = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          originKind: issues.originKind,
        })
        .from(issues)
        .where(and(eq(issues.id, ref.id), eq(issues.companyId, ref.companyId)));
      if (!row) return null;
      const priority = ISSUE_PRIORITIES.find((candidate) => candidate === row.priority) ?? "medium";
      // The same preparation duplicate detection applies before text leaves the instance:
      // secret-like text is redacted and the description is cut.
      const text = prepareIssueText(row);
      return { ...row, title: text.title, description: text.description, priority };
    },

    async hasTriage(companyId, issueId) {
      const [row] = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, ISSUE_TRIAGE_ACTIVITY_ACTION),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async listOwnerCandidates(companyId) {
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          status: agents.status,
          reportsTo: agents.reportsTo,
          role: agents.role,
          title: agents.title,
          capabilities: agents.capabilities,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      return rows
        .filter((agent) => isAgentInvokable({ agent, agents: rows }))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          title: agent.title,
          capabilities: agent.capabilities === null ? null : redactSensitiveText(agent.capabilities),
        }));
    },

    async assignIfUnassignedTodo({ companyId, issueId, agentId }) {
      try {
        await assertAssignableAgent(db, companyId, agentId, { kind: "work" });
      } catch {
        return { ok: false, reason: "not_assignable" };
      }
      const [row] = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          statusVersion: sql`${issues.statusVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.companyId, companyId),
            eq(issues.status, "todo"),
            isNull(issues.assigneeAgentId),
            isNull(issues.assigneeUserId),
          ),
        )
        .returning({ identifier: issues.identifier, status: issues.status, statusVersion: issues.statusVersion });
      if (!row) return { ok: false, reason: "assignee_changed" };
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: TRIAGE_ACTOR_ID,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: {
          identifier: row.identifier,
          assigneeAgentId: agentId,
          source: "issue_triage",
          _previous: { assigneeAgentId: null },
        },
      });
      return { ok: true, status: row.status, statusVersion: row.statusVersion };
    },

    async record(entry) {
      await logActivity(db, {
        companyId: entry.companyId,
        actorType: "system",
        actorId: TRIAGE_ACTOR_ID,
        action: ISSUE_TRIAGE_ACTIVITY_ACTION,
        entityType: "issue",
        entityId: entry.issueId,
        details: { ...entry },
      });
    },

    async listRecords({ companyId, issueId, limit, after }) {
      const rows = await db
        .select({ id: activityLog.id, createdAt: activityLog.createdAt, details: activityLog.details })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, ISSUE_TRIAGE_ACTIVITY_ACTION),
            after
              ? sql`(${activityLog.createdAt}, ${activityLog.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .limit(limit);
      return rows.flatMap((row): TriageRow[] => {
        const entry = readEntry(row.details);
        return entry ? [{ id: row.id, createdAt: row.createdAt, entry }] : [];
      });
    },
  };
}
