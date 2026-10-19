import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/** Per-company switch; absent row means disabled. */
export const companyBrowserSettings = pgTable("company_browser_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A company's saved browser login. `sealedState` is the browser session
 * (cookies, local storage) encrypted with a per-profile key kept as a company
 * secret; it is bound to the company, profile and generation as AEAD data.
 */
export const browserProfiles = pgTable(
  "browser_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    allowedDomains: jsonb("allowed_domains").$type<string[]>().notNull().default([]),
    keySecretId: uuid("key_secret_id").references(() => companySecrets.id, {
      onDelete: "set null",
    }),
    sealedState: text("sealed_state"),
    stateGeneration: integer("state_generation").notNull().default(0),
    lastSealedAt: timestamp("last_sealed_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUniqueIdx: uniqueIndex("browser_profiles_company_name_idx").on(
      table.companyId,
      table.name,
    ),
    companyIdx: index("browser_profiles_company_idx").on(table.companyId),
  }),
);

/** Agents the board allowed to use a profile; both sides must be the same company. */
export const browserProfileAgents = pgTable(
  "browser_profile_agents",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => browserProfiles.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.agentId] }),
    companyIdx: index("browser_profile_agents_company_idx").on(table.companyId),
  }),
);
