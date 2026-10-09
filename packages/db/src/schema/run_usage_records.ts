import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** One entry of the bounded, closed-shape footprint list kept on a usage record. */
export interface RunUsageFootprintSource {
  kind: string;
  ref: string;
  chars: number;
}

/**
 * Analytics fact, one row per terminal heartbeat run, derived asynchronously from the run's own
 * row (never written from the run path). It holds counts, closed enums and length-capped
 * identifiers only: no prompt, context, stdout, stderr or free text. No foreign keys to agents or
 * runs, so the fact survives agent deletion. See doc/plans/2026-10-09-full-observability.md.
 */
export const runUsageRecords = pgTable(
  "run_usage_records",
  {
    runId: uuid("run_id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    issueId: uuid("issue_id"),
    projectId: uuid("project_id"),
    routineId: uuid("routine_id"),

    adapterType: text("adapter_type").notNull(),
    runtimeMode: text("runtime_mode").notNull(),
    driverKind: text("driver_kind"),
    provider: text("provider"),
    biller: text("biller"),
    billingType: text("billing_type"),
    model: text("model"),
    modelCount: smallint("model_count"),
    invocationSource: text("invocation_source").notNull(),
    wakeReason: text("wake_reason"),
    isRetry: boolean("is_retry").notNull().default(false),
    retryDepth: smallint("retry_depth").notNull().default(0),
    retryReason: text("retry_reason"),
    sessionReused: boolean("session_reused").notNull().default(false),

    status: text("status").notNull(),
    errorCode: text("error_code"),
    causeFamily: text("cause_family"),
    livenessState: text("liveness_state"),
    providerWorkStarted: boolean("provider_work_started").notNull().default(true),
    usefulAction: boolean("useful_action"),
    issueStatusAtStart: text("issue_status_at_start"),
    issueStatusAtEnd: text("issue_status_at_end"),

    inputTokens: bigint("input_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }),
    usageBasis: text("usage_basis"),
    usageQuality: text("usage_quality").notNull(),

    costMicros: bigint("cost_micros", { mode: "number" }),
    apiEquivalentMicros: bigint("api_equivalent_micros", { mode: "number" }),
    costStatus: text("cost_status"),

    runCreatedAt: timestamp("run_created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    day: date("day", { mode: "string" }).notNull(),
    queueWaitMs: bigint("queue_wait_ms", { mode: "number" }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    startupMs: bigint("startup_ms", { mode: "number" }),
    firstEventMs: bigint("first_event_ms", { mode: "number" }),

    turns: integer("turns"),
    toolCalls: integer("tool_calls"),
    toolErrors: integer("tool_errors"),

    firstTurnPromptTokens: bigint("first_turn_prompt_tokens", { mode: "number" }),
    footprintChars: bigint("footprint_chars", { mode: "number" }),
    footprintSources: jsonb("footprint_sources").$type<RunUsageFootprintSource[]>(),

    schemaVersion: smallint("schema_version").notNull(),
    source: text("source").notNull(),
    derivedAt: timestamp("derived_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFinishedRunIdx: index("run_usage_records_company_finished_run_idx").on(
      table.companyId,
      table.finishedAt,
      table.runId,
    ),
    companyAgentFinishedIdx: index("run_usage_records_company_agent_finished_idx").on(
      table.companyId,
      table.agentId,
      table.finishedAt,
    ),
    companyIssueIdx: index("run_usage_records_company_issue_idx")
      .on(table.companyId, table.issueId)
      .where(sql`${table.issueId} is not null`),
    companyRoutineFinishedIdx: index("run_usage_records_company_routine_finished_idx")
      .on(table.companyId, table.routineId, table.finishedAt)
      .where(sql`${table.routineId} is not null`),
  }),
);
