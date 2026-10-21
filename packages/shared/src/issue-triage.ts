import { z } from "zod";
import { ISSUE_PRIORITIES, type IssuePriority } from "./constants.js";

/**
 * Per-company issue triage mode.
 * - `off`: nothing is sent anywhere and nothing is recorded.
 * - `suggest`: Jev scores each new issue and the result is recorded; no issue is changed.
 * - `apply`: as `suggest`, plus the router fills the assignee of an unassigned `todo` issue when its
 *   top owner is clear enough (see `ISSUE_TRIAGE_THRESHOLDS`). Priority is never changed.
 */
export const ISSUE_TRIAGE_MODES = ["off", "suggest", "apply"] as const;
export type IssueTriageMode = (typeof ISSUE_TRIAGE_MODES)[number];

/** Closed set of short categories the model picks from. */
export const ISSUE_TRIAGE_CATEGORIES = ["bug", "feature", "chore", "docs", "research", "ops", "question"] as const;
export type IssueTriageCategory = (typeof ISSUE_TRIAGE_CATEGORIES)[number];

/**
 * - `suggested`: the triage was recorded; nothing on the issue changed.
 * - `applied`: the router set the assignee.
 * - `skipped`: a deterministic rule kept the issue's values, so no model call was made.
 * - `degraded`: the model could not answer (no key, daily cap, timeout or error); nothing changed.
 */
export const ISSUE_TRIAGE_OUTCOMES = ["suggested", "applied", "skipped", "degraded"] as const;
export type IssueTriageOutcome = (typeof ISSUE_TRIAGE_OUTCOMES)[number];

export const ISSUE_TRIAGE_SKIP_REASONS = ["routine_origin", "short_title"] as const;
export type IssueTriageSkipReason = (typeof ISSUE_TRIAGE_SKIP_REASONS)[number];

export const ISSUE_TRIAGE_DEGRADED_REASONS = ["no_key", "cap_exceeded", "timeout", "error"] as const;
export type IssueTriageDegradedReason = (typeof ISSUE_TRIAGE_DEGRADED_REASONS)[number];

/**
 * Why `apply` did or did not set the assignee. `applied` is the only value that changed the issue.
 * The other values name the first rule that stopped it.
 */
export const ISSUE_TRIAGE_APPLY_DECISIONS = [
  "applied",
  "mode_suggest",
  "not_todo",
  "already_assigned",
  "no_candidates",
  "no_owner_suggested",
  "no_probabilities",
  "below_probability",
  "below_margin",
  "assignee_changed",
  "not_assignable",
] as const;
export type IssueTriageApplyDecision = (typeof ISSUE_TRIAGE_APPLY_DECISIONS)[number];

/** The owner rule: the top probability must reach `ownerMinProbability` and beat the next by `ownerMinMargin`. */
export const ISSUE_TRIAGE_THRESHOLDS = { ownerMinProbability: 0.8, ownerMinMargin: 0.2 } as const;

/** Titles with fewer words than this are not sent to the model. */
export const ISSUE_TRIAGE_MIN_TITLE_WORDS = 3;

/** Upper bound of model calls for one issue. */
export const ISSUE_TRIAGE_MAX_MODEL_CALLS = 6;

export const ISSUE_TRIAGE_ACTIVITY_ACTION = "issue.triaged";

export interface IssueTriagePriority {
  /** The issue's priority when it was triaged. */
  current: IssuePriority;
  /** Null when the issue already had a non-default priority, so the question was not asked. */
  suggested: IssuePriority | null;
  probabilities: Record<string, number> | null;
}

export interface IssueTriageCategoryResult {
  suggested: IssueTriageCategory | null;
  probabilities: Record<string, number> | null;
}

export interface IssueTriageOwner {
  /** Agent id; null when no owner was asked for or the model named none. */
  suggestedAgentId: string | null;
  suggestedAgentName: string | null;
  /** Probability per candidate agent id, plus `none` for "no listed agent fits". */
  probabilities: Record<string, number> | null;
  topProbability: number | null;
  /** Gap between the top probability and the next one; null when fewer than two are known. */
  margin: number | null;
  decision: IssueTriageApplyDecision;
  appliedAgentId: string | null;
  /** How many candidate agents were offered to the model. */
  candidateCount: number;
}

/** One recorded triage. `issue.triaged` activity entries carry exactly this as their details. */
export interface IssueTriage {
  id: string;
  issueId: string;
  companyId: string;
  createdAt: string;
  version: 1;
  mode: IssueTriageMode;
  outcome: IssueTriageOutcome;
  reason: IssueTriageSkipReason | IssueTriageDegradedReason | null;
  modelId: string | null;
  modelCalls: number;
  inputHashes: string[];
  thresholds: { ownerMinProbability: number; ownerMinMargin: number };
  priority: IssueTriagePriority | null;
  category: IssueTriageCategoryResult | null;
  owner: IssueTriageOwner | null;
}

export interface IssueTriagePage {
  items: IssueTriage[];
  nextCursor: string | null;
}

export const listIssueTriageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListIssueTriageQuery = z.infer<typeof listIssueTriageQuerySchema>;

const probabilitiesSchema = z.record(z.string(), z.number()).nullable();

/** Shape of a stored triage entry (an `issue.triaged` activity entry's details). */
export const issueTriageEntrySchema = z.object({
  version: z.literal(1),
  issueId: z.string(),
  companyId: z.string(),
  mode: z.enum(ISSUE_TRIAGE_MODES),
  outcome: z.enum(ISSUE_TRIAGE_OUTCOMES),
  reason: z.enum([...ISSUE_TRIAGE_SKIP_REASONS, ...ISSUE_TRIAGE_DEGRADED_REASONS]).nullable(),
  modelId: z.string().nullable(),
  modelCalls: z.number().int().nonnegative(),
  inputHashes: z.array(z.string()),
  thresholds: z.object({ ownerMinProbability: z.number(), ownerMinMargin: z.number() }),
  priority: z
    .object({
      current: z.enum(ISSUE_PRIORITIES),
      suggested: z.enum(ISSUE_PRIORITIES).nullable(),
      probabilities: probabilitiesSchema,
    })
    .nullable(),
  category: z
    .object({
      suggested: z.enum(ISSUE_TRIAGE_CATEGORIES).nullable(),
      probabilities: probabilitiesSchema,
    })
    .nullable(),
  owner: z
    .object({
      suggestedAgentId: z.string().nullable(),
      suggestedAgentName: z.string().nullable(),
      probabilities: probabilitiesSchema,
      topProbability: z.number().nullable(),
      margin: z.number().nullable(),
      decision: z.enum(ISSUE_TRIAGE_APPLY_DECISIONS),
      appliedAgentId: z.string().nullable(),
      candidateCount: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type IssueTriageEntry = z.infer<typeof issueTriageEntrySchema>;
