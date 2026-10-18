import { Router, type Request } from "express";
import { eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  findSimilarIssuesSchema,
  isUuidLike,
  labelDuplicatePairSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import type { DuplicateDetectionService } from "../services/duplicate-detection.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

function assertNotSkillTestScoped(req: Request): void {
  if (req.actor.type === "agent" && req.actor.keyScope?.kind === "skill_test") {
    throw forbidden("Skill-test run tokens cannot check for duplicates.");
  }
}

/**
 * Duplicate-check endpoints, all company-scoped and open to board and agent keys:
 * - `POST /companies/:companyId/issues/similar` checks a draft before creating an issue.
 * - `GET /issues/:id/duplicate-pairs` lists the ledger rows for an issue. An unauthenticated caller
 *   always gets 401, and another company's issue gets the same 404 as a missing one, so the route
 *   does not reveal which ids exist elsewhere.
 * - `POST /companies/:companyId/issue-duplicate-pairs/:pairId/label` records "duplicate" or "keep_both".
 */
export function issueDuplicateRoutes(db: Db, detection: DuplicateDetectionService): Router {
  const router = Router();

  router.post(
    "/companies/:companyId/issues/similar",
    validate(findSimilarIssuesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertNotSkillTestScoped(req);
      const result = await detection.findSimilar({
        companyId,
        title: req.body.title,
        description: req.body.description,
        parentId: req.body.parentId,
      });
      res.json(result);
    },
  );

  router.get("/issues/:id/duplicate-pairs", async (req, res) => {
    assertAuthenticated(req);
    const idOrIdentifier = req.params.id as string;
    const [issue] = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(isUuidLike(idOrIdentifier) ? eq(issues.id, idOrIdentifier) : eq(issues.identifier, idOrIdentifier));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    res.json(await detection.listPairs(issue.companyId, issue.id));
  });

  router.post(
    "/companies/:companyId/issue-duplicate-pairs/:pairId/label",
    validate(labelDuplicatePairSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertNotSkillTestScoped(req);
      const actor = getActorInfo(req);
      const pairId = req.params.pairId as string;
      if (!isUuidLike(pairId)) throw notFound("Duplicate pair not found");
      const pair = await detection.labelPair(companyId, pairId, req.body.label, {
        type: actor.actorType,
        id: actor.actorId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.duplicate_labeled",
        entityType: "issue",
        entityId: pair.issueId,
        details: { pairId: pair.id, candidateIssueId: pair.candidateIssueId, label: pair.label },
      });
      res.json(pair);
    },
  );

  return router;
}
