import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyPolicies, companySkills, documents, issueComments } from "@paperclipai/db";
import { POLICY_INDEX_MAX_MENTIONS, extractPolicyMentionKeys } from "@paperclipai/shared";
import type { MentionSources, PolicyIndexRowsPort } from "../application/ports.js";
import { mergeMentionedKeys } from "../domain/policy-index.js";
import type { MentionScanCache } from "./scan-cache.js";

/** A comment is only read when its text holds a policy link, and at most this many of them. */
const MENTION_COMMENT_LIMIT = 50;
/** A run names at most this many skills. */
const SKILL_KEY_LIMIT = 200;

export function createPostgresPolicyIndexRows(db: Db): PolicyIndexRowsPort {
  return {
    async load({ companyId, projectId, mentionedKeys, limit }) {
      const keys = [...mentionedKeys];
      const baseline = and(
        eq(companyPolicies.status, "active"),
        projectId
          ? or(isNull(companyPolicies.projectId), eq(companyPolicies.projectId, projectId))
          : isNull(companyPolicies.projectId),
      );
      const matches = keys.length > 0 ? or(baseline, inArray(companyPolicies.key, keys)) : baseline;
      const mentionedFirst = keys.length > 0 ? [desc(sql`(${inArray(companyPolicies.key, keys)})`)] : [];
      const rows = await db
        .select({
          key: companyPolicies.key,
          summary: companyPolicies.summary,
          status: companyPolicies.status,
          projectId: companyPolicies.projectId,
          title: documents.title,
          total: sql<number>`(count(*) over ())::int`,
        })
        .from(companyPolicies)
        .innerJoin(documents, eq(documents.id, companyPolicies.documentId))
        .where(and(eq(companyPolicies.companyId, companyId), matches))
        .orderBy(
          ...mentionedFirst,
          sql`${companyPolicies.projectId} nulls first`,
          asc(documents.title),
          asc(companyPolicies.key),
        )
        .limit(limit);
      return {
        rows: rows.map(({ total: _total, title, ...row }) => ({ ...row, title: title ?? "" })),
        totalMatching: rows[0]?.total ?? 0,
      };
    },
  };
}

/**
 * The issue text: its title and description, which already hold any routine or step text the issue
 * was created from, and its comments. The database filters the comments, so a thread with no policy
 * link returns no rows.
 */
export function createPostgresIssueMentionSource(db: Db): MentionSources["issue"] {
  return async ({ companyId, issueId, title, description }) => {
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          isNull(issueComments.deletedAt),
          ilike(issueComments.body, "%policy://%"),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(MENTION_COMMENT_LIMIT);
    return mergeMentionedKeys(
      [title, description ?? "", ...comments.map((comment) => comment.body)].map((text) => extractPolicyMentionKeys(text)),
      POLICY_INDEX_MAX_MENTIONS,
    );
  };
}

/**
 * The markdown of the company skills a run uses. Each scan is cached by the skill's id, version and
 * update time, so a run reads a skill's markdown only after the skill changed.
 */
export function createPostgresSkillMentionSource(db: Db, cache: MentionScanCache): MentionSources["skills"] {
  return async ({ companyId, skillKeys }) => {
    const keys = [...new Set(skillKeys)].slice(0, SKILL_KEY_LIMIT);
    if (keys.length === 0) return [];
    const skills = await db
      .select({
        id: companySkills.id,
        currentVersionId: companySkills.currentVersionId,
        updatedAt: companySkills.updatedAt,
      })
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.key, keys)));

    const cacheKeyOf = (skill: (typeof skills)[number]) =>
      `skill:${skill.id}:${skill.currentVersionId ?? ""}:${skill.updatedAt.getTime()}`;
    const mentioned: string[][] = [];
    const uncached: typeof skills = [];
    for (const skill of skills) {
      // A hit never reads the markdown.
      const hit = cache.peek(cacheKeyOf(skill));
      if (hit) mentioned.push(hit);
      else uncached.push(skill);
    }
    if (uncached.length > 0) {
      const rows = await db
        .select({ id: companySkills.id, markdown: companySkills.markdown })
        .from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.id, uncached.map((skill) => skill.id))));
      const markdownById = new Map(rows.map((row) => [row.id, row.markdown]));
      for (const skill of uncached) {
        const found = extractPolicyMentionKeys(markdownById.get(skill.id) ?? "").slice(0, POLICY_INDEX_MAX_MENTIONS);
        cache.set(cacheKeyOf(skill), found);
        mentioned.push(found);
      }
    }
    return mergeMentionedKeys(mentioned, POLICY_INDEX_MAX_MENTIONS);
  };
}
