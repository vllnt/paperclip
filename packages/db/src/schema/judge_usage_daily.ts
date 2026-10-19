import { date, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Decision-model calls reserved per company per UTC day. Backs the daily call cap. */
export const judgeUsageDaily = pgTable(
  "judge_usage_daily",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    calls: integer("calls").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.day] }),
  }),
);
