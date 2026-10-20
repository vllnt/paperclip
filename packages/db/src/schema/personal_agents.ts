import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PersonalAgentToolPolicy } from "@paperclipai/shared";

/**
 * User-scoped personal agents: one per user, holding that user's own
 * configuration. No auth foreign key, like other per-user preference tables.
 * Company data is never stored here; every company read or write goes
 * through the company's own routes as the user.
 */
export const personalAgents = pgTable(
  "personal_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    instructions: text("instructions").notNull().default(""),
    instructionsRevision: integer("instructions_revision").notNull().default(0),
    toolPolicy: jsonb("tool_policy").$type<PersonalAgentToolPolicy>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: uniqueIndex("personal_agents_user_idx").on(table.userId),
  }),
);

/** Append-only saved versions of a personal agent's instructions. */
export const personalAgentInstructionRevisions = pgTable(
  "personal_agent_instruction_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personalAgentId: uuid("personal_agent_id").notNull().references(() => personalAgents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    revision: integer("revision").notNull(),
    body: text("body").notNull(),
    changeSummary: text("change_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentRevisionIdx: uniqueIndex("personal_agent_instruction_revisions_agent_revision_idx").on(
      table.personalAgentId,
      table.revision,
    ),
  }),
);

/** Skills of a personal agent: custom, or copied from the app skills catalog. */
export const personalAgentSkills = pgTable(
  "personal_agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personalAgentId: uuid("personal_agent_id").notNull().references(() => personalAgents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    markdown: text("markdown").notNull(),
    source: text("source").notNull(),
    catalogKey: text("catalog_key"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentKeyIdx: uniqueIndex("personal_agent_skills_agent_key_idx").on(table.personalAgentId, table.key),
  }),
);
