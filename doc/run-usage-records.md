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

## Reports

Two reports read the records. Each one works from the API, the CLI and the UI client (`ui/src/api/observability.ts`). A test fails when a route under `/observability` has no CLI command or no UI client method.

```sh
# tokens, cost and duration, grouped by agent (default), for the last 7 days
paperclipai observability usage --company-id <company-id>
# one model, one agent, a fixed window, JSON out
paperclipai observability usage --company-id <company-id> --group-by day --model <model> --agent-id <agent-id> --since 2026-10-01 --until 2026-10-08 --json
# failed runs by cause (default), and by agent with the count of all runs
paperclipai observability failures --company-id <company-id>
paperclipai observability failures --company-id <company-id> --group-by agent --cause timeout
```

`GET /api/companies/:companyId/observability/usage` and `GET /api/companies/:companyId/observability/failures` take the same values as query parameters: `groupBy`, `since`, `until`, `agentId`, `routineId`, `projectId`, `issueId`, `adapterType`, `provider`, `model`, `limit`, and `status` (usage) or `cause` (failures). An unknown parameter returns 400, so a typo cannot widen a result.

- **Groups.** Usage: `agent`, `routine`, `project`, `issue`, `adapter`, `provider`, `model`, `status`, `day`, `hour`. Failures: `cause`, `agent`, `routine`, `project`, `issue`, `adapter`, `provider`, `model`, `day`, `hour`. A run with no value for the group (for example no routine) forms one group with a null `key`.
- **Window.** `since` is included and `until` is not. A plain date means 00:00 UTC. With no `until` the window ends now, and with no `since` it starts 7 days before `until`. The window may not be longer than 366 days, or 31 days when grouped by hour. A run counts in the window of its `finished_at`.
- **Order and limit.** Day and hour groups come in time order and are never cut. Other groups come in order of token volume (input, cache read, cache write and output tokens added together), and `limit` (default 50, most 500) cuts them. `truncated` is true when groups were cut. `totals` always covers the whole window.
- **Not reported is not zero.** A token or cost sum is null when no run in the group reported that class. `quality` counts the runs of the group by trust level (`measured`, `declared`, `derived`, `missing`). Show it next to every token number.
- **Failures.** A failure is a record with a failure cause. Sums cover the failed runs only. `allRuns` is the count of all runs in the group, so `runs / allRuns` is the failure rate. `allRuns` is null when grouped by cause. The `cause` filter changes `runs` and the sums, but `allRuns` still counts every run.
- **Labels.** `label` holds the name of the agent, project or routine in the company. It is null when the record outlives the agent, or when the group has none.
- **Access.** The same as `health`: board access to the company, or a same-company agent that `company_scope:read` allows.

### Query cost

`server/scripts/observability-explain.ts` fills a throwaway embedded database with synthetic records and times every report through the service (`node --import tsx scripts/observability-explain.ts --rows 2000000 --big-share 90`, from `server/`). The last run had 2,000,000 records. One company held 1,800,000 of them, finished evenly over 365 days (about 4,900 runs a day). The table was 539 MB and its indexes 360 MB. The numbers below are the median of 3 runs in milliseconds, on a Mac that other work shared, so read them as plus or minus 30%.

| Window | agent, project, routine, adapter, model, status | issue | day |
|---|---|---|---|
| 7 days | 8 to 19 | 45 | 13 |
| 30 days | 21 to 29 | 113 | 40 |
| 90 days | 130 to 164 | 364 | 153 |
| 365 days | 200 to 276 | 874 | 347 |

Grouped by hour: 4 ms for 1 day, 28 ms for 7 days, 90 ms for 31 days. Failures: by cause 6, 15 and 144 ms for 7, 30 and 365 days; by agent 6, 20 and 196 ms; by day 10, 29 and 307 ms. A small company answered in 1 ms.

- A window of 7 or 30 days reads the `(company_id, finished_at, run_id)` index. A window that covers the whole year of a company that holds almost every row reads the whole table, which is the right plan there, and the time grows in step with the number of records in the window.
- Grouping by issue is the slowest report. It has 20,000 groups, and the hash aggregate spills to disk at the default `work_mem` of 4 MB.
- **Rollups (decision D6): none for now.** At this size no report needs more than 1 second. The budget is an assumption: 1 second for the default windows and 3 seconds for a 365-day window. Add a rollup when the 30-day report by issue is slower than 1 second on a copy of a real company, or when one company writes more than 5,000,000 records in a year. A 5,000,000-record table did not fit on the disk of the machine that ran this, so that size is a projection (about 2.5 times the numbers above), not a measurement.

## For other tracks

`runUsageRecordService(db).listUsageRecordsAfter({ companyId, cursor, limit })` reads rows in `(finished_at, run_id)` order for runs that finished more than 10 minutes ago. `RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION` (in `@paperclipai/shared`) is the lowest `schema_version` whose row has taken everything it needs from the run's events and log. Delete a run's events or log only when its row is at that version or higher.
