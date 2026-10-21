CREATE TABLE "company_eval_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"question_key" text DEFAULT '' NOT NULL,
	"verdict" text NOT NULL,
	"note" text,
	"author_type" text NOT NULL,
	"author_key" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"eval_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"caller_type" text NOT NULL,
	"caller_agent_id" uuid,
	"caller_user_id" text,
	"heartbeat_run_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"input_hash" text NOT NULL,
	"input_redacted" boolean DEFAULT false NOT NULL,
	"input_redaction_count" integer DEFAULT 0 NOT NULL,
	"input_bytes" integer NOT NULL,
	"input" jsonb,
	"input_expires_at" timestamp with time zone,
	"mode" text DEFAULT 'live' NOT NULL,
	"outcome" text NOT NULL,
	"failure_reason" text,
	"answers" jsonb,
	"any_abstained" boolean DEFAULT false NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"latency_ms" integer NOT NULL,
	"model_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_eval_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"eval_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"input_schema" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"change_note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_evals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"when_to_use" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_version_id" uuid,
	"latest_version_number" integer DEFAULT 0 NOT NULL,
	"template_key" text,
	"template_version" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_eval_feedback" ADD CONSTRAINT "company_eval_feedback_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_feedback" ADD CONSTRAINT "company_eval_feedback_run_id_company_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."company_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_feedback" ADD CONSTRAINT "company_eval_feedback_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_eval_id_company_evals_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."company_evals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_version_id_company_eval_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."company_eval_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_runs" ADD CONSTRAINT "company_eval_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_versions" ADD CONSTRAINT "company_eval_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_eval_versions" ADD CONSTRAINT "company_eval_versions_eval_id_company_evals_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."company_evals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_evals" ADD CONSTRAINT "company_evals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_evals" ADD CONSTRAINT "company_evals_published_version_id_company_eval_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."company_eval_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_eval_feedback_run_question_author_uq" ON "company_eval_feedback" USING btree ("run_id","question_key","author_key");--> statement-breakpoint
CREATE INDEX "company_eval_feedback_company_created_idx" ON "company_eval_feedback" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "company_eval_feedback_author_agent_idx" ON "company_eval_feedback" USING btree ("author_agent_id") WHERE "company_eval_feedback"."author_agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "company_eval_runs_eval_created_idx" ON "company_eval_runs" USING btree ("eval_id","created_at");--> statement-breakpoint
CREATE INDEX "company_eval_runs_version_created_idx" ON "company_eval_runs" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "company_eval_runs_company_created_idx" ON "company_eval_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "company_eval_runs_agent_created_idx" ON "company_eval_runs" USING btree ("caller_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "company_eval_runs_project_created_idx" ON "company_eval_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "company_eval_runs_heartbeat_run_idx" ON "company_eval_runs" USING btree ("heartbeat_run_id") WHERE "company_eval_runs"."heartbeat_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "company_eval_runs_issue_idx" ON "company_eval_runs" USING btree ("issue_id") WHERE "company_eval_runs"."issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "company_eval_runs_input_expiry_idx" ON "company_eval_runs" USING btree ("input_expires_at") WHERE "company_eval_runs"."input" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "company_eval_versions_eval_version_uq" ON "company_eval_versions" USING btree ("eval_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "company_evals_company_slug_uq" ON "company_evals" USING btree ("company_id","slug");