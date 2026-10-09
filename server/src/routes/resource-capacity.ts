import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { resourceCapacityService } from "../services/resource-capacity.js";
import { assertBoardOrAgent, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

// Host resource capacity reads. Instance views are for instance admins; a
// company's members and agents read only the environments its agents run
// on, and anything else is a 404, the same as a missing environment.

/** The companies whose environments the actor may read; null means all (instance admins). */
function readableCompanyIds(req: Request): string[] | null {
  if (req.actor.type === "agent") return req.actor.companyId ? [req.actor.companyId] : [];
  if (req.actor.type !== "board") return [];
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
  return req.actor.companyIds ?? [];
}

export function resourceCapacityRoutes(db: Db) {
  const router = Router();
  const svc = resourceCapacityService(db);

  router.get("/instance/resource-capacity", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.getInstanceView());
  });

  router.get("/companies/:companyId/resource-capacity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getCompanyView(companyId));
  });

  router.get("/environments/:id/resource-capacity", async (req, res) => {
    assertBoardOrAgent(req);
    const environmentId = req.params.id as string;
    const detail = isUuidLike(environmentId)
      ? await svc.getEnvironmentDetail(environmentId, { companyIds: readableCompanyIds(req) })
      : null;
    if (!detail) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    res.json(detail);
  });

  return router;
}
