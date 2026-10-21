import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { readRunContextIssueId } from "../../../services/run-context-issue-id.js";
import type { RunContextPort } from "../application/ports.js";

/**
 * Checks the run id and issue that a caller sends before a run row stores them.
 *
 * Only an agent token carries a signed run id. An agent key and a board caller send the
 * `X-Paperclip-Run-Id` header, which the auth middleware takes as it is. So the run is looked up by
 * id and company and, for an agent, by agent id. A value that is not a UUID, or a run that does not
 * match, gives null and never fails the call. The issue comes from the request body, or else from the
 * verified run's context, and must be an issue of the same company.
 */
export function createPostgresRunContext(db: Db): RunContextPort {
  return {
    async verify({ companyId, actor, runId, issueId }) {
      let heartbeatRunId: string | null = null;
      let runIssueId: string | null = null;
      const verifiedRunId = runId?.trim() ?? null;
      if (verifiedRunId !== null && isUuidLike(verifiedRunId)) {
        const conditions = [eq(heartbeatRuns.id, verifiedRunId), eq(heartbeatRuns.companyId, companyId)];
        if (actor.type === "agent") conditions.push(eq(heartbeatRuns.agentId, actor.agentId));
        const [run] = await db
          .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(...conditions));
        if (run) {
          heartbeatRunId = run.id;
          runIssueId = readRunContextIssueId(run.contextSnapshot);
        }
      }
      const candidate = issueId ?? runIssueId;
      if (candidate === null) {
        return { heartbeatRunId, issueId: null, projectId: null, requestedIssueMissing: false };
      }
      const [issue] = await db
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, candidate), eq(issues.companyId, companyId)));
      return {
        heartbeatRunId,
        issueId: issue?.id ?? null,
        projectId: issue?.projectId ?? null,
        requestedIssueMissing: issueId !== null && !issue,
      };
    },
  };
}
