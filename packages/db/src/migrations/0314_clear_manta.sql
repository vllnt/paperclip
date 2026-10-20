-- An agent's runs without an issue, by creation time. The attention feed checks
-- whether a later run of the same agent without an issue supersedes an exhausted
-- run without an issue. Without this index, the planner reads the agent's later
-- runs and the context (detoasted) of each one. Queries must state this exact
-- predicate for the planner to use the index.
--
-- The predicate "(coalesce(issueId, taskId) > '') is not true" equals
-- "coalesce(issueId, taskId) is null or ... = ''": a null or empty issue gives
-- true, any other gives false, because '' sorts before every other string in a
-- deterministic collation. It computes the expression once per run (the other
-- form computes it twice for each run that has an issue), so the build reads
-- each context once, and the planner estimates it from the statistics of the
-- 0313 index on the same expression.
--
-- Lock: the build holds a SHARE lock on heartbeat_runs and reads every run's
-- context_snapshot once. Reads continue; run inserts and updates wait until the
-- build commits. The time grows with the context_snapshot TOAST size:
--   SELECT pg_size_pretty(pg_total_relation_size('heartbeat_runs'));
-- On a large instance, build the same index first without blocking writes:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_agent_no_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at") WHERE (coalesce("heartbeat_runs"."context_snapshot"->>'issueId', "heartbeat_runs"."context_snapshot"->>'taskId') > '') is not true;
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
		WHERE indexrelid = to_regclass('heartbeat_runs_company_agent_no_issue_created_idx') AND NOT indisvalid
	) THEN
		DROP INDEX "heartbeat_runs_company_agent_no_issue_created_idx";
	END IF;
END $$;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runner applies every migration inside BEGIN/COMMIT, so CREATE INDEX CONCURRENTLY cannot run here. Operators can build the same index CONCURRENTLY under the same name first, which IF NOT EXISTS adopts; otherwise the one-time build lock is described above.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_no_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at") WHERE (coalesce("heartbeat_runs"."context_snapshot"->>'issueId', "heartbeat_runs"."context_snapshot"->>'taskId') > '') is not true;
