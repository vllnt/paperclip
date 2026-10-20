import { and, eq, isNull } from "drizzle-orm";
import {
  documentRevisions,
  documents,
  issueDocuments,
  issues,
  type Db,
} from "@paperclipai/db";
import { redactQuarantinedBodyForHigherTrust } from "./source-trust.js";
import { cutText } from "@paperclipai/shared";

/** Characters of the plan body that a wake's task brief carries. */
export const TASK_PLAN_BODY_MAX_CHARS = 32_000;

/**
 * Read the task's durable plan before constructing any provider's assignment.
 * The body is cut at {@link TASK_PLAN_BODY_MAX_CHARS}, with a line that says
 * where the full revision is: the latest revision through the document read,
 * an older approved one through the revision list.
 */
export async function getTaskPlanContext(input: {
  db: Db;
  companyId: string;
  issueId: string;
  approvedRevisionId?: string | null;
  exposeLowTrustRaw?: boolean;
}) {
  const { db, companyId, issueId } = input;
  const plan = await db
    .select({
      documentId: documents.id,
      revisionId: documentRevisions.id,
      revisionNumber: documentRevisions.revisionNumber,
      body: documentRevisions.body,
      sourceTrust: documents.sourceTrust,
      latestRevisionId: documents.latestRevisionId,
    })
    .from(issueDocuments)
    .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .innerJoin(
      documentRevisions,
      and(
        eq(documentRevisions.documentId, documents.id),
        input.approvedRevisionId
          ? eq(documentRevisions.id, input.approvedRevisionId)
          : eq(documentRevisions.id, documents.latestRevisionId),
      ),
    )
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.companyId, companyId),
        eq(issueDocuments.companyId, companyId),
        eq(documents.companyId, companyId),
        eq(documentRevisions.companyId, companyId),
        eq(issueDocuments.key, "plan"),
        isNull(issues.conversationAgentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!plan) return null;
  const { latestRevisionId, ...row } = plan;
  const visible = input.exposeLowTrustRaw ? row : redactQuarantinedBodyForHigherTrust(row);
  const readHint = latestRevisionId === row.revisionId
    ? `read it with GET /api/issues/${issueId}/documents/plan (CLI: paperclipai issue document:get ${issueId} plan)`
    : `revision ${row.revisionNumber} is not the latest; GET /api/issues/${issueId}/documents/plan/revisions returns every revision in full`;
  return { ...visible, body: cutText(visible.body, TASK_PLAN_BODY_MAX_CHARS, readHint) };
}
