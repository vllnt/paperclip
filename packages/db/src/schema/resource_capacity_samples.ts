import { bigint, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { environments } from "./environments.js";

// Bounded history of host-resource readings: at most one row per target per
// five minutes plus level changes, deleted by age. Numbers and closed-set
// labels only; raw probe output is never stored.
export const resourceCapacitySamples = pgTable(
  "resource_capacity_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetKey: text("target_key").notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    errorClass: text("error_class"),
    cpuCount: integer("cpu_count"),
    load1: real("load1"),
    load5: real("load5"),
    load15: real("load15"),
    memTotalBytes: bigint("mem_total_bytes", { mode: "number" }),
    memAvailableBytes: bigint("mem_available_bytes", { mode: "number" }),
    disks: jsonb("disks").$type<Array<{ labels: string[]; totalBytes: number; freeBytes: number }>>().notNull().default([]),
    level: text("level").notNull(),
  },
  (table) => ({
    targetSampledIdx: index("resource_capacity_samples_target_sampled_idx").on(table.targetKey, table.sampledAt),
    sampledIdx: index("resource_capacity_samples_sampled_idx").on(table.sampledAt),
  }),
);
