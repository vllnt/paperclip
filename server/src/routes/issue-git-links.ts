import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { isUuidLike, linkIssuePullRequestSchema, normalizeIssueIdentifier } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { extractGitHubPullRequestReferences } from "../services/github-pull-request-merge.js";
import { issueGitLinkService } from "../services/issue-git-links.js";
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
    return getAccessibleResource(req, res, issuesSvc.getById(id), "Issue not found");
  }

  function assertMayLink(req: Request, issue: { assigneeAgentId: string | null }) {
    if (req.actor.type === "agent" && issue.assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only link pull requests on tasks assigned to them");
    }
  }

  router.get("/issues/:id/git", async (req, res) => {
    const issue = await findIssue(req, res);
    if (!issue) return;
    res.json(await git.getView(issue.id, issue.companyId));
  });

  router.post("/issues/:id/git/pull-requests", validate(linkIssuePullRequestSchema), async (req, res) => {
    const issue = await findIssue(req, res);
    if (!issue) return;
    assertMayLink(req, issue);

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
    assertMayLink(req, issue);
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
