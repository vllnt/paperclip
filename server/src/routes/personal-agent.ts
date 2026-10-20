import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  PERSONAL_AGENT_TOOLS,
  createPersonalAgentSkillSchema,
  putPersonalAgentInstructionsSchema,
  updatePersonalAgentSchema,
  updatePersonalAgentSkillSchema,
  userAuditQuerySchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { personalAgentService, type PersonalAgentActor } from "../services/personal-agent.js";
import { assertAuthenticated } from "./authz.js";

const skillIdSchema = z.string().uuid();
const revisionSchema = z.coerce.number().int().min(1);

/**
 * The personal agent belongs to a signed-in user. Only that user's browser
 * session or the user's own board API key may read or change it. Agent keys
 * and the implicit local board (`local_trusted`, where every request has full
 * access) are refused, so "acts as the user" always means a real user.
 */
function requirePersonalAgentUser(req: Request): { userId: string; actor: PersonalAgentActor } {
  assertAuthenticated(req);
  const { actor } = req;
  if (actor.type !== "board" || !actor.userId || (actor.source !== "session" && actor.source !== "board_key")) {
    throw forbidden("The personal agent needs a signed-in user", { code: "personal_agent_user_required" });
  }
  return { userId: actor.userId, actor: { source: actor.source, keyId: actor.keyId ?? null } };
}

function parseSkillId(value: unknown): string {
  const parsed = skillIdSchema.safeParse(value);
  if (!parsed.success) throw notFound("Skill not found");
  return parsed.data;
}

/**
 * Routes for the user-scoped personal agent: its record, instructions with
 * revisions, skills, tool catalog and audit log.
 */
export function personalAgentRoutes(db: Db) {
  const router = Router();
  const svc = personalAgentService(db);

  router.use("/personal-agent", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/personal-agent", async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.json(await svc.get(userId, actor));
  });

  router.patch("/personal-agent", validate(updatePersonalAgentSchema), async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.json(await svc.update(userId, updatePersonalAgentSchema.parse(req.body), actor));
  });

  router.put("/personal-agent/instructions", validate(putPersonalAgentInstructionsSchema), async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.json(await svc.putInstructions(userId, putPersonalAgentInstructionsSchema.parse(req.body), actor));
  });

  router.get("/personal-agent/instructions/revisions", async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.json(await svc.listInstructionRevisions(userId, actor));
  });

  router.get("/personal-agent/instructions/revisions/:revision", async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    const revision = revisionSchema.safeParse(req.params.revision);
    if (!revision.success) throw notFound("Revision not found");
    res.json(await svc.getInstructionRevision(userId, revision.data, actor));
  });

  router.get("/personal-agent/skills", async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.json(await svc.listSkills(userId, actor));
  });

  router.post("/personal-agent/skills", validate(createPersonalAgentSkillSchema), async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.status(201).json(await svc.createSkill(userId, createPersonalAgentSkillSchema.parse(req.body), actor));
  });

  router.get("/personal-agent/skills/:skillId", async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    res.json(await svc.getSkill(userId, parseSkillId(req.params.skillId), actor));
  });

  router.patch("/personal-agent/skills/:skillId", validate(updatePersonalAgentSkillSchema), async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    const skillId = parseSkillId(req.params.skillId);
    res.json(await svc.updateSkill(userId, skillId, updatePersonalAgentSkillSchema.parse(req.body), actor));
  });

  router.delete("/personal-agent/skills/:skillId", async (req, res) => {
    const { userId, actor } = requirePersonalAgentUser(req);
    await svc.deleteSkill(userId, parseSkillId(req.params.skillId), actor);
    res.status(204).end();
  });

  router.get("/personal-agent/tools", (req, res) => {
    requirePersonalAgentUser(req);
    res.json(PERSONAL_AGENT_TOOLS);
  });

  router.get("/personal-agent/audit-log", async (req, res) => {
    const { userId } = requirePersonalAgentUser(req);
    const { limit } = userAuditQuerySchema.parse(req.query);
    res.json(await svc.listAudit(userId, limit));
  });

  return router;
}
