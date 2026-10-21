import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { CompanyPolicyStatus } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { projects } from "./projects.js";

/**
 * A written rule or guardrail for a company, or for one project when `projectId` is set.
 * The title, body and revision history live in the linked document.
 */
export const companyPolicies = pgTable(
  "company_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    summary: text("summary"),
    status: text("status").$type<CompanyPolicyStatus>().notNull().default("draft"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("company_policies_company_key_uq").on(table.companyId, table.key),
    documentUq: uniqueIndex("company_policies_document_uq").on(table.documentId),
    companyProjectStatusIdx: index("company_policies_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
  }),
);
