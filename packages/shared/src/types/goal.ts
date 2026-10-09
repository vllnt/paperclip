import type { GoalHorizon, GoalKind, GoalLevel, GoalStatus } from "../constants.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  kind: GoalKind;
  horizon: GoalHorizon | null;
  /** Calendar date, `YYYY-MM-DD`. */
  targetDate: string | null;
  successCriteria: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Tasks linked to a goal or any goal below it. Cancelled and hidden tasks do not count. */
export interface GoalProgress {
  total: number;
  done: number;
  open: number;
}

export interface CompanyFocusMilestone {
  id: string;
  title: string;
  status: GoalStatus;
  targetDate: string | null;
  /** Whole days from today (UTC) to the target date; negative when overdue. */
  daysLeft: number | null;
  progress: GoalProgress;
}

export interface CompanyFocusGoal {
  id: string;
  title: string;
  kind: GoalKind;
  level: GoalLevel;
  targetDate: string | null;
  daysLeft: number | null;
  successCriteria: string | null;
  ownerAgentId: string | null;
  progress: GoalProgress;
  /** Open milestones directly under this goal, nearest target date first. */
  milestones: CompanyFocusMilestone[];
}

/**
 * The company's current focus: active short term goals, nearest target date first.
 * Agents read it to choose what to work on.
 */
export interface CompanyFocus {
  goals: CompanyFocusGoal[];
  guidance: string;
}
