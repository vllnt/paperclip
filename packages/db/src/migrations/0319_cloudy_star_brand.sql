CREATE TABLE "issue_triages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"mode" text NOT NULL,
	"suggested_priority" text,
	"category" text,
	"suggested_assignee_agent_id" uuid,
	"probabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"apply_outcome" text,
	"applied_at" timestamp with time zone,
	"model_id" text,
	"input_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "issue_triage_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_triages" ADD CONSTRAINT "issue_triages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_triages" ADD CONSTRAINT "issue_triages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_triages" ADD CONSTRAINT "issue_triages_suggested_assignee_agent_id_agents_id_fk" FOREIGN KEY ("suggested_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_triages_company_issue_uq" ON "issue_triages" USING btree ("company_id","issue_id");