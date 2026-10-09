import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

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

    create: async (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) => {
      await assertGoalRelations(db, companyId, data);
      return db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: Partial<typeof goals.$inferInsert>) => {
      const [existing] = await db.select({ companyId: goals.companyId }).from(goals).where(eq(goals.id, id));
      if (!existing) return null;
      await assertGoalRelations(db, existing.companyId, data, id);
      return db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(goals.id, id), eq(goals.companyId, existing.companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
