CREATE TABLE "personal_agent_instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"personal_agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"personal_agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"markdown" text NOT NULL,
	"source" text NOT NULL,
	"catalog_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"instructions_revision" integer DEFAULT 0 NOT NULL,
	"tool_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_source" text NOT NULL,
	"actor_key_id" text,
	"company_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_agent_instruction_revisions" ADD CONSTRAINT "personal_agent_instruction_revisions_personal_agent_id_personal_agents_id_fk" FOREIGN KEY ("personal_agent_id") REFERENCES "public"."personal_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_skills" ADD CONSTRAINT "personal_agent_skills_personal_agent_id_personal_agents_id_fk" FOREIGN KEY ("personal_agent_id") REFERENCES "public"."personal_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_agent_instruction_revisions_agent_revision_idx" ON "personal_agent_instruction_revisions" USING btree ("personal_agent_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_agent_skills_agent_key_idx" ON "personal_agent_skills" USING btree ("personal_agent_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_agents_user_idx" ON "personal_agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_audit_log_user_created_idx" ON "user_audit_log" USING btree ("user_id","created_at");