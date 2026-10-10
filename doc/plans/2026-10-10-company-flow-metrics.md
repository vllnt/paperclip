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

- **Read only.** The report reads existing tables. It writes nothing. So it writes
  no activity entry, and slice F1 needs no migration (section 7 names the one case
  that could).
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
  (section 10, Q9).
- Rollup tables. The observability plan decided to add none until measured
  evidence demands them.
- Targets or service levels. Limits describe what the company does, not what it
  should do.

## 2. What exists today

| Need | On `main` | Gap |
|---|---|---|
| One row of facts per terminal run: status, `error_code`, closed cause, `cost_micros`, `issue_id`, `is_retry`, `finished_at` | `run_usage_records` (pull request #70, merged). Index `(company_id, finished_at, run_id)` and a partial index `(company_id, issue_id)` | Derived after a **10 minute settle** (`RUN_USAGE_SETTLE_MS`), so the newest minutes are missing |
| Closed failure causes | 14 causes in `RUN_FAILURE_CAUSES`. Restart losses are `interrupted_graceful` (a shutdown) and `interrupted_crash` | None |
| When an issue was done | `issues.completed_at`. Set when the status becomes `done`, **cleared when the issue is reopened** | **No index** on `(company_id, completed_at)`. Only `(company_id, status)` exists |
| Run counts by status and `error_code` | **Not on `main`.** Pull request #28 adds `GET /heartbeat-runs/stats` | It counts by **creation time** from `heartbeat_runs`, up to 90 days, with daily cap usage per agent |
| Usage and failure reports with day and hour buckets | **Not on `main`.** Pull request #73 (its base branch was rewritten, so it needs a `rebase --onto`) | Only `day` and `hour` buckets; no issue data; no limits |
| A marker for a planned restart | Activity entries `instance.task_drain.started` and `.stopped`, one per company. Index `(company_id, created_at)` on the activity log | The window end is not stored. The drain route caps the time to live at 24 hours |
| Cost shown to the board today | The dashboard month total comes from `cost_events.cost_cents` | A **different source** from `run_usage_records.cost_micros` |
| A guard for company-wide read data | `assertCompanyScopeReadAllowed` (used by the observability routes). `company_scope:read` has no permission key and task bridge keys are denied | The dashboard route checks `assertCompanyAccess` only |
| A card to show a number | `MetricCard`, `Dashboard.tsx` | No chart with limits |

### Findings

- **F1. Three of the four metrics come from one table.** Runs, scrap and cost all
  read `run_usage_records`. Only throughput needs the issues table.
- **F2. "Done" is the current state.** Reopening an issue clears `completed_at`, so
  an issue that was done in last week's window and reopened since is not counted
  there. This is acceptable if the plan says so (section 3.2).
- **F3. The newest 10 minutes of runs are not derived yet.** A one hour window with
  five minute buckets would show a false drop at its right edge. The plan fixes the
  window end to a settled time (section 3.1).
- **F4. The word "runs" means two things.** Pull request #28 counts runs by when they
  were created. This plan counts terminal runs by when they finished. The two totals
  differ on a live company. The plan names the difference and does not hide it.
- **F5. Cost has two sources.** The dashboard uses the billing ledger. This plan uses
  the per run cost that the run reported. They can differ, and the report says which
  one it shows (section 3.6).
- **F6. The restart split has a marker that works now.** The observability plan
  wanted `server_boot_events` for it (not built). The drain entries already exist and
  cover planned restarts, which is the split that matters.

## 3. Definitions

The report is a contract. Each term is defined once.

### 3.1 Windows and buckets

A window ends at **`asOf`**, not at the wall clock: `asOf = now - settle`, where
`settle` is `RUN_USAGE_SETTLE_MS` plus one worker interval (11 minutes). Every metric
of one response uses the same `asOf`. The response returns it.

| Window | Bucket | Points | Why |
|---|---|---|---|
| `1h` | 5 minutes | 12 | |
| `24h` | 1 hour | 24 | |
| `7d` | 6 hours | 28 | Daily would give only 7 points, too few for limits |
| `30d` | 1 day | 30 | |

Buckets are aligned to UTC. The bucket that contains `asOf` may be partial; it is
flagged `partial: true` and left out of the limit calculation. The windows are a
fixed set. A free range is the job of the #73 reports.

The cost of the settle rule is staleness: the one hour window ends 11 minutes in the
past. The alternative, reading `heartbeat_runs` for the tail, would add a second
source and a much larger table (section 10, Q8).

### 3.2 Throughput

The number of issues with `status = 'done'` and `completed_at` in the bucket. It uses
the board's own visibility rule for issues, so the report counts the issues that the
board lists (section 10, Q5). It is the **current** state: a reopened issue drops out
of the past (F2). The response also gives `byOrigin` (the issue origin kind), so
issues that the system creates are visible and not silently mixed in.

### 3.3 Runs

The number of terminal runs with `finished_at` in the bucket, from
`run_usage_records`. `retryShare` is the part with `is_retry = true`.

### 3.4 Scrap

A **scrap run** is a terminal run that did not succeed and was not a deliberate
stop. In terms of the closed causes: status other than `succeeded`, and cause not
`operator_cancel` and not `control_plane_cancel`. Deliberate stops are reported
separately as `stopped`, so nobody can hide scrap by cancelling.

| Field | Meaning |
|---|---|
| `count` | scrap runs |
| `rate` | `count / runs`. Null in a bucket with fewer than 5 runs (a rate of 1 of 2 is noise) |
| `byErrorCode` | The ten largest `error_code` values and `other`. `error_code` is a length capped identifier |
| `byCause` | The closed cause totals |
| `stopped` | Deliberate stops, by cause |
| `restartLoss` | `{ total, insideDeployWindow, outsideDeployWindow, windowsFound }` |

**Restart loss** is scrap with the cause `interrupted_graceful` or
`interrupted_crash`. It is **inside a deploy window** when its `finished_at` falls
between a drain start and the matching drain stop **plus a 15 minute grace**. The
grace matters because a lost run is finalized when the new process boots, after the
drain has ended. If a start has no stop, the window ends 24 hours after the start,
the longest drain the route allows. A loss with no window around it is *outside*: an
unplanned loss. The windows come from the company's own drain entries, found with the
existing `(company_id, created_at)` index.

### 3.5 Runs per done issue

A cohort measure. For the issues done in the bucket, the mean and median number of
terminal runs that ever ran on each (`run_usage_records.issue_id`, partial index
`(company_id, issue_id)`). It is the effort that it took to deliver, not a ratio of
two window totals, which would mix runs from issues that finish later. Runs with no
issue are left out and shown as `unattributedRuns`. The response gives the cohort
size, because a mean of three issues says little.

### 3.6 Cost

`cost_micros` summed over the terminal runs of the bucket. It is **reported cost**:
the cost a run reported, and null when no run reported one. The response gives
`basis: "reported"` and `coverage` (the share of runs that reported a cost).
`apiEquivalentMicros` is an estimate and is never added to it. `perDoneIssueMicros`
divides the cost of the cohort in 3.5 by its size.

The dashboard month total uses the billing ledger, and the two can differ (F5). The
report says so in its `basis` field, and a test explains the known differences
(window axis, runs without a cost).

### 3.7 Data quality

Each response carries `dataQuality`: `asOf`, the settle in seconds, the derivation
lag from the observability health route, and the number of runs of the window that
still have no usage record. A reader can see when the numbers are late.

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
  to catch it. Worked example below.
- A count cannot be negative, so a lower limit below 0 is shown as 0.
- **At least 8 points** (the partial bucket excluded). Fewer: `limits` is null with
  `reason: "insufficient_data"`. A limit from five points is a guess.
- The response states `method: "xmr.v1"`, so the rules can change later.

### 4.2 Signals

| Rule | Signal |
|---|---|
| 1 | A point beyond a natural process limit |
| 4 | Eight points in a row on the same side of the mean |

F1 implements these two. The two other common rules (two of three points in the
outer third, four of five beyond one sigma) are an extension. Each point in the
response carries the rules it breaks, and the whole series gets a `signals` list.

### 4.3 Series that get limits

Throughput, runs, scrap count, scrap rate (only buckets with a rate), runs per done
issue (the bucket mean) and cost. The mean of an empty cohort is a gap: the point is
null and the series skips it.

### 4.4 Worked fixture

These numbers are the test fixture. Series A is twelve stable points. Series B is A
with the last point replaced by a spike.

| Series | Points | x̄ | mR̄ (after revision) | Upper limit | Lower limit | Signal |
|---|---|---|---|---|---|---|
| A | 12 15 11 14 13 16 12 15 13 14 12 15 | 13.5 | 2.6364 (no range dropped) | 20.5127 | 6.4873 | none |
| B | 12 15 11 14 13 16 12 15 13 14 12 **30** | 14.75 | 2.6 (one range dropped; all ranges give 4.0) | 21.666 | 7.834 | rule 1 on 30 |

Without the revision step, B's limits would be 4.11 and 25.39, and the spike would
sit much closer to the limit. A third series, ten points of counts 0 to 2, has a
computed lower limit of −2.4511, shown as 0. A step series (10 10 11 10 12 12 13 12 13
13 12 13) breaks rule 4.

### 4.5 Where the limits live

| Option | For | Against |
|---|---|---|
| **A. The server computes them** (a pure function in `packages/shared`, called by the report) | One implementation, so the web card, the CLI and an agent show the same numbers. Agents read JSON and need not do statistics. Cheap: at most 30 points per series. Versioned by `method`. Easy to test with a fixed fixture | A reader cannot choose another baseline without a new query option |
| B. Each reader computes them | Flexible for the reader | Three implementations that drift. Every agent that wants the answer must copy the maths |
| C. Both | | The drift problem of B, and the cost of A |

**Recommendation: A.** The response includes `mean`, `mRBar`, the limits and the
dropped ranges, so a reader can verify the result. Readers receive the series and
can compute their own view from it. They do not need to compute these limits.

The limits are computed from **the window's own buckets**. The alternative, a
baseline from the previous period, is better at catching a shift that started inside
the window, but it needs a second query and a rule for two bucket sizes. It is a
query option for a later slice (section 10, Q2).

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
  "dataQuality": { "settleSeconds": 660, "derivationLagSeconds": 42, "runsWithoutRecord": 0 },
  "throughput": { "total": 31, "previous": 27, "byOrigin": { "…": 0 }, "series": [ { "t": "…", "value": 2, "partial": false, "signals": [] } ], "limits": { "method": "xmr.v1", "mean": 1.3, "mRBar": 1.1, "upper": 4.2, "lower": 0, "droppedRanges": 0 }, "signals": [] },
  "runs": { "total": 290, "retryShare": 0.12, "series": [ ], "limits": { } },
  "scrap": { "count": 51, "rate": 0.18, "stopped": { }, "byErrorCode": [ ], "byCause": { }, "restartLoss": { "total": 9, "insideDeployWindow": 7, "outsideDeployWindow": 2, "windowsFound": 1 }, "series": [ ] },
  "runsPerDoneIssue": { "mean": 2.4, "median": 2, "cohortSize": 31, "unattributedRuns": 12, "series": [ ] },
  "cost": { "basis": "reported", "totalMicros": 41200000, "perDoneIssueMicros": 1329000, "coverage": 0.97, "series": [ ] }
}
```

`previous` is the same metric for the window before this one, so a reader sees the
change without a second call.

### 5.2 Authorization: no new permission

| Who | Allowed when |
|---|---|
| A board user | `assertCompanyAccess` and `assertCompanyScopeReadAllowed`, as the observability routes |
| An agent of the company | The same two checks. `company_scope:read` maps to no permission key, so there is nothing to grant. The decision is the company's default |
| An agent of another company | Refused by `assertCompanyAccess` |
| A task bridge key | Refused. The authorization service denies company wide reads for bridge keys |

Two decisions come out of this.

- **The card must call this route and not extend the dashboard summary.** The
  dashboard route checks `assertCompanyAccess` only. Putting flow data in its
  payload would expose it to a weaker check.
- **Cost is visible to every actor that can read the report.** Run telemetry is
  already readable under the same decision, so this is consistent, but it is a
  choice (section 10, Q10).

A test matrix pins the table above: a board member, a viewer, an agent of the same
company, an agent of another company and a bridge key. Each case expects the answer
that `access.decide` gives today. I have not traced the viewer case, so the test
records what it is and the plan changes nothing about it.

### 5.3 CLI

`paperclipai observability flow [--window 1h|24h|7d|30d] [--no-limits] [--json]`.
Without `--json` it prints a table per metric with the current value, the previous
value, the limits and any signals. It uses the same route as the web card.

### 5.4 Web

A **Flow** section on the dashboard, one `MetricCard` row for the four metrics with a
sparkline, the limit band and a signal badge:

- a window switcher (1h, 24h, 7d, 30d), kept in the URL;
- the number, the change against `previous`, and a short sentence for a signal ("above
  the usual range for 3 of the last 24 hours");
- scrap opens a panel with the `error_code` list and the planned versus unplanned
  restart split;
- a link to the #73 reports for drilling down by agent or model.

Web checks follow `AGENTS.md`: token-only styling (`pnpm check:token-gates`), a real
browser at desktop and mobile widths, zero console errors.

### 5.5 Activity log

The report is read only, so it writes no entry. If a later slice stores a saved
view or a threshold, those mutations write entries.

## 6. Cost of the query

| Metric | Shape | Index |
|---|---|---|
| Runs, scrap, cost | One grouped scan of `run_usage_records` for the window, bucketed by `floor(epoch / bucket)` | `(company_id, finished_at, run_id)` |
| Runs per done issue | Done issues of the window joined to usage records by `issue_id` | partial `(company_id, issue_id)` on usage records |
| Throughput | Done issues with `completed_at` in the window | **None on `completed_at`** |
| Restart windows | Drain entries of the company for the window, then a range join | `(company_id, created_at)` on the activity log |

The report uses `floor(epoch / seconds)` for the buckets, which works on every
supported PostgreSQL version, and not `date_bin`.

**Evidence first.** The earlier observability work measured 2,000,000 usage records:
the slowest report took 874 ms and most took under 120 ms. The usage side is covered.
The issues side is not measured. Slice F1 extends the existing EXPLAIN script to the
issues table at a realistic size and applies a budget of **1 second median for the
30 day window**. If the plan misses it, F1 adds a partial index
`(company_id, completed_at) WHERE status = 'done'`. The migration safety check has a rule
(`large-create-index-not-concurrently`) against a plain `CREATE INDEX` on a table it
knows to be large. F1 must read whether `issues` is on that list. If it is, or if the
evidence is close to the budget, the index is created `CONCURRENTLY`, as its own
commit (section 10, Q7).

**The previous window.** `previous` doubles the rows read. The usage side reads one
range that covers both windows (`[since - length, asOf]`) and splits it by bucket
arithmetic, so it stays one scan. The issues side reads the same range once.

**Caching.** The report is read by a dashboard that can poll. A cache of 30 seconds
per company and window, in the process and single flight, keeps repeated reads off
the database. It is not a rollup table and stores nothing.

## 7. Slice plan

| Slice | Scope | Needs |
|---|---|---|
| **F1** | Shared contract; the pure XmR function with the fixtures of 4.4; the service for runs, scrap, restart split, cost, throughput and runs per done issue; `GET .../observability/flow`; OpenAPI; CLI; the EXPLAIN evidence for the issues side (and the index only if it is needed) | #73 merged (its window and bucket helpers), or the helpers extracted (Q8) |
| **F2** | The web card and panel (section 5.4). `MetricCard` shows a number only, so F2 adds a small chart component for the series, the limit band and the signal marks | F1 |
| **F3** | Options: a baseline from the previous period; the two more rules; the signal as an attention item | F1, F2 |

F1 reaches the API and the CLI, and F2 is the linked web follow-up, as the parity rule
allows. If the reviewer prefers, F1 and F2 can be one pull request.

## 8. Verification per slice

Tests are written red first.

**F1**

- **Limits.** The fixtures of 4.4 give the exact values. The revision step drops the
  right range. A series of fewer than 8 points gives `insufficient_data`. A negative
  lower limit is shown as 0. Rule 1 and rule 4 fire on the fixtures and on nothing else.
- **Definitions.** A fixture with every status and cause: scrap excludes
  `operator_cancel` and `control_plane_cancel`, and `stopped` counts them. The scrap
  rate is null under 5 runs. A retry counts in `retryShare`.
- **Settle.** `asOf` is eleven minutes before the clock, the partial bucket is flagged
  and left out of the limits, and a run newer than `asOf` is not counted.
- **Throughput.** A done issue counts in the bucket of `completed_at`. A reopened
  issue does not count. The origin split sums to the total.
- **Runs per done issue.** The cohort counts every run of the issue, whenever it
  finished. Runs without an issue go to `unattributedRuns`. An empty cohort gives a
  null point.
- **Restart split.** A loss inside a drain window plus the grace is *inside*. One
  after the grace is *outside*. A start with no stop ends after 24 hours. Two
  companies with different windows do not mix.
- **Company isolation.** Company A never sees company B in any field, through the API
  and the CLI.
- **Authorization matrix** of 5.2.
- **Cost.** Reported cost only, null when no run reported, and the estimate never
  added.
- **Parity.** Every OpenAPI path under `/observability/flow` has a CLI command and a
  web client method, and the OpenAPI route test passes.
- **Evidence.** The EXPLAIN script output for 30 days at the chosen size is in the
  pull request.
- **Cache.** Two reads inside 30 seconds make one query. Companies and windows do not
  share a cache entry.

**F2** is checked in a real browser at desktop and mobile widths with zero console
errors, with a company that has a signal and one that has no data.

## 9. Alternatives considered

| Option | Why not |
|---|---|
| Add rollup tables | The earlier measurement showed no need, and the observability plan set the trigger. A rollup is a second copy to keep right |
| Read `heartbeat_runs` for fresh data | A much larger table, and the cause classification would run again in the request. The settle rule costs 11 minutes of staleness and gives one source |
| Extend the #28 stats route | It counts by creation time and per agent against a cap. Different question, different axis. Two meanings under one route would confuse |
| Limits from a baseline period by default | Better at catching a shift, but a second query and two bucket sizes. Kept as an option |
| Put the card data in the dashboard summary | The dashboard route has a weaker guard (5.2) |
| A rate as the only scrap view | Hides a rise in volume. The count and the rate are both shown |

## 10. Open questions

Each has a recommendation. The slice plan assumes it.

- **Q1. Where the limits live.** Server (recommended), reader, or both. See 4.5.
- **Q2. The baseline for the limits.** The window's own buckets (recommended), or the
  previous period. The second is an option for F3.
- **Q3. What counts as scrap.** Everything terminal that did not succeed, except the
  deliberate stops `operator_cancel` and `control_plane_cancel`, which are shown
  apart (recommended). The alternative is #28's "unsuccessful" (failed, cancelled and
  timed out), which leaves interrupted runs out and counts operator cancels.
- **Q4. What "done" means for throughput.** The current state with `completed_at`
  (recommended, with the reopen caveat in the response notes). An event based count
  from the activity log would keep history but is heavier and depends on entry shapes.
- **Q5. Which issues count.** The same issues the board lists, with an origin split
  (recommended). I have not read the visibility rule in detail. F1 must read it before
  it fixes the query.
- **Q6. The cost source.** Reported cost from the usage records, with `basis` and
  `coverage` (recommended), or the billing ledger, which matches the dashboard but
  has no per run link in the same shape.
- **Q7. An index on `issues`.** None unless the evidence needs it, and then a
  concurrent partial index as its own commit (recommended).
- **Q8. The #73 dependency and the settle staleness.** Wait for #73 (it needs a
  `rebase --onto` that is not yet authorized) and accept the 11 minute staleness
  (recommended). The alternatives are to extract the shared window helpers into F1, and
  to read `heartbeat_runs` for the tail.
- **Q9. Pull request #62 (`estimateTokens`).** The brief names it. None of the four
  metrics uses tokens, so I recommend that this plan does not depend on it. A later
  metric such as tokens per done issue should read the reported tokens first.
- **Q10. Agents and cost.** Every actor that can read run telemetry can read cost here
  (recommended, for consistency). A later plan can add field level limits. Say if cost
  should be board only.
- **Q11. The deploy window.** Use the drain entries with a 15 minute grace now
  (recommended). `server_boot_events` from the observability plan would also catch
  restarts that skip a drain, but it is not built. The planned restart plan may add a
  marker on the run itself, which would replace the time window.

## Appendix A. Code anchors

On `main` at `38819d350`:

| Fact | `file:line` |
|---|---|
| Usage record columns | `packages/db/src/schema/run_usage_records.ts:24` (`issue_id`), `:38` (`is_retry`), `:43` (`status`), `:44` (`error_code`), `:45` (`cause_family`), `:60` (`cost_micros`), `:62` (`cost_status`), `:66` (`finished_at`), `:67` (`day`) |
| Usage record indexes | `run_usage_records.ts:86` (company, finished, run), `:96` (company, issue) |
| Settle delay | `server/src/services/run-usage-records.ts:43` (`RUN_USAGE_SETTLE_MS`) |
| Closed failure causes | `packages/shared/src/run-failure-cause.ts:6` (list), `:7` and `:8` (restart losses), `:17` and `:18` (deliberate stops), `:33` (shutdown mapping) |
| Issue completion | `packages/db/src/schema/issues.ts:44` (`status`), `:88` (`completed_at`), `:106` (the only status index) |
| `completed_at` set and cleared | `server/src/services/issues.ts:322`, `:10236` (set); `:10950` (cleared on reopen) |
| Observability route guard | `server/src/routes/observability.ts:13` (route), `:16` (`assertCompanyScopeReadAllowed`) |
| Run telemetry guard | `server/src/routes/agents.ts:1172` (`assertRunTelemetryReadAllowed`) |
| `company_scope:read` has no permission key | `server/src/services/authorization.ts:167` (inside the group that returns null) |
| Dashboard route and cost source | `server/src/routes/dashboard.ts:27`; `server/src/services/dashboard.ts:92` (month spend from `cost_events`) |
| Drain markers | `server/src/routes/instance-settings.ts:343` (`started`), `:396` (`stopped`) |
| Migration safety for indexes | `packages/db/src/check-migration-safety.ts:18` (`large-create-index-not-concurrently`) |
| Table size estimates | `packages/db/src/table-size-estimates.ts:41` (`issues`), `:34` (`heartbeat_runs`) |
| Card component | `ui/src/components/MetricCard.tsx:14`; `ui/src/pages/Dashboard.tsx:22` |

In open pull requests (not on `main`):

| Fact | `file:line` |
|---|---|
| #28 at `ad969df8b`: stats route | `server/src/routes/agents.ts:7154` |
| #28: stats service and daily cap usage | `server/src/services/heartbeat.ts:32005` (`runStats`), `:17807` (`computeDailyRunUsage`) |
| #28: window limit and query schema | `packages/shared/src/validators/heartbeat-run.ts:5` (90 days), `:52` |
| #73 at `0d197569a`: report groups and hourly cap | `packages/shared/src/observability-query.ts:6`, `:40` |
| #73: report query builder | `server/src/services/run-usage-query.ts:186` (`buildReportQueries`) |
| Planned restart plan: drain route and the 24 hour cap | `doc/plans/2026-10-10-planned-restart-drain-and-resume.md:70` (pull request #103) |
