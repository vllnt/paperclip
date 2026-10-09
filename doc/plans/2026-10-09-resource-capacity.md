# Resource capacity: host CPU, memory and disk for the instance and its workers

Status: plan, revision 1 (2026-10-09). Owner: resource-capacity track.
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
| History with rollups | **Raw samples, bounded retention (30 days), bucketing on read.** No materialized rollup table. | Size is small (section 5.3: under 10k rows per target per 30 days). A rollup job is code to maintain for no measured need. If a read is slow at real sizes, add rollups then. |
| Audit events | **Events only** in `activity_log`: threshold crossed or recovered, disk-full projected, run deferred, run resumed, run admitted despite a critical level (warn mode). Samples never go to the audit log. | The audit log stays readable. |
| Scheduler acts, agents read | **Yes.** Admission defers. Agents and members read numbers through API and CLI. No agent-facing placement. | As asked. |
| Placement / repartition | **Not built.** | See section 9: each run resolves exactly one environment from a fixed chain. No company has a set of eligible environments to choose from. |
| Workers | **No daemon, no extra SSH session per run.** The probe rides on the SSH command that lease acquire already runs. A slow sweep adds at most one SSH command per environment per interval. | As asked. Fail-open everywhere. |

## 3. Data path classification (AGENTS.md section 5 item 7)

This is an **instance-local** path. Samples and events stay in the instance
database. Nothing is sent to a Paperclip endpoint and nothing is emitted as an
OpenTelemetry span.

- It is not **Telemetry**: no import from `packages/shared/src/telemetry/`.
- It is not **Observability**: no change to `server/src/instrumentation.ts`
  or the span allowlist.
- It follows the **run-log** rule (no extra review): the data stays in the
  instance database, like `heartbeat_run_events`.

Slice 1 adds one additive sentence to AGENTS.md section 5 item 7 that names
the new paths (`packages/db/src/schema/resource_capacity_samples.ts`,
`server/src/services/resource-capacity/`) under the run-log rule, so later
contributors classify them by path.

## 4. Targets and what is measured

Two kinds of target:

| Target | Where it runs | Disk roots | Memory, load, CPUs |
|---|---|---|---|
| `instance` (one per server host, keyed by hostname) | in-process | `data` (instance root), `runLogs` (`RUN_LOG_BASE_PATH` or `<root>/data/run-logs`), `workspaces` (`<root>/workspaces` and `<root>/projects`) | host |
| `environment`, driver `local` | same host as the instance | `workspaces` of the instance sample | instance sample |
| `environment`, driver `ssh` | remote, through the driver's existing SSH command | the environment's `remoteWorkspacePath` | remote host |
| `environment`, driver `sandbox` or `plugin` | not sampled | none | none |

Sandbox and plugin environments report `status: "unsupported"`. They are
ephemeral or provider-managed; sampling them needs a lease. They are a
follow-up if a provider exposes quota through its plugin.

Roots on the same filesystem (same `st_dev`) are reported once, with all
their labels.

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
  that appends `; printf '\n__paperclip_rc__\n'; { <probe>; } 2>/dev/null || true`.
  The existing `pwd` output is everything before the marker, so `remoteCwd`
  is unchanged. A probe failure cannot fail the command. The sample is
  recorded after the lease row is written, never awaited by the run, and a
  recording error is logged and dropped.
- **Slow sweep:** each sweep pass runs the probe as one `runSshCommand`
  (`cd <root> && <probe>`, timeout 10 s) for an SSH environment only when
  it has an active lease, or its level is not `ok`, or it has runs held for
  capacity (slice 3). Interval per environment: 5 minutes, or 60 seconds
  while the level is `critical` (so held runs resume quickly). A sample
  newer than half the interval is not repeated, so two server processes do
  not double the SSH traffic. Environments are probed one at a time per
  pass.
- **Parsing is defensive:** the output comes from a host Paperclip does not
  control. Only tagged lines are read; each value must be a finite
  non-negative number in range (`free <= total`, `total > 0`, at most 4096
  CPUs); unknown lines are ignored; output over 16 KB is discarded. The raw
  output is never stored. A sample with any missing metric has
  `status: "partial"`; a failed command stores `status: "failed"` and a
  bounded error class (`timeout`, `auth`, `exit_<code>`), never stderr.
- The probe uses `config.remoteWorkspacePath` through the existing
  `shellQuote`. The script has no other input.

### 4.2 Instance sampler

