import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import type { IssueTriageService } from "../services/issue-triage-factory.js";
import { assertAuthenticated, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

/**
 * `GET /issues/:id/triage` returns the triage recorded for an issue: suggested priority, category and
 * owner, the probabilities behind them, the model, and what the router did. Board and agent keys
 * work, always scoped to their company. An unauthenticated caller gets 401, and another company's
 * issue gets the same 404 as a missing one, so the route does not reveal which ids exist elsewhere.
 */
export function issueTriageRoutes(db: Db, triage: Pick<IssueTriageService, "find">): Router {
  const router = Router();

  router.get("/issues/:id/triage", async (req, res) => {
    assertAuthenticated(req);
    const idOrIdentifier = req.params.id as string;
    const [issue] = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(isUuidLike(idOrIdentifier) ? eq(issues.id, idOrIdentifier) : eq(issues.identifier, idOrIdentifier));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const record = await triage.find(issue.companyId, issue.id);
    if (!record) throw notFound("No triage recorded for this issue");
    res.json(record);
  });

  return router;
}
