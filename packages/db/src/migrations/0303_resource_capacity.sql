CREATE TABLE "resource_capacity_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_key" text NOT NULL,
	"environment_id" uuid,
	"sampled_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"error_class" text,
	"cpu_count" integer,
	"load1" real,
	"load5" real,
	"load15" real,
	"mem_total_bytes" bigint,
	"mem_available_bytes" bigint,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"level" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_capacity_targets" (
	"target_key" text PRIMARY KEY NOT NULL,
	"target_kind" text NOT NULL,
	"environment_id" uuid,
	"host_label" text,
	"latest_sampled_at" timestamp with time zone,
	"latest_status" text,
	"latest_reading" jsonb,
	"level" text DEFAULT 'unknown' NOT NULL,
	"metric_levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metric_sampled_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"level_changed_at" timestamp with time zone,
	"next_sweep_at" timestamp with time zone,
	"last_history_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_capacity_samples" ADD CONSTRAINT "resource_capacity_samples_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_capacity_targets" ADD CONSTRAINT "resource_capacity_targets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_capacity_samples_target_sampled_idx" ON "resource_capacity_samples" USING btree ("target_key","sampled_at");--> statement-breakpoint
CREATE INDEX "resource_capacity_samples_sampled_idx" ON "resource_capacity_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_capacity_targets_environment_uq" ON "resource_capacity_targets" USING btree ("environment_id");