An in-process interval (default 60 s, `PAPERCLIP_RESOURCE_CAPACITY_SAMPLE_INTERVAL_MS`,
minimum 15 s, `unref`'d, cleared on shutdown) samples the instance. It keeps
the latest sample in memory for admission and persists a row when 5 minutes
have passed since the last persisted row or the level changed. It runs even
when `HEARTBEAT_SCHEDULER_ENABLED=false`, because reads need it. The same
interval drives the SSH sweep and, once an hour, retention.

## 5. Data model

### 5.1 `resource_capacity_samples` (migration `0297`, regenerated if another lands first)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `target_kind` | text not null | `instance` or `environment` |
| `environment_id` | uuid null, fk `environments.id` on delete cascade | set when `target_kind = environment` |
| `host_label` | text null | hostname, set when `target_kind = instance`; shown to instance admins only |
| `sampled_at` | timestamptz not null | |
| `source` | text not null | `interval`, `lease_acquire`, `sweep` |
| `status` | text not null | `ok`, `partial`, `failed` |
| `error_class` | text null | bounded enum, never raw output |
| `cpu_count` | integer null | |
| `load1`, `load5`, `load15` | real null | |
| `mem_total_bytes`, `mem_available_bytes` | bigint null | |
| `disks` | jsonb not null default `[]` | at most 4 entries `{labels: string[], totalBytes, freeBytes}`; labels from a closed set |
| `level` | text not null | `ok`, `low`, `critical`, `unknown`, computed at write time with the thresholds in force |
| `created_at` | timestamptz not null default now() | |

Indexes: `(environment_id, sampled_at desc)` where `environment_id is not
null`; `(host_label, sampled_at desc)` where `target_kind = 'instance'`;
`(sampled_at)` for retention.

No `company_id`: environments are instance-wide (the table has no
`company_id`, `packages/db/src/schema/environments.ts:4-30`). Company scoping
is enforced at read time (section 7).

### 5.2 Run hold (slice 3)

`heartbeat_runs.admission_hold` jsonb null: `{ kind: "resource_capacity",
target: "instance" | "environment", environmentId, environmentName, metric:
"disk" | "memory", label, freePercent, freeBytes, thresholdBytes, since }`.
Written once when a queued run is first held, cleared in the same update
that claims it. It exists so run lists, the issue run ledger and agents can
show "deferred: disk 96% used on worker-a" without a join. A dedicated
column is used because the existing ones mean something else
(`nextAction` and `livenessReason` are written by liveness classification
at finalization; `errorCode` marks failures).

### 5.3 Size

Per SSH environment: one row per 5 minutes while active, plus one per run
start: about 8,640 rows per 30 days at most, plus one per run. Per instance
host: one row per 5 minutes plus level changes, about 8,640 per 30 days.
Rows are about 300 bytes. Ten targets: under 100k rows, about 30 MB.

### 5.4 Retention

`PAPERCLIP_RESOURCE_CAPACITY_RETENTION_DAYS`, default 30, minimum 1. Once an
hour the sampler deletes rows older than that in batches of 5,000
(`delete ... where id in (select id ... order by sampled_at limit 5000)`),
looping until fewer than 5,000 are deleted. The latest row of each target is
never deleted, so a quiet environment keeps its last known state.

## 6. Levels, thresholds, projection and events

### 6.1 Levels

A disk root or memory is `critical` when free is below the critical
threshold, `low` below the low threshold, otherwise `ok`. A target's level is
its worst metric. `unknown` means the latest sample is `failed` or older
than 15 minutes.

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
minutes. If the slope is negative, `hoursToFull = freeBytes / -slope`. The
read model returns `{ label, hoursToFull, basisMinutes }`. It is computed on
read from at most 72 rows per root, so it is never stale. A projection under
24 hours raises an event (6.3); the event re-arms when the projection is
over 48 hours or the root is `ok` again.

### 6.3 Activity events (slice 2 and 3)

`activity_log.company_id` is `NOT NULL`, and environments have no company.
A target event is written once per **affected company**: a company with at
least one non-terminated agent whose resolved environment
(`resolveExecutionWorkspaceEnvironmentId`, the same pure resolver
`executeRun` uses) is the target. An instance-target event goes to every
company with an agent, because an instance root at `critical` (database,
run logs) holds every run. Events are rare: they fire on level transitions
with hysteresis.

| Action | Entity | When | Details (numbers and labels only) |
|---|---|---|---|
| `resource_capacity.threshold_crossed` | `environment` / `instance` | level goes up (`ok`→`low`, `low`→`critical`, `ok`→`critical`) | `target`, `environmentId`, `environmentName`, `metric`, `label`, `from`, `to`, `freePercent` |
| `resource_capacity.recovered` | same | level goes down | same |
| `resource_capacity.disk_full_projected` | same | projection under 24 h (re-arms as in 6.2) | `label`, `hoursToFull`, `freePercent` |
| `heartbeat.run_deferred_resource_capacity` | `heartbeat_run` (with `runId`, `agentId`) | a queued run is first held (slice 3, enforce) | the hold (5.2) |
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
  permission), for the environments the company **can use**: the resolved
  environment of each of the company's non-terminated agents. Instance admins
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

