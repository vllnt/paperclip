# Run usage records

`run_usage_records` holds one row for each terminal heartbeat run: tokens by class, cost in micro-USD, timings, the failure cause, and the issue, project and routine the run worked on. Panels, the CLI and the analysis export read this table instead of parsing `usage_json` on every request.

This is the **run-log data path** in `AGENTS.md`. The rows stay in the instance database. Nothing is sent to a Paperclip endpoint, and nothing needs an OTLP endpoint. The design is in `doc/plans/2026-10-09-full-observability.md`.

## What a row holds

- Keys: run, company, agent, issue, project, routine. A row has no foreign key to the agent or the run, so it survives agent deletion.
- Counts and closed values only. Text columns hold a closed value or a short identifier (`[a-z0-9_.:@/+-]`, at most 80 characters). The table never holds a prompt, context, stdout, stderr or other free text.
- `usage_quality` says how much to trust the token counts: `measured`, `declared` (an adapter claim not yet verified, today every Codex run), `derived` (the server subtracted a session baseline), or `missing` (the run reported none).
- `schema_version` says which rules wrote the row.

## How rows are written

A worker derives each row from the run's own row after the run settles. It does not run on the run path, so a failure here delays a panel and cannot affect a run.

- Every 60 seconds (`RUN_USAGE_RECORD_INTERVAL_MS`, at least 10000), one server instance at a time (a Postgres advisory lock) writes a row for each terminal run that was created in the last 48 hours, finished more than 10 minutes ago, and has no row.
- Once a day the worker repeats the scan over the last 30 days. It finds runs that turned terminal after the 48-hour window. The health response counts them as `lateRecords30d`.
- A row is replaced only when the writer's `schema_version` is higher than the stored one.

## Commands

Check the collector for a company:

```sh
paperclipai observability health --company-id <company-id>
```

`GET /api/companies/:companyId/observability/health` returns the same data. It needs board access to the company, or a same-company agent that `company_scope:read` allows.

Write rows for runs that finished before this feature, or after a rule change:

```sh
pnpm observability:backfill
# optional flags
pnpm observability:backfill -- --company <company-id>
pnpm observability:backfill -- --since 2026-01-01
# also replace rows written under an older schema version
pnpm observability:backfill -- --rederive
```

The backfill is safe to repeat and safe to run while the server runs. An interrupted backfill resumes from the runs that still have no row. Run it before you enable any pruning of run events or run logs, because later slices read those events.

## For other tracks

`runUsageRecordService(db).listUsageRecordsAfter({ companyId, cursor, limit })` reads rows in `(finished_at, run_id)` order for runs that finished more than 10 minutes ago. `RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION` (in `@paperclipai/shared`) is the lowest `schema_version` whose row has taken everything it needs from the run's events and log. Delete a run's events or log only when its row is at that version or higher.
