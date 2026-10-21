CREATE TABLE "database_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"key" text,
	"title" text DEFAULT '' NOT NULL,
	"cells" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"updated_by_run_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by_agent_id" uuid,
	"deleted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_rows_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"properties" jsonb NOT NULL,
	"schema_revision" integer DEFAULT 1 NOT NULL,
	"agent_access" text DEFAULT 'write' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"next_row_seq" bigint DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"archived_at" timestamp with time zone,
	"archived_by_agent_id" uuid,
	"archived_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "databases_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "databases_agent_access_check" CHECK ("databases"."agent_access" IN ('write', 'read')),
	CONSTRAINT "databases_row_count_check" CHECK ("databases"."row_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_updated_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("updated_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_database_company_fk" FOREIGN KEY ("database_id","company_id") REFERENCES "public"."databases"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_rows_database_seq_uq" ON "database_rows" USING btree ("database_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "database_rows_database_key_uq" ON "database_rows" USING btree ("database_id","key") WHERE "database_rows"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "database_rows_company_database_idx" ON "database_rows" USING btree ("company_id","database_id");--> statement-breakpoint
CREATE INDEX "database_rows_cells_idx" ON "database_rows" USING gin ("cells" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "databases_company_key_uq" ON "databases" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "databases_company_project_idx" ON "databases" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "databases_company_archived_updated_idx" ON "databases" USING btree ("company_id","archived_at","updated_at");