`startNextQueuedRunForAgent` (`heartbeat.ts:20604`), after the invokability
and free-slot checks and **before** `claimQueuedRun`. Every new run start
goes through it (wakes, scheduled-retry promotion, deferred-wake
re-delivery from #52, `resumeQueuedRuns` on each 30 s tick). The other
`executeRun` callers are native restart recovery and session resume of runs
already in flight; they are not gated, because holding them would strand
started work.

Why not copy `WorkspaceBusyDeferral` (post-claim cancel plus scheduled
retry): it cancels the claimed run and creates a new retry run every 60 to
120 seconds. A cancelled run keeps its `startedAt`, so it counts toward
`maxDailyRuns` (`getHeartbeatDailyCapBlock` excludes only `queued` and
`scheduled_retry`). An hour of full disk would create 30 to 60 cancelled
runs per waiting issue and could spend an agent's daily cap. Holding
before the claim uses no slot, no issue lock, no daily-cap count, and no
new rows. The existing 30 s tick re-checks it.

### 8.2 How

1. Resolve the agent's target once per pass with the same pure resolver
   `executeRun` uses (`resolveExecutionWorkspaceEnvironmentId`, plus the
   managed-sandbox and Kubernetes rules, which map to sandbox environments
   and are therefore not gated). The resolution is extracted into one helper
   that both callers use, so the two cannot drift.
2. Read the latest sample of the instance (memory, from the in-process
   sampler) and, for an SSH target, of the environment (DB, cached 15 s).
3. Hold when the instance `data` or `runLogs` root is `critical` (every
   driver), or the target environment's disk or memory is `critical` (local:
   the instance `workspaces` root and host memory; SSH: the remote root and
   remote memory).
4. **Fail-open:** a missing, `failed`, `partial`-for-that-metric or stale
   (older than 15 minutes) sample never holds. A sampling error never fails
   or delays a run.
5. On hold, in `enforce` mode: for each queued run of the agent that has no
   hold yet, set `admission_hold`, append one run event and one activity
   entry. Return without claiming. In `warn` mode: claim as usual and write
   `heartbeat.run_admitted_despite_resource_capacity` once per run.
6. When a held run is claimed, the claim update clears `admission_hold`,
   and one `heartbeat.run_resumed_resource_capacity` entry is written.

The hold is per agent and target, so one full worker does not block agents
on other environments.

Interaction with other holds: budget, daily caps, pause holds and dependency
blocks keep their order inside `claimQueuedRun`. A capacity hold comes
first because it is cheapest and holds nothing. #52's deferred-wake sweep
still re-delivers wakes; the resulting queued run waits in the same hold.
#12's provider-quota retry lane is unaffected: a held run is `queued`, not
`scheduled_retry`, and is not counted by the daily cap.

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
an admission tweak, and it is out of scope. To count what a deployment would
gain, an operator can run (read-only):

```sql
select a.company_id, count(distinct a.default_environment_id) as explicit_envs,
       count(*) filter (where a.default_environment_id is null) as agents_on_defaults
from agents a where a.status <> 'terminated' group by a.company_id;
```

## 10. Threat notes

| Threat | Mitigation |
|---|---|
| Cross-company leak through a shared environment | Numbers and labels only; "can use" check (section 7); `404` for others; activity only to affected companies; no hostnames, paths, leases or run ids of others. Tests with two companies on one environment. |
| Instance details to non-admins | Instance route `assertInstanceAdmin`; host labels and paths only there; OpenAPI `INSTANCE_ADMIN_OPERATIONS`. |
| Remote command injection | Fixed script; the only input is `remoteWorkspacePath` through the existing `shellQuote`. |
| Hostile or broken worker output | Tagged lines only, numeric range checks, 16 KB cap, raw output never stored, errors stored as a closed enum. |
| A bad sample blocks all runs | Default `warn`; fail-open on stale, failed or partial; hysteresis; the hold reason names the metric and value, so an operator sees a wrong reading at once; `admission: "off"` turns it off without a deploy. |
| SSH load from sampling | Zero extra sessions at lease acquire; sweep at most one command per environment per 5 minutes (60 s only while critical), serial, 10 s timeout; skipped when a recent sample exists. |
| Unbounded growth | Retention from day one; latest row per target kept. |
| Agents changing placement or thresholds | Agents read only. Thresholds are instance settings (board, instance admin). |

