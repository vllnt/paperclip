import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies, issueDuplicatePairs, issues } from "@paperclipai/db";
import type {
  DuplicateDetectionMode,
  DuplicatePairLabel,
  FindSimilarIssuesResult,
  IssueDuplicatePair,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  DUPLICATE_CANDIDATE_LIMIT,
  recommend,
  scoreCandidates,
  type CascadeCandidate,
  type CascadeResult,
  type ScoredPair,
} from "./duplicate-cascade.js";
import { DUPLICATE_DESCRIPTION_MAX_CHARS, prepareIssueText, type IssueText } from "./duplicate-lexical.js";
import type { JudgeClient } from "./judge-client.js";

const CANDIDATE_POOL_SIZE = 10;
const ROUTINE_ORIGIN_KIND = "routine_execution";
const DETECTOR_ACTOR_ID = "duplicate-detection";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const candidateRowSchema = z.object({
  id: z.string(),
  identifier: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  parent_id: z.string().nullable(),
  created_at: z.coerce.date(),
  title_sim: z.coerce.number(),
  desc_sim: z.coerce.number(),
  both_described: z.boolean(),
});

export interface SimilarityQuery {
  companyId: string;
  title: string;
  description?: string | null;
  parentId?: string | null;
  /** Set once the issue exists so it never matches itself. */
  issueId?: string | null;
  /** Issues from the same routine share recurring titles by design and are skipped. */
  origin?: { kind: string; id: string | null } | null;
}

export interface CreatedIssueForCheck {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  description: string | null;
  parentId: string | null;
  originKind: string;
  originId: string | null;
  createdAt: Date;
}

export interface DuplicateLabelActor {
  type: "user" | "agent";
  id: string;
}

export interface DuplicateDetectionDeps {
  db: Db;
  judge: JudgeClient;
  /** Posts a system-authored comment inside the caller's transaction. */
  postSystemComment: (issueId: string, body: string, tx: DbTransaction) => Promise<{ id: string }>;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/[`[\]]/g, "").replace(/@/g, "\uFF20").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function issueLink(identifier: string | null, id: string): string {
  if (!identifier) return id;
  const prefix = identifier.split("-")[0] ?? identifier;
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

/**
 * Builds the single comment posted on a new issue. It lists likely duplicates with their score and
 * how to record a verdict. It is a suggestion; nothing is changed on either issue.
 */
export function buildDuplicateComment(
  entries: ReadonlyArray<{ pairId: string; pair: ScoredPair }>,
): string {
  const lines = entries.map(({ pair }) => {
    const { candidate } = pair;
    const score = pair.sameOutcomeProbability === null ? "n/a" : pair.sameOutcomeProbability.toFixed(2);
    const basis = pair.verdict === "exact" ? "identical text" : `same-outcome score ${score}`;
    return `- ${issueLink(candidate.identifier, candidate.id)} "${oneLine(candidate.text.title, 120)}" (${candidate.status}, ${basis})`;
  });
  const labels = entries.map(({ pairId }) => `\`${pairId}\``).join(", ");
  return [
    "**Possible duplicate.** This issue looks like the same work as:",
    "",
    ...lines,
    "",
    "This is a suggestion only; nothing was changed. If it is a duplicate, link or close one of the two. " +
      `Record your call so the detector can be calibrated: \`paperclipai issue duplicate-label <pair-id> duplicate|keep_both\` (pair ids: ${labels}).`,
  ].join("\n");
}

const AFTER_CREATE_CONCURRENCY = 3;
const AFTER_CREATE_MAX_PENDING = 100;

/**
 * Runs jobs with limited concurrency and a bounded wait list. A job that finds the list full is
 * dropped and its promise resolves at once. Jobs must not throw.
 */
