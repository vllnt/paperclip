import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { goals, issues, type Db } from "@paperclipai/db";
import {
  COMPANY_FOCUS_GUIDANCE,
  GOAL_TEXT_MAX_LENGTH,
  GOAL_LEVELS,
  GOAL_STATUSES,
  type CompanyFocus,
  type CompanyFocusGoal,
  type GoalLevel,
  type IssueCompanyFocus,
  type GoalProgress,
  type GoalStatus,
  truncateAtGrapheme,
} from "@paperclipai/shared";
import { executionIssueCondition } from "./issue-visibility.js";
import { logger } from "../middleware/logger.js";

type GoalRow = typeof goals.$inferSelect;

const MAX_FOCUS_GOALS = 10;
const MAX_MILESTONES_PER_GOAL = 5;
/** Focus is advice, so a slow read gives up rather than delay an agent's run or inbox. */
const FOCUS_READ_TIMEOUT_MS = 500;
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

/**
 * The one cut for every goal text that reaches an agent. New goal text is limited to the same
 * length when written; this keeps goals written before that limit short too.
 */
function capAgentContextText(value: string): string {
  return truncateAtGrapheme(value, GOAL_TEXT_MAX_LENGTH);
}

function capOptionalAgentContextText(value: string | null): string | null {
  return value === null ? null : capAgentContextText(value);
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
        title: capAgentContextText(goal.title),
        kind: goal.kind,
        level: isGoalLevel(goal.level) ? goal.level : "task",
        targetDate: goal.targetDate,
        daysLeft: daysUntil(goal.targetDate, today),
        successCriteria: capOptionalAgentContextText(goal.successCriteria),
        ownerAgentId: goal.ownerAgentId,
        progress: rollUp(goal.id, children, counts),
        milestones: (children.get(goal.id) ?? [])
          .filter((child) => child.kind === "milestone" && OPEN_GOAL_STATUSES.has(child.status))
          .sort(compareByTargetDate)
          .slice(0, MAX_MILESTONES_PER_GOAL)
          .map((milestone) => ({
            id: milestone.id,
            title: capAgentContextText(milestone.title),
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
 * A goal as an agent reads it from the goal and issue APIs: the title and success criteria cut
 * like the heartbeat context. Board readers get the stored goal.
 */
export function capGoalTextForAgents<T extends { title: string; successCriteria?: string | null }>(goal: T): T {
  return {
    ...goal,
    title: capAgentContextText(goal.title),
    ...(goal.successCriteria != null ? { successCriteria: capAgentContextText(goal.successCriteria) } : {}),
  };
}

/** A task's goal as its heartbeat context shows it. */
export type HeartbeatContextGoal = Pick<GoalRow, "id" | "title" | "status" | "level" | "parentId">
  & Partial<Pick<GoalRow, "kind" | "horizon" | "targetDate" | "successCriteria">>;

/**
 * A task's goal for its heartbeat context. The title and success criteria are cut like the focus,
 * because agents may write ordinary goals, such as the company's default goal, that every agent
 * then reads. Planning fields appear only when set, so a goal without planning reads as it did
 * before goals had them; a missing field counts as unset.
 */
export function heartbeatContextGoal(goal: HeartbeatContextGoal): HeartbeatContextGoal {
  return {
    id: goal.id,
    title: capAgentContextText(goal.title),
    status: goal.status,
    level: goal.level,
    parentId: goal.parentId,
    ...(goal.kind === "milestone" ? { kind: goal.kind } : {}),
    ...(goal.horizon != null ? { horizon: goal.horizon } : {}),
    ...(goal.targetDate != null ? { targetDate: goal.targetDate } : {}),
    ...(goal.successCriteria != null ? { successCriteria: capAgentContextText(goal.successCriteria) } : {}),
  };
}

/**
 * Orders an agent's tasks: critical tasks first (an incident outranks the focus), then tasks
 * that serve the focus, then the rest, each tagged with the `focusGoalId` it serves. The order
 * inside each group does not change. With no focus the rows come back untouched and untagged.
 */
export function orderByFocus<T extends { goalId: string | null; priority: string }>(
  rows: T[],
  focusIndex: Map<string, string>,
): T[] {
  if (focusIndex.size === 0) return rows;
  const tagged = rows.map((row) => ({ ...row, focusGoalId: row.goalId ? focusIndex.get(row.goalId) ?? null : null }));
  const rank = (row: (typeof tagged)[number]) => (row.priority === "critical" ? 0 : row.focusGoalId ? 1 : 2);
  return [0, 1, 2].flatMap((group) => tagged.filter((row) => rank(row) === group));
}

/** Lets tests swap the focus reader or shorten the time limit of the guarded reads below. */
export interface FocusReadOptions {
  service?: Pick<ReturnType<typeof goalFocusService>, "getFocusIndex" | "getFocusForIssue">;
  timeoutMs?: number;
}

/**
 * Resolves to the read's value, or to `fallback` when the read fails or outlasts `timeoutMs`.
 * Never rejects. The race keeps a handler on the read, so a read that fails after the time limit
 * is ignored rather than left unhandled. A read that times out keeps running in the background.
 */
async function readWithinTimeLimit<T>(
  read: () => Promise<T>,
  fallback: T,
  timeoutMs: number,
  warn: (error: unknown) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const answered = Promise.resolve()
      .then(read)
      .then((value) => ({ timedOut: false as const, value }));
    const outcome = await Promise.race([answered, timedOut]);
    if (outcome.timedOut) {
      warn(new Error(`Company focus read took longer than ${timeoutMs} ms`));
      return fallback;
    }
    return outcome.value;
  } catch (error) {
    warn(error);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The focus index for a request path that must not fail or wait. Focus is advice: if it cannot
 * be read in time, the caller keeps its normal order.
 */
export async function readFocusIndex(
  db: Db,
  companyId: string,
  options: FocusReadOptions = {},
): Promise<Map<string, string>> {
  const service = options.service ?? goalFocusService(db);
  return readWithinTimeLimit(
    () => service.getFocusIndex(companyId),
    new Map<string, string>(),
    options.timeoutMs ?? FOCUS_READ_TIMEOUT_MS,
    (error) => logger.warn({ err: error, companyId }, "Company focus could not be read; keeping the normal task order"),
  );
}

/**
 * The company focus for an agent's run context, plus which focus goal the task serves. Null when
 * the company has no focus, or when the focus cannot be read in time. Never throws.
 */
export async function readCompanyFocusForIssue(
  db: Db,
  companyId: string,
  issueGoalId: string | null,
  options: FocusReadOptions = {},
): Promise<IssueCompanyFocus | null> {
  const service = options.service ?? goalFocusService(db);
  const focus = await readWithinTimeLimit<IssueCompanyFocus | null>(
    () => service.getFocusForIssue(companyId, issueGoalId),
    null,
    options.timeoutMs ?? FOCUS_READ_TIMEOUT_MS,
    (error) => logger.warn({ err: error, companyId }, "Company focus could not be read for the heartbeat context"),
  );
  return focus && focus.goals.length > 0 ? focus : null;
}
