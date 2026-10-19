import { once } from "node:events";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  COMPANY_ARCHIVE_EXPORT_DEFAULT_LIMIT,
  COMPANY_ARCHIVE_INCLUDES,
  companyArchiveExportQuerySchema,
  decodeCompanyArchiveCursor,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { companyArchiveExportService } from "../services/company-archive-export.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const DRAIN_TIMEOUT_MS = 30_000;

export function companyArchiveRoutes(db: Db) {
  const router = Router();
  const exporter = companyArchiveExportService(db);

  // Bulk raw export of a company's run history (transcripts included). Board
  // only: agents that may read single runs still may not pull everything.
  router.get("/companies/:companyId/archive/export", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = companyArchiveExportQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid archive export query", parsed.error.issues);
    const cursor = parsed.data.cursor ? decodeCompanyArchiveCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) throw badRequest("Invalid archive export cursor");
    const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
    const until = parsed.data.until ? new Date(parsed.data.until) : undefined;
    const include = parsed.data.include ?? [...COMPANY_ARCHIVE_INCLUDES];
    const limit = parsed.data.limit ?? COMPANY_ARCHIVE_EXPORT_DEFAULT_LIMIT;
    const follow = parsed.data.follow ?? false;

    const controller = new AbortController();
    const stop = () => controller.abort();
    // Listen before the first await so a client that leaves early stops the work.
    res.on("close", stop);
    try {
      // Bulk export is the main way run content leaves the instance, so it is
      // audited even though it is a read. No content goes into the row.
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.data_exported",
        entityType: "company",
        entityId: companyId,
        details: {
          include,
          since: since?.toISOString() ?? null,
          until: until?.toISOString() ?? null,
          resumed: cursor !== null,
          limit,
          follow,
        },
      });

      const records = exporter.stream({ companyId, cursor, since, until, include, limit, follow, signal: controller.signal });
      // The first record comes after the first page query, so a failure there
      // is still a normal HTTP error response.
      let next = await records.next();
      if (controller.signal.aborted) return;
      res.set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        // no-transform keeps the API compression middleware from buffering the stream.
        "Cache-Control": "no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no",
        // Lets a plain browser link save the stream as a file.
        "Content-Disposition": `attachment; filename="paperclip-archive-${companyId}.ndjson"`,
      });
      res.flushHeaders();

      try {
        while (!next.done) {
          controller.signal.throwIfAborted();
          if (!res.write(`${JSON.stringify(next.value)}\n`)) {
            const stalled = setTimeout(() => {
              controller.abort();
              res.destroy();
            }, DRAIN_TIMEOUT_MS);
            stalled.unref();
            try {
              await once(res, "drain", { signal: controller.signal });
            } finally {
              clearTimeout(stalled);
            }
          }
          next = await records.next();
        }
        res.end();
      } catch (error) {
        await records.return(undefined).catch(() => undefined);
        if (controller.signal.aborted) return;
        // Headers are already sent: cut the stream so the client sees no
        // `export.end` line and resumes from its last `run.end` cursor.
        logger.error({ err: error, companyId }, "company archive export failed mid-stream");
        res.destroy();
      }
    } finally {
      res.off("close", stop);
    }
  });

  return router;
}
