CREATE TABLE "project_principal_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "access_mode" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_principal_access" ADD CONSTRAINT "project_principal_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_principal_access" ADD CONSTRAINT "project_principal_access_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_principal_access_project_principal_uq" ON "project_principal_access" USING btree ("project_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "project_principal_access_company_principal_idx" ON "project_principal_access" USING btree ("company_id","principal_type","principal_id");