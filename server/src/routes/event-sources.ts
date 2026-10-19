import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createEventSourceSchema,
  listEventDeliveriesQuerySchema,
  rotateEventSourceSecretSchema,
  testEventSourceSchema,
  updateEventSourceSchema,
  type EventSource,
} from "@paperclipai/shared";
import { badRequest, unsupportedMediaType } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import type { EventSourceService } from "../services/event-sources/service.js";
import { routineService } from "../services/routines.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

/**
 * Sender-facing ingress, mounted at `/api` outside the board mutation guard and
 * after the 64 KB event body parser: the source's own secret is the only
 * credential, and it is checked before any shared rate limit is spent.
 */
export function eventSourcePublicRoutes(service: EventSourceService) {
  const router = Router();
  router.post("/event-sources/public/:publicId/events", async (req, res) => {
    if (!req.is("application/json")) {
      throw unsupportedMediaType("Send the event with Content-Type: application/json");
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw badRequest("Event body must be a JSON object");
    }
    const result = await service.ingest({
      publicId: req.params.publicId as string,
      ip: req.ip || req.socket?.remoteAddress || null,
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      timestampHeader: req.header("x-paperclip-timestamp"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      body: req.body,
    });
    res.set("Cache-Control", "no-store");
    for (const [name, value] of Object.entries(result.headers ?? {})) res.set(name, value);
    res.status(result.status).json(result.body);
  });
  return router;
}

export function eventSourceRoutes(db: Db, service: EventSourceService) {
  const router = Router();
  const routinesSvc = routineService(db);

  function actorIds(req: Request) {
    return {
      agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    };
  }

  async function logSourceActivity(req: Request, source: EventSource, action: string, details: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: source.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "event_source",
      entityId: source.id,
      details: { name: source.name, ...details },
    });
  }

  router.get("/companies/:companyId/event-sources", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
    res.json(await service.list(companyId, { includeArchived }));
  });

  router.post("/companies/:companyId/event-sources", validate(createEventSourceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const created = await service.create(companyId, req.body, actorIds(req));
    await logSourceActivity(req, created.source, "event_source.created", {
      normalizer: created.source.normalizer,
      signingMode: created.source.signingMode,
    });
    res.status(201).json(created);
  });

  router.get("/event-sources/:id", async (req, res) => {
    const source = await getAccessibleResource(req, res, service.find(req.params.id as string), "Event source not found");
    if (!source) return;
    res.json(source);
  });

  router.patch("/event-sources/:id", validate(updateEventSourceSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, service.find(req.params.id as string), "Event source not found");
    if (!existing) return;
    assertBoard(req);
    const updated = await service.update(existing.id, req.body, actorIds(req));
    await logSourceActivity(req, updated, "event_source.updated", { fields: Object.keys(req.body as object) });
    res.json(updated);
  });

  router.delete("/event-sources/:id", async (req, res) => {
    const existing = await getAccessibleResource(req, res, service.find(req.params.id as string), "Event source not found");
    if (!existing) return;
    assertBoard(req);
    const archived = await service.archive(existing.id, actorIds(req));
    await logSourceActivity(req, archived, "event_source.archived");
    res.json(archived);
  });

  router.post("/event-sources/:id/rotate-secret", validate(rotateEventSourceSecretSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, service.find(req.params.id as string), "Event source not found");
    if (!existing) return;
    assertBoard(req);
    const rotated = await service.rotateSecret(existing.id, actorIds(req));
    await logSourceActivity(req, rotated.source, "event_source.secret_rotated");
    res.json(rotated);
  });

  router.post("/event-sources/:id/test", validate(testEventSourceSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, service.find(req.params.id as string), "Event source not found");
    if (!existing) return;
    res.json(await service.dryRun(existing.id, req.body.payload));
  });

  router.get("/event-sources/:id/deliveries", async (req, res) => {
    const existing = await getAccessibleResource(req, res, service.find(req.params.id as string), "Event source not found");
    if (!existing) return;
    const query = listEventDeliveriesQuerySchema.parse(req.query);
    res.json(await service.listDeliveries(existing.id, query));
  });

  router.get("/routines/:id/event-groups", async (req, res) => {
    const routine = await getAccessibleResource(req, res, routinesSvc.get(req.params.id as string), "Routine not found");
    if (!routine) return;
    const open = req.query.open === undefined ? true : req.query.open === "true" || req.query.open === "1";
    const limit = Number(req.query.limit ?? 50);
    res.json(await routinesSvc.listEventGroups(routine.id, { open, limit: Number.isFinite(limit) ? limit : 50 }));
  });

  return router;
}
