-- A run's issue as recovery and the attention feed read it: issueId, else taskId.
-- Without this index, "runs of this issue" lookups (recovery's live-path checks)
-- scan heartbeat_runs and read (detoast) every run's context_snapshot. Queries
-- must use this exact expression for the planner to use the index.
--
-- Lock: the build holds a SHARE lock on heartbeat_runs and reads every run's
-- context_snapshot once. Reads continue; run inserts and updates wait until the
-- build commits. The time grows with the context_snapshot TOAST size:
--   SELECT pg_size_pretty(pg_total_relation_size('heartbeat_runs'));
-- On a large instance, build the same index first without blocking writes:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_issue_or_task_idx" ON "heartbeat_runs" USING btree ("company_id", (coalesce("context_snapshot"->>'issueId', "context_snapshot"->>'taskId')));
-- IF NOT EXISTS then keeps that index, and this migration builds nothing.
--
-- A failed or cancelled concurrent build leaves an INVALID index under this
-- name. The planner never uses it, and IF NOT EXISTS would keep it. The DO block
-- below drops such an index, so the migration builds it again. In that case
-- DROP INDEX holds an ACCESS EXCLUSIVE lock on heartbeat_runs until the
-- migration commits, so reads also wait during the build. Do not run a
-- concurrent build of this index while the migration runs.
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_index
		WHERE indexrelid = to_regclass('heartbeat_runs_company_issue_or_task_idx') AND NOT indisvalid
	) THEN
		DROP INDEX "heartbeat_runs_company_issue_or_task_idx";
	END IF;
END $$;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runner applies every migration inside BEGIN/COMMIT, so CREATE INDEX CONCURRENTLY cannot run here. Operators can build the same index CONCURRENTLY under the same name first, which IF NOT EXISTS adopts; otherwise the one-time build lock is described above.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_or_task_idx" ON "heartbeat_runs" USING btree ("company_id", (coalesce("context_snapshot"->>'issueId', "context_snapshot"->>'taskId')));
