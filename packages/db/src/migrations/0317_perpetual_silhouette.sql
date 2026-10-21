-- A run that a server restart cut short, by its restart resume. The daily run
-- count charges the cut run once, on its resume, and checks for that resume
-- through this index, as heartbeat_runs_harness_fallback_successor_idx serves the
-- harness-fallback check.
--
-- Lock: the build holds a SHARE lock on heartbeat_runs. Reads continue; run
-- inserts and updates wait until the build commits. The build reads only heap
-- columns (never context_snapshot), so it takes about one sequential scan of the
-- heap:
--   SELECT pg_size_pretty(pg_relation_size('heartbeat_runs'));
-- On a large instance, build the same index first without blocking writes:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_restart_resume_successor_idx" ON "heartbeat_runs" USING btree ("company_id","retry_of_run_id") WHERE "heartbeat_runs"."scheduled_retry_reason" = 'planned_restart_resume';
-- IF NOT EXISTS then keeps that index, and this migration builds nothing.
--
-- A failed or cancelled concurrent build leaves an INVALID index under this
-- name. The planner never uses it, and IF NOT EXISTS would keep it. The DO block
-- below drops such an index, so the migration builds it again. In that case
-- DROP INDEX holds an ACCESS EXCLUSIVE lock on heartbeat_runs until the
-- migration commits, so reads also wait during the build. Do not run a
-- concurrent build of this index while the migration runs. See doc/DATABASE.md.
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_index
		WHERE indexrelid = to_regclass('heartbeat_runs_restart_resume_successor_idx') AND NOT indisvalid
	) THEN
		DROP INDEX "heartbeat_runs_restart_resume_successor_idx";
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_restart_resume_successor_idx" ON "heartbeat_runs" USING btree ("company_id","retry_of_run_id") WHERE "heartbeat_runs"."scheduled_retry_reason" = 'planned_restart_resume';
