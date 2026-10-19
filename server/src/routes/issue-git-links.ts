import { Router } from "express";
import type { Request } from "express";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { isUuidLike, linkIssuePullRequestSchema, normalizeIssueIdentifier } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { extractGitHubPullRequestReferences } from "../services/github-pull-request-merge.js";
import { issueGitLinkService } from "../services/issue-git-links.js";
import { accessService } from "../services/access.js";
import { issueService } from "../services/issues.js";
import { getAccessibleResource, getActorInfo } from "./authz.js";

/**
 * The git panel of a task: the branch to copy and the pull requests linked to it.
 *
 * Reads follow normal company access. Writes by an agent are limited to tasks assigned to
 * that agent; board users with access to the company may link and unlink on any task.
 */
export function issueGitLinkRoutes(db: Db, options: { git?: ReturnType<typeof issueGitLinkService> } = {}) {
  const router = Router();
  const issuesSvc = issueService(db);
  const access = accessService(db);
  const git = options.git ?? issueGitLinkService(db);

  router.param("id", async (req, _res, next, rawId) => {
    try {
      const identifier = normalizeIssueIdentifier(rawId);
      const issue = identifier ? await issuesSvc.getByIdentifier(identifier) : null;
      req.params.id = issue?.id ?? rawId;
      next();
    } catch (error) {
      next(error);
    }
  });

  async function findIssue(req: Request, res: Parameters<typeof getAccessibleResource>[1]) {
    const id = req.params.id as string;
    if (!isUuidLike(id)) {
      res.status(404).json({ error: "Issue not found" });
      return null;
    }
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(id), "Issue not found");
    if (!issue) return null;
    const scope = {
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    };
    const decision = await access.decide({
      actor: req.actor,
      action: req.method === "GET" || req.method === "HEAD" ? "issue:read" : "issue:mutate",
      resource: { type: "issue", companyId: issue.companyId, status: issue.status, ...scope },
      scope,
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
      return null;
    }
    return issue;
  }

  /**
   * A pull request is a deliverable. A status-only recovery run is told it may not change
   * deliverables, so it may not change links either; the work-product routes enforce the same rule.
   */
  async function assertRunMayChangeDeliverables(req: Request, companyId: string) {
    const runId = req.actor.type === "agent" ? req.actor.runId?.trim() : null;
    if (!runId) return;
    const [run] = await db
      .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return;
    const context = run.context && typeof run.context === "object" && !Array.isArray(run.context) ? (run.context as Record<string, unknown>) : {};
    if (context.recoveryIntent === "status_only" && context.allowDeliverableWork === false) {
      throw forbidden("Status-only recovery runs cannot change pull request links");
    }
  }

  async function assertMayLink(req: Request, issue: { assigneeAgentId: string | null; companyId: string }) {
    if (req.actor.type !== "agent") return;
    if (issue.assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only link pull requests on tasks assigned to them");
    }
    await assertRunMayChangeDeliverables(req, issue.companyId);
  }

  router.get("/issues/:id/git", async (req, res) => {
    const issue = await findIssue(req, res);
    if (!issue) return;
    res.json(await git.getView(issue.id, issue.companyId));
  });

  router.post("/issues/:id/git/pull-requests", validate(linkIssuePullRequestSchema), async (req, res) => {
    const issue = await findIssue(req, res);
    if (!issue) return;
    await assertMayLink(req, issue);

    const body = req.body as { url?: string; repository?: string; number?: number; closes?: boolean };
    const reference = body.url
      ? extractGitHubPullRequestReferences([body.url])[0]
      : { owner: body.repository!.split("/")[0]!, repo: body.repository!.split("/")[1]!, number: body.number! };
    if (!reference) throw unprocessable("Use the URL of a github.com pull request");
    const repository = `${reference.owner}/${reference.repo}`.toLowerCase();

    const actor = getActorInfo(req);
    const result = await git.linkPullRequest(
      issue.id,
      issue.companyId,
      { repository, number: reference.number, closes: body.closes },
      actor.actorType === "agent" ? "agent" : "manual",
    );
    const link = result.links[0];
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.git_pull_request_linked",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: { identifier: issue.identifier, repository, number: reference.number, closes: body.closes ?? true },
    });
    res.status(link?.created ? 201 : 200).json(await git.getView(issue.id, issue.companyId));
  });

  router.delete("/issues/:id/git/pull-requests/:workProductId", async (req, res) => {
    const issue = await findIssue(req, res);
    if (!issue) return;
    await assertMayLink(req, issue);
    const workProductId = req.params.workProductId as string;
    if (!isUuidLike(workProductId)) {
      res.status(404).json({ error: "Pull request link not found" });
      return;
    }

    const outcome = await git.unlinkPullRequest(issue.id, issue.companyId, workProductId);
    if (outcome === "not_found") {
      res.status(404).json({ error: "Pull request link not found" });
      return;
    }
    if (outcome === "unlinked") {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.git_pull_request_unlinked",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: { identifier: issue.identifier, workProductId },
      });
    }
    res.status(204).end();
  });

  return router;
}
