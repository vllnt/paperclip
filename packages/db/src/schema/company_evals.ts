import type {
  CompanyEvalAnswer,
  CompanyEvalCallerType,
  CompanyEvalFailureReason,
  CompanyEvalFeedbackVerdict,
  CompanyEvalInputSchema,
  CompanyEvalQuestions,
  CompanyEvalRunMode,
  CompanyEvalRunOutcome,
  CompanyEvalStatus,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * A named Jev decision that belongs to one company. The definition lives in immutable
 * `company_eval_versions` rows; this row holds the name, the status and which version is published.
 * `latest_version_number` is the parent-row counter that numbers new versions: a writer bumps it
 * with a compare-and-set, so no lock or sequence is needed.
 */
export const companyEvals = pgTable(
  "company_evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    whenToUse: text("when_to_use").notNull(),
    status: text("status").$type<CompanyEvalStatus>().notNull().default("draft"),
    publishedVersionId: uuid("published_version_id").references((): AnyPgColumn => companyEvalVersions.id, {
      onDelete: "set null",
    }),
    latestVersionNumber: integer("latest_version_number").notNull().default(0),
    templateKey: text("template_key"),
    templateVersion: text("template_version"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    companySlugUq: uniqueIndex("company_evals_company_slug_uq").on(table.companyId, table.slug),
  }),
);

/** One immutable definition of an eval. The service has no update path for this table. */
export const companyEvalVersions = pgTable(
  "company_eval_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    evalId: uuid("eval_id").notNull().references(() => companyEvals.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    inputSchema: jsonb("input_schema").$type<CompanyEvalInputSchema>().notNull(),
    questions: jsonb("questions").$type<CompanyEvalQuestions>().notNull(),
    definitionHash: text("definition_hash").notNull(),
    changeNote: text("change_note"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    evalVersionUq: uniqueIndex("company_eval_versions_eval_version_uq").on(table.evalId, table.versionNumber),
  }),
);

/**
 * One call of one version with one input. The row is the audit record for the call. `input` is the
 * redacted input and is cleared by the retention job after `input_expires_at`; the hash and the
 * size stay.
 */
export const companyEvalRuns = pgTable(
  "company_eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    evalId: uuid("eval_id").notNull().references(() => companyEvals.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull().references(() => companyEvalVersions.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    callerType: text("caller_type").$type<CompanyEvalCallerType>().notNull(),
    callerAgentId: uuid("caller_agent_id").references(() => agents.id, { onDelete: "set null" }),
    callerUserId: text("caller_user_id"),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    inputHash: text("input_hash").notNull(),
    inputRedacted: boolean("input_redacted").notNull().default(false),
    inputRedactionCount: integer("input_redaction_count").notNull().default(0),
    inputBytes: integer("input_bytes").notNull(),
    input: jsonb("input").$type<unknown>(),
    inputExpiresAt: timestamp("input_expires_at", { withTimezone: true }),
    mode: text("mode").$type<CompanyEvalRunMode>().notNull().default("live"),
    outcome: text("outcome").$type<CompanyEvalRunOutcome>().notNull(),
    failureReason: text("failure_reason").$type<CompanyEvalFailureReason>(),
    answers: jsonb("answers").$type<Record<string, CompanyEvalAnswer>>(),
    anyAbstained: boolean("any_abstained").notNull().default(false),
    cached: boolean("cached").notNull().default(false),
    latencyMs: integer("latency_ms").notNull(),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    evalCreatedIdx: index("company_eval_runs_eval_created_idx").on(table.evalId, table.createdAt),
    versionCreatedIdx: index("company_eval_runs_version_created_idx").on(table.versionId, table.createdAt),
    companyCreatedIdx: index("company_eval_runs_company_created_idx").on(table.companyId, table.createdAt),
    agentCreatedIdx: index("company_eval_runs_agent_created_idx").on(table.callerAgentId, table.createdAt),
    projectCreatedIdx: index("company_eval_runs_project_created_idx").on(table.projectId, table.createdAt),
    heartbeatRunIdx: index("company_eval_runs_heartbeat_run_idx")
      .on(table.heartbeatRunId)
      .where(sql`${table.heartbeatRunId} IS NOT NULL`),
    issueIdx: index("company_eval_runs_issue_idx")
      .on(table.issueId)
      .where(sql`${table.issueId} IS NOT NULL`),
    inputExpiryIdx: index("company_eval_runs_input_expiry_idx")
      .on(table.inputExpiresAt)
      .where(sql`${table.input} IS NOT NULL`),
  }),
);

/** A correct or incorrect mark on a run, or on one question of a run. One mark per author. */
export const companyEvalFeedback = pgTable(
  "company_eval_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => companyEvalRuns.id, { onDelete: "cascade" }),
    questionKey: text("question_key").notNull().default(""),
    verdict: text("verdict").$type<CompanyEvalFeedbackVerdict>().notNull(),
    note: text("note"),
    authorType: text("author_type").$type<CompanyEvalCallerType>().notNull(),
    authorKey: text("author_key").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runQuestionAuthorUq: uniqueIndex("company_eval_feedback_run_question_author_uq").on(
      table.runId,
      table.questionKey,
      table.authorKey,
    ),
    companyCreatedIdx: index("company_eval_feedback_company_created_idx").on(table.companyId, table.createdAt),
    authorAgentIdx: index("company_eval_feedback_author_agent_idx")
      .on(table.authorAgentId)
      .where(sql`${table.authorAgentId} IS NOT NULL`),
  }),
);
