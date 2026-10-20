import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only, user-scoped audit: changes to the user's personal agent and,
 * for delegated credentials, one row per request any harness makes on the
 * user's behalf. `company_id` names the target company when there is one.
 * No auth foreign key, like other per-user tables.
 */
export const userAuditLog = pgTable(
  "user_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    actorSource: text("actor_source").notNull(),
    actorKeyId: text("actor_key_id"),
    companyId: uuid("company_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("user_audit_log_user_created_idx").on(table.userId, table.createdAt),
  }),
);
