import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DatabaseAgentAccess, DatabaseProperty } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projects } from "./projects.js";

export const databases = pgTable(
  "databases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    properties: jsonb("properties").$type<DatabaseProperty[]>().notNull(),
    schemaRevision: integer("schema_revision").notNull().default(1),
    agentAccess: text("agent_access").$type<DatabaseAgentAccess>().notNull().default("write"),
    rowCount: integer("row_count").notNull().default(0),
    nextRowSeq: bigint("next_row_seq", { mode: "number" }).notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    archivedByUserId: text("archived_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("databases_company_key_uq").on(table.companyId, table.key),
    idCompanyUq: unique("databases_id_company_uq").on(table.id, table.companyId),
    companyProjectIdx: index("databases_company_project_idx").on(table.companyId, table.projectId),
    companyArchivedUpdatedIdx: index("databases_company_archived_updated_idx").on(
      table.companyId,
      table.archivedAt,
      table.updatedAt,
    ),
    agentAccessCheck: check("databases_agent_access_check", sql`${table.agentAccess} IN ('write', 'read')`),
    rowCountCheck: check("databases_row_count_check", sql`${table.rowCount} >= 0`),
  }),
);

export const databaseRows = pgTable(
  "database_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    databaseId: uuid("database_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    key: text("key"),
    title: text("title").notNull().default(""),
    cells: jsonb("cells").$type<Record<string, unknown>>().notNull().default({}),
    revision: integer("revision").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    updatedByRunId: uuid("updated_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByAgentId: uuid("deleted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    deletedByUserId: text("deleted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    databaseSeqUq: uniqueIndex("database_rows_database_seq_uq").on(table.databaseId, table.seq),
    databaseKeyUq: uniqueIndex("database_rows_database_key_uq")
      .on(table.databaseId, table.key)
      .where(sql`${table.key} IS NOT NULL`),
    idCompanyUq: unique("database_rows_id_company_uq").on(table.id, table.companyId),
    companyDatabaseIdx: index("database_rows_company_database_idx").on(table.companyId, table.databaseId),
    cellsIdx: index("database_rows_cells_idx").using("gin", table.cells.op("jsonb_path_ops")),
    databaseCompanyFk: foreignKey({
      columns: [table.databaseId, table.companyId],
      foreignColumns: [databases.id, databases.companyId],
      name: "database_rows_database_company_fk",
    }).onDelete("cascade"),
  }),
);
