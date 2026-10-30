import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "../../../services/activity-log.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "../../../services/issue-assignment-wakeup.js";
import type { issueService } from "../../../services/issues.js";
import type { TriageAssignmentPort } from "../application/ports.js";
import { TRIAGE_ACTOR_ID, UNASSIGNABLE_AGENT_STATUSES } from "./postgres.js";

type IssueService = ReturnType<typeof issueService>;

type Assigned = { applied: true; id: string; status: string; statusVersion: number };
type NotAssigned = { applied: false; reason: "not_unassigned_todo" | "owner_unavailable" };

/**
 * Fills the assignee of an unassigned `todo` issue through the issue service, so the assignment gets
 * the same bookkeeping as any other (status version, cleared execution locks). The issue row is
 * locked first and the state is read again under that lock: an issue that someone assigned or moved
 * in the meantime is left alone. The wake of the new assignee runs after the commit.
 */
export function createGuardedAssignment(deps: {
  db: Db;
  issues: Pick<IssueService, "update">;
  heartbeat: IssueAssignmentWakeupDeps;
}): TriageAssignmentPort {
  const { db } = deps;
  return {
    async assignIfUnassignedTodo({ companyId, issueId, agentId }) {
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx): Promise<Assigned | NotAssigned> => {
        const [row] = await tx
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            hiddenAt: issues.hiddenAt,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
          .for("update");
        if (!row || row.status !== "todo" || row.assigneeAgentId || row.assigneeUserId || row.hiddenAt) {
          return { applied: false, reason: "not_unassigned_todo" };
        }
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, agentId),
              eq(agents.companyId, companyId),
              notInArray(agents.status, [...UNASSIGNABLE_AGENT_STATUSES]),
            ),
          )
          .for("share");
        if (!agent) return { applied: false, reason: "owner_unavailable" };

        const updated = await deps.issues.update(
          issueId,
          { assigneeAgentId: agentId, companyGuard: companyId },
          tx,
          publications,
        );
        if (!updated || updated.assigneeAgentId !== agentId) return { applied: false, reason: "not_unassigned_todo" };
        await logActivity(
          tx as unknown as Db,
          {
            companyId,
            actorType: "system",
            actorId: TRIAGE_ACTOR_ID,
            action: "issue.triage_assigned",
            entityType: "issue",
            entityId: issueId,
            details: { assigneeAgentId: agentId, previousAssigneeAgentId: null, source: "issue_triage" },
          },
          publications,
        );
        return { applied: true, id: updated.id, status: updated.status, statusVersion: updated.statusVersion };
      });

      if (!result.applied) return result;
      for (const publication of publications) publishActivity(publication);
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        assignmentEvent: true,
        issue: { id: result.id, assigneeAgentId: agentId, status: result.status, statusVersion: result.statusVersion },
        reason: "issue_assigned",
        mutation: "triage_apply",
        contextSource: "issue.triage",
        requestedByActorType: "system",
        requestedByActorId: TRIAGE_ACTOR_ID,
      });
      return { applied: true };
    },
  };
}
