import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { environments } from "./environments.js";

// Latest host-resource state per measured target: `instance:<hostname>` or
// `environment:<id>`. Environments are instance-wide, so this table has no
// company; reads enforce company scoping. Every server process reads the
// current level here. A reading applies only if it is newer than
// `latest_sampled_at`; level changes compare-and-set `state_version`, and
// sweeps and history rows compare-and-set `next_sweep_at` and
// `last_history_at`, so each happens once across processes.
export const resourceCapacityTargets = pgTable(
  "resource_capacity_targets",
  {
    targetKey: text("target_key").primaryKey(),
    targetKind: text("target_kind").notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }),
    hostLabel: text("host_label"),
    latestSampledAt: timestamp("latest_sampled_at", { withTimezone: true }),
    latestStatus: text("latest_status"),
    latestReading: jsonb("latest_reading").$type<Record<string, unknown>>(),
    level: text("level").notNull().default("unknown"),
    metricLevels: jsonb("metric_levels").$type<Record<string, string>>().notNull().default({}),
    metricSampledAt: jsonb("metric_sampled_at").$type<Record<string, string>>().notNull().default({}),
    stateVersion: integer("state_version").notNull().default(0),
    levelChangedAt: timestamp("level_changed_at", { withTimezone: true }),
    nextSweepAt: timestamp("next_sweep_at", { withTimezone: true }),
    lastHistoryAt: timestamp("last_history_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    environmentUq: uniqueIndex("resource_capacity_targets_environment_uq").on(table.environmentId),
  }),
);
