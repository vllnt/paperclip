CREATE TABLE "event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"delivery_key_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"routine_outcomes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event" jsonb,
	"matched_trigger_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routine_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"reject_counts" jsonb,
	"first_ip" text,
	"last_ip" text
);
--> statement-breakpoint
CREATE TABLE "event_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"public_id" text NOT NULL,
	"secret_id" uuid,
	"signing_mode" text DEFAULT 'hmac_sha256' NOT NULL,
	"replay_window_sec" integer DEFAULT 300 NOT NULL,
	"normalizer" text DEFAULT 'generic_v1' NOT NULL,
	"normalizer_config" jsonb,
	"pinned_labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 600 NOT NULL,
	"max_new_issues_per_hour" integer DEFAULT 20 NOT NULL,
	"storm_window_start" timestamp with time zone,
	"storm_window_count" integer DEFAULT 0 NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"last_rotated_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"last_result" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_event_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_comment_at" timestamp with time zone,
	"repeat_count" integer DEFAULT 0 NOT NULL,
	"last_severity" text NOT NULL,
	"last_state" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "event_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "event_source_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "event_match" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "event_grouping" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_source_id_event_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."event_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sources" ADD CONSTRAINT "event_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sources" ADD CONSTRAINT "event_sources_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sources" ADD CONSTRAINT "event_sources_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sources" ADD CONSTRAINT "event_sources_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_event_groups" ADD CONSTRAINT "routine_event_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_event_groups" ADD CONSTRAINT "routine_event_groups_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_event_groups" ADD CONSTRAINT "routine_event_groups_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_deliveries_source_delivery_key_uq" ON "event_deliveries" USING btree ("source_id","delivery_key_hash") WHERE "event_deliveries"."delivery_key_hash" is not null;--> statement-breakpoint
CREATE INDEX "event_deliveries_source_received_idx" ON "event_deliveries" USING btree ("source_id","received_at");--> statement-breakpoint
CREATE INDEX "event_deliveries_company_received_idx" ON "event_deliveries" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_sources_public_id_uq" ON "event_sources" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "event_sources_company_archived_idx" ON "event_sources" USING btree ("company_id","archived");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_event_groups_routine_fingerprint_issue_uq" ON "routine_event_groups" USING btree ("routine_id","fingerprint","issue_id");--> statement-breakpoint
CREATE INDEX "routine_event_groups_routine_fingerprint_idx" ON "routine_event_groups" USING btree ("routine_id","fingerprint");--> statement-breakpoint
CREATE INDEX "routine_event_groups_issue_idx" ON "routine_event_groups" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "routine_event_groups_company_idx" ON "routine_event_groups" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_event_delivery_id_event_deliveries_id_fk" FOREIGN KEY ("event_delivery_id") REFERENCES "public"."event_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_event_source_id_event_sources_id_fk" FOREIGN KEY ("event_source_id") REFERENCES "public"."event_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_runs_event_delivery_idx" ON "routine_runs" USING btree ("event_delivery_id","routine_id") WHERE "routine_runs"."event_delivery_id" is not null;--> statement-breakpoint
CREATE INDEX "routine_triggers_event_source_idx" ON "routine_triggers" USING btree ("event_source_id") WHERE "routine_triggers"."event_source_id" is not null;