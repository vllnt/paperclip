import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { accessService } from "../services/index.js";
import { runUsageRecordService } from "../services/run-usage-records.js";
import { assertCompanyAccess } from "./authz.js";
import { assertCompanyScopeReadAllowed } from "./company-scope-read.js";

export function observabilityRoutes(db: Db) {
  const router = Router();
  const usage = runUsageRecordService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/observability/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(access, req, res, companyId, "Observability data is outside this actor's authorization boundary"))) return;
    res.json(await usage.health(companyId));
  });

  return router;
}
