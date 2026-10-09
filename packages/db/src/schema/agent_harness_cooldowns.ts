import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * A harness/model target an agent must not use until `cooldownUntil`, after a
 * provider quota or capacity failure. `returnedAt` closes a primary cooldown
 * once a run is dispatched on the primary again.
 */
export const agentHarnessCooldowns = pgTable(
  "agent_harness_cooldowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    targetKey: text("target_key").notNull(),
    adapterType: text("adapter_type").notNull(),
    model: text("model"),
    reason: text("reason").notNull(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }).notNull(),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentTargetUq: uniqueIndex("agent_harness_cooldowns_agent_target_uq").on(table.agentId, table.targetKey),
    companyAgentIdx: index("agent_harness_cooldowns_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
