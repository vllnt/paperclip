ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "run_context_policy" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "run_context_policy" jsonb;
