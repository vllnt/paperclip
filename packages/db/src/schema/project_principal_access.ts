import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Explicit project access list. A row lets one principal (a user or an agent)
 * into a project whose `projects.access_mode` is `restricted`. Rows grant
 * presence only: what the principal may do there still comes from its company
 * role and grants. Rows are ignored while the project is in `company` mode.
 */
export const projectPrincipalAccess = pgTable(
  "project_principal_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectPrincipalUq: uniqueIndex("project_principal_access_project_principal_uq").on(
      table.projectId,
      table.principalType,
      table.principalId,
    ),
    companyPrincipalIdx: index("project_principal_access_company_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
  }),
);
