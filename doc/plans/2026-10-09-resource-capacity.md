# Resource capacity: host CPU, memory and disk for the instance and its workers

Status: plan, revision 3 (2026-10-09), after independent review rounds 1 and 2, with per-metric levels from building slice 1. Owner: resource-capacity track.
"Resource capacity" means host resources (disk, memory, load). It is not
provider capacity (model quota, `provider_quota`, PR #12) and not agent run
slots (`maxConcurrentRuns`).

## 1. Problem and evidence

Operators and agents cannot see whether the instance or a worker has room
for another run, and Paperclip starts runs whatever the host state is.

Observed on 2026-10-09 (one self-hosted deployment, numbers rounded):

- A development host filled its disk (`ENOSPC`). Every agent session on it
  failed.
- On one SSH worker, disk use went from 88% to 92% in 12 minutes and tripped
  an operator's merge hard stop.
- In both cases people found out by running `df` and `du` over SSH by hand.
  Paperclip kept starting runs onto the full disk.
- Load averages of 33 to 45 killed or flaked test runs. Runs were lost as
  `process_lost` and `orphaned_running_run`.
- PR #44 measured the main disk consumer on workers: run directories, about
  35 runs and 17 GB per hour on one worker.
- On a production instance host (measured read-only by its operator), the
  two steady disk consumers are run logs and deploy backups. Run logs
  (`data/run-logs`, NDJSON) grow about 142 MB a day: 853 MB in 6 days,
  2,218 files, median 259 KB, largest 10 MB. Nothing prunes them. Each
  deploy writes a pre-deploy database backup of about 4.6 GB, in one step.

What `main` has today (verified at `4fefdc432`):

- One free-space guard: `assertWorkspaceManifestDiskSpace`
  (`packages/adapter-utils/src/workspace-manifest.ts:14-25`, `statfsSync`
  against `PAPERCLIP_WORKSPACE_MANIFEST_MIN_FREE_BYTES`). It is a point
  check during manifest writes, not a metric. Nothing reads `os.freemem`
  or `os.loadavg`.
- `/api/health` (`server/src/routes/health.ts`) reports no host resources.
- Run admission (`startNextQueuedRunForAgent`, `heartbeat.ts:20604`;
  `claimQueuedRun`, `:17432`) checks budget, daily caps, pause holds,
  dependencies, staleness and chat control. It never checks resources.
- `environments` has no capacity fields. `environments.status` is only
  `active` or `archived`. Probes (`POST /environments/:id/probe`) are not
  stored.

## 2. Scope decisions (the challenge)

| Asked | Decision | Why |
|---|---|---|
| A monitoring product | **No.** One small samples table, latest snapshot, on-read bucketing. No TSDB, no exporter, no dashboards beyond two panels. | Only data that drives a decision: admission, "why deferred", "is there room", disk-full projection, trend for planning. |
| CPU, memory, disk | **Disk free** per root, **memory available**, **load per core**, **CPU count**. | These four explain every 2026-10-09 failure. |
| Per-run process RSS | **Not built.** | Agent CLIs fork process trees, so the root pid's RSS undercounts. A tree walk on macOS needs a `ps` spawn per sample. It feeds no admission decision. Revisit if memory deferrals turn out to need a per-run estimate. |
| History with rollups | **Raw samples, bounded retention (30 days), bucketing on read.** No materialized rollup table. | Size is small (section 5.5: under 10k rows per target per 30 days). A rollup job is code to maintain for no measured need. If a read is slow at real sizes, add rollups then. |
| Audit events | **Events only** in `activity_log`: threshold crossed or recovered, disk-full projected, run deferred, run resumed, run admitted despite a critical level (warn mode). Samples never go to the audit log. | The audit log stays readable. |
| Scheduler acts, agents read | **Yes.** Admission defers. Agents and members read numbers through API and CLI. No agent-facing placement. | As asked. |
| Placement / repartition | **Not built.** | See section 9: each run resolves exactly one environment from a fixed chain. No company has a set of eligible environments to choose from. |
| Workers | **No daemon, no extra SSH session per run.** The probe rides on the SSH command that lease acquire already runs. A slow sweep adds at most one SSH command per environment per interval. | As asked. Fail-open everywhere. |

## 3. Data path classification (AGENTS.md section 5 item 7)

None of the three named paths. This is a **separate instance-local
database path**: host readings and capacity state in two new tables, and
audit events in the existing `activity_log`. Nothing is sent to a Paperclip
endpoint and nothing is emitted as an OpenTelemetry span.

- Not **Telemetry**: no import from `packages/shared/src/telemetry/`, no
  change to the generated contract.
- Not **Observability**: no change to `server/src/instrumentation.ts`, the
  span allowlist, or `doc/observability.md`.
- The two new tables are not the **run log** (`heartbeat_run_events`).
  Slice 3 does touch the run log: it appends two lifecycle rows per held
  run (deferred, resumed) through `appendRunEvent`. That part is a run-log
  change and needs no extra review under the same rule.

Review treatment: ordinary code review. No Telemetry privacy review (nothing
leaves the instance) and no span-allowlist review. The isolation rules of
section 7 are the privacy boundary; the route tests prove them. AGENTS.md is
not edited; the PRs state this classification.

## 4. Targets and what is measured

Two kinds of target:

| Target | Where it runs | Disk roots | Memory, load, CPUs |
|---|---|---|---|
| `instance` (one per server host, keyed by hostname) | in-process | `data` (instance root), `runLogs` (`RUN_LOG_BASE_PATH` or `<root>/data/run-logs`), `workspaces` (`<root>/workspaces` and `<root>/projects`), `backups` (slice 2: `PAPERCLIP_DB_BACKUP_DIR` or `<root>/data/backups`, the server's `databaseBackupDir`) | host |
| `environment`, driver `local` | same host as the instance | `workspaces` of the instance sample | instance sample |
| `environment`, driver `ssh` | remote, through the driver's existing SSH command | the environment's `remoteWorkspacePath` | remote host |
| `environment`, driver `sandbox` or `plugin` | not sampled | none | none |

Sandbox and plugin environments report `status: "unsupported"`. They are
ephemeral or provider-managed; sampling them needs a lease. They are a
follow-up if a provider exposes quota through its plugin.

Roots on the same filesystem (same `st_dev`) are reported once, with all
their labels.

`runLogs` and `backups` are named roots because they are the instance's
steady disk consumers (section 1). Usually they share the `data`
filesystem and appear as labels of that one disk; a separate mount shows
on its own. With `backups` the closed label set has 4 entries, which
is the samples table's limit of 4 disks (section 5.2). Unverified: the
deploy tooling is not in this repo, so it is not known that the pre-deploy
backup is written to `databaseBackupDir`. If the operator confirms another
location, slice 2 adds that path to the `backups` root; until then no new
setting is added.

This track reports and projects disk use. It never deletes run logs,
backups or run directories (section 14).

Per sample:

- `cpuCount`: `os.availableParallelism()` locally; `nproc` (fallback
  `getconf _NPROCESSORS_ONLN`) remotely.
- `load1`, `load5`, `load15`: `os.loadavg()`; remotely `/proc/loadavg`.
  Load per core is derived on read.
- `memTotalBytes`, `memAvailableBytes`: on Linux, `MemTotal` and
  `MemAvailable` from `/proc/meminfo` (same parser for local and remote).
  If a cgroup v2 memory limit is set for the server process
  (`/sys/fs/cgroup/memory.max` is not `max`), available is
  `min(MemAvailable, memory.max - memory.current)`. On macOS (development
  only) `os.freemem()`, which undercounts reclaimable memory; the panel
  says so.
- `disks[]`: `{ labels, totalBytes, freeBytes }` from `fs.statfs`
  (`bavail * bsize`, the space an unprivileged process can use) and,
  remotely, `df -Pk` on the workspace root.

### 4.1 Remote probe

One fixed POSIX `sh` script, `LC_ALL=C`, each line tagged so parsing does
not depend on output order:

```sh
echo "rc:nproc $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
echo "rc:loadavg $(cat /proc/loadavg 2>/dev/null)"
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null | sed 's/^/rc:/'
df -Pk . 2>/dev/null | tail -n 1 | sed 's/^/rc:df /'
```

- **At lease acquire:** `ensureSshWorkspaceReady` already runs
  `mkdir -p <root> && cd <root> && pwd` once per run. It gains an option
  that appends
  `&& { printf '\n<marker>\n'; { { <probe>; } 2>/dev/null | head -c 16384; } 2>/dev/null; true; }`.
  The marker is `__paperclip_rc_<16 hex>__`, random per command
  (`node:crypto`), so a workspace path that contains a marker-like line
  cannot cut `remoteCwd`; anything that is not that shape is refused before
  it reaches shell text.
  `head -c` bounds the probe's output to the parser cap on the worker, so a
  hostile or broken host cannot push the command past `runSshCommand`'s
  128 KB `maxBuffer` (which would reject the acquire). `remoteCwd` is the
  text before the **first** marker, so nothing the probe prints can change
  it.
  The probe runs only after `pwd` succeeds, so a failing `mkdir` or `cd`
  still fails the command with its own status (a `; ... || true` suffix
  would have turned that failure into success with an empty `remoteCwd`).
  The existing `pwd` output is everything before the marker, so `remoteCwd`
  is unchanged. A probe failure cannot fail the command. Login profiles are
  already sourced with output sent to `/dev/null` (`ssh.ts:1287-1292`), so
  they cannot inject text before the marker. (A worker whose login shell's
  startup files echo to stdout would already break `remoteCwd` today; that
  is unchanged and out of scope.) The probe runs inside the acquire's
  existing 15 s timeout: it reads `/proc` and runs one `df` on the
  filesystem `cd` just entered, so the added time is small, but a hung
  filesystem now fails the acquire inside `df` rather than later in the run.
  A test proves that a root that cannot be created still fails the acquire
  with the probe on. The reading is
  recorded (section 5.3) after the lease row is written, not awaited by the
  run; a recording error is logged and dropped. Recording updates the
  target's latest state on every acquire but appends a history row at most
  once per 5 minutes per target, so the history size does not grow with the
  run rate.
- **Slow sweep:** each sweep pass runs the probe as one `runSshCommand`
  (`cd <root> && <probe>`, timeout 10 s) for an SSH environment only when
  it has an active lease, or its effective level is not `ok` (read with
  freshness, so a stale `ok` counts as `unknown` and is swept again), or it
  has runs held for capacity (slice 3). The probe resolves the
  environment's secrets under the company of its latest lease, active or
  released. An environment that was never leased has no such company: it is
  claimed but not probed, and stays `unknown` until its first run's
  lease-acquire probe. Interval per environment: 5 minutes, or 60 seconds
  while the level is `critical` (so held runs resume quickly). Before
  probing, a process claims the environment with a compare-and-set on
  `resource_capacity_targets.next_sweep_at` (section 5.1); only the process
  whose update returns a row probes, so several server processes never
  probe the same environment in the same interval. A reading taken at lease
  acquire moves `next_sweep_at` forward the same way. Environments are
  probed one at a time per pass.
- **Workers without `/proc`** (macOS, BSD) report CPU count and disk only.
  Their readings are `partial`; the disk is classified and can hold runs,
  memory and load show as unknown (section 6.1). The real-sshd fixture runs
  on macOS, so it is the end-to-end test of this case.
- **Parsing is defensive:** the output comes from a host Paperclip does not
  control. Only tagged lines are read; each value must be a finite
  non-negative number in range (`free <= total`, `total > 0`, at most 4096
  CPUs); unknown lines are ignored; output that reaches the 16 KB cap is
  discarded whole, because the worker's `head -c` may have cut its last line
  mid-number. The raw
  output is never stored. A sample with any missing metric has
  `status: "partial"`; a failed command stores `status: "failed"` and a
  bounded error class (`timeout`, `auth`, `exit_<code>`), never stderr.
- The probe uses `config.remoteWorkspacePath` through the existing
  `shellQuote`. The script has no other input.

### 4.2 Instance sampler

An in-process interval (default 60 s, `PAPERCLIP_RESOURCE_CAPACITY_SAMPLE_INTERVAL_MS`,
minimum 15 s, `unref`'d, cleared on shutdown) samples the instance and
records it through the same path as every other reading (section 5.3). It
runs in every server process,
including those with `HEARTBEAT_SCHEDULER_ENABLED=false`, because reads and
the recovery wake (section 8.2) need it. The same interval drives the SSH
sweep and, once an hour, retention.

Each process samples its own host, keyed by a hash of its hostname (the
hostname itself is stored only in the admin-only `host_label`). A `local`
environment's runs execute on the process that claims them, so admission
for a local run reads the instance row of that process's host.

## 5. Data model

Two tables (migration `0297`, regenerated if another lands first). Neither
has a `company_id`: environments are instance-wide
(`packages/db/src/schema/environments.ts:4-30`). Company scoping is enforced
at read time (section 7).

A **target key** names what is measured: `instance:<hostname>` or
`environment:<environment id>`.

### 5.1 `resource_capacity_targets`: latest state, one row per target

| Column | Type | Notes |
|---|---|---|
| `target_key` | text pk | |
| `target_kind` | text not null | `instance` or `environment` |
| `environment_id` | uuid null unique, fk `environments.id` on delete cascade | |
| `host_label` | text null | hostname for `instance`; instance admins only |
| `latest_sampled_at` | timestamptz null | |
| `latest_status` | text null | `ok`, `partial`, `failed` |
| `latest_reading` | jsonb null | the metrics of section 4, numbers and closed-set labels only |
| `metric_levels` | jsonb not null default `{}` | level per metric: `disk:data`, `disk:runLogs`, `disk:workspaces`, `memory`, `load`; each `ok`, `low` or `critical`; the authority for admission |
| `metric_sampled_at` | jsonb not null default `{}` | when each metric was last measured; a metric older than 15 minutes is ignored (6.1) |
| `level` | text not null default `unknown` | worst of `metric_levels`, kept for listing and sorting |
| `state_version` | integer not null default 0 | incremented on every level change; the compare-and-set token (5.3) |
| `level_changed_at` | timestamptz null | |
| `next_sweep_at` | timestamptz null | sweep claim (section 4.1) |
| `last_history_at` | timestamptz null | history rate limit (5.3) |
| `updated_at` | timestamptz not null | |

It gives every process one place to read the current level and one row to
compare-and-set, so sweeps, history appends and level transitions happen
once across server processes. Slice 2 adds `disk_full_alarms` (jsonb, disk
label to `armed` or `fired`) for the projection event, one state per disk
root (section 6.2).

### 5.2 `resource_capacity_samples`: history

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `target_key` | text not null | |
| `environment_id` | uuid null, fk `environments.id` on delete cascade | |
| `sampled_at` | timestamptz not null | |
| `source` | text not null | `interval`, `lease_acquire`, `sweep` |
| `status` | text not null | `ok`, `partial`, `failed` |
| `error_class` | text null | closed set (`timeout`, `auth`, `exit_nonzero`, `unparseable`), never raw output |
| `cpu_count` | integer null | |
| `load1`, `load5`, `load15` | real null | |
| `mem_total_bytes`, `mem_available_bytes` | bigint null | |
| `disks` | jsonb not null default `[]` | at most 4 entries `{labels: string[], totalBytes, freeBytes}`; labels from a closed set |
| `level` | text not null | level after this reading |

Indexes: `(target_key, sampled_at desc)`; `(sampled_at)` for retention.

### 5.3 Recording a reading

One function records every reading (instance interval, lease acquire,
sweep), in one transaction. A reading carries the time it was taken (for a
probe, when the command returned), not the time it is recorded.

1. Update the target row's latest state only if the reading is newer:
   `update ... set latest_sampled_at = $t, latest_status, latest_reading = latest_reading || $measured, metric_sampled_at = metric_sampled_at || $measuredAt where target_key = $k and (latest_sampled_at is null or latest_sampled_at < $t) returning *`.
   No row means a newer reading is already recorded; the reading is
   dropped (no level change, no history). The update locks the row until
   commit, so recordings of one target apply one at a time, in time order,
   and step 2 sees committed levels. A partial reading merges: values it
   lacks keep their last value and their old `metric_sampled_at`.
2. Compute the new per-metric levels from the reading and the returned
   `metric_levels` (hysteresis, section 6.1). If any metric differs, run
   `update ... set metric_levels = $new, level = $worst, state_version = state_version + 1, level_changed_at = $t where target_key = $k and state_version = $read returning`.
   The process whose update returns a row writes the transitions' activity
   entries (section 6.3) in the same transaction, so each transition is
   written exactly once.
3. Append a history row only if the level changed, or if
   `update ... set last_history_at = $t where target_key = $k and (last_history_at is null or last_history_at <= $t - interval '5 minutes') returning`
   returns a row.

A recording error is logged and dropped; it never fails a run or a request.

### 5.4 Run hold (slice 3)

`heartbeat_runs.admission_hold` jsonb null:
`{ kind: "resource_capacity", targetKey, environmentId, environmentName,
metric, label, freePercent, freeBytes, thresholdBytes, thresholdsVersion,
since }`. `thresholdsVersion` is a short hash of the effective thresholds.

The hold is a **record for display, never an authorization**: the gate
re-evaluates on every claim attempt (section 8.2). It exists so run lists,
the issue run ledger and agents can show "deferred: disk 96% used on
worker-a" without a join. It is written with
`update ... set admission_hold = $hold where id = $id and status = 'queued' and (admission_hold is null or admission_hold->>'targetKey' <> $k or admission_hold->>'metric' <> $m or admission_hold->>'thresholdsVersion' <> $v) returning id`,
so repeated passes and several processes write it once per distinct cause.
The hold update, its run event and its activity entry are written in one
transaction, and the entries only when the update returns a row, so a crash
leaves either all three or none. The claim update that moves the run to
`running` sets it to null; the resumed entries are written in the claim's
transaction. Readers show the hold only while the run is `queued`.

A dedicated column is used because the existing ones mean something else
(`nextAction` and `livenessReason` are written by liveness classification
at finalization; `errorCode` marks failures).

### 5.5 Size

History grows by at most one row per target per 5 minutes plus level
changes, whatever the run rate (lease-acquire readings at 35 runs per hour
update `resource_capacity_targets` but add no rows). That is about 8,640
rows per target per 30 days, about 300 bytes each: ten targets stay under
100k rows and about 30 MB with indexes. The targets table has one row per
target.

### 5.6 Retention

`PAPERCLIP_RESOURCE_CAPACITY_RETENTION_DAYS`, default 30, minimum 1. Once an
hour one process (the one whose `pg_try_advisory_xact_lock` on a fixed key
succeeds) deletes history rows older than that in batches of 5,000
(`delete ... where id in (select id ... where sampled_at < $cutoff order by sampled_at limit 5000)`),
until a batch deletes fewer. The latest state lives in
`resource_capacity_targets`, so history can be deleted by age alone.

## 6. Levels, thresholds, projection and events

### 6.1 Levels

Each metric has its own level: a disk root (keyed by its first label) or
memory is `critical` when free is below the critical threshold, `low` below
the low threshold, otherwise `ok`. A target's level is its worst metric.
Levels are kept per metric because admission needs to know which metric is
critical (section 8.2: an SSH run is held by the instance `data` root but not
by the instance `workspaces` root).

A reading is `ok` when it has both disk and memory (CPU count and load are
optional), `partial` when it has some metrics, `failed` when it has none.
A reading changes only the levels of the metrics it contains; a metric it
lacks keeps its stored level, so a worker without `/proc` or a dropped
connection never fakes a recovery, and a disk-only reading still raises a
full disk. A `failed` reading changes no level. Freshness is per metric
(`metric_sampled_at`): a metric not measured in the last 15 minutes is
ignored on read, so a `critical` that no reading confirms any more stops
holding runs (fail-open), and a target with no fresh metric is `unknown`.
Level transitions, and therefore events, happen only between `ok`, `low` and
`critical`.

Each threshold is `min(percent of total, absolute bytes)`, so large disks are
not held with hundreds of GB free and small disks are not allowed to reach
zero:

| Metric | Low | Critical (holds runs in slice 3) |
|---|---|---|
| Disk free | min(15%, 20 GiB) | min(5%, 5 GiB) |
| Memory available | min(15%, 2 GiB) | min(5%, 512 MiB) |
| Load5 per core | >= 1.5 (shown, event) | not used for holds |

Examples: a 460 GiB disk is `low` under 20 GiB free and `critical` under
5 GiB free. A 50 GiB disk is `low` under 7.5 GiB and `critical` under
2.5 GiB.

Against a 4.6 GB deploy backup (section 1): on a disk of 134 GiB or more,
`low` (20 GiB) leaves room for about four backups and `critical` (5 GiB)
for about one. On a smaller disk the percentage wins and `critical` can
sit below one backup, so a deploy can hit `ENOSPC` while the root still
reads `low`. No new mechanism: the instance page and CLI show free bytes
on the root, and an operator with a small instance disk raises
`diskCriticalPercent` (section 8.3).

Hysteresis: a metric leaves `critical` only when free is at least 1.25
times the critical threshold, and leaves `low` at 1.1 times the low
threshold. This stops flapping around the line.

Load is informational. The 2026-10-09 load failures came from too many
concurrent runs on one host; the fix for that is a per-environment
concurrency limit, which is a different decision (section 11, D5).

Slice 1 and 2 use these defaults as constants in `packages/shared`. Slice 3
makes the critical thresholds configurable (section 8.3).

### 6.2 Disk-full projection

For each disk root, a least-squares slope of free bytes over the last 6 hours
of `ok` samples, if there are at least 6 samples spanning at least 30
minutes. If the slope is negative, `hoursToFull = freeBytes / -slope`.

Steps are left out of the fit. A deploy backup takes about 4.6 GB between
two history rows (section 1). A 6-hour least-squares fit across such a step
in mid-window reads it as about 1.5 times the step per window, about
1.15 GB an hour, so a root with 25 GB free would project full in under
24 hours after every deploy. So the fit uses only the samples after the last step. A step is a
change between two consecutive rows larger than both `max(1 GiB, 1% of
total)` and 10 times the median absolute change between consecutive rows
in the window. The second condition keeps a steady fast fill (a worker
filling 17 GB an hour, about 1.4 GB per 5-minute row) from being read as
steps. After a step the projection is absent until the minimums above hold
again (about 30 minutes).

A 6-hour basis cannot see slow growth: run logs at 142 MB a day are about
35 MB per 6 hours. So the read model also returns a trend: a least-squares
slope over the daily minimum free bytes of the last 7 days, steps
included (backups that are never pruned are real growth), when at least
2 days of history exist. It gives `trendDaysToFull`, shown on the instance
page and in the CLI, with no event.

The read model returns
`{ label, hoursToFull, basisMinutes, trendDaysToFull, trendBasisDays }`.
Both are computed on read (at most 72 rows per root for the 6-hour fit,
one grouped query for the 7 daily minimums), so they are never stale. A
projection under 24 hours raises an event (6.3); the event re-arms when the projection is
over 48 hours or the root is `ok` again. The alarm state is kept per disk
root in `disk_full_alarms` and changed with a per-label compare-and-set
(`... where target_key = $k and coalesce(disk_full_alarms->>$label, 'armed') = 'armed' returning`),
so one root's alarm never suppresses or re-arms another's.

### 6.3 Activity events (slice 2 and 3)

`activity_log.company_id` is `NOT NULL`, and environments have no company.
A target event is written once per **affected company**: a company with at
least one non-terminated agent whose effective environment (the read-only
resolver of section 8.2) is the target. An
instance-target event goes to every company with an agent, because an
instance root at `critical` (database, run logs) holds every run.

Each transition is written exactly once across server processes: only the
process whose level compare-and-set returns a row writes it, in the same
transaction (section 5.3). The projection event uses the same pattern on
its disk root's entry in `disk_full_alarms`. Events are rare: transitions have hysteresis, and one
affected-company lookup (agents plus instance settings) runs per
transition, not per reading.

| Action | Entity | When | Details (numbers and labels only) |
|---|---|---|---|
| `resource_capacity.threshold_crossed` | `environment` / `instance` | level goes up (`ok`→`low`, `low`→`critical`, `ok`→`critical`) | `target`, `environmentId`, `environmentName`, `metric`, `label`, `from`, `to`, `freePercent` |
| `resource_capacity.recovered` | same | level goes down | same |
| `resource_capacity.disk_full_projected` | same | projection under 24 h (re-arms as in 6.2) | `label`, `hoursToFull`, `freePercent` |
| `heartbeat.run_deferred_resource_capacity` | `heartbeat_run` (with `runId`, `agentId`) | a queued run is held for a new cause (slice 3, enforce; written once per cause, section 5.4) | the hold |
| `heartbeat.run_resumed_resource_capacity` | same | a held run is claimed | `heldSeconds` |
| `heartbeat.run_admitted_despite_resource_capacity` | same | warn mode: a run starts while its target is `critical` | the would-be hold |

`actorType: "system"`, `actorId: "resource_capacity"`. No hostnames, paths,
process lists or other companies' data in any entry. The run also gets one
`heartbeat_run_events` lifecycle row for deferred and resumed.

## 7. Surfaces and access (web, API, CLI parity)

Routes say "resource-capacity" to avoid confusion with provider capacity.

| Surface | Instance view | Company view (agents use this) | Environment detail with history |
|---|---|---|---|
| API | `GET /api/instance/resource-capacity` | `GET /api/companies/:companyId/resource-capacity` | `GET /api/environments/:id/resource-capacity?since=24h&bucket=auto` |
| CLI | `paperclipai capacity --instance` | `paperclipai capacity [-C <companyId>]` | `paperclipai environment capacity <id> --since 24h` |
| Web | Instance settings page "Resource capacity" (hosts, all environments, levels, projections, recent transitions) | Environments page: a capacity line per environment | Environment capacity panel with sparklines (disk free, memory available, load per core) |
| OpenAPI | `INSTANCE_ADMIN_OPERATIONS` | board or agent | board or agent |

Access:

- **Instance view:** `assertInstanceAdmin`. It includes host labels, root
  paths and every environment.
- **Company view and environment detail:** a board member of the company,
  or an agent of the company (any agent; reading numbers needs no extra
  permission), for the environments the company **can use**: the effective
  environment (the resolver of section 8.2) of each of the company's
  non-terminated agents. Instance admins
  can read any environment. Anything else returns `404`, the same body as a
  missing environment. Responses carry numbers, labels (`workspaces`), the
  level, the projection and the environment's name and driver. No paths,
  hostnames, process lists, leases or runs of other companies.
- This is narrower than today's environment read rule (any board member reads
  every environment's redacted config, and agents get `403`). It matches the
  isolation asked for; see D2.

History: `since` accepts `1h` to `30d` (default `24h`). Points are bucketed
on read (`bucket=auto` picks 5 min up to 24 h, 1 h up to 7 d, 6 h beyond), at
most 400 points, each `{ t, diskFreeBytesMin per label, memAvailableMin,
load5PerCoreMax }`. The worst value per bucket is kept, because a headroom
graph that averages hides the dip that failed the run.

`/api/health` gains nothing new except for instance admins and the local
board, who get `resourceCapacity: { level, sampledAt }` (no numbers), so a
health check can alert on `critical`.

Line format for exports: none in v1. If a capacity export is added later it
uses the observability track's NDJSON envelope (`kind`, integer `v`, ISO-8601
UTC, base64url cursor), agreed with that track.

## 8. Resource-aware admission (slice 3)

### 8.1 Where

Inside `claimQueuedRun` (`heartbeat.ts:17432`), right after the last gate
that cancels a run (agent gone, not invokable, budget, daily caps, pause
hold, blocked dependencies, staleness, ending near `:17585`) and **before
all three updates that move a run from `queued` to `running`**: the
queued-comment claim transaction (`:17821`), the native-review assignment
claim (`:17920`) and the ordinary claim (`:17987`). On a hold it returns
`null` and leaves the run `queued`, like the existing "native owner still
settling" gate (`heartbeat.ts:17485-17499`). Tests cover each of the three
branches.

- Every path that turns a queued run into a running one goes through
  `claimQueuedRun`: `startNextQueuedRunForAgent` (wakes, scheduled-retry
  promotion, #52's deferred-wake re-delivery, `resumeQueuedRuns` on each
  30 s tick) and the defensive `queued` branch of `executeRun`
  (`heartbeat.ts:20877-20884`). A gate in `startNextQueuedRunForAgent`
  alone would miss that branch.
- The gate reads shared database state (section 5.1), so two server
  processes reach the same decision; `withAgentStartLock` is in-process only
  (`agent-start-lock.ts:3-45`) and is not relied on. Capacity is a soft
  signal, so a reading that changes between the gate and the claim update
  is acceptable; the claim update itself stays the existing atomic
  compare-and-set.
- A run that a cancelling gate would cancel is cancelled, not held. The
  chat-control decisions inside the claim branches run after the hold, so a
  queued-comment run that chat control would discard is held first and
  decided when capacity recovers; a held run does no work, so the delay
  changes nothing else.
- The other `executeRun` callers are native restart recovery and session
  resume of runs already `running`; they never pass through the claim and
  are not gated, because holding them would strand started work.

Why not copy `WorkspaceBusyDeferral` (post-claim cancel plus scheduled
retry): it cancels the claimed run and creates a new retry run every 60 to
120 seconds. A cancelled run keeps its `startedAt`, so it counts toward
`maxDailyRuns` (`getHeartbeatDailyCapBlock` excludes only `queued` and
`scheduled_retry`). An hour of full disk would create 30 to 60 cancelled
runs per waiting issue and could spend an agent's daily cap. Holding
before the claim uses no slot, no issue lock, no daily-cap count, and no
new rows.

### 8.2 How

1. **Target.** Extract the environment resolution of `executeRun`
   (`heartbeat.ts:21900-22011`: agent default, company default, instance
   default, local; the managed-sandbox redirect; forced Kubernetes) is
   resolved by a read-only resolver in the capacity service, built from the
   same pure functions `executeRun` calls (`resolveExecutionWorkspaceEnvironmentId`,
   `resolveCompanyEnvironmentDefault`, `isExecutionForcedToKubernetes`) and
   the environment service's read-only finders. `executeRun` is not
   restructured: its side effects (`ensureLocalEnvironment`, lazy
   Kubernetes provisioning) stay where they are, and a test pins the
   resolver to the same cases. Sandbox and plugin targets are not gated.
   The result is cached per agent for 15 s.
   **No target.** The resolver returns no environment where `executeRun`
   would create one or fail: forced Kubernetes before the company's managed
   Kubernetes row exists (lazy provisioning), or managed-sandbox-only with no
   managed row. Both outcomes are `sandbox` environments (or a fail-closed
   run), which are never measured or gated. So a run with no resolved
   target is gated by the instance `disk:data` and `disk:runLogs` rule only,
   exactly as it would be once the sandbox row exists: provisioning cannot
   change the admission decision. The company view lists the Kubernetes
   environment (as `unsupported`) once it exists. If a measurable driver
   ever gains lazy provisioning, this rule must be revisited.
2. **Readings.** From the database, never process memory: the instance
   target row of this process's host and, for an SSH target, the
   environment's row (each cached 15 s). Processes on one host therefore
   decide alike.
3. **Decision.** Hold when the instance `disk:data` or `disk:runLogs`
   metric is `critical` (every driver), or the target's disk or memory
   metric is `critical` (local: the instance `disk:workspaces` and `memory`;
   SSH: the environment's `disk:workspaces` and `memory`). The instance
   `disk:workspaces` and `memory` do not hold SSH runs. The decision is re-evaluated on **every** claim
   attempt from the current target and thresholds. An existing hold never
   authorizes or blocks anything; it is only the record of the last cause.
   So an agent moved to another environment, or a threshold edit, takes
   effect on the next attempt.
4. **Fail-open.** Only fresh metrics count (section 6.1): a metric not
   measured in 15 minutes never holds. A sampling or recording error never
   fails or delays a run.
5. **Enforce mode.** In one transaction, write the hold with the
   conditional update of section 5.4 and, when it returns a row, one run
   event and one `heartbeat.run_deferred_resource_capacity` entry. Return
   `null`.
6. **Warn mode.** Claim as usual; in the same conditional style, write
   `heartbeat.run_admitted_despite_resource_capacity` once per run.
7. **Resume.** The claim update sets `admission_hold` to null. If the run
   had a hold, write one `heartbeat.run_resumed_resource_capacity` entry and
   one run event.
8. **Recovery wake.** Level-based, not only edge-triggered: on every
   sampler tick (every process, section 4.2), select the agents with a held
   run (`select distinct agent_id ... where status = 'queued' and admission_hold is not null`,
   served by a partial index on queued runs with a hold) and call
   `startNextQueuedRunForAgent` for each agent whose hold's target is no
   longer critical by the current fresh metrics, or whose hold names a
   target or metric the gate would no longer pick. A level transition out of
   `critical` triggers the same check at once. Held runs therefore resume
   within one tick of recovery, after a crash between a transition and its
   wake, when failed readings let the `critical` metric go stale, and on
   deployments where every process runs with
   `HEARTBEAT_SCHEDULER_ENABLED=false`, whose interval never calls
   `resumeQueuedRuns` (`server/src/index.ts:1830-1841`). The 30 s tick,
   where enabled, stays a second path.

The hold is per run and target, so one full worker does not block agents
on other environments.

Interaction with other work: #52's deferred-wake sweep still re-delivers
wakes; the resulting queued run meets the same gate. #12's provider-quota
retry lane is unaffected: a held run is `queued`, not `scheduled_retry`,
and is not counted by the daily cap. Task-drain suppression
(`getSchedulingSuppression`) is checked before `claimQueuedRun` is reached,
so it keeps priority.

### 8.3 Configuration

`instance_settings.general.resourceCapacity` (strict zod, all optional):

```ts
{
  admission: "off" | "warn" | "enforce",   // default "warn"
  diskCriticalPercent: number,             // default 5, 1..50
  diskCriticalBytes: number,               // default 5 GiB, >= 512 MiB
  memoryCriticalPercent: number,           // default 5, 1..50
  memoryCriticalBytes: number,             // default 512 MiB, >= 128 MiB
}
```

It is edited through the existing instance general settings API, page and
CLI. Changing it writes the existing instance-settings activity entry. Low
thresholds stay constants.

## 9. Placement: not built

Each run resolves exactly one environment
(`execution-workspace-policy.ts:296-336`, `heartbeat.ts:21900-22011`):

1. the agent's `defaultEnvironmentId`;
2. otherwise the company default (`instance_settings.general.companyEnvironmentDefaults`),
   otherwise the instance default;
3. otherwise the local environment.

The managed-sandbox and Kubernetes rules then override it. Project and issue
`environmentId` fields exist in validators, but run resolution never reads
them. No code has a set of eligible environments for a run, so there is
nothing for headroom-aware placement to choose between: the number of
eligible environments per run is 1 for every company.

Placement needs a new concept (an environment pool per agent or company,
with workspace portability between hosts). That is a product change, not
an admission tweak, and it is out of scope.

**Counting what a deployment has.** The per-run count is 1 by construction.
The per-company count of distinct effective environments (the number a
pool could choose from if one existed) is what the slice 1 company view
returns: it lists the environments the company can use, computed with the
same resolver as admission (section 8.2), including company and instance
defaults and the managed-sandbox and Kubernetes rules. A plain SQL count of
`agents.default_environment_id` would miss the defaults and the overrides,
so it is not used. After slice 1 deploys, `paperclipai capacity -C <company>`
gives the count for each company; if a company shows two or more
environments with real headroom differences, that is the evidence to
reopen placement as its own plan.

## 10. Threat notes

| Threat | Mitigation |
|---|---|
| Cross-company leak through a shared environment | Numbers and labels only; "can use" check (section 7); `404` for others; activity only to affected companies; no hostnames, paths, leases or run ids of others. Tests with two companies on one environment. |
| Instance details to non-admins | Instance route `assertInstanceAdmin`; host labels and paths only there; OpenAPI `INSTANCE_ADMIN_OPERATIONS`. |
| Remote command injection | Fixed script; the only input is `remoteWorkspacePath` through the existing `shellQuote`. |
| Hostile or broken worker output | Output capped at 16 KB on the worker (`head -c`), so `maxBuffer` is never hit; `remoteCwd` taken before the first marker; tagged lines only; numeric range checks; raw output never stored; errors stored as a closed enum. |
| A bad sample blocks all runs | Default `warn`; fail-open on stale, failed or partial; hysteresis; the hold reason names the metric and value, so an operator sees a wrong reading at once; `admission: "off"` turns it off without a deploy. |
| SSH load from sampling | Zero extra sessions at lease acquire; sweep at most one command per environment per 5 minutes (60 s only while critical), serial, 10 s timeout; claimed by compare-and-set so several server processes never probe the same environment in one interval. |
| Duplicate events or rows from several server processes | Level transitions, projection alarms, history appends, sweep claims and run holds are all conditional updates; only the process whose update returns a row writes the event. Tests run two service instances on one database. |
| Unbounded growth | Retention from day one; history at most one row per target per 5 minutes whatever the run rate; latest state in `resource_capacity_targets`. |
| A held run never resumes | The gate re-evaluates on every claim attempt; a recovery transition wakes the held agents directly (section 8.2 step 8), also where the scheduler interval is disabled; stale readings fail open. |
| Agents changing placement or thresholds | Agents read only. Thresholds are instance settings (board, instance admin). |

## 11. Decisions

Decided by the orchestrator 2026-10-09, under the user's autonomy grant;
the user may override.

| # | Decision | Decided |
|---|---|---|
| D1 | Admission default | `warn` is the code default. Switching a deployment to `enforce` is the operator's call, after reviewing 24 to 48 hours of warn entries. Slice 3 adds the count of warn entries (`heartbeat.run_admitted_despite_resource_capacity`) per environment for the last 24 and 48 hours, on API, CLI and web, so the switch rests on data. |
| D2 | Who reads environment capacity | Members and agents of companies whose agents run on the environment; instance admins read everything. A test proves another company is denied. |
| D3 | Instance-root threshold events | Written to every company's audit log, with level and percent only: no paths, hostnames or other companies' data. |
| D4 | Retention | 30 days. |
| D5 | Load-based throttling | Out of this track. A per-environment concurrency limit is proposed separately if the warn data shows it is needed. |

## 12. Slices

Each slice ships web, API, OpenAPI and CLI together with tests.

| Slice | Scope | Size |
|---|---|---|
| **1** | Both tables and the migration, shared types and constants, the recording path with its compare-and-set (5.3), levels with hysteresis, instance sampler, SSH probe at lease acquire and sweep, retention; the read-only environment resolver (needed for "can use"); the three read routes (latest only, no history yet), OpenAPI, CLI `capacity` and `environment capacity`, instance page and environment capacity line; `/api/health` level for admins. | L |
| **2** | History (`since`, bucketing), sparklines, the `backups` disk root, disk-full projection (step-aware 6-hour fit and 7-day trend, section 6.2), the three `resource_capacity.*` activity events with affected-company fan-out. | M |
| **3** | Admission hold before claim, `admission_hold` column, run and activity events, instance setting with `warn` default, the hold reason in run lists, the issue run ledger and run detail; warn-entry counts per environment for the last 24 and 48 hours (D1) on API, CLI and web. | M |
| 4 | Placement: not built (section 9). | none |

Follow-ups, not in this track: PR #44's reaper reads the latest capacity
sample for its disk-pressure mode when the sample is under 10 minutes old,
and keeps its own `df` otherwise (idle workers full of old run directories
are not swept by this track, section 4.1); sandbox
and plugin quota through the plugin SDK; a per-environment concurrency limit
(D5).

## 13. Test plan

Each item is a test that fails before its slice and passes after.

- **Parsers (pure):** `/proc/meminfo`, `/proc/loadavg`, `df -Pk` with
  Linux, BusyBox and macOS output; missing lines give `partial`; hostile
  output (huge numbers, negative, `free > total`, 1 MB of noise) is rejected.
- **Classifier (pure):** thresholds as `min(percent, bytes)`, hysteresis in
  both directions, worst-metric level, metrics a `partial` reading lacks
  keep their level, a `failed` reading changes nothing, stale gives `unknown`.
- **Projection (pure):** steady fill, refill (positive slope gives none),
  too few samples, too short a span; a 4.6 GB drop inside an otherwise flat
  6-hour window gives no projection under 24 hours; a steady fill of
  1.4 GB per row is not read as steps; the 7-day trend of 142 MB a day
  plus a 4.6 GB step every second day gives the expected
  `trendDaysToFull`; under 2 days of history gives no trend.
- **SSH probe:** with the real-sshd fixture (`ssh-fixture.test.ts`,
  `PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1` on macOS): `ensureSshWorkspaceReady`
  with the probe returns the same `remoteCwd` as without; on a worker with
  no `/proc` (the macOS fixture) it still returns `remoteCwd`, CPU count and
  disk; a root that cannot be created still fails the acquire. Local
  `sh` tests (no sshd needed): a probe printing 1 MB is cut to 16 KB and the
  command still succeeds; a marker printed by the probe does not change
  `remoteCwd`; a workspace path that contains a marker-like line keeps its
  `remoteCwd` (also through the real-sshd fixture); a failing `mkdir` or
  `cd` keeps its non-zero status.
- **Service (embedded Postgres):** a history row at most every 5 minutes
  or on a level change, whatever the number of lease-acquire readings; a
  reading older than the recorded one changes nothing; a disk-only reading
  classifies the disk; `critical` followed by failed readings stays
  `critical` for 15 minutes, then reads `unknown`;
  retention deletes in batches; the sweep probes environments that are
  leased or whose effective level is not `ok` (a released lease with no
  reading is probed, a fresh `ok` is not, a never-leased environment is
  claimed but not probed); a sweep failure stores `failed`, keeps the
  level, and does not throw. **Two service instances on one database:** concurrent
  recordings of the same transition write one level change and one set of
  events; concurrent sweeps probe an environment once per interval.
- **Routes:** instance route 403 for non-admins; company route and
  environment detail return `404` for an environment the company cannot use,
  with two companies sharing one environment; agents allowed for their own
  company; responses contain no path or hostname (string scan); OpenAPI
  route test covers the new routes.
- **Events (slice 2):** one projection alarm per disk root (two roots
  filling at once raise two events; one recovering does not re-arm the
  other); one entry per affected company per transition
  (affected = effective environment, including company and instance
  defaults), none on an unchanged level, a `failed` reading, or a metric a
  `partial` reading lacks,
  re-arm rules for the projection, exactly once with two service instances.
- **Admission (slice 3):** a queued run on a `critical` target stays
  `queued` with `admission_hold` and one activity entry, on each of the
  three claim branches (ordinary, queued-comment, native-review); a crash
  between the hold update and its entries leaves neither (one transaction);
  a held run resumes on the next sampler tick after its metric goes stale
  or recovers, with no transition event and the scheduler interval
  disabled; repeated passes and
  a second service instance write nothing more; the `executeRun` queued
  branch is gated too; recovery claims it, clears the hold and writes one
  resumed entry; the recovery wake resumes it with the scheduler interval
  disabled; moving the agent to a healthy environment or raising a
  threshold admits it on the next attempt, and a new critical cause replaces
  the hold; stale and failed readings admit; a run that another gate
  cancels is cancelled, not held; `warn` starts the run and writes one
  entry; another agent on a healthy environment is not held; the daily cap
  is unchanged by a hold; native resume paths are not gated.
- **CLI:** URL and output tests in the style of `operations-parity.test.ts`.
- **UI:** component tests for the panels and the hold label; browser check at
  desktop and mobile widths with zero console errors; `pnpm check:token-gates`.

## 14. Coordination

- **Run-log and backup retention:** owned by the observability track
  (slice 1e) and the session warehouse track (archive, then prune). This
  track reports and projects those roots; it never deletes files.
- **Observability track:** owns run failure causes (including a disk-full
  cause from `ENOSPC`) and usage records. This track owns host sampling. Its
  optional "PR 7: worker free-bytes sampling at the `statfsSync` point" is
  covered here and can be dropped. If a capacity export is added, it uses
  their NDJSON envelope.
- **SSH driver (PR #44, restore track):** the probe changes
  `ensureSshWorkspaceReady` behind an option and adds no session. PR #44
  edits `environment-runtime.ts` and `index.ts` in other regions; whichever
  lands second rebases.
- **#52 (deferred-wake re-delivery):** unchanged; re-delivered wakes create
  queued runs that pass through the same hold.
- **#12 (provider capacity retries):** different meaning of "capacity";
  held runs are `queued`, so its daily-cap accounting is unaffected.
- **#22 (API/CLI coverage matrix):** if it lands first, the new routes get
  CLI commands in the same PR, so the matrix needs no exemption.
- **#38 (lease read scoping):** same "404 for another company's row" rule.
