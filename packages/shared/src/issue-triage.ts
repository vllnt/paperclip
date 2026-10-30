import { z } from "zod";
import type { IssuePriority } from "./constants.js";

/**
 * Per-company issue triage mode.
 * - `off`: nothing runs and no issue text leaves the instance.
 * - `suggest`: Jev scores every new issue and the result is recorded (priority, category, owner and the
 *   probabilities behind them). Nothing on the issue changes.
 * - `apply`: as `suggest`, plus the router fills the assignee of an unassigned `todo` issue when the
 *   top owner is confident. It never reassigns and never changes a priority.
 */
export const ISSUE_TRIAGE_MODES = ["off", "suggest", "apply"] as const;
export type IssueTriageMode = (typeof ISSUE_TRIAGE_MODES)[number];

export const issueTriageModeSchema = z.enum(ISSUE_TRIAGE_MODES);

export const ISSUE_TRIAGE_CATEGORIES = [
  "bug",
  "feature",
  "improvement",
  "maintenance",
  "docs",
  "research",
  "ops",
  "security",
  "other",
] as const;
export type IssueTriageCategory = (typeof ISSUE_TRIAGE_CATEGORIES)[number];

/**
 * - `scored`: the model answered every question that was asked.
 * - `degraded`: a model call could not be made or failed; the reason says why and nothing was applied.
 * - `skipped`: a rule decided that no model call was needed (see `ISSUE_TRIAGE_REASONS`).
 */
export const ISSUE_TRIAGE_STATUSES = ["scored", "degraded", "skipped"] as const;
export type IssueTriageStatus = (typeof ISSUE_TRIAGE_STATUSES)[number];

/** Why a triage is `degraded` (the judge failure reasons) or `skipped` (`short_title`). */
export const ISSUE_TRIAGE_REASONS = ["no_key", "cap_exceeded", "timeout", "error", "short_title"] as const;
export type IssueTriageReason = (typeof ISSUE_TRIAGE_REASONS)[number];

/**
 * What the router did with the owner suggestion. Recorded so a later calibration can tune the
 * thresholds: `below_threshold` and `narrow_margin` mark near misses.
 */
export const ISSUE_TRIAGE_APPLY_OUTCOMES = [
  "applied",
  "suggest_mode",
  "not_requested",
  "no_suggestion",
  "none_preferred",
  "below_threshold",
  "narrow_margin",
  "no_probabilities",
  "not_unassigned_todo",
  "owner_unavailable",
] as const;
export type IssueTriageApplyOutcome = (typeof ISSUE_TRIAGE_APPLY_OUTCOMES)[number];

/** One owner option the model saw: a group of agents that share a role and title. */
export interface IssueTriageOwnerOption {
  /** The agent the group resolves to (least loaded), or null for the "no fit" option. */
  agentId: string | null;
  role: string;
  title: string | null;
  probability: number | null;
  /** How many agents share this role and title. */
  groupSize: number;
}

export interface IssueTriageProbabilities {
  priority?: Partial<Record<IssuePriority, number>>;
  category?: Partial<Record<IssueTriageCategory, number>>;
  owner?: IssueTriageOwnerOption[];
}

export interface IssueTriage {
  id: string;
  companyId: string;
  issueId: string;
  status: IssueTriageStatus;
  reason: IssueTriageReason | null;
  /** The company mode the triage ran under. */
  mode: Exclude<IssueTriageMode, "off">;
  suggestedPriority: IssuePriority | null;
  category: IssueTriageCategory | null;
  suggestedAssigneeAgentId: string | null;
  probabilities: IssueTriageProbabilities;
  applyOutcome: IssueTriageApplyOutcome | null;
  appliedAt: Date | null;
  modelId: string | null;
  /** Hashes of the exact inputs sent, one per model call. */
  inputHashes: string[];
  modelCalls: number;
  createdAt: Date;
  updatedAt: Date;
}
