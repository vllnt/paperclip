import type {
  CompanyEval,
  CompanyEvalFeedback,
  CompanyEvalRun,
  CompanyEvalVersion,
} from "@paperclipai/shared";
import type { EvalRecord, FeedbackRecord, RunRecord, VersionRecord } from "./types.js";

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toEval(record: EvalRecord, publishedVersionNumber: number | null): CompanyEval {
  return {
    id: record.id,
    companyId: record.companyId,
    slug: record.slug,
    title: record.title,
    whenToUse: record.whenToUse,
    status: record.status,
    publishedVersionId: record.publishedVersionId,
    publishedVersionNumber,
    latestVersionNumber: record.latestVersionNumber,
    templateKey: record.templateKey,
    templateVersion: record.templateVersion,
    createdByUserId: record.createdByUserId,
    updatedByUserId: record.updatedByUserId,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    publishedAt: isoOrNull(record.publishedAt),
    archivedAt: isoOrNull(record.archivedAt),
  };
}

export function toVersion(record: VersionRecord): CompanyEvalVersion {
  return {
    id: record.id,
    companyId: record.companyId,
    evalId: record.evalId,
    versionNumber: record.versionNumber,
    inputSchema: record.inputSchema,
    questions: record.questions,
    definitionHash: record.definitionHash,
    changeNote: record.changeNote,
    createdByUserId: record.createdByUserId,
    createdAt: iso(record.createdAt),
  };
}

export function toRun(record: RunRecord): CompanyEvalRun {
  return {
    id: record.id,
    companyId: record.companyId,
    evalId: record.evalId,
    versionId: record.versionId,
    versionNumber: record.versionNumber,
    callerType: record.callerType,
    callerAgentId: record.callerAgentId,
    callerUserId: record.callerUserId,
    heartbeatRunId: record.heartbeatRunId,
    issueId: record.issueId,
    projectId: record.projectId,
    inputHash: record.inputHash,
    inputRedacted: record.inputRedacted,
    inputRedactionCount: record.inputRedactionCount,
    inputBytes: record.inputBytes,
    input: record.input ?? null,
    inputExpiresAt: isoOrNull(record.inputExpiresAt),
    mode: record.mode,
    outcome: record.outcome,
    failureReason: record.failureReason,
    answers: record.answers,
    anyAbstained: record.anyAbstained,
    cached: record.cached,
    latencyMs: record.latencyMs,
    modelId: record.modelId,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: record.costUsd,
    createdAt: iso(record.createdAt),
  };
}

export function toFeedback(record: FeedbackRecord): CompanyEvalFeedback {
  return {
    id: record.id,
    companyId: record.companyId,
    runId: record.runId,
    questionId: record.questionKey === "" ? null : record.questionKey,
    verdict: record.verdict,
    note: record.note,
    authorType: record.authorType,
    authorAgentId: record.authorAgentId,
    authorUserId: record.authorUserId,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}
