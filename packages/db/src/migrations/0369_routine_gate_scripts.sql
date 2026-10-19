ALTER TABLE "routine_runs" ADD COLUMN "gate_result_fingerprint" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "gate_result" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "gate_dispatch_input" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "gate_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "gate_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "gate" jsonb;--> statement-breakpoint
CREATE INDEX "routine_runs_gating_idx" ON "routine_runs" USING btree ("routine_id","trigger_id") WHERE "routine_runs"."status" = 'gating';