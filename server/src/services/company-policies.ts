import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  companyPolicies,
  documentRevisions,
  documents,
  projects,
} from "@paperclipai/db";
import type {
  CompanyPolicy,
  CompanyPolicyRevision,
  CreateCompanyPolicy,
  ListCompanyPoliciesQuery,
  UpdateCompanyPolicy,
} from "@paperclipai/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, notFound } from "../errors.js";

type DbReader = Pick<Db, "select">;

const KEY_INDEX = "company_policies_company_key_uq";
const POLICY_FORMAT = "markdown";
/** The history view shows the newest revisions; older ones stay in the database. */
export const COMPANY_POLICY_REVISION_LIMIT = 100;

/** Who writes a policy. Writes are board-only, so this is a board user. */
export interface CompanyPolicyWriter {
  userId: string;
  runId?: string | null;
}

/** The fields an update changed, for the activity log. */
export type CompanyPolicyChange = keyof Omit<UpdateCompanyPolicy, "changeSummary" | "baseRevisionId">;

const policyColumns = {
  id: companyPolicies.id,
  companyId: companyPolicies.companyId,
  projectId: companyPolicies.projectId,
  key: companyPolicies.key,
  summary: companyPolicies.summary,
  status: companyPolicies.status,
  ownerAgentId: companyPolicies.ownerAgentId,
  ownerUserId: companyPolicies.ownerUserId,
  documentId: companyPolicies.documentId,
  createdAt: companyPolicies.createdAt,
  updatedAt: companyPolicies.updatedAt,
  title: documents.title,
  body: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
};

function mapPolicy(row: Omit<CompanyPolicy, "title"> & { title: string | null }): CompanyPolicy {
  return { ...row, title: row.title ?? "" };
}

