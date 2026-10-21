import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyPolicyKeySchema,
  createCompanyPolicySchema,
  listCompanyPoliciesQuerySchema,
  updateCompanyPolicySchema,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyPolicyService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function parseKey(raw: unknown): string {
  const parsed = companyPolicyKeySchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid policy key");
  return parsed.data;
}

/**
 * Company policies: written rules and guardrails. Any actor with company access reads them;
 * only the board writes them.
 */
export function companyPolicyRoutes(db: Db) {
  const router = Router();
  const svc = companyPolicyService(db);

  router.get("/companies/:companyId/policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listCompanyPoliciesQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest(query.error.issues[0]?.message ?? "Invalid policy filter");
    if (query.data.scope === "company" && query.data.projectId) {
      throw badRequest("A company-scope list cannot filter by projectId. Use scope=project, or leave out scope.");
    }
    res.json(await svc.list(companyId, query.data));
  });

  router.get("/companies/:companyId/policies/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await svc.getByKey(companyId, parseKey(req.params.key));
    if (!policy) throw notFound("Policy not found");
    res.json(policy);
  });

  router.get("/companies/:companyId/policies/:key/revisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listRevisions(companyId, parseKey(req.params.key)));
  });

  router.post("/companies/:companyId/policies", validate(createCompanyPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const policy = await svc.create(companyId, req.body, { userId: actor.actorId, runId: actor.runId });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "policy.created",
      entityType: "policy",
      entityId: policy.id,
      details: { key: policy.key, title: policy.title, status: policy.status, projectId: policy.projectId },
    });
    res.status(201).json(policy);
  });

  router.patch("/companies/:companyId/policies/:key", validate(updateCompanyPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const { policy, changed } = await svc.update(companyId, parseKey(req.params.key), req.body, {
      userId: actor.actorId,
      runId: actor.runId,
    });
    if (changed.length > 0) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "policy.updated",
        entityType: "policy",
        entityId: policy.id,
        details: {
          key: policy.key,
          title: policy.title,
          changed,
          status: policy.status,
          revisionNumber: policy.latestRevisionNumber,
        },
      });
    }
    res.json(policy);
  });

  router.delete("/companies/:companyId/policies/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const policy = await svc.remove(companyId, parseKey(req.params.key));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "policy.deleted",
      entityType: "policy",
      entityId: policy.id,
      details: { key: policy.key, title: policy.title },
    });
    res.json(policy);
  });

  return router;
}
