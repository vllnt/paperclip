ALTER TABLE "goals" ADD COLUMN "kind" text DEFAULT 'goal' NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "horizon" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "success_criteria" text;