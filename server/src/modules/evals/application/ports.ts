import type {
  EvalActor,
  EvalJudgeOutcome,
  EvalRecord,
  FeedbackRecord,
  NewRunRecord,
  NewVersionFields,
  RunCursor,
  RunFilter,
  RunRecord,
  VerifiedRunContext,
  VersionRecord,
} from "./types.js";
import type { CompanyEvalQuestions, CompanyEvalStatus } from "@paperclipai/shared";
import type { JsonObject } from "../domain/input.js";

export interface ListEvalsQuery {
  /** Only evals with one of these statuses. */
  statuses: readonly CompanyEvalStatus[];
  /** Only evals that have a published version (the agent view). */
  publishedOnly: boolean;
  limit: number;
  /** Keyset: slugs after this one, in ascending order. */
  afterSlug?: string;
}

export interface NewEvalFields {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  whenToUse: string;
  createdByUserId: string | null;
  now: Date;
}

export interface NewFeedbackFields {
  id: string;
  companyId: string;
  runId: string;
  questionKey: string;
  verdict: FeedbackRecord["verdict"];
  note: string | null;
  authorType: FeedbackRecord["authorType"];
  authorKey: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  now: Date;
}

/**
 * Storage for evals. Every method filters on `companyId`. Methods that change more than one row
 * are one atomic unit in the adapter.
 */
export interface EvalsRepository {
  findEvalBySlug(companyId: string, slug: string): Promise<EvalRecord | null>;
  listEvals(companyId: string, query: ListEvalsQuery): Promise<EvalRecord[]>;
  /** Creates the eval and its version 1 together. Throws `EvalSlugTakenError` on a duplicate slug. */
  insertEvalWithFirstVersion(eval_: NewEvalFields, version: NewVersionFields): Promise<{ eval: EvalRecord; version: VersionRecord }>;
  updateEvalMeta(
    companyId: string,
    evalId: string,
    patch: { title?: string; whenToUse?: string; updatedByUserId: string | null; now: Date },
  ): Promise<EvalRecord | null>;
  getVersionByNumber(companyId: string, evalId: string, versionNumber: number): Promise<VersionRecord | null>;
  getVersionsByIds(companyId: string, ids: readonly string[]): Promise<VersionRecord[]>;
  /** Newest first. Keyset: version numbers below `beforeNumber`. */
  listVersions(companyId: string, evalId: string, query: { limit: number; beforeNumber?: number }): Promise<VersionRecord[]>;
  /**
   * Adds the next version when the eval's `latest_version_number` still equals `expectedLatest`
   * (compare-and-set on the parent row). Returns null when another writer got there first.
   */
  appendVersion(input: {
    companyId: string;
    evalId: string;
    expectedLatest: number;
    version: NewVersionFields;
  }): Promise<VersionRecord | null>;
  setPublished(
    companyId: string,
    evalId: string,
    input: { versionId: string; updatedByUserId: string | null; now: Date },
  ): Promise<EvalRecord | null>;
  setArchived(companyId: string, evalId: string, input: { updatedByUserId: string | null; now: Date }): Promise<EvalRecord | null>;
  /** Deletes the eval, its versions, runs and feedback, only while it was never published. */
  deleteNeverPublished(companyId: string, evalId: string): Promise<boolean>;
  insertRun(run: NewRunRecord): Promise<RunRecord>;
  listRuns(
    companyId: string,
    evalId: string,
    query: { filter: RunFilter; limit: number; after: RunCursor | null },
  ): Promise<RunRecord[]>;
  getRun(companyId: string, evalId: string, runId: string): Promise<RunRecord | null>;
  upsertFeedback(feedback: NewFeedbackFields): Promise<FeedbackRecord>;
  listFeedback(companyId: string, runId: string): Promise<FeedbackRecord[]>;
  /** Clears `input` on runs whose `input_expires_at` has passed. Returns how many it cleared. */
  clearExpiredInputs(now: Date, batchSize: number): Promise<number>;
}

/** Checks the run id and issue that a caller sends against this company before they are stored. */
export interface RunContextPort {
  verify(input: {
    companyId: string;
    actor: EvalActor;
    /** The run id from the signed token or the `X-Paperclip-Run-Id` header. Not trusted. */
    runId: string | null;
    /** The issue id from the request body. Not trusted. */
    issueId: string | null;
  }): Promise<VerifiedRunContext>;
}

export interface EvalJudgePort {
  ask(request: {
    companyId: string;
    rubricVersion: string;
    state: JsonObject;
    questions: CompanyEvalQuestions;
  }): Promise<EvalJudgeOutcome>;
}

export interface EvalsRuntime {
  now(): Date;
  /** A monotonic reading in milliseconds, for latency. */
  monotonicMs(): number;
  newId(): string;
  sha256Hex(text: string): string;
  /** Masks secret-shaped text in a string. */
  redactText(text: string): string;
}

export interface EvalsSettings {
  /** 0 means inputs are not stored. */
  inputRetentionDays: number;
}
