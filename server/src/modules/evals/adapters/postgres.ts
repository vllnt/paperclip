import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyEvalFeedback,
  companyEvalRuns,
  companyEvals,
  companyEvalVersions,
} from "@paperclipai/db";
import { isUniqueViolation } from "../../../db-errors.js";
import type { EvalsRepository, NewEvalFields } from "../application/ports.js";
import {
  EvalSlugTakenError,
  type EvalRecord,
  type FeedbackRecord,
  type NewRunRecord,
  type NewVersionFields,
  type RunRecord,
  type VersionRecord,
} from "../application/types.js";

const SLUG_CONSTRAINT = "company_evals_company_slug_uq";

function toEvalRecord(row: typeof companyEvals.$inferSelect): EvalRecord {
  return { ...row };
}

function toVersionRecord(row: typeof companyEvalVersions.$inferSelect): VersionRecord {
  return { ...row };
}

function toRunRecord(row: typeof companyEvalRuns.$inferSelect): RunRecord {
  return { ...row };
}

function toFeedbackRecord(row: typeof companyEvalFeedback.$inferSelect): FeedbackRecord {
  return { ...row };
}

function versionValues(companyId: string, evalId: string, versionNumber: number, version: NewVersionFields) {
  return {
    id: version.id,
    companyId,
    evalId,
    versionNumber,
    inputSchema: version.inputSchema,
    questions: version.questions,
    definitionHash: version.definitionHash,
    changeNote: version.changeNote,
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt,
  };
}

/**
 * Postgres storage for company evals. Every statement filters on `company_id`. Version numbers use
 * a compare-and-set on the eval row (`latest_version_number`), so the adapter takes no lock.
 */
