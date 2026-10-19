import type {
  DuplicatePairLabel,
  DuplicatePairVerdict,
} from "@paperclipai/shared";
import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

/**
 * Ledger of scored (new issue, candidate) pairs. Rows hold ids, scores, the model that scored the
 * pair and a hash of the exact input sent. They never hold issue text or provider responses.
 */
export const issueDuplicatePairs = pgTable(
  "issue_duplicate_pairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    candidateIssueId: uuid("candidate_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    lexicalScore: doublePrecision("lexical_score").notNull(),
    sameOutcomeProbability: doublePrecision("same_outcome_probability"),
    verdict: text("verdict").$type<DuplicatePairVerdict>().notNull(),
    modelId: text("model_id"),
    inputHash: text("input_hash").notNull(),
    label: text("label").$type<DuplicatePairLabel>(),
    labeledByType: text("labeled_by_type").$type<"user" | "agent">(),
    labeledById: text("labeled_by_id"),
    labeledAt: timestamp("labeled_at", { withTimezone: true }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_duplicate_pairs_company_issue_idx").on(table.companyId, table.issueId),
    pairInputUq: uniqueIndex("issue_duplicate_pairs_pair_input_uq").on(
      table.companyId,
      table.issueId,
      table.candidateIssueId,
      table.inputHash,
    ),
  }),
);
