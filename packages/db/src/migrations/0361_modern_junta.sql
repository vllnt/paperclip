CREATE TABLE IF NOT EXISTS "run_usage_records" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_id" uuid,
	"routine_id" uuid,
	"adapter_type" text NOT NULL,
	"runtime_mode" text NOT NULL,
	"driver_kind" text,
	"provider" text,
	"biller" text,
	"billing_type" text,
	"model" text,
	"model_count" smallint,
	"invocation_source" text NOT NULL,
	"wake_reason" text,
	"is_retry" boolean DEFAULT false NOT NULL,
	"retry_depth" smallint DEFAULT 0 NOT NULL,
	"retry_reason" text,
	"session_reused" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"cause_family" text,
	"liveness_state" text,
	"provider_work_started" boolean DEFAULT true NOT NULL,
	"useful_action" boolean,
	"issue_status_at_start" text,
	"issue_status_at_end" text,
	"input_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"output_tokens" bigint,
	"reasoning_tokens" bigint,
	"usage_basis" text,
	"usage_quality" text NOT NULL,
	"cost_micros" bigint,
	"api_equivalent_micros" bigint,
	"cost_status" text,
	"run_created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"queue_wait_ms" bigint,
	"duration_ms" bigint,
	"startup_ms" bigint,
	"first_event_ms" bigint,
	"turns" integer,
	"tool_calls" integer,
	"tool_errors" integer,
	"first_turn_prompt_tokens" bigint,
	"footprint_chars" bigint,
	"footprint_sources" jsonb,
	"schema_version" smallint NOT NULL,
	"source" text NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_usage_records_company_id_companies_id_fk' AND conrelid = 'public.run_usage_records'::regclass) THEN
    ALTER TABLE "run_usage_records" ADD CONSTRAINT "run_usage_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_usage_records_company_finished_run_idx" ON "run_usage_records" USING btree ("company_id","finished_at","run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_usage_records_company_agent_finished_idx" ON "run_usage_records" USING btree ("company_id","agent_id","finished_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_usage_records_company_issue_idx" ON "run_usage_records" USING btree ("company_id","issue_id") WHERE "run_usage_records"."issue_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_usage_records_company_routine_finished_idx" ON "run_usage_records" USING btree ("company_id","routine_id","finished_at") WHERE "run_usage_records"."routine_id" is not null;