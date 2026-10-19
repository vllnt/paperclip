import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { observabilityFailuresQuerySchema, observabilityUsageQuerySchema } from "@paperclipai/shared";
import { accessService } from "../services/index.js";
import { runUsageQueryService } from "../services/run-usage-query.js";
import { runUsageRecordService } from "../services/run-usage-records.js";
import { assertCompanyAccess } from "./authz.js";
import { assertCompanyScopeReadAllowed } from "./company-scope-read.js";

const DENIED_MESSAGE = "Observability data is outside this actor's authorization boundary";

export function observabilityRoutes(db: Db) {
  const router = Router();
  const records = runUsageRecordService(db);
  const queries = runUsageQueryService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/observability/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(access, req, res, companyId, DENIED_MESSAGE))) return;
    res.json(await records.health(companyId));
  });

  router.get("/companies/:companyId/observability/usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(access, req, res, companyId, DENIED_MESSAGE))) return;
    const query = observabilityUsageQuerySchema.parse(req.query);
    res.json(await queries.usage(companyId, query));
  });

  router.get("/companies/:companyId/observability/failures", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(access, req, res, companyId, DENIED_MESSAGE))) return;
    const query = observabilityFailuresQuerySchema.parse(req.query);
    res.json(await queries.failures(companyId, query));
  });

  return router;
}
