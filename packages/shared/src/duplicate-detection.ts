import { z } from "zod";

/**
 * Per-company duplicate detection mode.
 * - `off`: the similar-issues API runs the free lexical tier only; no issue text leaves the instance.
 * - `suggest`: Jev scores candidate pairs (API and after-create ledger); nothing is posted on issues.
 * - `comment`: as `suggest`, plus one comment on a new issue when a pair clears the alert threshold.
 */
export const DUPLICATE_DETECTION_MODES = ["off", "suggest", "comment"] as const;
export type DuplicateDetectionMode = (typeof DUPLICATE_DETECTION_MODES)[number];

export const DUPLICATE_PAIR_LABELS = ["duplicate", "keep_both"] as const;
export type DuplicatePairLabel = (typeof DUPLICATE_PAIR_LABELS)[number];

/**
 * Outcome of scoring one (new issue, candidate) pair.
 * `exact` is a normalized-content match with no model call. `lexical_only` means the model was not
 * consulted (mode off, short text, cap, timeout, or error), so only the trigram score is known.
 */
export const DUPLICATE_PAIR_VERDICTS = [
  "exact",
  "likely_duplicate",
  "uncertain",
  "distinct",
  "lexical_only",
] as const;
export type DuplicatePairVerdict = (typeof DUPLICATE_PAIR_VERDICTS)[number];

export const DUPLICATE_DEGRADED_REASONS = [
  "mode_off",
  "no_key",
  "cap_exceeded",
  "timeout",
  "error",
] as const;
export type DuplicateDegradedReason = (typeof DUPLICATE_DEGRADED_REASONS)[number];

export const findSimilarIssuesSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type FindSimilarIssues = z.infer<typeof findSimilarIssuesSchema>;

export const labelDuplicatePairSchema = z
  .object({
    label: z.enum(DUPLICATE_PAIR_LABELS),
  })
  .strict();
export type LabelDuplicatePair = z.infer<typeof labelDuplicatePairSchema>;

export interface SimilarIssueCandidate {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  lexicalScore: number;
  sameOutcomeProbability: number | null;
  verdict: DuplicatePairVerdict;
}

export interface FindSimilarIssuesResult {
  mode: DuplicateDetectionMode;
  modelUsed: boolean;
  degradedReason: DuplicateDegradedReason | null;
  recommendation: "create" | "review_candidates" | "likely_duplicate";
  candidates: SimilarIssueCandidate[];
}

export interface IssueDuplicatePair {
  id: string;
  companyId: string;
  issueId: string;
  candidateIssueId: string;
  lexicalScore: number;
  sameOutcomeProbability: number | null;
  verdict: DuplicatePairVerdict;
  modelId: string | null;
  inputHash: string;
  label: DuplicatePairLabel | null;
  labeledByType: "user" | "agent" | null;
  labeledById: string | null;
  labeledAt: Date | null;
  commentId: string | null;
  createdAt: Date;
}
