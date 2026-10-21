import type {
  CompanyEvalAnswer,
  CompanyEvalCallerType,
  CompanyEvalFailureReason,
  CompanyEvalFeedbackVerdict,
  CompanyEvalInputIssue,
  CompanyEvalInputSchema,
  CompanyEvalQuestions,
  CompanyEvalRunMode,
  CompanyEvalRunOutcome,
  CompanyEvalStatus,
} from "@paperclipai/shared";
import type { JudgeAnswerShape } from "../domain/policy.js";

/** Who is calling. A board user (`user`) or an agent. */
export type EvalActor = { type: "user"; userId: string } | { type: "agent"; agentId: string };

export interface EvalRecord {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  whenToUse: string;
  status: CompanyEvalStatus;
  publishedVersionId: string | null;
  latestVersionNumber: number;
  templateKey: string | null;
  templateVersion: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
}

export interface VersionRecord {
  id: string;
  companyId: string;
  evalId: string;
  versionNumber: number;
  inputSchema: CompanyEvalInputSchema;
  questions: CompanyEvalQuestions;
  definitionHash: string;
  changeNote: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface RunRecord {
  id: string;
  companyId: string;
  evalId: string;
  versionId: string;
  versionNumber: number;
  callerType: CompanyEvalCallerType;
  callerAgentId: string | null;
  callerUserId: string | null;
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
  inputHash: string;
  inputRedacted: boolean;
  inputRedactionCount: number;
  inputBytes: number;
  input: unknown;
  inputExpiresAt: Date | null;
  mode: CompanyEvalRunMode;
  outcome: CompanyEvalRunOutcome;
  failureReason: CompanyEvalFailureReason | null;
  answers: Record<string, CompanyEvalAnswer> | null;
  anyAbstained: boolean;
  cached: boolean;
  latencyMs: number;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  createdAt: Date;
}

export type NewRunRecord = Omit<RunRecord, "id"> & { id: string };

export interface FeedbackRecord {
  id: string;
  companyId: string;
  runId: string;
  questionKey: string;
  verdict: CompanyEvalFeedbackVerdict;
  note: string | null;
  authorType: CompanyEvalCallerType;
  authorKey: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewVersionFields {
  id: string;
  inputSchema: CompanyEvalInputSchema;
  questions: CompanyEvalQuestions;
  definitionHash: string;
  changeNote: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface RunFilter {
  from?: Date;
  to?: Date;
  versionNumber?: number;
  agentId?: string;
  projectId?: string;
  outcome?: CompanyEvalRunOutcome;
  mode?: CompanyEvalRunMode;
}

export interface RunCursor extends Record<string, string | number> {
  at: string;
  id: string;
}

/** What the run-id check found. Only ids that belong to the caller's company come back. */
export interface VerifiedRunContext {
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
  /** True when the body named an issue that is not an issue of this company. */
  requestedIssueMissing: boolean;
}

export type EvalJudgeOutcome =
  | {
      ok: true;
      answers: Readonly<Record<string, JudgeAnswerShape>>;
      modelId: string;
      cached: boolean;
      usage?: { inputTokens?: number; outputTokens?: number };
      costUsd?: number;
    }
  | { ok: false; reason: Exclude<CompanyEvalFailureReason, "input_too_large" | "input_invalid"> };

export type EvalsErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "invalid_request"
  | "input_rejected";

/** A use-case failure. The route turns it into an HTTP response. */
export class EvalsApplicationError extends Error {
  readonly code: EvalsErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: EvalsErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EvalsApplicationError";
    this.code = code;
    this.details = details;
  }
}

/** A rejected input: too large or not matching the schema. The run is recorded with its own id. */
export interface RejectionFacts {
  code: "eval_input_too_large" | "eval_input_invalid";
  errors?: CompanyEvalInputIssue[];
  maxInputBytes?: number;
  inputBytes?: number;
}

export interface RejectedInputDetails extends RejectionFacts, Record<string, unknown> {
  runId: string;
}

/** Thrown after the rejected run is recorded; `rejection.runId` is that run. */
export class EvalInputRejectedError extends EvalsApplicationError {
  readonly rejection: RejectedInputDetails;
  constructor(message: string, rejection: RejectedInputDetails) {
    super("input_rejected", message, rejection);
    this.name = "EvalInputRejectedError";
    this.rejection = rejection;
  }
}

export class EvalSlugTakenError extends Error {
  constructor(slug: string) {
    super(`An eval with the slug "${slug}" already exists in this company.`);
    this.name = "EvalSlugTakenError";
  }
}
