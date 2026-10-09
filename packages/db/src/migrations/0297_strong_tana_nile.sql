CREATE TABLE IF NOT EXISTS "storage_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text DEFAULT 's3' NOT NULL,
	"origin" text DEFAULT 'company' NOT NULL,
	"label" text NOT NULL,
	"location_json" jsonb NOT NULL,
	"physical_key" text NOT NULL,
	"credentials_json" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"credential_revision" integer DEFAULT 0 NOT NULL,
	"last_probe_json" jsonb,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_destinations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "storage_destinations_provider_check" CHECK ("storage_destinations"."provider" in ('s3')),
	CONSTRAINT "storage_destinations_origin_check" CHECK ("storage_destinations"."origin" in ('company'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_destinations_company_id_companies_id_fk') THEN
		ALTER TABLE "storage_destinations" ADD CONSTRAINT "storage_destinations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_destinations_company_created_idx" ON "storage_destinations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_destinations_active_physical_key_idx" ON "storage_destinations" USING btree ("physical_key") WHERE "storage_destinations"."retired_at" is null;
