# Company flow metrics: throughput, scrap, runs per done issue and cost, with process limits

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
Branch: `docs/company-flow-metrics`
Code anchors: `main` at `38819d350`, plus three open pull requests named in section 2. Appendix A lists every anchor as `file:line`.

## 1. Goal and constraints

An operator needs one answer for each company: **is the flow healthy, and did it
change?** A number alone does not say it. "14 issues done today" is good or bad only
next to what is normal for that company.

**Goal.** One read-only report per company over four windows (1 hour, 24 hours,
7 days, 30 days) with four metrics:

1. **Throughput.** Issues done.
2. **Scrap.** Failed and lost runs, by `error_code`.
3. **Runs per done issue.**
4. **Cost.**

Each metric comes with a time series and **process limits** (an XmR chart: an
individuals chart and a moving range chart) that say whether a change is a signal
or noise.

Constraints, all binding:

- **Read only.** The report reads existing tables and writes nothing, so it writes
  no activity entry. It needs no migration. One prerequisite (slice F0, section 7)
  changes which runs the usage record covers. That is a code change with a version
  bump and no migration.
- **Company scope.** Every query filters on `company_id`. The report never mixes
  companies.
- **Web, API (listed in OpenAPI) and CLI** for the report, in the same slice or
  with a named follow-up. Parity of surfaces is not parity of permissions.
- **Readable by the board and by the company's own agents**, with the existing
  `company_scope:read` decision. **No new permission** (section 5.2).
- **Fail open.** A failed or slow read affects the reader only. It never touches a
  run.
- **Counts, closed enums and numbers only.** No prompt, output or issue text.
- **Public repository.** No instance, host or company names in this document.

Not in scope:

- Custom date ranges and per-agent, per-project or per-model breakdowns. The
  usage and failures reports of pull request #73 do those.
- Alerts or notifications on a signal (a follow-up; the attention feed is the
  natural place).
- Tokens. The four metrics need none, so this plan does not use `estimateTokens`
  (section 2, reuse map, and Q9).
- Rollup tables. The observability plan decided to add none until measured
  evidence demands them.
- Targets or service levels. Limits describe what the company does, not what it
  should do.

## 2. What exists today