## 11. Decisions for the user

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Admission default | `warn` (log "would defer", start anyway) or `enforce` | Ship `warn` as the code default (safe for every install). Set this deployment to `enforce` after 24 to 48 hours of `run_admitted_despite_resource_capacity` entries look right. |
| D2 | Who reads environment capacity | (a) members and agents of companies that can use the environment (narrower than today's environment read rule); (b) any board member, as today's environment routes | (a), as the brief asks. |
| D3 | Instance-root events in every company's audit log | (a) yes, level and percent only; (b) instance admins only, no audit entry | (a): an instance disk at `critical` holds every company's runs, and the audit entry is the explanation. |
| D4 | Retention | 30 days default | Accept. |
| D5 | Load-based throttling | not in this track | A per-environment concurrency limit is the right tool for load; propose it as its own issue if wanted. |

## 12. Slices

Each slice ships web, API, OpenAPI and CLI together with tests.

| Slice | Scope | Size |
|---|---|---|
| **1** | Table, migration, shared types and constants, instance sampler, SSH probe at lease acquire and sweep, retention, levels on read; the three read routes (latest only, no history yet), OpenAPI, CLI `capacity` and `environment capacity`, instance page and environment capacity line; AGENTS.md classification sentence; `/api/health` level for admins. | L |
| **2** | History (`since`, bucketing), sparklines, disk-full projection, the three `resource_capacity.*` activity events with affected-company fan-out. | M |
| **3** | Admission hold before claim, `admission_hold` column, run and activity events, instance setting with `warn` default, the hold reason in run lists, the issue run ledger and run detail. | M |
| 4 | Placement: not built (section 9). | none |

Follow-ups, not in this track: PR #44's reaper reads the latest capacity
sample instead of running its own `df` for its disk-pressure mode; sandbox
and plugin quota through the plugin SDK; a per-environment concurrency limit
(D5).

## 13. Test plan

Each item is a test that fails before its slice and passes after.

- **Parsers (pure):** `/proc/meminfo`, `/proc/loadavg`, `df -Pk` with
  Linux, BusyBox and macOS output; missing lines give `partial`; hostile
  output (huge numbers, negative, `free > total`, 1 MB of noise) is rejected.
- **Classifier (pure):** thresholds as `min(percent, bytes)`, hysteresis in
  both directions, worst-metric level, stale gives `unknown`.
- **Projection (pure):** steady fill, refill (positive slope gives none),
  too few samples, too short a span.
- **SSH probe:** with the real-sshd fixture (`ssh-fixture.test.ts`,
  `PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1` on macOS): `ensureSshWorkspaceReady`
  with the probe returns the same `remoteCwd` as without; a probe that fails
  (no `/proc`) still returns `remoteCwd` and a `partial` sample.
- **Service (embedded Postgres):** sampler persists every 5 minutes or on a
  level change; retention deletes in batches and keeps the latest row per
  target; sweep picks only active or non-ok environments and skips a recent
  sample; a sweep failure stores `failed` and does not throw.
- **Routes:** instance route 403 for non-admins; company route and
  environment detail return `404` for an environment the company cannot use,
  with two companies sharing one environment; agents allowed for their own
  company; responses contain no path or hostname (string scan); OpenAPI
  route test covers the new routes.
- **Events (slice 2):** one entry per affected company per transition, none
  on an unchanged level, re-arm rules for the projection.
- **Admission (slice 3):** a queued run on a `critical` target stays
  `queued` with `admission_hold` and one activity entry; repeated ticks write
  nothing more; recovery claims it, clears the hold and writes one resumed
  entry; stale and failed samples admit; `warn` starts the run and writes one
  entry; another agent on a healthy environment is not held; the daily cap
  is unchanged by a hold; native resume paths are not gated.
- **CLI:** URL and output tests in the style of `operations-parity.test.ts`.
- **UI:** component tests for the panels and the hold label; browser check at
  desktop and mobile widths with zero console errors; `pnpm check:token-gates`.

## 14. Coordination

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
