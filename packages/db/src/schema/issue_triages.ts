import type {
  IssuePriority,
  IssueTriageApplyOutcome,
  IssueTriageCategory,
  IssueTriageMode,
  IssueTriageProbabilities,
  IssueTriageReason,
  IssueTriageStatus,
} from "@paperclipai/shared";
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * One triage record per issue: the suggested priority, category and owner, the probabilities behind
 * them, the model that answered and a hash of each exact input sent. Rows never hold issue text or
 * provider responses.
 */
export const issueTriages = pgTable(
  "issue_triages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    status: text("status").$type<IssueTriageStatus>().notNull(),
    reason: text("reason").$type<IssueTriageReason>(),
    mode: text("mode").$type<Exclude<IssueTriageMode, "off">>().notNull(),
    suggestedPriority: text("suggested_priority").$type<IssuePriority>(),
    category: text("category").$type<IssueTriageCategory>(),
    suggestedAssigneeAgentId: uuid("suggested_assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    probabilities: jsonb("probabilities").$type<IssueTriageProbabilities>().notNull().default({}),
    applyOutcome: text("apply_outcome").$type<IssueTriageApplyOutcome>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    modelId: text("model_id"),
    inputHashes: jsonb("input_hashes").$type<string[]>().notNull().default([]),
    modelCalls: integer("model_calls").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueUq: uniqueIndex("issue_triages_company_issue_uq").on(table.companyId, table.issueId),
  }),
);
