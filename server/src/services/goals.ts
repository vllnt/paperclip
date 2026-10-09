import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals } from "@paperclipai/db";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

/**
 * Who writes a goal. Every agent reads the company focus on every run, so only the board may
 * write what the focus shows. Agents and plugins keep every other goal write they had.
 */
export type GoalWriter = "board" | "agent" | "plugin";

const FOCUS_GOAL_REFUSAL = "Only the board can change or delete a short term goal or a milestone";
const PLANNING_FIELDS_REFUSAL = "Only the board can set a goal's kind, horizon, target date or success criteria";

/** The focus shows short term goals and their milestones. */
function inFocusScope(goal: { kind: string; horizon: string | null }): boolean {
  return goal.horizon === "short" || goal.kind === "milestone";
}

/** The rows a writer other than the board may change, checked again in the write itself. */
function writableBy(writer: GoalWriter) {
  return writer === "board"
    ? undefined
    : and(or(isNull(goals.horizon), ne(goals.horizon, "short")), ne(goals.kind, "milestone"));
}

/**
 * Refuses a write that would let an agent or a plugin put text into the company focus: setting a
 * planning field, or touching a goal the focus can show. Clearing a field to empty is allowed.
 */
function assertFocusWriteAllowed(
  writer: GoalWriter,
  existing: { kind: string; horizon: string | null } | null,
  input: { kind?: string; horizon?: string | null; targetDate?: string | null; successCriteria?: string | null },
) {
  if (writer === "board") return;
  if (existing && inFocusScope(existing)) throw forbidden(FOCUS_GOAL_REFUSAL);
  const setsPlanningField =
    (input.kind !== undefined && input.kind !== "goal") ||
    input.horizon != null ||
    input.targetDate != null ||
    input.successCriteria != null;
  if (setsPlanningField) throw forbidden(PLANNING_FIELDS_REFUSAL);
}

function invalidGoalInput(action: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  const issue = error.issues[0];
  return unprocessable(`Invalid goal ${action}: ${issue?.path.join(".") || "goal"}: ${issue?.message ?? "invalid"}`);
}

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

/**
 * A goal's parent and owner must belong to the goal's company, and a parent must not sit
 * below the goal itself. Foreign keys prove a row exists, not that it is in the same company.
 */
async function assertGoalRelations(
  db: Db,
  companyId: string,
  input: { parentId?: string | null; ownerAgentId?: string | null },
  goalId?: string,
) {
  if (input.parentId) {
    const companyGoals = await db
      .select({ id: goals.id, parentId: goals.parentId })
      .from(goals)
      .where(eq(goals.companyId, companyId));
    const parentById = new Map(companyGoals.map((row) => [row.id, row.parentId]));
    if (!parentById.has(input.parentId)) throw unprocessable("parentId must identify a goal in this company");
    if (goalId) {
      const seen = new Set<string>();
      for (let current: string | null | undefined = input.parentId; current; current = parentById.get(current)) {
        if (current === goalId) throw unprocessable("parentId would put the goal below itself");
        if (seen.has(current)) break;
        seen.add(current);
      }
    }
  }
  if (input.ownerAgentId) {
    const [owner] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.ownerAgentId), eq(agents.companyId, companyId)));
    if (!owner) throw unprocessable("ownerAgentId must identify an agent in this company");
  }
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    /**
     * Creates a goal, validated the same way as the API, because plugins and the onboarding seed
     * call this directly.
     */
    create: async (companyId: string, input: unknown, writer: GoalWriter) => {
      const parsed = createGoalSchema.safeParse(input);
      if (!parsed.success) throw invalidGoalInput("create", parsed.error);
      const data = parsed.data;
      assertFocusWriteAllowed(writer, null, data);
      await assertGoalRelations(db, companyId, data);
      return db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Applies only the fields a goal update may change, validated the same way as the API.
     * Plugins call this directly, so it must not trust its input: a stray `companyId` or `id`
     * is dropped, and an invalid horizon or date is refused.
     */
    update: async (id: string, input: unknown, writer: GoalWriter) => {
      const parsed = updateGoalSchema.safeParse(input);
      if (!parsed.success) throw invalidGoalInput("update", parsed.error);
      const data = parsed.data;
      const [existing] = await db
        .select({ companyId: goals.companyId, kind: goals.kind, horizon: goals.horizon })
        .from(goals)
        .where(eq(goals.id, id));
      if (!existing) return null;
      assertFocusWriteAllowed(writer, existing, data);
      await assertGoalRelations(db, existing.companyId, data, id);
      const [updated] = await db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(goals.id, id), eq(goals.companyId, existing.companyId), writableBy(writer)))
        .returning();
      // No row while the goal existed: the board moved it into the focus after the check above.
      if (!updated && writer !== "board") throw forbidden(FOCUS_GOAL_REFUSAL);
      return updated ?? null;
    },

    remove: async (id: string, writer: GoalWriter) => {
      const [existing] = await db.select({ kind: goals.kind, horizon: goals.horizon }).from(goals).where(eq(goals.id, id));
      if (!existing) return null;
      assertFocusWriteAllowed(writer, existing, {});
      const [removed] = await db.delete(goals).where(and(eq(goals.id, id), writableBy(writer))).returning();
      if (!removed && writer !== "board") throw forbidden(FOCUS_GOAL_REFUSAL);
      return removed ?? null;
    },
  };
}
