import { and, eq, isNull } from "drizzle-orm";
import {
  documentRevisions,
  documents,
  issueDocuments,
  issues,
  type Db,
} from "@paperclipai/db";
import { redactQuarantinedBodyForHigherTrust } from "./source-trust.js";
import { cutText } from "./continuation-window.js";

/** Characters of the plan body that a wake's task brief carries. */
export const TASK_PLAN_BODY_MAX_CHARS = 32_000;

/**
 * Read the task's durable plan before constructing any provider's assignment.
 * The body is cut at {@link TASK_PLAN_BODY_MAX_CHARS}, with a line that says
 * where the full revision is.
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
  const visible = plan && !input.exposeLowTrustRaw
    ? redactQuarantinedBodyForHigherTrust(plan)
    : plan;
  return visible
    ? {
        ...visible,
        body: cutText(
          visible.body,
          TASK_PLAN_BODY_MAX_CHARS,
          `read revision ${visible.revisionNumber} with GET /api/issues/${issueId}/documents/plan/revisions`,
        ),
      }
    : visible;
}