| Need | On `main` | Gap |
|---|---|---|
| One row of facts per terminal run: status, `error_code`, closed cause, `cost_micros`, `issue_id`, `is_retry`, `provider_work_started`, `finished_at` | `run_usage_records` (pull request #70, merged). Index `(company_id, finished_at, run_id)` and a partial index `(company_id, issue_id)` | **It covers four statuses only: `succeeded`, `failed`, `cancelled`, `timed_out`.** A run that a shutdown or the orphan backstop ends has the status `interrupted` and gets **no record**. It is also derived after a 10 minute settle (`RUN_USAGE_SETTLE_MS`) |
| Closed failure causes | 14 causes in `RUN_FAILURE_CAUSES`. Restart losses are `interrupted_graceful` and `interrupted_crash` | The orphan backstop codes `orphaned_running_run` and `orphaned_running_run_issue_terminal` have no cause mapping, so they read as `unknown` |
| When an issue was done | `issues.completed_at`, set when a write carries `status: done` and cleared when a write sets a non-done status | **No index** on `(company_id, completed_at)`. Only `(company_id, status)` exists. A `done` to `done` write sets it again |
| Which issues the board lists | `visibleIssueCondition()`, no conversation issues, and `nonIdleSlackIssueCondition()` in the list query | A metric must use the same rule or it counts a different set |
| Run counts by status and `error_code` | **Not on `main`.** Pull request #28 adds `GET /heartbeat-runs/stats` | It counts by **creation time** from `heartbeat_runs`, up to 90 days, with daily cap usage per agent |
| Usage and failure reports with day and hour buckets | **Not on `main`.** Pull request #73 (its base branch was rewritten, so it needs a `rebase --onto`) | It groups and filters by issue, but has no completion data, only `day` and `hour` buckets, and no limits |
| A marker for a planned restart | Activity entries `instance.task_drain.started` and `.stopped`. The started entry carries `details.startedAt` and `details.expiresAt`. One row per company, written in one transaction | The drain state lives in **process memory**, so a restart ends it **without a `stopped` entry**. The time to live is optional (`null` means no expiry) and at most 24 hours when set |
| Cost shown to the board today | The dashboard month total comes from `cost_events.cost_cents`. The costs routes use `assertCompanyScopeReadAllowed` | A **different source** from `run_usage_records.cost_micros` |
| A guard for company-wide read data | `assertCompanyScopeReadAllowed` (the observability and costs routes). `company_scope:read` has no permission key. Task bridge keys are denied | The dashboard route checks `assertCompanyAccess` only, and already shows month cost and failure counts |
| A card to show a number | `MetricCard`, `Dashboard.tsx` | No chart with limits |

### Reuse map

The brief names what to reuse. This is what the plan does with each item.

| Named | What the plan takes | What it does not take |
|---|---|---|
| #28 run statistics | The terms *terminal* and *unsuccessful*, the 90 day cap idea, the `company_scope:read` guard | Its route and its numbers. They count by creation time and per agent against a cap. Two meanings under one route would confuse |
| #64 plan, #70, #73 | The run facts of #70. The window and bucket helpers and the report builder of #73 | #73's `day` and `hour` buckets are too coarse for the one hour window, so F1 adds bucket sizes |
| #62 `estimateTokens` | Nothing | None of the four metrics uses tokens (Q9) |
| The split of restart losses inside and outside a deploy window | The idea. The observability plan names `server_boot_events` as the marker, and that table is not built | This plan builds the split from the drain entries (section 3.4). **The split is new in this plan.** The observability plan defines no such split |

### Findings

- **G1. Three of the four metrics come from one table.** Runs, scrap and cost read
  `run_usage_records`. Only throughput needs the issues table.
- **G2. The usage record does not cover `interrupted` runs.** This is the most
  important finding. In one production day that the planned restart plan measured,
  416 of 991 terminal runs ended because of a restart: `process_lost` 172,
  `orphaned_running_run` 140, `server_shutdown_interrupted` 104. Only
  `process_lost` has the status `failed` and gets a record. The other 244 have the
  status `interrupted` and do not. A scrap and restart report built on the table
  as it is would miss most restart losses. Slice F0 fixes this first.
- **G3. "Done" is the current state.** A write that sets a non-done status clears
  `completed_at`, so an issue that was done in last week's window and reopened
  since is not counted there. A write that carries `status: done` sets it again,
  even from `done`, which moves the issue to a later bucket. Both are acceptable if
  the report says so (section 3.2).
- **G4. The newest 10 minutes of runs are not derived yet.** A one hour window with
  five minute buckets would show a false drop at its right edge. The plan fixes the
  window end to a settled time (section 3.1).
- **G5. The word "failed" already means three things.** Pull request #28 counts
  unsuccessful runs by creation time. The dashboard shows a failed count that nets
  out runs that a retry recovered, also by creation time. This plan counts scrap by
  finish time. The plan names its definition and does not claim the others are wrong.
- **G6. Cost has two sources.** The dashboard uses the billing ledger. This plan uses
  the per run cost that the run reported (section 3.6).
- **G7. The drain marker is weaker than it looks.** A drain with no expiry that ends
  in a restart leaves a started entry with no stop. That is the normal case, not an
  edge case. A restart without a drain leaves no marker at all (section 3.4).

## 3. Definitions

The report is a contract. Each term is defined once.

### 3.1 Windows and buckets

A window ends at **`asOf`**, not at the wall clock: `asOf = now - settle`, where
`settle` is `RUN_USAGE_SETTLE_MS` plus one worker interval (the interval is
configurable, 60 seconds by default, so the plan does not hard code the sum). If the
observability health data reports a larger derivation lag, `asOf` moves back by that
lag. Every metric of one response uses the same `asOf`, and the response returns it.

The window is `[asOf - length, asOf)`. The previous window is
`[asOf - 2 x length, asOf - length)`.

| Window | Bucket | Points | Why |
|---|---|---|---|
| `1h` | 5 minutes | 12 | |
| `24h` | 1 hour | 24 | |
| `7d` | 6 hours | 28 | Daily would give only 7 points, too few for limits |
| `30d` | 1 day | 30 | |

Buckets are aligned to UTC multiples of the bucket size. The first and the last
bucket can be partial. A partial bucket is flagged `partial: true`, **shown, left
out of the limit calculation and not tested for signals**. `total` and `previous`
cover the whole window, partial edges included. The windows are a fixed set. A free
range is the job of the #73 reports.

The cost of the settle rule is staleness: the one hour window ends about 11 minutes
in the past. The alternative, reading `heartbeat_runs` for the tail, would add a
second source and a much larger table (Q8).

### 3.2 Throughput

The number of issues with `status = 'done'` and `completed_at` in the bucket, using
**the same visibility rule as the board list** (the list query's conditions, section
2). It is the **current** state (G3). The response also gives `byOrigin` (the issue
origin kind), so issues that the system creates are visible and not silently mixed in.

Because `runs.total` counts every terminal run and throughput counts only the board
visible issues, the two do not describe the same set. The report says so in its
notes, and the cohort measure (3.5) uses only visible done issues.

### 3.3 Runs

The number of terminal runs with `finished_at` in the bucket, from
`run_usage_records` (after slice F0, this includes `interrupted`). `retryShare` is
the part with `is_retry = true`.

### 3.4 Scrap, stopped and deferred

Every terminal run falls into **exactly one** class. The class depends on the status
and on `provider_work_started`:

| Class | Rule |
|---|---|
| `succeeded` | status `succeeded` |
| **`scrap`** | status `failed`, `timed_out` or `interrupted` |
| `stopped` | status `cancelled`, and provider work had started. A person or the control plane chose to stop it |
| `deferred` | status `cancelled`, and provider work had **not** started. The run waited and was held back (a busy workspace, a busy AI connection, a daily cap) |

The identity `succeeded + scrap + stopped + deferred = runs` always holds, and a test
checks it. A `cancelled` run is never scrap, even when its cause reads `unknown`,
because a cancel is a decision and a classification error must not inflate the rate.
The difference from #28 is stated in Q3.

| Field | Meaning |
|---|---|
| `count` | scrap runs |
| `rate` | `count / runs`. Null in a bucket with fewer than 5 runs |
| `byErrorCode` | The ten largest `error_code` values, and `otherCount` for the rest. `error_code` is a length capped identifier. A literal code `other` cannot collide with `otherCount` |
| `byCause` | The closed cause totals for scrap |
| `stopped`, `deferred` | Counts, `stopped` by cause |
| `restartLoss` | `{ total, insideDeployWindow, outsideDeployWindow, windowsFound, windowsOpenEnded }` |

**Restart loss** is scrap with the cause `interrupted_graceful` or
`interrupted_crash`. After slice F0 it includes the three kinds of restart loss
(`process_lost`, `orphaned_running_run`, `server_shutdown_interrupted`).

**Deploy windows** come from the company's drain entries. For each `started` entry:

1. The window ends at the earliest of: the first later `stopped` entry, and
   `details.expiresAt` when it is not null.
2. If neither exists, the window ends **60 minutes** after the start. (A drain with
   no expiry ends in a restart that clears the memory state and writes no stop. The
   planned restart plan measured about 17 minutes between the two stops of one
   deploy.)
3. The window then gets a **30 minute grace** at its end, because a lost run is
   finalized when the new process boots, after the drain ended.

A restart loss is *inside* when its `finished_at` falls in a window, and *outside*
otherwise. A restart without a drain leaves no marker, so it counts as outside: a hot
restart shows as unplanned. The response says so in its notes. Drain rows are written
to every company in one transaction, so the windows are the same for all companies of
an instance. `windowsOpenEnded` counts the windows that used rule 2. The numbers 60
and 30 are constants, not settings, in F1.

### 3.5 Runs per done issue

A cohort measure. For the board visible issues done in the bucket, the mean and
median number of terminal runs that ever ran on each (`run_usage_records.issue_id`,
partial index `(company_id, issue_id)`, with `company_id` stated on the join). It is
the effort that it took to deliver, not a ratio of two window totals, which would mix
runs from issues that finish later.

- It counts runs with `finished_at <= asOf` only.
- Runs with no issue are left out and shown as `unattributedRuns`.
- Usage records start when the feature rolled out, plus any backfill. The response
  gives **`dataFrom`**, the time of the first record. Before that date the cohort and
  `previous` are marked incomplete.
- A bucket mean needs a cohort of at least **3 issues**, else the point is null.
- The response gives the cohort size.

### 3.6 Cost

`cost_micros` summed over the terminal runs of the bucket. It is **reported cost**:
the cost a run reported, and null when no run reported one. The response gives
`basis: "reported"` and `coverage` (the share of runs that reported a cost).
`apiEquivalentMicros` is an estimate and is never added to it. `cohortCostMicros` is
the reported cost of the cohort in 3.5, and `perDoneIssueMicros` is that cost divided
by the cohort size. It is not the window total divided by the throughput.

The dashboard month total uses the billing ledger, and the two can differ (G6). The
report says so in its `basis` field, and a test explains the known differences
(window axis, runs without a cost).

### 3.7 Data quality

Each response carries `dataQuality`: `asOf`, the settle in seconds, the derivation lag
from the observability health route, `dataFrom`, and the number of runs of the window
that still have no usage record.

## 4. Process limits (XmR)

### 4.1 Method

For a series of points x₁…xₙ:

- the **mean** x̄ of the points;
- the moving ranges mRᵢ = |xᵢ − xᵢ₋₁| and their mean mR̄;
- the **natural process limits** are x̄ ± 2.660 × mR̄, and the upper range limit is
  3.268 × mR̄. (2.660 is 3 ÷ 1.128, and 3.268 is the 2-point range constant, both
  rounded as in the standard tables.)
- **One revision step.** A moving range above the upper range limit is dropped, and
  mR̄ is computed again once. Without this, a spike widens the limits that are meant
  to catch it (fixture B2).
- A count cannot be negative, so a lower limit below 0 is shown as 0.
- **A gap breaks the chain.** A null point is skipped, and no moving range spans it.
  mR̄ uses only ranges between two adjacent points.
- **At least 8 points and 4 moving ranges** (partial buckets and null points
  excluded). Fewer: `limits` is null with `reason: "insufficient_data"`. A limit from
  five points is a guess.
- The response states `method: "xmr.v1"`, so the rules can change later.

### 4.2 Signals

| Rule | Signal | Windows |
|---|---|---|
| 1 | A point beyond a natural process limit | all |
| 4 | Eight points in a row on the same side of the mean | `7d` and `30d` only |

Rule 4 is off for `1h` and `24h`. A company that works in the day has a daily cycle:
over 24 hourly points, the night is a run of 8 or more points below the mean, and
rule 4 would fire every day (fixture E). On the one hour window the counts are mostly
0 to 2, and a run below the mean is only quiet. Both would teach readers to ignore
the badge. The two other common rules (two of three points in the outer third, four of
five beyond one sigma) are an extension. Each point carries the rules it breaks, and
the series gets a `signals` list.

**What the limits do not do.** The limits describe variation around a stable level.
They do not model a daily or weekly cycle. A company with a strong cycle sees its
peaks near the upper limit. A previous-period baseline (F3) is the better tool for
those series.

### 4.3 Series that get limits

| Series | Rule for the series |
|---|---|
| Throughput, runs, scrap count, cost | Counts or sums per bucket. Lower limit shown as 0 |
| Scrap rate | A bucket joins only if it has at least 5 runs. The **centre line is the pooled rate** (scrap ÷ runs over the included buckets), because the mean of the bucket rates is a different number (fixture F). The limits use the moving range of the bucket rates and are clamped to [0, 1]. XmR on rates ignores that the denominators change; a p-chart would be exact, and it is an F3 option |
| Runs per done issue | The bucket mean, for buckets with a cohort of at least 3 issues |

### 4.4 Fixtures

These numbers are the tests. Each was computed by a script.

| Series | Points | x̄ | mR̄ after revision | Upper | Lower | Result |
|---|---|---|---|---|---|---|
| A | 12 15 11 14 13 16 12 15 13 14 12 15 | 13.5 | 2.6364 (none dropped) | 20.5127 | 6.4873 | no signal |
| B1 | A with the last point 30 | 14.75 | 2.6 (one dropped; before: 4.0) | 21.666 | 7.834 | rule 1 on 30 |
| B2 | A with the last point **23** | 14.1667 | 2.6 (one dropped; before: 3.3636) | 21.0827 | 7.2507 | rule 1 on 23, **only after the revision**. Without it the upper limit is 23.1139 and 23 does not fire |
| Z | 0 1 0 2 1 0 1 0 2 1 | 0.8 | 1.2222 | 4.0511 | −2.4511, shown as 0 | no signal |
| D | 10 10 11 10 12 12 13 12 13 13 12 13 | 11.75 | 0.8182 | 13.9264 | 9.5736 | rule 4 fires at the 12th point; rule 1 does not |

- **Fixture E (a cycle).** A square wave of 12 hours at 2 and 12 hours at 10 over 24
  hourly points has runs of 8 or more on each side of the mean. It must give *no*
  rule 4 signal on `24h` and must give one on `30d` if the same wave covers 30 daily
  points with a long step. This pins section 4.2.
- **Fixture F (a rate).** Scrap `1 0 3 2 0 9 1 0` over runs `5 6 8 6 5 40 5 6` has a
  mean of bucket rates of 0.1667 and a pooled rate of 0.1975. The centre line must be
  0.1975.

### 4.5 Where the limits live

| Option | For | Against |
|---|---|---|
| **A. The server computes them** (a pure function in `packages/shared`, called by the report) | One implementation, so the web card, the CLI and an agent show the same numbers. Agents read JSON and need not do statistics. Cheap: at most 30 points per series. Versioned by `method`. Easy to test with fixed fixtures | A reader cannot choose another baseline without a new query option |
| B. Each reader computes them | Flexible for the reader | Three implementations that drift. Every agent that wants the answer must copy the maths |
| C. Both | | The drift problem of B, and the cost of A |

**Recommendation: A.** The response includes `mean`, `mRBar`, the limits and the
dropped ranges, so a reader can verify the result. Readers receive the series and can
compute their own view from it. They do not need to compute these limits.

The limits are computed from **the window's own buckets**. A baseline from the
previous period catches a shift that started inside the window, but it needs a second
query and a rule for two bucket sizes. It is a query option for a later slice (Q2).

## 5. Surfaces

### 5.1 API

`GET /companies/:companyId/observability/flow?window=24h` (under the existing
observability prefix, listed in OpenAPI).

| Query | Meaning |
|---|---|
| `window` | `1h`, `24h`, `7d` or `30d`. Default `24h` |
| `limits` | `true` (default) or `false` to leave the limits out |

Response, in short:

```json
{
  "companyId": "…", "window": "24h", "bucketMinutes": 60,
  "asOf": "2026-10-10T12:49:00.000Z", "generatedAt": "…",
  "dataQuality": { "settleSeconds": 660, "derivationLagSeconds": 42, "dataFrom": "2026-10-09T18:00:00.000Z", "runsWithoutRecord": 0 },
  "throughput": { "total": 31, "previous": 27, "byOrigin": { "…": 0 }, "series": [ { "t": "…", "value": 2, "partial": false, "signals": [] } ], "limits": { "method": "xmr.v1", "mean": 1.3, "mRBar": 1.1, "upper": 4.2, "lower": 0, "droppedRanges": 0 }, "signals": [] },
  "runs": { "total": 290, "retryShare": 0.12, "series": [ ], "limits": { } },
  "scrap": { "count": 51, "rate": 0.18, "stopped": { }, "deferred": 6, "byErrorCode": [ ], "otherCount": 4, "byCause": { }, "restartLoss": { "total": 9, "insideDeployWindow": 7, "outsideDeployWindow": 2, "windowsFound": 1, "windowsOpenEnded": 0 }, "series": [ ] },
  "runsPerDoneIssue": { "mean": 2.4, "median": 2, "cohortSize": 31, "unattributedRuns": 12, "series": [ ] },
  "cost": { "basis": "reported", "totalMicros": 41200000, "cohortCostMicros": 52700000, "perDoneIssueMicros": 1700000, "coverage": 0.97, "series": [ ] },
  "notes": [ "A reopened issue is not counted in the past.", "A restart without a drain counts as outside a deploy window." ]
}
```

`previous` is the same metric for the window before this one, so a reader sees the
change without a second call.

### 5.2 Authorization: no new permission

| Who | Result |
|---|---|
| A board user | `assertCompanyAccess` and `assertCompanyScopeReadAllowed`, as the observability and costs routes |
| A board viewer | Allowed. The same company membership rule applies, and `company_scope:read` does not need a non-viewer role |
| An agent of the company | The same two checks. `company_scope:read` maps to no permission key, so there is nothing to grant. The decision is the company's default |
| A low-trust agent, a skill-test token, a task bridge key | **Refused.** The authorization service lists `company_scope:read` in each of these three deny blocks |
| An agent of another company | Refused by `assertCompanyAccess` |

The test matrix covers all six rows.

Two decisions come out of this.

- **The card must call this route and not extend the dashboard summary.** The
  dashboard route checks `assertCompanyAccess` only, and it already shows month cost
  and failure counts, so the stricter guard cannot be claimed as a gain for those
  numbers. The new route has per run detail (error codes, cost per issue) and uses the
  same stricter guard as the costs and observability routes. The dashboard summary
  stays as it is.
- **Cost is visible to every actor that can read the report.** Cost reads already use
  `company_scope:read`, so this is consistent. It is still a choice (Q10).

### 5.3 CLI

`paperclipai observability flow [--window 1h|24h|7d|30d] [--no-limits] [--json]`.
Without `--json` it prints a table per metric with the current value, the previous
value, the limits and any signals. It uses the same route as the web card.

### 5.4 Web

F1 adds the **UI client method** that the parity test needs. F2 adds the screen.

A **Flow** section on the dashboard, one `MetricCard` row for the four metrics with a
sparkline, the limit band and a signal badge:

- a window switcher (1h, 24h, 7d, 30d), kept in the URL;
- the number, the change against `previous`, and a short sentence for a signal ("above
  the usual range for 3 of the last 24 hours");
- scrap opens a panel with the `error_code` list, the stopped and deferred counts, and
  the planned versus unplanned restart split;
- a link to the #73 reports for drilling down by agent or model.

Web checks follow `AGENTS.md`: token-only styling (`pnpm check:token-gates`), a real
browser at desktop and mobile widths, zero console errors.

### 5.5 Activity log

The report is read only, so it writes no entry. If a later slice stores a saved view
or a threshold, those mutations write entries.

## 6. Cost of the query

| Metric | Shape | Index |
|---|---|---|
| Runs, scrap, cost | One grouped scan of `run_usage_records` for both windows, bucketed by `floor(epoch / bucket)` | `(company_id, finished_at, run_id)` |
| Runs per done issue | Done visible issues of the window joined to usage records by `issue_id` and `company_id` | partial `(company_id, issue_id)` on usage records |
| Throughput | Done issues with `completed_at` in the range | **None on `completed_at`.** The issues table is medium sized (about 1,609 rows locally, estimated at 250 times that), so the evidence below decides |
| Drain windows | The drain entries of the company, from 24 hours before the window start | `(entity_type, entity_id)` on the activity log, then filter by company and time. The `(company_id, created_at)` index would scan all company activity, and the activity log is the largest table |
| `runsWithoutRecord` | An anti-join of terminal runs in the window against usage records | `heartbeat_runs`. It is the one query on the large table. F1 measures it and may drop it or bound it |

The report uses `floor(epoch / seconds)` for the buckets, which works on every
supported PostgreSQL version, and not `date_bin`.

**The previous window.** `previous` doubles the rows read. The usage side reads one
range that covers both windows (`[asOf - 2 x length, asOf)`) and splits it by bucket
arithmetic, so it stays one scan. The issues side reads the same range once.

**Evidence first.** The earlier observability work measured 2,000,000 usage records:
the slowest report took 874 ms and most took under 120 ms. The usage side is covered.
The issues side and the anti-join are not measured. Slice F1 extends the existing
EXPLAIN script to the issues table at a realistic size and applies a budget of **1
second median for the 30 day window**. If a query misses it, F1 adds a partial index
`(company_id, completed_at) WHERE status = 'done'`. The migration safety check has a
rule (`large-create-index-not-concurrently`) against a plain `CREATE INDEX` on a table
it knows to be large. The estimates list `issues` with a small local count, so it may
not be on that list. F1 checks, and the index is created `CONCURRENTLY` as its own
commit if the rule applies (Q7).

**Caching.** The report is read by a dashboard that can poll. A cache of 30 seconds
per company and window, in the process and single flight, keeps repeated reads off the
database. It stores nothing and is not a rollup. Its benefit is not measured, so F1
adds it only if the evidence shows repeated reads.

## 7. Slice plan

| Slice | Scope | Needs |
|---|---|---|
| **F0** | **Prerequisite, a small change to the merged usage record code.** Add `interrupted` to `RUN_USAGE_TERMINAL_STATUSES`. Map `orphaned_running_run` and `orphaned_running_run_issue_terminal` to `interrupted_crash`. Bump `RUN_USAGE_RECORD_SCHEMA_VERSION`, so the worker and the backfill command derive the missing rows (`--rederive`). Update the health counts and the docs. No migration (`status` is text). It widens the `status` filter of #73 too | none |
| **F1** | Shared contract; the pure XmR function with the fixtures of 4.4; the service for runs, scrap, stopped, deferred, restart split, cost, throughput and runs per done issue; `GET .../observability/flow`; OpenAPI; CLI; the **UI client method**; the EXPLAIN evidence for the issues side and the anti-join (the index only if needed) | F0, and #73 merged (its window and report helpers), or the helpers extracted (Q8) |
| **F2** | The web card and panel (section 5.4). `MetricCard` shows a number only, so F2 adds a small chart component for the series, the limit band and the signal marks | F1 |
| **F3** | Options: a baseline from the previous period; the two more rules; a p-chart for rates; the signal as an attention item | F1, F2 |

F1 reaches the API, the CLI and the UI client, and F2 is the linked web follow-up, as
the parity rule allows. Humans get no screen until F2. If the reviewer prefers, F1
and F2 can be one pull request.

## 8. Verification per slice

Tests are written red first.

**F0**

- A run with the status `interrupted` gets a record, with the cause
  `interrupted_graceful` for `server_shutdown_interrupted` and `interrupted_crash` for
  `orphaned_running_run` and its sibling.
- Records that exist at the old version are replaced by the rederive pass. Records of
  the four old statuses keep their values.
- The health denominators and the #73 status filter include `interrupted`.
- The derivation reads the run row only, so it does not depend on run events that a
  retention job may have removed.

**F1**

- **Limits.** The fixtures of 4.4 give the exact values. The revision step drops the
  right range, and fixture B2 fires only after it. A series of fewer than 8 points
  gives `insufficient_data`. A negative lower limit is shown as 0. A gap breaks the
  moving range chain. Rule 1 fires on B1 and B2 and on nothing in A. Rule 4 fires on D
  for `7d` and `30d`, and **never for `1h` and `24h`** (fixture E).
- **Rates.** The centre line is the pooled rate (fixture F), limits are clamped to
  [0, 1], and a bucket under 5 runs is a gap.
- **Classes.** A fixture with every status, `provider_work_started` true and false, and
  null and unknown causes: `succeeded + scrap + stopped + deferred = runs`. A cancelled
  run with a null `error_code` is `stopped`, not scrap. A literal error code `other`
  does not collide with `otherCount`.
- **Settle and windows.** `asOf` is before the clock by the settle, the edge buckets are
  flagged partial and left out of the limits, a run newer than `asOf` is not counted,
  and `previous` covers the window before.
- **Throughput.** A done issue counts in the bucket of `completed_at`. A reopened issue
  does not count. A hidden issue and a conversation issue do not count. The origin
  split sums to the total.
- **Runs per done issue.** The cohort counts every run of the issue with
  `finished_at <= asOf`. Runs without an issue go to `unattributedRuns`. A cohort under
  3 gives a null point. A cohort before `dataFrom` is marked incomplete.
- **Restart split.** Cases: a loss inside a window plus the grace; one after it; a
  `started` entry with a later `stopped` entry; one with an `expiresAt` and no stop; one
  with neither (the 60 minute rule, counted in `windowsOpenEnded`); two `started`
  entries and one `stopped`; a `stopped` entry that says nothing was active; a company
  created during a drain; a loss with no drain at all (outside).
- **Company isolation.** Company A never sees company B in any field, through the API
  and the CLI.
- **Authorization matrix** of 5.2, with all six rows.
- **Cost.** Reported cost only, null when no run reported, the estimate never added, and
  `perDoneIssueMicros` equal to the cohort cost over the cohort size.
- **Parity.** Every OpenAPI path under `/observability/flow` has a CLI command and a
  UI client method, and the OpenAPI route test passes.
- **Evidence.** The EXPLAIN script output for 30 days at the chosen size is in the pull
  request, for the issues scan, the cohort join, the drain lookup and the anti-join.

**F2** is checked in a real browser at desktop and mobile widths with zero console
errors, with a company that has a signal and one that has no data.

## 9. Alternatives considered

| Option | Why not |
|---|---|
| Add rollup tables | The earlier measurement showed no need, and the observability plan set the trigger. A rollup is a second copy to keep right |
| Read `heartbeat_runs` for scrap and for fresh data | A much larger table, and the cause classification would run again in the request. F0 makes the usage record complete instead, and the settle rule costs 11 minutes of staleness |
| Extend the #28 stats route | It counts by creation time and per agent against a cap. Different question, different axis |
| Limits from a baseline period by default | Better at catching a shift, but a second query and two bucket sizes. Kept as an option |
| Put the card data in the dashboard summary | The dashboard route has the weaker guard, and this data has per run detail (5.2) |
| A rate as the only scrap view | Hides a rise in volume. The count and the rate are both shown |
| End a drain window 24 hours after its start when it has no stop | In a normal restart the stop never comes, so a day of crash losses would count as planned |

## 10. Open questions

Each has a recommendation. The slice plan assumes it.

- **Q1. Where the limits live.** Server (recommended), reader, or both. See 4.5.
- **Q2. The baseline for the limits.** The window's own buckets (recommended). The
  previous period is an option for F3.
- **Q3. What counts as scrap.** By status: `failed`, `timed_out` and `interrupted`.
  Every `cancelled` run is `stopped` or `deferred`, never scrap (recommended). #28's
  "unsuccessful" is failed, cancelled and timed out, so it counts cancels and leaves
  interrupted runs out. The two will differ, and the plan says why.
- **Q4. What "done" means.** The current state with `completed_at` (recommended). A
  reopened issue drops out of the past. An event based count from the activity log
  would keep history but is heavier and depends on entry shapes.
- **Q5. Which issues count.** The board's list rule: visible, no conversation issue,
  no idle Slack issue (recommended). F1 must read that rule again at implementation
  time, because it is a query condition and not a named policy.
- **Q6. The cost source.** Reported cost from the usage records, with `basis` and
  `coverage` (recommended), or the billing ledger, which matches the dashboard but has
  no per run link in the same shape.
- **Q7. An index on `issues`.** None unless the measured evidence needs it, and then a
  concurrent partial index as its own commit (recommended).
- **Q8. The #73 dependency and the 11 minute staleness.** Wait for #73 and accept the
  staleness (recommended). The alternatives are to extract the shared window helpers
  into F1, and to read `heartbeat_runs` for the tail.
- **Q9. Pull request #62 (`estimateTokens`).** The brief names it. None of the four
  metrics uses tokens, so I recommend that this plan does not depend on it. A later
  metric such as tokens per done issue should read the reported tokens first.
- **Q10. Agents and cost.** Every actor that can read run telemetry can read cost here
  (recommended, for consistency with the costs routes). A later plan can add field level
  limits. Say if cost should be board only.
- **Q11. The deploy window.** Drain entries with the end rules of 3.4 and a 30 minute
  grace now (recommended). A hot restart shows as unplanned. A run level marker from the
  planned restart plan would replace the time window, and `server_boot_events` would
  also catch restarts without a drain.
- **Q12. Widening the usage record to `interrupted` runs (slice F0).** Do it before
  F1 (recommended). It is a change to merged code, with a version bump and a rederive.
  The alternative is to read `heartbeat_runs` for interrupted runs, which adds a second
  source and the large table to every request.

## Appendix A. Code anchors

On `main` at `38819d350`:

| Fact | `file:line` |
|---|---|
| Usage record columns | `packages/db/src/schema/run_usage_records.ts:24` (`issue_id`), `:38` (`is_retry`), `:43` (`status`), `:44` (`error_code`), `:45` (`cause_family`), `:60` (`cost_micros`), `:62` (`cost_status`), `:66` (`finished_at`), `:67` (`day`) |
| Usage record indexes | `run_usage_records.ts:86` (company, finished, run), `:96` (company, issue) |
| Statuses that get a record | `packages/shared/src/run-usage-record.ts:30` and `:31` (`RUN_USAGE_TERMINAL_STATUSES`); `server/src/services/run-usage-record-derive.ts:175` (returns null for any other status); `server/src/services/run-usage-records.ts:160` (the scan filter) |
| Deferral flag | `server/src/services/run-usage-record-derive.ts:61` (`DEFERRAL_ERROR_CODES`), `:222` (`providerWorkStarted`) |
| Settle delay | `server/src/services/run-usage-records.ts:43` (`RUN_USAGE_SETTLE_MS`) |
| Closed failure causes | `packages/shared/src/run-failure-cause.ts:6` (list), `:7` and `:8` (restart losses), `:17` and `:18` (deliberate stops), `:33` (shutdown mapping), `:196` (fall through to `unknown`). No mapping for `orphaned_running_run` |
| Where interrupted runs come from | `server/src/services/heartbeat.ts:15599` (`server_shutdown_interrupted`); `:20462` (`process_lost`, status failed); `server/src/services/recovery/service.ts:6076` and `:6077` (`orphaned_running_run_issue_terminal`, `orphaned_running_run`) |
| Issue completion | `packages/db/src/schema/issues.ts:44` (`status`), `:88` (`completed_at`), `:106` (the only status index) |
| `completed_at` set and cleared | `server/src/services/issues.ts:322`, `:10236` (set); `:10950` (cleared on a non-done status) |
| Board issue list rule | `server/src/services/issues.ts:7935` to `:7943` (`visibleIssueCondition`, no conversation issues, `nonIdleSlackIssueCondition`) |
| Observability route guard | `server/src/routes/observability.ts:13` (route), `:16` (`assertCompanyScopeReadAllowed`) |
| Costs route guard | `server/src/routes/costs.ts:76` and `:77` |
| Run telemetry guard | `server/src/routes/agents.ts:1172` (`assertRunTelemetryReadAllowed`) |
| `company_scope:read` has no permission key | `server/src/services/authorization.ts:167` (inside the group that returns null) |
| Deny blocks that list `company_scope:read` | `authorization.ts:1033` (low trust), `:1217` (task bridge keys), `:1287` (skill-test tokens). Viewers: `:1855` |
| Dashboard route and cost source | `server/src/routes/dashboard.ts:27`; `server/src/services/dashboard.ts:92` (month spend from `cost_events`) |
| Drain markers | `server/src/routes/instance-settings.ts:343` (`started`), `:346` to `:349` (`startedAt`, `expiresAt`), `:396` (`stopped`) |
| Drain state in memory, optional expiry | `server/src/services/heartbeat.ts:1411` (`taskDrainState`); `packages/shared/src/validators/instance.ts:127` (24 hour cap), `:130` (`ttlMs` nullable) |
| Activity log indexes | `packages/db/src/schema/activity_log.ts:23` (company, created), `:35` (entity type and id) |
| Migration safety for indexes | `packages/db/src/check-migration-safety.ts:18` (`large-create-index-not-concurrently`) |
| Table size estimates | `packages/db/src/table-size-estimates.ts:41` (`issues`), `:34` (`heartbeat_runs`) |
| Card component | `ui/src/components/MetricCard.tsx:14`; `ui/src/pages/Dashboard.tsx:22` |

In open pull requests (not on `main`):

| Fact | `file:line` |
|---|---|
| #28 at `ad969df8b`: stats route | `server/src/routes/agents.ts:7154` |
| #28: stats service and daily cap usage | `server/src/services/heartbeat.ts:32005` (`runStats`), `:17807` (`computeDailyRunUsage`) |
| #28: window limit and query schema | `packages/shared/src/validators/heartbeat-run.ts:5` (90 days), `:52` |
| #73 at `0d197569a`: report groups, issue filter and hourly cap | `packages/shared/src/observability-query.ts:6` (groups), `:10` and `:26` (`issue`), `:56` (`issueId`), `:40` (hourly cap) |
| #73: report query builder | `server/src/services/run-usage-query.ts:186` (`buildReportQueries`) |
| Planned restart plan: the 24 hour evidence, drain route and the two-stop gap | `doc/plans/2026-10-10-planned-restart-drain-and-resume.md:14` to `:19`, `:70` (pull request #103) |
