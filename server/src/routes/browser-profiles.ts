import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  browserAgentActionSchema,
  browserSignInInputSchema,
  browserSignInStartSchema,
  companyBrowserSettingsSchema,
  createBrowserProfileSchema,
  updateBrowserProfileSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { browserProfileService, type BrowserProfileService } from "../services/browser-profiles.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const idSchema = z.string().uuid();

function boardUserId(req: Request, companyId: string): string {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  const actor = getActorInfo(req);
  if (actor.actorType !== "user") throw forbidden("Board access required");
  return actor.actorId;
}

function agentActor(req: Request, companyId: string): { agentId: string; runId: string | null } {
  if (req.actor.type !== "agent") throw forbidden("Agent access required");
  assertCompanyAccess(req, companyId);
  const actor = getActorInfo(req);
  if (actor.actorType !== "agent" || !actor.agentId) throw forbidden("Agent access required");
  return { agentId: actor.agentId, runId: actor.runId };
}

/**
 * Browser profile routes. Board users manage profiles and sign in; agents can
 * only run actions on profiles the board allowed them to use. Every route is
 * company scoped and every response is `no-store`. Paths stay literal so the
 * OpenAPI coverage test can read them.
 * @param db - Database handle.
 * @param service - Injectable for tests.
 */
export function browserProfileRoutes(db: Db, service: BrowserProfileService = browserProfileService(db)) {
  const router = Router();
  const companyId = (req: Request) => idSchema.parse(req.params.companyId);
  const profileId = (req: Request) => idSchema.parse(req.params.profileId);

  router.use("/companies/:companyId/browser", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/companies/:companyId/browser/overview", async (req, res) => {
    boardUserId(req, companyId(req));
    res.json(await service.overview(companyId(req)));
  });

  router.put("/companies/:companyId/browser/settings", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    const { enabled } = companyBrowserSettingsSchema.parse(req.body);
    res.json(await service.setEnabled(companyId(req), enabled, userId));
  });

  router.post("/companies/:companyId/browser/profiles", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.status(201).json(await service.create(companyId(req), createBrowserProfileSchema.parse(req.body), userId));
  });

  router.patch("/companies/:companyId/browser/profiles/:profileId", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.json(await service.update(companyId(req), profileId(req), updateBrowserProfileSchema.parse(req.body), userId));
  });

  router.post("/companies/:companyId/browser/profiles/:profileId/suspend", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.json(await service.setSuspended(companyId(req), profileId(req), true, userId));
  });

  router.post("/companies/:companyId/browser/profiles/:profileId/resume", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.json(await service.setSuspended(companyId(req), profileId(req), false, userId));
  });

  router.delete("/companies/:companyId/browser/profiles/:profileId", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    await service.destroy(companyId(req), profileId(req), userId);
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/browser/profiles/:profileId/signin", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    const { startUrl } = browserSignInStartSchema.parse(req.body ?? {});
    res.json(await service.startSignIn(companyId(req), profileId(req), userId, startUrl));
  });

  router.get("/companies/:companyId/browser/profiles/:profileId/signin/state", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.json(await service.signInStatus(companyId(req), profileId(req), userId));
  });

  router.get("/companies/:companyId/browser/profiles/:profileId/signin/frame", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    const frame = await service.signInFrame(companyId(req), profileId(req), userId);
    res.type("image/jpeg").send(frame);
  });

  router.post("/companies/:companyId/browser/profiles/:profileId/signin/input", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.json(await service.signInInput(companyId(req), profileId(req), userId, browserSignInInputSchema.parse(req.body)));
  });

  router.post("/companies/:companyId/browser/profiles/:profileId/signin/end", async (req, res) => {
    const userId = boardUserId(req, companyId(req));
    res.json(await service.endSignIn(companyId(req), profileId(req), userId));
  });

  router.get("/companies/:companyId/browser/agent-profiles", async (req, res) => {
    const actor = agentActor(req, companyId(req));
    res.json(await service.listForAgent(companyId(req), actor.agentId));
  });

  router.post("/companies/:companyId/browser/profiles/:profileId/actions", async (req, res) => {
    const actor = agentActor(req, companyId(req));
    res.json(await service.agentAction(companyId(req), profileId(req), actor, browserAgentActionSchema.parse(req.body)));
  });

  return router;
}