function mapRevision(policyId: string, row: typeof documentRevisions.$inferSelect): CompanyPolicyRevision {
  return {
    id: row.id,
    policyId,
    revisionNumber: row.revisionNumber,
    title: row.title ?? null,
    body: row.body,
    changeSummary: row.changeSummary ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

/** An empty summary is stored as no summary. */
function normalizeSummary(summary: string | null | undefined): string | null | undefined {
  return summary === undefined ? undefined : summary || null;
}

function listFilter(companyId: string, query: ListCompanyPoliciesQuery): SQL | undefined {
  const conditions: SQL[] = [eq(companyPolicies.companyId, companyId)];
  if (query.projectId) conditions.push(eq(companyPolicies.projectId, query.projectId));
  else if (query.scope === "company") conditions.push(isNull(companyPolicies.projectId));
  else if (query.scope === "project") conditions.push(isNotNull(companyPolicies.projectId));
  if (query.status) conditions.push(eq(companyPolicies.status, query.status));
  return and(...conditions);
}

/** Company policies: written rules and guardrails for a company or one of its projects. */
export function companyPolicyService(db: Db) {
  async function findByKey(reader: DbReader, companyId: string, key: string): Promise<CompanyPolicy | null> {
    const row = await reader
      .select(policyColumns)
      .from(companyPolicies)
      .innerJoin(documents, eq(documents.id, companyPolicies.documentId))
      .where(and(eq(companyPolicies.companyId, companyId), eq(companyPolicies.key, key)))
      .then((rows) => rows[0] ?? null);
    return row ? mapPolicy(row) : null;
  }

  async function requireByKey(reader: DbReader, companyId: string, key: string): Promise<CompanyPolicy> {
    const policy = await findByKey(reader, companyId, key);
    if (!policy) throw notFound("Policy not found");
    return policy;
  }

  async function assertProjectInCompany(reader: DbReader, companyId: string, projectId: string): Promise<void> {
    const row = await reader
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
  }

  async function assertOwnerInCompany(
    reader: DbReader,
    companyId: string,
    owner: { ownerAgentId?: string | null; ownerUserId?: string | null },
  ): Promise<void> {
    if (owner.ownerAgentId) {
      const row = await reader
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, owner.ownerAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Owner agent not found");
    }
    if (owner.ownerUserId) {
      const row = await reader
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, owner.ownerUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Owner user not found");
    }
  }

  async function list(companyId: string, query: ListCompanyPoliciesQuery = {}): Promise<CompanyPolicy[]> {
    const rows = await db
      .select(policyColumns)
      .from(companyPolicies)
      .innerJoin(documents, eq(documents.id, companyPolicies.documentId))
      .where(listFilter(companyId, query))
      .orderBy(sql`${companyPolicies.projectId} nulls first`, asc(documents.title), asc(companyPolicies.key));
    return rows.map(mapPolicy);
  }

  async function getByKey(companyId: string, key: string): Promise<CompanyPolicy | null> {
    return findByKey(db, companyId, key);
  }

  async function create(companyId: string, input: CreateCompanyPolicy, writer: CompanyPolicyWriter): Promise<CompanyPolicy> {
    if (input.projectId) await assertProjectInCompany(db, companyId, input.projectId);
    await assertOwnerInCompany(db, companyId, input);
    const now = new Date();
    try {
      return await db.transaction(async (tx) => {
        const [document] = await tx
          .insert(documents)
          .values({
            companyId,
            title: input.title,
            format: POLICY_FORMAT,
            latestBody: input.body,
            latestRevisionNumber: 1,
            createdByUserId: writer.userId,
            updatedByUserId: writer.userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId,
            documentId: document.id,
            revisionNumber: 1,
            title: input.title,
            format: POLICY_FORMAT,
            body: input.body,
            createdByUserId: writer.userId,
            createdByRunId: writer.runId ?? null,
            createdAt: now,
          })
          .returning();
        await tx.update(documents).set({ latestRevisionId: revision.id }).where(eq(documents.id, document.id));
        await tx.insert(companyPolicies).values({
          companyId,
          projectId: input.projectId ?? null,
          documentId: document.id,
          key: input.key,
          summary: normalizeSummary(input.summary) ?? null,
          status: input.status,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          createdAt: now,
          updatedAt: now,
        });
        return requireByKey(tx, companyId, input.key);
      });
    } catch (error) {
      if (isUniqueViolation(error, KEY_INDEX)) throw conflict(`A policy with the key "${input.key}" already exists`);
      throw error;
    }
  }

  /**
   * Updates a policy. A changed title or body saves a new revision; the other fields change in place.
   * Returns the policy and the fields that changed, or null when the policy does not exist.
   */
  async function update(
    companyId: string,
    key: string,
    input: UpdateCompanyPolicy,
    writer: CompanyPolicyWriter,
  ): Promise<{ policy: CompanyPolicy; changed: CompanyPolicyChange[] }> {
    if (input.projectId) await assertProjectInCompany(db, companyId, input.projectId);
    await assertOwnerInCompany(db, companyId, input);
    const now = new Date();
    return db.transaction(async (tx) => {
      const current = await tx
        .select({ policy: companyPolicies, document: documents })
        .from(companyPolicies)
        .innerJoin(documents, eq(documents.id, companyPolicies.documentId))
        .where(and(eq(companyPolicies.companyId, companyId), eq(companyPolicies.key, key)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Policy not found");
      const { policy, document } = current;

      const changed: CompanyPolicyChange[] = [];
      const titleChanged = input.title !== undefined && input.title !== (document.title ?? "");
      const bodyChanged = input.body !== undefined && input.body !== document.latestBody;
      if (titleChanged) changed.push("title");
      if (bodyChanged) changed.push("body");

      if (titleChanged || bodyChanged) {
        if (input.baseRevisionId && input.baseRevisionId !== document.latestRevisionId) {
          throw conflict("Someone else changed this policy. Reload it and apply your edit again.", {
            currentRevisionId: document.latestRevisionId,
          });
        }
        const title = input.title ?? document.title;
        const body = input.body ?? document.latestBody;
        const revisionNumber = document.latestRevisionNumber + 1;
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId,
            documentId: document.id,
            revisionNumber,
            title,
            format: POLICY_FORMAT,
            body,
            changeSummary: input.changeSummary ?? null,
            createdByUserId: writer.userId,
            createdByRunId: writer.runId ?? null,
            createdAt: now,
          })
          .returning();
        await tx
          .update(documents)
          .set({
            title,
            latestBody: body,
            latestRevisionId: revision.id,
            latestRevisionNumber: revisionNumber,
            updatedByAgentId: null,
            updatedByUserId: writer.userId,
            updatedAt: now,
          })
          .where(eq(documents.id, document.id));
      }

      const patch: Partial<typeof companyPolicies.$inferInsert> = {};
      const summary = normalizeSummary(input.summary);
      if (summary !== undefined && summary !== policy.summary) {
        patch.summary = summary;
        changed.push("summary");
      }
      if (input.status !== undefined && input.status !== policy.status) {
        patch.status = input.status;
        changed.push("status");
      }
      if (input.projectId !== undefined && input.projectId !== policy.projectId) {
        patch.projectId = input.projectId;
        changed.push("projectId");
      }
      const ownerAgentId = input.ownerUserId ? null : input.ownerAgentId;
      const ownerUserId = input.ownerAgentId ? null : input.ownerUserId;
      if (ownerAgentId !== undefined && ownerAgentId !== policy.ownerAgentId) {
        patch.ownerAgentId = ownerAgentId;
        changed.push("ownerAgentId");
      }
      if (ownerUserId !== undefined && ownerUserId !== policy.ownerUserId) {
        patch.ownerUserId = ownerUserId;
        changed.push("ownerUserId");
      }
      if (changed.length > 0) {
        await tx
          .update(companyPolicies)
          .set({ ...patch, updatedAt: now })
          .where(eq(companyPolicies.id, policy.id));
      }
      return { policy: await requireByKey(tx, companyId, key), changed };
    });
  }

  /** Deletes an archived policy with its document and revisions. Archive is the normal way to retire one. */
  async function remove(companyId: string, key: string): Promise<CompanyPolicy> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: companyPolicies.id })
        .from(companyPolicies)
        .where(and(eq(companyPolicies.companyId, companyId), eq(companyPolicies.key, key)))
        .for("update");
      const policy = await requireByKey(tx, companyId, key);
      if (policy.status !== "archived") {
        throw conflict("Archive the policy before you delete it. Archiving keeps policy:// references valid.");
      }
      await tx.delete(documents).where(and(eq(documents.id, policy.documentId), eq(documents.companyId, companyId)));
      return policy;
    });
  }

  async function listRevisions(companyId: string, key: string): Promise<CompanyPolicyRevision[]> {
    const policy = await requireByKey(db, companyId, key);
    const rows = await db
      .select()
      .from(documentRevisions)
      .where(and(eq(documentRevisions.companyId, companyId), eq(documentRevisions.documentId, policy.documentId)))
      .orderBy(desc(documentRevisions.revisionNumber))
      .limit(COMPANY_POLICY_REVISION_LIMIT);
    return rows.map((row) => mapRevision(policy.id, row));
  }

  return { list, getByKey, create, update, remove, listRevisions };
}
