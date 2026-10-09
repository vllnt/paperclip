import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  createStorageDestinationSchema,
  retireStorageDestinationSchema,
  rotateStorageCredentialsSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { storageDestinationService, type StorageDestinationActor } from "../services/storage-destinations.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdmin, getActorInfo } from "./authz.js";

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw badRequest("Check the storage destination settings", parsed.error.issues);
  return parsed.data;
}

/**
 * Board-only company storage destinations (S3-01). Cloud-managed instances
 * keep storage under the platform's control, so every route refuses there.
 * Choosing where company keys are sent (create, key rotation) and retiring
 * need a company owner or admin, like secret definitions.
 */
function requireStorageAccess(req: Request, options: { admin?: boolean } = {}): { companyId: string; actor: StorageDestinationActor } {
  assertBoard(req);
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  if (options.admin) assertCompanyAdmin(req, companyId);
  if (isCloudManagedInstance()) throw forbidden("Storage destinations are managed by the platform on this instance");
  const actor = getActorInfo(req);
  return {
    companyId,
    actor: { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId },
  };
}

const destinationIdSchema = z.string().uuid();

function destinationId(req: Request): string {
  return parse(destinationIdSchema, req.params.destinationId);
}

export function companyStorageRoutes(db: Db) {
  const router = Router();
  const destinations = storageDestinationService(db);

  router.get("/companies/:companyId/storage/destinations", async (req, res) => {
    const { companyId } = requireStorageAccess(req);
    res.json(await destinations.list(companyId));
  });

  router.post("/companies/:companyId/storage/destinations", async (req, res) => {
    const { companyId, actor } = requireStorageAccess(req, { admin: true });
    const input = parse(createStorageDestinationSchema, req.body);
    const { destination, created } = await destinations.create(companyId, input, actor);
    res.status(created ? 201 : 200).json(destination);
  });

  router.post("/companies/:companyId/storage/destinations/:destinationId/probe", async (req, res) => {
    const { companyId, actor } = requireStorageAccess(req);
    res.json(await destinations.probe(companyId, destinationId(req), actor));
  });

  router.patch("/companies/:companyId/storage/destinations/:destinationId/credentials", async (req, res) => {
    const { companyId, actor } = requireStorageAccess(req, { admin: true });
    const input = parse(rotateStorageCredentialsSchema, req.body);
    res.json(await destinations.rotateCredentials(companyId, destinationId(req), input, actor));
  });

  router.post("/companies/:companyId/storage/destinations/:destinationId/retire", async (req, res) => {
    const { companyId, actor } = requireStorageAccess(req, { admin: true });
    const input = parse(retireStorageDestinationSchema, req.body);
    res.json(await destinations.retire(companyId, destinationId(req), input, actor));
  });

  return router;
}
