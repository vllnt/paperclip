import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import type {
  EventRejectOutcome,
  EventRoutineOutcome,
} from "@paperclipai/shared";

/**
 * Signed, company-scoped ingress for external alert senders. `event` routine
 * triggers subscribe to a source; the source itself owns the URL, credential,
 * rate limits, normalizer and the labels it pins onto every event.
 */
export const eventSources = pgTable(
  "event_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    publicId: text("public_id").notNull(),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    signingMode: text("signing_mode").notNull().default("hmac_sha256"),
    replayWindowSec: integer("replay_window_sec").notNull().default(300),
    normalizer: text("normalizer").notNull().default("generic_v1"),
    normalizerConfig: jsonb("normalizer_config").$type<Record<string, unknown>>(),
    pinnedLabels: jsonb("pinned_labels").$type<Record<string, string>>().notNull().default({}),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(600),
    maxNewIssuesPerHour: integer("max_new_issues_per_hour").notNull().default(20),
    stormWindowStart: timestamp("storm_window_start", { withTimezone: true }),
    stormWindowCount: integer("storm_window_count").notNull().default(0),
    retentionDays: integer("retention_days").notNull().default(30),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastResult: text("last_result"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    publicIdUq: uniqueIndex("event_sources_public_id_uq").on(table.publicId),
    companyArchivedIdx: index("event_sources_company_archived_idx").on(table.companyId, table.archived),
  }),
);

/**
 * One row per authenticated delivery; doubles as the replay receipt. Rejected
 * and duplicate requests are aggregated into one `rejected_aggregate` row per
 * source per minute instead of one row per request.
 */
export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => eventSources.id, { onDelete: "cascade" }),
    deliveryKeyHash: text("delivery_key_hash"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
    status: text("status").notNull().default("processing"),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    routineOutcomes: jsonb("routine_outcomes").$type<Record<string, EventRoutineOutcome>>().notNull().default({}),
    event: jsonb("event").$type<Record<string, unknown>>(),
    matchedTriggerIds: jsonb("matched_trigger_ids").$type<string[]>().notNull().default([]),
    routineRunIds: jsonb("routine_run_ids").$type<string[]>().notNull().default([]),
    issueIds: jsonb("issue_ids").$type<string[]>().notNull().default([]),
    error: text("error"),
    rejectCounts: jsonb("reject_counts").$type<Partial<Record<EventRejectOutcome, number>>>(),
    firstIp: text("first_ip"),
    lastIp: text("last_ip"),
  },
  (table) => ({
    deliveryKeyUq: uniqueIndex("event_deliveries_source_delivery_key_uq")
      .on(table.sourceId, table.deliveryKeyHash)
      .where(sql`${table.deliveryKeyHash} is not null`),
    sourceReceivedIdx: index("event_deliveries_source_received_idx").on(table.sourceId, table.receivedAt),
    companyReceivedIdx: index("event_deliveries_company_received_idx").on(table.companyId, table.receivedAt),
  }),
);
