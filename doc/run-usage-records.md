# Run usage records

`run_usage_records` holds one row for each terminal heartbeat run: tokens by class, cost in micro-USD, timings, the failure cause, and the issue, project and routine the run worked on. Panels, the CLI and the analysis export read this table instead of parsing `usage_json` on every request.

This is the **run-log data path** in `AGENTS.md`. The rows stay in the instance database. Nothing is sent to a Paperclip endpoint, and nothing needs an OTLP endpoint. The design is in `doc/plans/2026-10-09-full-observability.md`.

## What a row holds

- Keys: run, company, agent, issue, project, routine. A row has no foreign key to the agent or the run, so it survives agent deletion.
- Counts and closed values only. Text columns hold a closed value or a short identifier (`[a-z0-9_.:@/+-]`, at most 80 characters). The table never holds a prompt, context, stdout, stderr or other free text.
- Token classes do not overlap. `input_tokens` is the fresh input only, `cache_read_tokens` is the cached part, and `output_tokens` is the output. Providers differ in what they report: OpenAI-family streams count the cached tokens inside the input, so for the recorded providers `openai` and `xai` the worker stores the reported input minus the cached part. The recorded provider label decides, not the model id: a Grok model that runs through `codex_local` is recorded as `openai` and follows the OpenAI rule. The `xai` label is expected only from the `grok_local` adapter. Anthropic streams report the cached tokens on top, so those counts are stored as reported. The stream and the provider decide this, not the adapter type: a `codex_local` run on an Anthropic model streams Anthropic counts. Claude `input_tokens` still includes the cache-creation tokens until a later slice splits them (`cache_write_tokens` is null).
- `usage_quality` says how much to trust the token counts: `measured` (the provider reported them for this run, including the `codex_local` CLI, whose counts were checked to be per run), `declared` (a claim nobody has checked: the Codex app-server runner, another Codex adapter, or a cached count larger than the input of a provider that counts it inside the input), `derived` (the server subtracted a session baseline), or `missing` (the run reported none).
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
