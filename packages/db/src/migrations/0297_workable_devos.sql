-- Lock: each statement takes a brief ACCESS EXCLUSIVE lock on goals to change the catalog
-- only. The new columns are nullable or have a constant default, so Postgres rewrites no rows
-- and the lock lasts milliseconds regardless of table size.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'goal' NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "horizon" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "target_date" date;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "success_criteria" text;
