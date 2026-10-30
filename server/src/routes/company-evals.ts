import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyEvalSlugSchema,
  createCompanyEvalSchema,
  createCompanyEvalVersionSchema,
  isUuidLike,
  listCompanyEvalRunsQuerySchema,
  listCompanyEvalVersionsQuerySchema,
  listCompanyEvalsQuerySchema,
  publishCompanyEvalSchema,
  putCompanyEvalFeedbackSchema,
  runCompanyEvalSchema,
  updateCompanyEvalSchema,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  EvalInputRejectedError,
  EvalsApplicationError,
  type EvalActor,
  type EvalsService,
} from "../modules/evals/index.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function assertNotSkillTestScoped(req: Request): void {
  if (req.actor.type === "agent" && req.actor.keyScope?.kind === "skill_test") {
    throw forbidden("Skill-test run tokens cannot use evals.");
  }
}

function actorOf(req: Request): EvalActor {
  const info = getActorInfo(req);
  if (info.actorType === "agent") {
    if (!info.agentId) throw forbidden("Agent identity is missing.");
    return { type: "agent", agentId: info.agentId };
  }
  return { type: "user", userId: info.actorId };
}

function toHttpError(error: unknown): unknown {
  if (!(error instanceof EvalsApplicationError)) return error;
  if (error.code === "not_found") return notFound(error.message);
  if (error.code === "forbidden") return forbidden(error.message);
  if (error.code === "conflict") return conflict(error.message, error.details);
  if (error.code === "invalid_request") return badRequest(error.message);
  return new HttpError(500, "Unexpected eval error");
}

function readSlug(req: Request): string {
  const parsed = companyEvalSlugSchema.safeParse(req.params.slug);
  if (!parsed.success) throw notFound("Eval not found");
  return parsed.data;
}

function readVersionNumber(req: Request): number {
  const value = Number(req.params.versionNumber);
  if (!Number.isInteger(value) || value < 1) throw notFound("Version not found");
  return value;
}

function readRunId(req: Request): string {
  const runId = req.params.runId as string;
  if (!isUuidLike(runId)) throw notFound("Run not found");
  return runId;
}

/**
 * Company eval routes. All are company-scoped and open to board users and agent keys, but only board
 * users change evals; agents list and read published evals, run them, read their own runs and mark them.
 *
 * - `POST .../runs` and `PUT .../runs/:runId/feedback` take caller-written input, so the HTTP logger
 *   leaves their request bodies out (`isCompanyEvalHttpRequest`).
 * - A rejected input answers 422 with the `runId` of the run that recorded it.
 */
export function companyEvalRoutes(db: Db, evals: EvalsService): Router {
  const router = Router();

  async function record(
    req: Request,
    companyId: string,
    entry: { action: string; entityType: "eval" | "eval_run"; entityId: string; details: Record<string, unknown> },
  ): Promise<void> {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      ...entry,
    });
  }

  router.get("/companies/:companyId/evals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    const query = listCompanyEvalsQuerySchema.parse(req.query);
    try {
      res.json(await evals.list(actorOf(req), companyId, query));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.post("/companies/:companyId/evals", validate(createCompanyEvalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      const created = await evals.create(actorOf(req), companyId, req.body);
      await record(req, companyId, {
        action: "eval.created",
        entityType: "eval",
        entityId: created.id,
        details: { slug: created.slug, versionNumber: created.latestVersion?.versionNumber ?? 1 },
      });
      res.status(201).json(created);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/companies/:companyId/evals/:slug", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      res.json(await evals.get(actorOf(req), companyId, readSlug(req)));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.patch("/companies/:companyId/evals/:slug", validate(updateCompanyEvalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      const updated = await evals.update(actorOf(req), companyId, readSlug(req), req.body);
      await record(req, companyId, {
        action: "eval.updated",
        entityType: "eval",
        entityId: updated.id,
        details: {
          slug: updated.slug,
          changed: Object.keys(req.body).sort(),
        },
      });
      res.json(updated);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.delete("/companies/:companyId/evals/:slug", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      const removed = await evals.remove(actorOf(req), companyId, readSlug(req));
      await record(req, companyId, {
        action: "eval.deleted",
        entityType: "eval",
        entityId: removed.id,
        details: { slug: removed.slug },
      });
      res.status(204).end();
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/companies/:companyId/evals/:slug/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    const query = listCompanyEvalVersionsQuerySchema.parse(req.query);
    try {
      res.json(await evals.listVersions(actorOf(req), companyId, readSlug(req), query));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.post("/companies/:companyId/evals/:slug/versions", validate(createCompanyEvalVersionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    const slug = readSlug(req);
    try {
      const { version, created } = await evals.createVersion(actorOf(req), companyId, slug, req.body);
      if (created) {
        await record(req, companyId, {
          action: "eval.version_created",
          entityType: "eval",
          entityId: version.evalId,
          details: { slug, versionNumber: version.versionNumber },
        });
      }
      res.status(created ? 201 : 200).json(version);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/companies/:companyId/evals/:slug/versions/:versionNumber", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      res.json(await evals.getVersion(actorOf(req), companyId, readSlug(req), readVersionNumber(req)));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.post("/companies/:companyId/evals/:slug/publish", validate(publishCompanyEvalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      const published = await evals.publish(actorOf(req), companyId, readSlug(req), req.body);
      await record(req, companyId, {
        action: "eval.published",
        entityType: "eval",
        entityId: published.id,
        details: { slug: published.slug, versionNumber: published.publishedVersionNumber },
      });
      res.json(published);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.post("/companies/:companyId/evals/:slug/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      const archived = await evals.archive(actorOf(req), companyId, readSlug(req));
      await record(req, companyId, {
        action: "eval.archived",
        entityType: "eval",
        entityId: archived.id,
        details: { slug: archived.slug },
      });
      res.json(archived);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.post("/companies/:companyId/evals/:slug/runs", validate(runCompanyEvalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      const result = await evals.run(actorOf(req), companyId, readSlug(req), req.body, {
        runId: getActorInfo(req).runId,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof EvalInputRejectedError) {
        const { code, runId, ...details } = error.rejection;
        res.status(422).json({ error: error.message, code, runId, details });
        return;
      }
      throw toHttpError(error);
    }
  });

  router.get("/companies/:companyId/evals/:slug/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    const query = listCompanyEvalRunsQuerySchema.parse(req.query);
    try {
      res.json(await evals.listRuns(actorOf(req), companyId, readSlug(req), query));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/companies/:companyId/evals/:slug/runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    try {
      res.json(await evals.getRun(actorOf(req), companyId, readSlug(req), readRunId(req)));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.put("/companies/:companyId/evals/:slug/runs/:runId/feedback", validate(putCompanyEvalFeedbackSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNotSkillTestScoped(req);
    const slug = readSlug(req);
    try {
      const feedback = await evals.putFeedback(actorOf(req), companyId, slug, readRunId(req), req.body);
      await record(req, companyId, {
        action: "eval.feedback_recorded",
        entityType: "eval_run",
        entityId: feedback.runId,
        details: {
          slug,
          questionId: feedback.questionId,
          verdict: feedback.verdict,
          hasNote: feedback.note !== null,
        },
      });
      res.json(feedback);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  return router;
}