export function createBoundedRunner(concurrency: number, maxPending: number): (job: () => Promise<void>) => Promise<void> {
  let active = 0;
  const pending: Array<() => void> = [];
  return (job) =>
    new Promise<void>((resolve) => {
      const start = () => {
        active += 1;
        void job()
          .catch(() => {})
          .finally(() => {
            active -= 1;
            resolve();
            pending.shift()?.();
          });
      };
      if (active < concurrency) start();
      else if (pending.length < maxPending) pending.push(start);
      else {
        logger.warn({ maxPending }, "duplicate check queue full; skipping check");
        resolve();
      }
    });
}

/**
 * Duplicate detection for issues: a free trigram tier, an exact-hash tier and one Jev predicate per
 * candidate pair. Every query here is scoped by `company_id`.
 */
export function duplicateDetectionService(deps: DuplicateDetectionDeps) {
  const { db, judge } = deps;

  async function getMode(companyId: string): Promise<DuplicateDetectionMode> {
    const [row] = await db
      .select({ mode: companies.duplicateDetectionMode })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row?.mode ?? "off";
  }

  async function fetchCandidates(query: SimilarityQuery, text: IssueText): Promise<CascadeCandidate[]> {
    const onlyOlder = query.issueId
      ? sql`AND (i.created_at, i.id) < (SELECT s.created_at, s.id FROM issues s WHERE s.id = ${query.issueId} AND s.company_id = ${query.companyId})`
      : sql``;
    const excludeRoutine =
      query.origin?.kind === ROUTINE_ORIGIN_KIND && query.origin.id
        ? sql`AND NOT (i.origin_kind = ${ROUTINE_ORIGIN_KIND} AND i.origin_id = ${query.origin.id})`
        : sql``;
    const rows = await db.execute(sql`
      WITH scored AS (
        SELECT i.id, i.identifier, i.title, i.description, i.status, i.parent_id, i.created_at,
               similarity(i.title, ${text.title}) AS title_sim,
               similarity(left(coalesce(i.description, ''), ${DUPLICATE_DESCRIPTION_MAX_CHARS}), ${text.description}) AS desc_sim,
               (${text.description} <> '' AND coalesce(i.description, '') <> '') AS both_described
        FROM issues i
        WHERE i.company_id = ${query.companyId}
          AND i.hidden_at IS NULL
          AND i.status <> 'cancelled'
          AND (i.status <> 'done' OR coalesce(i.completed_at, i.updated_at) > now() - interval '90 days')
          ${onlyOlder}
          ${excludeRoutine}
          AND (i.title % ${text.title} OR (${text.description} <> '' AND i.description % ${text.description}))
      )
      SELECT * FROM scored
      ORDER BY (CASE WHEN both_described THEN 0.6 * title_sim + 0.4 * desc_sim ELSE title_sim END) DESC
      LIMIT ${CANDIDATE_POOL_SIZE}
    `);
    return Array.from(rows).map((row) => {
      const parsed = candidateRowSchema.parse(row);
      return {
        id: parsed.id,
        identifier: parsed.identifier,
        status: parsed.status,
        parentId: parsed.parent_id,
        createdAt: parsed.created_at,
        text: prepareIssueText({ title: parsed.title, description: parsed.description }),
        titleSimilarity: parsed.title_sim,
        descriptionSimilarity: parsed.desc_sim,
      };
    });
  }

  async function score(query: SimilarityQuery, mode: DuplicateDetectionMode): Promise<CascadeResult> {
    const text = prepareIssueText(query);
    const candidates = await fetchCandidates(query, text);
    return scoreCandidates({
      mode,
      judge,
      companyId: query.companyId,
      subject: { id: query.issueId ?? null, parentId: query.parentId ?? null, text },
      candidates,
    });
  }

  async function recordPairs(companyId: string, issueId: string, pairs: readonly ScoredPair[]) {
    if (pairs.length === 0) return [];
    const now = new Date();
    return db
      .insert(issueDuplicatePairs)
      .values(
        pairs.map((pair) => ({
          companyId,
          issueId,
          candidateIssueId: pair.candidate.id,
          lexicalScore: pair.lexicalScore,
          sameOutcomeProbability: pair.sameOutcomeProbability,
          verdict: pair.verdict,
          modelId: pair.modelId,
          inputHash: pair.inputHash,
        })),
      )
      .onConflictDoUpdate({
        target: [
          issueDuplicatePairs.companyId,
          issueDuplicatePairs.issueId,
          issueDuplicatePairs.candidateIssueId,
          issueDuplicatePairs.inputHash,
        ],
        set: {
          lexicalScore: sql`excluded.lexical_score`,
          sameOutcomeProbability: sql`excluded.same_outcome_probability`,
          verdict: sql`excluded.verdict`,
          modelId: sql`excluded.model_id`,
          updatedAt: now,
        },
        setWhere: isNull(issueDuplicatePairs.commentId),
      })
      .returning({ id: issueDuplicatePairs.id, candidateIssueId: issueDuplicatePairs.candidateIssueId });
  }

  async function commentOnce(
    issue: CreatedIssueForCheck,
    entries: ReadonlyArray<{ pairId: string; pair: ScoredPair }>,
  ): Promise<string | null> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
        .for("update");
      const [alreadyCommented] = await tx
        .select({ id: issueDuplicatePairs.id })
        .from(issueDuplicatePairs)
        .where(
          and(
            eq(issueDuplicatePairs.companyId, issue.companyId),
            eq(issueDuplicatePairs.issueId, issue.id),
            isNotNull(issueDuplicatePairs.commentId),
          ),
        )
        .limit(1);
      if (alreadyCommented) return null;
      const pending = await tx
        .select({ id: issueDuplicatePairs.id })
        .from(issueDuplicatePairs)
        .where(
          and(
            eq(issueDuplicatePairs.companyId, issue.companyId),
            eq(issueDuplicatePairs.issueId, issue.id),
            inArray(issueDuplicatePairs.id, entries.map((entry) => entry.pairId)),
            isNull(issueDuplicatePairs.commentId),
          ),
        )
        .for("update");
      if (pending.length === 0) return null;
      const pendingIds = new Set(pending.map((row) => row.id));
      const toComment = entries.filter((entry) => pendingIds.has(entry.pairId));
      const comment = await deps.postSystemComment(issue.id, buildDuplicateComment(toComment), tx);
      await tx
        .update(issueDuplicatePairs)
        .set({ commentId: comment.id, updatedAt: new Date() })
        .where(
          and(
            eq(issueDuplicatePairs.companyId, issue.companyId),
            inArray(issueDuplicatePairs.id, [...pendingIds]),
          ),
        );
      return comment.id;
    });
  }

  async function checkNow(issue: CreatedIssueForCheck): Promise<void> {
    try {
      const mode = await getMode(issue.companyId);
      if (mode === "off") return;
      const result = await score(
        {
          companyId: issue.companyId,
          title: issue.title,
          description: issue.description,
          parentId: issue.parentId,
          issueId: issue.id,
          origin: { kind: issue.originKind, id: issue.originId },
        },
        mode,
      );
      const recorded = await recordPairs(issue.companyId, issue.id, result.pairs);
      if (mode !== "comment") return;

      const idByCandidate = new Map(recorded.map((row) => [row.candidateIssueId, row.id]));
      const entries = result.pairs.flatMap((pair) => {
        const pairId = idByCandidate.get(pair.candidate.id);
        const alerting = pair.verdict === "exact" || pair.verdict === "likely_duplicate";
        return pairId && alerting ? [{ pairId, pair }] : [];
      });
      if (entries.length === 0) return;

      const commentId = await commentOnce(issue, entries);
      if (!commentId) return;
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: DETECTOR_ACTOR_ID,
        action: "issue.duplicate_suspected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          commentId,
          pairs: entries.map(({ pairId, pair }) => ({
            pairId,
            candidateIssueId: pair.candidate.id,
            candidateIdentifier: pair.candidate.identifier,
            verdict: pair.verdict,
            sameOutcomeProbability: pair.sameOutcomeProbability,
            lexicalScore: pair.lexicalScore,
            modelId: pair.modelId,
          })),
        },
      });
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), issueId: issue.id, companyId: issue.companyId },
        "duplicate check after create failed",
      );
    }
  }

  const runBounded = createBoundedRunner(AFTER_CREATE_CONCURRENCY, AFTER_CREATE_MAX_PENDING);

  return {
    getMode,

    /**
     * Finds likely duplicates of a not-yet-created issue. Safe to call on any company: with the mode
     * off only the free lexical tier runs and no issue text leaves the instance.
     */
    async findSimilar(query: SimilarityQuery): Promise<FindSimilarIssuesResult> {
      let mode: DuplicateDetectionMode = "off";
      let result: CascadeResult;
      try {
        mode = await getMode(query.companyId);
        result = await score(query, mode);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), companyId: query.companyId },
          "similar-issues check failed; advising to create",
        );
        return { mode, modelUsed: false, degradedReason: "error", recommendation: "create", candidates: [] };
      }
      return {
        mode,
        modelUsed: result.modelUsed,
        degradedReason: result.degradedReason,
        recommendation: recommend(result.pairs),
        candidates: result.pairs.slice(0, DUPLICATE_CANDIDATE_LIMIT).map((pair) => ({
          issueId: pair.candidate.id,
          identifier: pair.candidate.identifier,
          title: pair.candidate.text.title,
          status: pair.candidate.status,
          lexicalScore: pair.lexicalScore,
          sameOutcomeProbability: pair.sameOutcomeProbability,
          verdict: pair.verdict,
        })),
      };
    },

    /**
     * Runs after an issue is created, off the request path, through a small bounded queue so bulk
     * creates cannot flood the database or the gateway. Excess work is dropped, never queued without
     * bound. Records every scored pair in the ledger and, in `comment` mode, posts one idempotent
     * comment per issue for pairs that clear the alert threshold. Only older candidates are
     * considered, so only the newer issue of a pair is commented on. Never throws into the caller.
     */
    checkAfterCreate(issue: CreatedIssueForCheck): Promise<void> {
      return runBounded(() => checkNow(issue));
    },

    /** Ledger rows for one issue, newest first, with the candidate's identifier and title. */
    async listPairs(companyId: string, issueId: string) {
      const rows = await db
        .select({
          pair: issueDuplicatePairs,
          candidateIdentifier: issues.identifier,
          candidateTitle: issues.title,
        })
        .from(issueDuplicatePairs)
        .innerJoin(
          issues,
          and(eq(issues.id, issueDuplicatePairs.candidateIssueId), eq(issues.companyId, companyId)),
        )
        .where(and(eq(issueDuplicatePairs.companyId, companyId), eq(issueDuplicatePairs.issueId, issueId)))
        .orderBy(desc(issueDuplicatePairs.createdAt));
      return rows.map(({ pair, candidateIdentifier, candidateTitle }) => ({
        ...pair,
        candidateIdentifier,
        candidateTitle,
      }));
    },

    /** Records a human or agent verdict on a ledger pair. Throws not-found for other companies' pairs. */
    async labelPair(
      companyId: string,
      pairId: string,
      label: DuplicatePairLabel,
      actor: DuplicateLabelActor,
    ): Promise<IssueDuplicatePair> {
      const now = new Date();
      const [updated] = await db
        .update(issueDuplicatePairs)
        .set({ label, labeledByType: actor.type, labeledById: actor.id, labeledAt: now, updatedAt: now })
        .where(and(eq(issueDuplicatePairs.companyId, companyId), eq(issueDuplicatePairs.id, pairId)))
        .returning();
      if (!updated) throw notFound("Duplicate pair not found");
      return updated;
    },
  };
}

export type DuplicateDetectionService = ReturnType<typeof duplicateDetectionService>;