export function createPostgresEvalsRepository(db: Db): EvalsRepository {
  return {
    async findEvalBySlug(companyId, slug) {
      const [row] = await db
        .select()
        .from(companyEvals)
        .where(and(eq(companyEvals.companyId, companyId), eq(companyEvals.slug, slug)));
      return row ? toEvalRecord(row) : null;
    },

    async listEvals(companyId, query) {
      const conditions: SQL[] = [
        eq(companyEvals.companyId, companyId),
        inArray(companyEvals.status, [...query.statuses]),
      ];
      if (query.publishedOnly) conditions.push(isNotNull(companyEvals.publishedVersionId));
      if (query.afterSlug !== undefined) conditions.push(sql`${companyEvals.slug} > ${query.afterSlug}`);
      const rows = await db
        .select()
        .from(companyEvals)
        .where(and(...conditions))
        .orderBy(asc(companyEvals.slug))
        .limit(query.limit);
      return rows.map(toEvalRecord);
    },

    async insertEvalWithFirstVersion(eval_: NewEvalFields, version: NewVersionFields) {
      try {
        return await db.transaction(async (tx) => {
          const [evalRow] = await tx
            .insert(companyEvals)
            .values({
              id: eval_.id,
              companyId: eval_.companyId,
              slug: eval_.slug,
              title: eval_.title,
              whenToUse: eval_.whenToUse,
              status: "draft",
              latestVersionNumber: 1,
              createdByUserId: eval_.createdByUserId,
              updatedByUserId: eval_.createdByUserId,
              createdAt: eval_.now,
              updatedAt: eval_.now,
            })
            .returning();
          const [versionRow] = await tx
            .insert(companyEvalVersions)
            .values(versionValues(eval_.companyId, eval_.id, 1, version))
            .returning();
          if (!evalRow || !versionRow) throw new Error("eval insert returned no row");
          return { eval: toEvalRecord(evalRow), version: toVersionRecord(versionRow) };
        });
      } catch (error) {
        if (isUniqueViolation(error, SLUG_CONSTRAINT)) throw new EvalSlugTakenError(eval_.slug);
        throw error;
      }
    },

    async updateEvalMeta(companyId, evalId, patch) {
      const [row] = await db
        .update(companyEvals)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.whenToUse !== undefined ? { whenToUse: patch.whenToUse } : {}),
          updatedByUserId: patch.updatedByUserId,
          updatedAt: patch.now,
        })
        .where(and(eq(companyEvals.companyId, companyId), eq(companyEvals.id, evalId)))
        .returning();
      return row ? toEvalRecord(row) : null;
    },

    async getVersionByNumber(companyId, evalId, versionNumber) {
      const [row] = await db
        .select()
        .from(companyEvalVersions)
        .where(
          and(
            eq(companyEvalVersions.companyId, companyId),
            eq(companyEvalVersions.evalId, evalId),
            eq(companyEvalVersions.versionNumber, versionNumber),
          ),
        );
      return row ? toVersionRecord(row) : null;
    },

    async getVersionsByIds(companyId, ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(companyEvalVersions)
        .where(and(eq(companyEvalVersions.companyId, companyId), inArray(companyEvalVersions.id, [...ids])));
      return rows.map(toVersionRecord);
    },

    async listVersions(companyId, evalId, query) {
      const conditions: SQL[] = [eq(companyEvalVersions.companyId, companyId), eq(companyEvalVersions.evalId, evalId)];
      if (query.beforeNumber !== undefined) conditions.push(lt(companyEvalVersions.versionNumber, query.beforeNumber));
      const rows = await db
        .select()
        .from(companyEvalVersions)
        .where(and(...conditions))
        .orderBy(desc(companyEvalVersions.versionNumber))
        .limit(query.limit);
      return rows.map(toVersionRecord);
    },

    async appendVersion(input) {
      const nextNumber = input.expectedLatest + 1;
      return db.transaction(async (tx) => {
        // The counter moves only if no other writer moved it first. A lost race writes nothing.
        const claimed = await tx
          .update(companyEvals)
          .set({ latestVersionNumber: nextNumber, updatedAt: input.version.createdAt })
          .where(
            and(
              eq(companyEvals.companyId, input.companyId),
              eq(companyEvals.id, input.evalId),
              eq(companyEvals.latestVersionNumber, input.expectedLatest),
            ),
          )
          .returning({ id: companyEvals.id });
        if (claimed.length === 0) return null;
        const [row] = await tx
          .insert(companyEvalVersions)
          .values(versionValues(input.companyId, input.evalId, nextNumber, input.version))
          .returning();
        return row ? toVersionRecord(row) : null;
      });
    },

    async setPublished(companyId, evalId, input) {
      const [row] = await db
        .update(companyEvals)
        .set({
          status: "published",
          publishedVersionId: input.versionId,
          publishedAt: input.now,
          archivedAt: null,
          updatedByUserId: input.updatedByUserId,
          updatedAt: input.now,
        })
        .where(and(eq(companyEvals.companyId, companyId), eq(companyEvals.id, evalId)))
        .returning();
      return row ? toEvalRecord(row) : null;
    },

    async setArchived(companyId, evalId, input) {
      const [row] = await db
        .update(companyEvals)
        .set({ status: "archived", archivedAt: input.now, updatedByUserId: input.updatedByUserId, updatedAt: input.now })
        .where(and(eq(companyEvals.companyId, companyId), eq(companyEvals.id, evalId)))
        .returning();
      return row ? toEvalRecord(row) : null;
    },

    async deleteNeverPublished(companyId, evalId) {
      const deleted = await db
        .delete(companyEvals)
        .where(
          and(
            eq(companyEvals.companyId, companyId),
            eq(companyEvals.id, evalId),
            sql`${companyEvals.publishedAt} IS NULL`,
          ),
        )
        .returning({ id: companyEvals.id });
      return deleted.length > 0;
    },

    async insertRun(run: NewRunRecord) {
      const [row] = await db.insert(companyEvalRuns).values(run).returning();
      if (!row) throw new Error("eval run insert returned no row");
      return toRunRecord(row);
    },

    async listRuns(companyId, evalId, query) {
      const { filter } = query;
      const conditions: SQL[] = [eq(companyEvalRuns.companyId, companyId), eq(companyEvalRuns.evalId, evalId)];
      if (filter.from) conditions.push(gte(companyEvalRuns.createdAt, filter.from));
      if (filter.to) conditions.push(lte(companyEvalRuns.createdAt, filter.to));
      if (filter.versionNumber !== undefined) conditions.push(eq(companyEvalRuns.versionNumber, filter.versionNumber));
      if (filter.agentId) conditions.push(eq(companyEvalRuns.callerAgentId, filter.agentId));
      if (filter.projectId) conditions.push(eq(companyEvalRuns.projectId, filter.projectId));
      if (filter.outcome) conditions.push(eq(companyEvalRuns.outcome, filter.outcome));
      if (filter.mode) conditions.push(eq(companyEvalRuns.mode, filter.mode));
      if (query.after) {
        // A bare Date cannot be sent as a parameter of raw SQL (the driver has no serializer for it),
        // so the cursor time goes as ISO text and is cast here.
        conditions.push(
          sql`(${companyEvalRuns.createdAt}, ${companyEvalRuns.id}) < (${new Date(query.after.at).toISOString()}::timestamptz, ${query.after.id}::uuid)`,
        );
      }
      const rows = await db
        .select()
        .from(companyEvalRuns)
        .where(and(...conditions))
        .orderBy(desc(companyEvalRuns.createdAt), desc(companyEvalRuns.id))
        .limit(query.limit);
      return rows.map(toRunRecord);
    },

    async getRun(companyId, evalId, runId) {
      const [row] = await db
        .select()
        .from(companyEvalRuns)
        .where(
          and(
            eq(companyEvalRuns.companyId, companyId),
            eq(companyEvalRuns.evalId, evalId),
            eq(companyEvalRuns.id, runId),
          ),
        );
      return row ? toRunRecord(row) : null;
    },

    async upsertFeedback(feedback) {
      const [row] = await db
        .insert(companyEvalFeedback)
        .values({
          id: feedback.id,
          companyId: feedback.companyId,
          runId: feedback.runId,
          questionKey: feedback.questionKey,
          verdict: feedback.verdict,
          note: feedback.note,
          authorType: feedback.authorType,
          authorKey: feedback.authorKey,
          authorAgentId: feedback.authorAgentId,
          authorUserId: feedback.authorUserId,
          createdAt: feedback.now,
          updatedAt: feedback.now,
        })
        .onConflictDoUpdate({
          target: [companyEvalFeedback.runId, companyEvalFeedback.questionKey, companyEvalFeedback.authorKey],
          set: { verdict: feedback.verdict, note: feedback.note, updatedAt: feedback.now },
        })
        .returning();
      if (!row) throw new Error("eval feedback upsert returned no row");
      return toFeedbackRecord(row);
    },

    async listFeedback(companyId, runId) {
      const rows = await db
        .select()
        .from(companyEvalFeedback)
        .where(and(eq(companyEvalFeedback.companyId, companyId), eq(companyEvalFeedback.runId, runId)))
        .orderBy(asc(companyEvalFeedback.createdAt), asc(companyEvalFeedback.id));
      return rows.map(toFeedbackRecord);
    },

    async clearExpiredInputs(now, batchSize) {
      const expired = db
        .select({ id: companyEvalRuns.id })
        .from(companyEvalRuns)
        .where(and(isNotNull(companyEvalRuns.input), lte(companyEvalRuns.inputExpiresAt, now)))
        .orderBy(asc(companyEvalRuns.inputExpiresAt))
        .limit(batchSize);
      const cleared = await db
        .update(companyEvalRuns)
        .set({ input: null })
        .where(inArray(companyEvalRuns.id, expired))
        .returning({ id: companyEvalRuns.id });
      return cleared.length;
    },
  };
}
