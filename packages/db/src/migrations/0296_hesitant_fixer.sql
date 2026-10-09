CREATE TABLE "agent_harness_cooldowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"target_key" text NOT NULL,
	"adapter_type" text NOT NULL,
	"model" text,
	"reason" text NOT NULL,
	"cooldown_until" timestamp with time zone NOT NULL,
	"source_run_id" uuid,
	"returned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "executed_adapter_type" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "executed_model" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "agent_harness_cooldowns" ADD CONSTRAINT "agent_harness_cooldowns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_harness_cooldowns" ADD CONSTRAINT "agent_harness_cooldowns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_harness_cooldowns" ADD CONSTRAINT "agent_harness_cooldowns_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_harness_cooldowns_agent_target_uq" ON "agent_harness_cooldowns" USING btree ("agent_id","target_key");--> statement-breakpoint
CREATE INDEX "agent_harness_cooldowns_company_agent_idx" ON "agent_harness_cooldowns" USING btree ("company_id","agent_id");