CREATE TABLE "issue_duplicate_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"candidate_issue_id" uuid NOT NULL,
	"lexical_score" double precision NOT NULL,
	"same_outcome_probability" double precision,
	"verdict" text NOT NULL,
	"model_id" text,
	"input_hash" text NOT NULL,
	"label" text,
	"labeled_by_type" text,
	"labeled_by_id" text,
	"labeled_at" timestamp with time zone,
	"comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_usage_daily" (
	"company_id" uuid NOT NULL,
	"day" date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_usage_daily_company_id_day_pk" PRIMARY KEY("company_id","day")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "duplicate_detection_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_duplicate_pairs" ADD CONSTRAINT "issue_duplicate_pairs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_duplicate_pairs" ADD CONSTRAINT "issue_duplicate_pairs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_duplicate_pairs" ADD CONSTRAINT "issue_duplicate_pairs_candidate_issue_id_issues_id_fk" FOREIGN KEY ("candidate_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_duplicate_pairs" ADD CONSTRAINT "issue_duplicate_pairs_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_usage_daily" ADD CONSTRAINT "judge_usage_daily_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_duplicate_pairs_company_issue_idx" ON "issue_duplicate_pairs" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_duplicate_pairs_pair_input_uq" ON "issue_duplicate_pairs" USING btree ("company_id","issue_id","candidate_issue_id","input_hash");