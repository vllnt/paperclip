import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { isUuidLike, listIssueTriageQuerySchema } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import type { IssueTriageService } from "../modules/issue-triage/index.js";
import { assertAuthenticated, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

/**
 * Issue triage read endpoint:
 * - `GET /issues/:id/triage?limit=&cursor=` lists the recorded triage of an issue, newest first, with
 *   the suggested priority, category and owner, the probabilities behind them and the model id.
 *   An unauthenticated caller always gets 401, and another company's issue gets the same 404 as a
 *   missing one, so the route does not reveal which ids exist elsewhere.
 */
export function issueTriageRoutes(db: Db, triage: IssueTriageService): Router {
  const router = Router();

  router.get("/issues/:id/triage", async (req, res) => {
    assertAuthenticated(req);
    const query = listIssueTriageQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid triage query", query.error.flatten());
    const idOrIdentifier = req.params.id as string;
    const [issue] = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(isUuidLike(idOrIdentifier) ? eq(issues.id, idOrIdentifier) : eq(issues.identifier, idOrIdentifier));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const result = await triage.list({
      companyId: issue.companyId,
      issueId: issue.id,
      limit: query.data.limit,
      cursor: query.data.cursor,
    });
    if (!result.ok) throw badRequest("Invalid triage cursor");
    res.json(result.page);
  });

  return router;
}
