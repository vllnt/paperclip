import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { goals, issues, type Db } from "@paperclipai/db";
import {
  COMPANY_FOCUS_GUIDANCE,
  GOAL_LEVELS,
  GOAL_STATUSES,
  type CompanyFocus,
  type CompanyFocusGoal,
  type GoalLevel,
  type IssueCompanyFocus,
  type GoalProgress,
  type GoalStatus,
} from "@paperclipai/shared";
import { executionIssueCondition } from "./issue-visibility.js";
import { logger } from "../middleware/logger.js";

type GoalRow = typeof goals.$inferSelect;

const MAX_FOCUS_GOALS = 10;
const MAX_MILESTONES_PER_GOAL = 5;
/** Agents read the focus on every run, so free text in it stays short. */
const MAX_FOCUS_TEXT = 280;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_GOAL_STATUSES = new Set(["planned", "active"]);

function isGoalLevel(value: string): value is GoalLevel {
  return GOAL_LEVELS.some((level) => level === value);
}

function isGoalStatus(value: string): value is GoalStatus {
  return GOAL_STATUSES.some((status) => status === value);
}

/** Active short term goals are the company's current focus. */
function isFocusGoal(goal: GoalRow): boolean {
  return goal.status === "active" && goal.horizon === "short";
}

function compareByTargetDate(a: GoalRow, b: GoalRow): number {
  if (a.targetDate && b.targetDate && a.targetDate !== b.targetDate) return a.targetDate < b.targetDate ? -1 : 1;
  if (a.targetDate && !b.targetDate) return -1;
  if (!a.targetDate && b.targetDate) return 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function daysUntil(targetDate: string | null, now: Date): number | null {
  if (!targetDate) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${targetDate}T00:00:00Z`) - today) / DAY_MS);
}

function truncateText(value: string | null): string | null {
  if (value === null || value.length <= MAX_FOCUS_TEXT) return value;
  return `${value.slice(0, MAX_FOCUS_TEXT - 1)}…`;
}

/** The focus goals, nearest target date first, capped so the index and the list always agree. */
function selectFocusGoals(rows: GoalRow[]): GoalRow[] {
  return rows.filter(isFocusGoal).sort(compareByTargetDate).slice(0, MAX_FOCUS_GOALS);
}

/** Children of each goal, built once from the company's goals. */
function childrenIndex(rows: GoalRow[]): Map<string, GoalRow[]> {
  const children = new Map<string, GoalRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  return children;
}

/** The goal and every goal below it. Visits each goal once, so a bad loop in stored data cannot hang. */
function subtreeIds(rootId: string, children: Map<string, GoalRow[]>): Set<string> {
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      stack.push(child.id);
    }
  }
  return seen;
}

/**
 * Goal horizons, progress and the company's current focus.
 *
 * Progress counts the tasks linked to a goal or any goal below it. Cancelled, hidden and
 * conversation tasks do not count.
 */
export function goalFocusService(db: Db, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  const listGoals = (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId));

  async function countTasks(companyId: string, goalIds: string[]): Promise<Map<string, { total: number; done: number }>> {
    const counts = new Map<string, { total: number; done: number }>();
    if (goalIds.length === 0) return counts;
    const rows = await db
      .select({
        goalId: issues.goalId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        inArray(issues.goalId, goalIds),
        ne(issues.status, "cancelled"),
        executionIssueCondition(),
      ))
      .groupBy(issues.goalId);
    for (const row of rows) if (row.goalId) counts.set(row.goalId, { total: row.total, done: row.done });
    return counts;
  }

  function rollUp(rootId: string, children: Map<string, GoalRow[]>, counts: Map<string, { total: number; done: number }>): GoalProgress {
    let total = 0;
    let done = 0;
    for (const id of subtreeIds(rootId, children)) {
      const entry = counts.get(id);
      if (!entry) continue;
      total += entry.total;
      done += entry.done;
    }
    return { total, done, open: total - done };
  }

  async function buildFocus(companyId: string, rows: GoalRow[]): Promise<CompanyFocus> {
    const focusGoals = selectFocusGoals(rows);
    if (focusGoals.length === 0) return { goals: [], guidance: COMPANY_FOCUS_GUIDANCE };

    const children = childrenIndex(rows);
    const relevant = new Set<string>();
    for (const goal of focusGoals) for (const id of subtreeIds(goal.id, children)) relevant.add(id);
    const counts = await countTasks(companyId, [...relevant]);
    const today = now();

    return {
      guidance: COMPANY_FOCUS_GUIDANCE,
      goals: focusGoals.map((goal): CompanyFocusGoal => ({
        id: goal.id,
        title: goal.title,
        kind: goal.kind,
        level: isGoalLevel(goal.level) ? goal.level : "task",
        targetDate: goal.targetDate,
        daysLeft: daysUntil(goal.targetDate, today),
        successCriteria: truncateText(goal.successCriteria),
        ownerAgentId: goal.ownerAgentId,
        progress: rollUp(goal.id, children, counts),
        milestones: (children.get(goal.id) ?? [])
          .filter((child) => child.kind === "milestone" && OPEN_GOAL_STATUSES.has(child.status))
          .sort(compareByTargetDate)
          .slice(0, MAX_MILESTONES_PER_GOAL)
          .map((milestone) => ({
            id: milestone.id,
            title: milestone.title,
            status: isGoalStatus(milestone.status) ? milestone.status : "planned",
            targetDate: milestone.targetDate,
            daysLeft: daysUntil(milestone.targetDate, today),
            progress: rollUp(milestone.id, children, counts),
          })),
      })),
    };
  }

  /**
   * Maps every goal under a listed focus goal to that focus goal, so a task's goal tells whether
   * the task serves the focus. Goals outside the listed focus are absent.
   */
  function buildFocusIndex(rows: GoalRow[]): Map<string, string> {
    const children = childrenIndex(rows);
    const index = new Map<string, string>();
    for (const goal of selectFocusGoals(rows)) {
      for (const id of subtreeIds(goal.id, children)) if (!index.has(id)) index.set(id, goal.id);
    }
    return index;
  }

  return {
    /** Progress for every goal in the company, keyed by goal id. */
    getProgress: async (companyId: string): Promise<Record<string, GoalProgress>> => {
      const rows = await listGoals(companyId);
      const children = childrenIndex(rows);
      const counts = await countTasks(companyId, rows.map((row) => row.id));
      return Object.fromEntries(rows.map((row) => [row.id, rollUp(row.id, children, counts)]));
    },

    getFocus: async (companyId: string): Promise<CompanyFocus> => buildFocus(companyId, await listGoals(companyId)),

    getFocusIndex: async (companyId: string): Promise<Map<string, string>> => buildFocusIndex(await listGoals(companyId)),

    /** The focus and which focus goal one task serves, from a single read of the company's goals. */
    getFocusForIssue: async (companyId: string, issueGoalId: string | null): Promise<IssueCompanyFocus> => {
      const rows = await listGoals(companyId);
      const index = buildFocusIndex(rows);
      return { ...(await buildFocus(companyId, rows)), issueFocusGoalId: issueGoalId ? index.get(issueGoalId) ?? null : null };
    },
  };
}

/**
 * Orders an agent's tasks: critical tasks first (an incident outranks the focus), then tasks
 * that serve the focus, then the rest. The order inside each group does not change.
 */
export function orderByFocus<T extends { goalId: string | null; priority: string }>(
  rows: T[],
  focusIndex: Map<string, string>,
): Array<T & { focusGoalId: string | null }> {
  const tagged = rows.map((row) => ({ ...row, focusGoalId: row.goalId ? focusIndex.get(row.goalId) ?? null : null }));
  const rank = (row: (typeof tagged)[number]) => (row.priority === "critical" ? 0 : row.focusGoalId ? 1 : 2);
  return [0, 1, 2].flatMap((group) => tagged.filter((row) => rank(row) === group));
}

/**
 * The focus index for a request path that must not fail. Focus is advice: if it cannot be
 * read, the caller keeps its normal order.
 */
export async function readFocusIndex(db: Db, companyId: string): Promise<Map<string, string>> {
  try {
    return await goalFocusService(db).getFocusIndex(companyId);
  } catch (error) {
    logger.warn({ err: error, companyId }, "Company focus could not be read; keeping the normal task order");
    return new Map();
  }
}

/** The company focus for an agent's run context, plus which focus goal the task serves. Never throws. */
export async function readCompanyFocusForIssue(
  db: Db,
  companyId: string,
  issueGoalId: string | null,
): Promise<IssueCompanyFocus | null> {
  try {
    return await goalFocusService(db).getFocusForIssue(companyId, issueGoalId);
  } catch (error) {
    logger.warn({ err: error, companyId }, "Company focus could not be read for the heartbeat context");
    return null;
  }
}
