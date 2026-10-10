# Planned restart: drain first, then resume the interrupted runs

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
Branch: `docs/planned-restart-drain-and-resume`
Code anchors: `main` at `38819d350` (see Appendix A). Line numbers drift; names do not.

## 1. Goal and constraints

A planned restart (a deploy, a backup stop) ends every run that is alive at that
moment. Today those runs end as if the process had crashed. Their work is lost,
and each restart spends the run's transient-failure retry budget.

**Evidence (production, read-only, one company, last 24 hours).** Of 991
terminal runs, 416 ended because of a restart: `process_lost` 172,
`orphaned_running_run` 140, `server_shutdown_interrupted` 104. The loss per hour
lines up with the deploy windows. Each deploy stops the app twice today: a
pre-deploy backup stop, then the real restart about 17 minutes later. The
two-stop part is being fixed in the deploy job, outside this repository.

**Goal.**

1. Before a planned stop, the instance **drains**: it starts no new runs and gives
   the running runs a grace period to finish.
2. A run that is still alive at the end of the grace period ends cleanly with a
   new ending, `planned_restart`, and not with `process_lost`.
3. After the restart, each `planned_restart` run is **resumed once** on the same
   issue, with a note that a planned restart interrupted it. The resume respects
   free run slots and budgets, and it does not spend the retry budget.
4. The deploy job has a contract it can rely on: endpoints, timeouts, exit codes.

Constraints, all binding:

- **Build on what exists.** `main` already has a task drain (section 2.1). This
  plan extends it. It does not add a second drain, a second dispatcher or a second
  retry path.
- **Web, API (listed in OpenAPI) and CLI** for every control.
- **Board only.** Every write needs an instance admin, as the task drain does today.
- **Every change writes an activity log entry**, including the ones the system makes.
- **Additive, just-in-time migration.** One small new table (section 4.4). The
  migration number is assigned when the manager names this slice next.
- **Public repository.** No instance, host or company names. "The deploy job" is
  the caller.

Not in scope:

- The deploy job itself and its two-stop sequence (outside this repository).
- The stranded-issue repair for `in_progress` issues with no run. Another change
  owns `reconcileStrandedAssignedIssues` (section 5.3). This plan uses its result.
- Hot-restart adoption for service-manager installs (`paperclipai service restart`).
  It keeps working as today (section 2.5).
- Runs of the native runner (`paperclip_runner`). They are detached at shutdown and
  re-attached after it. A drain does not end them (section 4.6).

## 2. What exists today

### 2.1 The task drain

`main` has an instance-level **task drain**: a hold on new run admission, so that
a caller can wait for active work to finish before it stops the process.

- **State.** `taskDrainState` at module scope in `heartbeat.ts`: `startedAt` and an
  optional `expiresAt` (TTL). It lives in process memory only. A restart clears it.
- **Effect.** `resolveHeartbeatSchedulingSuppression` returns `task_drain`. Then
  `startNextQueuedRunForAgent` starts nothing, `executeRunAttempt` puts a run that
  it just claimed back to `queued`, and a wake that arrives during the drain stays
  in the queue (it is not skipped).
- **Routes.** `GET`, `POST` (`{ ttlMs }`, maximum 24 hours) and `DELETE`
  `/api/instance/task-drain`. Writes need `assertCanManageInstanceSettings`
  (instance admin). Each write runs inside `withTaskDrainTransition` and fans out
  one activity row per company (`instance.task_drain.started` and `.stopped`) in
  one transaction.
- **Status.** `getTaskDrainStatus`: `draining`, `startedAt`, `expiresAt`,
  `activeRuns`, `pendingWakes` and `quiescent`. The counts are in-process only.
- **Callers.** Cloud control maps the three methods to `task-drain:read|start|stop`.
  Its comment says this is "the task-drain hold the deploy path uses". The routes
  are in OpenAPI.
- **Gaps.** There is no CLI command, no web control, no banner and no health field.
  There is no grace deadline: a drain waits forever, or until the TTL ends the
  drain and lets new runs start. Nothing ends the runs that are still alive.

### 2.2 How a run ends at shutdown

`SIGTERM` and `SIGINT` call `shutdown` in `server/src/index.ts`. After it stops the
scheduler, it calls `drainRunningRunsForShutdown` in `heartbeat.ts`:

- For each `running` run of this boot (not native-runner runs), it terminates the
  child with the adapter's `graceSec` (default 20 seconds), **one run after
  another**.
- It sets `status: "interrupted"`, `errorCode: "server_shutdown_interrupted"`.
- It calls `enqueueProcessLossRetry`, which calls `scheduleBoundedRetryForRun` with
  the reason `transient_failure`. That retry **spends the failure budget**: two
  attempts, 30 seconds apart.

There is no shutdown timeout setting. `deploy/compose.yaml` sets no
`stop_grace_period`, so the container runtime's default applies. If that default
is shorter than the sequential sum of the grace periods, the process is killed
before `drainRunningRunsForShutdown` finishes. The remaining runs are then found
after the restart by the other two endings below. This is a likely cause of the
large `process_lost` and `orphaned_running_run` counts. **It is not verified**: the
deploy job's real stop timeout is not in this repository.

### 2.3 How a run ends after a hard stop

- **`process_lost`.** `reapOrphanedRuns` runs at startup (threshold 0) and on the
  periodic tick (threshold 5 minutes). It sets `failed` with `process_lost`. It
  schedules the same bounded transient retry, once.
- **`orphaned_running_run`.** `terminalizeOrphanedRunningRun` in the recovery
  service, called by `sweepStaleIssueLocks`, sets `interrupted` when the process and
  its group are gone.

`run-failure-cause.ts` maps `server_shutdown_interrupted` to `interrupted_graceful`
and `process_lost` to `interrupted_crash`. `orphaned_running_run` has no mapping
and reads as `unknown`.

### 2.4 Retry accounting

`execution-recovery-attempt.ts` already keeps some retries out of the failure
budget: `workspace_busy`, `ai_connection_busy` and `max_turns_continuation` have
their own counters ("Resource waits, repairs and productive continuations do not
spend failures"). A planned-restart resume fits this pattern.

When the budget is spent, the stranded-issue sweep escalates the issue to
`blocked`. A comment in `enqueueStrandedIssueRecovery` records the incident that
made this rule: "three deploy restarts in a row spent the budget and the issue sat
in_progress with no run".

### 2.5 Hot-restart adoption

Service-manager installs have `paperclipai service restart --wait`. It writes a
hot-restart intent, and the next process adopts or drains the runs
(`reconcileHotRestartAdoption`, `skipHeartbeatDrain`). That path does not apply to
a container stop, and this plan does not change it.

## 3. Design overview

```
deploy job            server (old process)                     server (new process)
----------            --------------------                     --------------------
drain start  ──────▶  drain row opened, admission held
                      runs finish ...  (live runs ↓)
drain wait   ◀──────  status: live runs, deadline
                      deadline: still-alive runs end
                      as planned_restart, each gets a
                      planned_restart_resume retry row
                      (scheduled_retry, due now)
stop app     ──────▶  SIGTERM: nothing left to end;
                      drain row closed: process_stopped
start app    ──────────────────────────────────────────────▶  admission open (memory is clean)
                                                               promoteDueScheduledRetries
                                                               → resumeQueuedRuns → claim
                                                               (free slots, budget) → run
                                                               with the restart note
```

The drain row is the durable record. The in-process state stays the admission
switch, so the hot path does not read the database.

## 4. Design

### 4.1 Drain mode

A drain has a **reason**, a **deadline** and an **expiry**:

| Field | Meaning |
|---|---|
| `reason` | `planned_restart` (the deploy job) or `manual` (an operator) |
| `deadlineAt` | `startedAt + graceMs`. When it passes, the server ends the runs that are still alive (section 4.2) |
| `expiresAt` | when the drain lifts by itself. For `planned_restart` it is required: `deadlineAt + 30 minutes` by default. This is the safety net when the deploy job dies |

Defaults: `graceMs` 5 minutes, maximum 30 minutes (an instance setting,
`plannedRestartGraceMs`, in the `general` JSON; no migration for the setting).

Behavior while draining, unchanged from today: no new run starts, wakes stay
queued, timers and routines queue their wakes. A drain that lifts (cancel or
expiry) lets the queue start again, through the normal claim.

**Start is idempotent.** A start while a drain is on returns the current drain
with `alreadyActive: true` and does not move its deadline. To change the deadline,
cancel and start again. Both writes are logged.

### 4.2 The deadline: a clean `planned_restart` ending

When `deadlineAt` passes and the drain is still on, the server ends every run
that this boot still runs, except native-runner runs:

- It uses the existing `drainRunningRunsForShutdown` body, with the ending code as
  an input. It ends the runs **in parallel**, each with its adapter's `graceSec`.
  (Today the shutdown path ends them one after another. The deadline path does not
  need the process to exit, so parallel is safe here.)
- Each run gets `status: "interrupted"`, `errorCode: "planned_restart"`, the run
  event "Interrupted by a planned restart", and a resume (section 4.5) in place of
  the transient retry.
- The process keeps running, with the drain on. The deploy job stops it when it
  likes.

The shutdown path also writes `planned_restart` (not `server_shutdown_interrupted`)
for a run that it ends **while a `planned_restart` drain is open**, for example
when the deploy job stops before the deadline. Without a drain, shutdown is
unchanged (section 5.1).

Why end the runs at the deadline, and not at the stop: the stop is controlled by
the deploy job and the container runtime. A short stop timeout kills the process
before the sequential shutdown loop finishes (section 2.2), and those runs become
`process_lost`. Ending them at the deadline, inside a live process, makes the
clean ending independent of the stop timeout.

### 4.3 The deploy hook contract

The deploy job calls these, in order:

1. **Start.** `POST /api/instance/task-drain`
   `{ "reason": "planned_restart", "graceMs": 300000 }` → `200`
   `{ drainId, reason, startedAt, deadlineAt, expiresAt, alreadyActive }`.
   The old body (`{ ttlMs }`) keeps working and means `reason: "manual"`, no
   deadline. That keeps the current Cloud control caller working.
2. **Wait.** Poll `GET /api/instance/task-drain` every 5 seconds until
   `phase` is `quiescent` or `ended_at_deadline`. The response adds `drainId`,
   `reason`, `deadlineAt`, `phase`, `liveRuns` (this boot's `running` legacy runs,
   read from the database) and `nativeRuns` (counted, not waited for).
   `phase` is one of `idle`, `draining`, `ending_at_deadline`, `quiescent`,
   `ended_at_deadline`.
3. **Stop** the app.

Authorization: an instance-admin board credential, or the existing Cloud control
assertion (`task-drain:read|start|stop`). An agent key never works.

**CLI** (wraps the same three calls):

```
paperclipai instance drain start [--grace 5m] [--reason planned_restart|manual]
paperclipai instance drain status [--json]
paperclipai instance drain wait [--timeout 7m] [--json]
paperclipai instance drain cancel
paperclipai instance drain run [--grace 5m] [--timeout 7m]   # start + wait, for scripts
```

Exit codes of `drain wait` and `drain run`, which a script can rely on:

| Code | Meaning | What the deploy job should do |
|---|---|---|
| `0` | Quiescent: every run finished in the grace period | Stop |
| `10` | The deadline passed; N runs ended as `planned_restart` and will resume | Stop |
| `20` | The drain did not start (HTTP error, not authorized, server unreachable) | The job's own policy; a stop now loses runs as today |
| `21` | The drain started, but the status could not be read before `--timeout` | Stop is allowed; the drain expires by itself |
| `22` | The drain was cancelled by someone else while waiting | Do not stop without a decision |

`--timeout` defaults to `graceMs` plus 2 minutes, so a deadline that passes always
ends the wait. The CLI prints one JSON line per poll with `--json`.

### 4.4 Data

**Run ending.** `heartbeat_runs.error_code` is free text, so the new code
`planned_restart` needs no migration. Status stays `interrupted`. In
`run-failure-cause.ts` it maps to the existing cause `interrupted_graceful`
(question Q3). The run-stop metadata, the cancellation source map
(`run-cancellation.ts`, `source: "shutdown", expected: true`) and the
conversation-continuation list (`conversation-continuation.ts`, which treats
`server_shutdown_interrupted` as an interruption) all gain the new code next to
`server_shutdown_interrupted`.

**Drain record.** One new table, `instance_drains` (instance-level, like
`instance_settings`; it holds no company data):

| Column | Type | Note |
|---|---|---|
| `id` | uuid | `drainId` |
| `reason` | text | `planned_restart` or `manual` |
| `started_at`, `deadline_at`, `expires_at` | timestamptz | `deadline_at` is null for `manual` |
| `ended_at` | timestamptz | null while open |
| `end_reason` | text | `cancelled`, `expired`, `process_stopped`, `superseded` |
| `boot_id` | text | the process that opened it (`legacyControllerBootId`) |
| `planned_restart_runs` | integer | runs ended at the deadline or at the stop |
| actor columns | | as `activity_log`: actor type and id |

At most one open row (a partial unique index on `ended_at is null`). The in-memory
state is set from the row when the row is opened and cleared when it is closed.

At startup, the new process closes any open row with `end_reason:
process_stopped`. It **never** re-applies a drain from the table. A drain that
survived a restart would hold admission and skip startup recovery
(`index.ts` skips the recovery block while scheduling is suppressed).

Why a table and not only memory: the alert (section 6) and the status need the
deadline after a request on another code path; the history shows how often and
how long the instance drained; and the startup step needs to know that the last
process stopped inside a drain (section 5.2). Why not the `general` JSON: that is
settings, not events, and it has no history.

### 4.5 Resume after restart

A run that ended `planned_restart` gets **one** resume on the same issue:

- **Path.** `scheduleBoundedRetryForRun`, the function the shutdown path and the
  stranded-issue sweep already use, with a new retry reason
  `planned_restart_resume`, delay 0, and the wake reason
  `planned_restart_resume`. It writes a `scheduled_retry` row. After the restart,
  `promoteDueScheduledRetries` and `resumeQueuedRuns` start it through the normal
  claim. No new dispatcher.
- **Slots and budget.** The claim enforces them: `startNextQueuedRunForAgent` checks
  `maxConcurrentRuns`, and `claimQueuedRun` checks `budgets.getInvocationBlock` and
  cancels the run on a hard stop, as for any queued run.
- **Retry budget.** `planned_restart_resume` gets its own counter in
  `execution-recovery-attempt.ts`, like `workspace_busy`. It does not spend
  `failureRetries`, so `transientRetryBudgetSpent` does not escalate the issue.
- **Once.** One resume per `planned_restart` ending. If the resumed run is
  interrupted by the next planned restart too, it gets its own resume. After 3
  `planned_restart` endings in a row on the same retry chain, the next one uses the
  normal transient retry (and its budget), so a loop of restarts ends in the
  existing escalation (question Q4).
- **Note.** The resumed run's context carries
  `resume: { reason: "planned_restart", interruptedRunId }`. The prompt builder adds
  one line: "A planned restart interrupted your previous run on this task. Continue
  from where it stopped." Conversation adapters continue the session as they do
  for `server_shutdown_interrupted` today.
- **Holds.** A pause hold, an operator Stop, a board-owned recovery action or a
  paused agent keeps the resume parked, by the same checks that apply to every
  retry. A drain is not one of these (section 6).

The resume row is written **before** the process exits, at the deadline or at the
stop. If the process dies before it writes the row, the run ends after the restart
as today (section 5.2), and the stranded-issue sweep is the net (section 5.3).

### 4.6 Native-runner runs

`drainRunningRunsForShutdown` detaches native `paperclip_runner` runs and the next
process re-attaches them. A drain does not wait for them and does not end them.
The status counts them as `nativeRuns`, so the deploy job can see them.

## 5. Restarts without a drain, and the safety nets

### 5.1 An unplanned restart (crash, or a stop with no drain)

Unchanged. A `SIGTERM` with no drain open writes `server_shutdown_interrupted`. A
crash leaves `running` rows that the reaper ends as `process_lost`, or the stale
lock sweep ends as `orphaned_running_run`. These runs keep the bounded transient
retry and its budget, and the stranded-issue path (section 5.3).

The only change: `orphaned_running_run` gains a mapping to `interrupted_crash` in
`run-failure-cause.ts`, so it stops reading as `unknown`. (A one-line change; it is
listed so the observability counts stay honest.)

### 5.2 A planned stop that the server could not finish

If the process is killed during a drain before the deadline (a stop timeout shorter
than the grace period), some runs end after the restart as `process_lost` or
`orphaned_running_run`. Slice D2 classifies them: at startup, before the reap, the
new process reads the drain row that it closes as `process_stopped`. A run whose
`controllerBootId` equals that row's `boot_id` and that the reaper ends gets
`planned_restart` and the resume, not `process_lost` and the transient retry.

### 5.3 The stranded-issue sweep is the net, not a second path

Another change fixes `reconcileStrandedAssignedIssues` so that an `in_progress`
issue with no live run is re-dispatched once or escalated, never left invisible.
This plan does not touch that sweep. It reaches the same function,
`scheduleBoundedRetryForRun`, by the same retry-row mechanism. If a resume row is
lost, that sweep sees an `in_progress` issue whose last run ended
`planned_restart` with no successor, and dispatches it under its own rules. That
change must treat `planned_restart` like `server_shutdown_interrupted` (question Q7).

## 6. A drain is not a hold, and a drain left on

A drain holds **admission for the whole instance** for minutes. It is not a hold on
a thing (an agent, an issue tree) with a lift condition, as in the holds plan
(#102). It does not use `hold_lift_conditions`.

A drain left on (the deploy job died after "start") is noticed in three ways:

1. **It ends by itself.** A `planned_restart` drain must have an expiry
   (`deadlineAt + 30 minutes` by default). At expiry the drain lifts, the row closes
   with `expired`, and an activity entry is written.
2. **An alert.** When `now > deadlineAt + 10 minutes` and the drain is still open,
   the attention feed shows a new source kind `instance_drain` in every company's
   feed, for instance admins only: "New runs are paused for a planned restart that
   has not happened. The drain lifts by itself at 12:35." Severity `high`. Verbs:
   **Lift drain** (the `DELETE`), **Dismiss**. It is derived on read from the open
   row, so it needs no stored alert.
3. **The banner** turns to the warning style (section 7.3).

The server also logs one `warn` line when the deadline plus 10 minutes passes.

## 7. Surfaces

### 7.1 API (all listed in OpenAPI)

| Method and path | Change |
|---|---|
| `POST /api/instance/task-drain` | Body adds `reason` and `graceMs`. Response adds `drainId`, `reason`, `deadlineAt`, `alreadyActive`. `{ ttlMs }` alone still works |
| `GET /api/instance/task-drain` | Response adds `drainId`, `reason`, `deadlineAt`, `phase`, `liveRuns`, `nativeRuns`, `plannedRestartRuns` |
| `DELETE /api/instance/task-drain` | Unchanged; closes the row with `cancelled` |
| `GET /api/instance/task-drains` | New: the history, newest first, paginated |

Reads need board access (as today). Writes need an instance admin (as today).
`GET /api/health` does not get drain fields (question Q8).

### 7.2 CLI

`paperclipai instance drain start|status|wait|cancel|run|history`, in the existing
`instance` command group (`cli/src/commands/client/access.ts`). Exit codes in
section 4.3.

### 7.3 Web

- **Banner**, in `Layout.tsx` next to `WorktreeBanner`, for every board user in
  every company while a drain is open: "New runs are paused for a planned restart.
  4 runs are finishing. Deadline 12:05." It turns to the warning style after
  `deadlineAt + 10 minutes`. Instance admins see **Lift drain**.
- **Control**, on the instance general settings page: the drain status, **Start
  drain** (grace period choice, reason `manual` or `planned_restart`), **Lift
  drain**, and the history list.

### 7.4 Activity log

`activity_log.company_id` is required and there is no instance activity table. Each
drain event fans out one row per company in one transaction, as the task drain does
today:

| Action | Actor |
|---|---|
| `instance.task_drain.started` (exists; details add `reason`, `deadlineAt`) | the caller |
| `instance.task_drain.stopped` (exists) | the caller |
| `instance.task_drain.deadline_reached` (details: `plannedRestartRuns`) | system |
| `instance.task_drain.expired` | system |
| `instance.task_drain.closed_by_restart` | system, at startup |

Each `planned_restart` run also writes a run event, and its resume writes the
normal retry event, in the run's own company.

## 8. Slice plan

| Slice | Content | Depends on |
|---|---|---|
| **D1** | `instance_drains` table and migration; `reason`, `graceMs`, deadline and expiry; deadline ending (parallel) and the shutdown ending inside a drain; `planned_restart` code and its maps; `planned_restart_resume` retry reason with its own counter and the cap of 3; the resume note; API and OpenAPI; CLI `instance drain` with the exit codes; web banner and control; activity entries | none |
| **D2** | Startup classification of runs killed during a drain (section 5.2); the `instance_drain` attention item; `orphaned_running_run` cause mapping; `stop_grace_period` in `deploy/compose.yaml` (question Q9) | D1; the stranded-issue change merged |

D1 is useful alone: the deploy job can drain, and the runs end clean and resume.

## 9. Verification per slice

D1, embedded Postgres unless noted:

- A drain start holds admission; a queued run does not start; a wake that arrives
  stays queued; cancel lets it start.
- Start is idempotent and does not move the deadline; `{ ttlMs }` alone still works.
- At the deadline, two live runs end in parallel as `interrupted` / `planned_restart`,
  each gets one `planned_restart_resume` row, and `phase` becomes
  `ended_at_deadline`. A native-runner run is not ended.
- A `SIGTERM` during a `planned_restart` drain writes `planned_restart`; without a
  drain it writes `server_shutdown_interrupted` (unchanged).
- After a simulated restart (new service instance, open row): the row closes with
  `process_stopped`, the in-memory drain is off, startup recovery runs, the resume
  starts on the same issue with the note, `failureRetries` is unchanged, and
  `transientRetryBudgetSpent` stays false.
- The resume waits for a free slot (agent at `maxConcurrentRuns`) and is cancelled
  by a budget hard stop, as any queued run.
- The cap: a fourth `planned_restart` in a row on one chain uses the transient retry.
- Expiry closes the row with `expired` and lets runs start.
- Authorization: an agent key and a non-admin board user get `403` on writes; the
  Cloud control assertion works on the three methods; another company sees only its
  own activity rows.
- CLI: each exit code from a stubbed server (`0`, `10`, `20`, `21`, `22`).
- Web: the banner shows and hides (desktop and mobile widths, no console errors),
  the control starts and lifts a drain.
- The new tests are added to the Dockerfile `vitest run` list, so CI runs them.

D2: a run of the previous boot found by the reaper after a `process_stopped` row
gets `planned_restart` and the resume; a run of a boot with no drain row gets
`process_lost` (unchanged); the attention item appears after `deadline + 10 min`
only for instance admins and disappears when the drain lifts.

## 10. Alternatives considered

| Alternative | Why not |
|---|---|
| A new drain mode next to the task drain | Two admission switches for one need. The task drain already holds admission correctly, including queued wakes |
| End the runs only at the stop | The stop timeout is outside the server's control; a short one turns the clean ending into `process_lost` (section 2.2) |
| Persist the drain and re-apply it after a restart | A drain that survives the restart would skip startup recovery and hold admission with no deploy job left to lift it |
| Resume through a new wake and not a retry row | A second dispatch path. The retry row already has the issue, the agent and the slot and budget checks at claim |
| Count the resume in the failure budget | Three deploys in a row escalate a healthy issue (section 2.4) |
| Model the drain as a hold (#102) | A hold targets one thing and waits for a condition; a drain targets admission for minutes and ends with the process |

## 11. Open questions, each with a recommendation

- **Q1. Where runs end: at the deadline, or at the stop?** Recommend: at the
  deadline, in the live process (section 4.2), plus the shutdown ending inside a
  drain for a stop before the deadline.
- **Q2. Durable drain record?** Recommend: the small `instance_drains` table
  (section 4.4). Memory-only cannot classify runs killed during a drain (D2) and has
  no history.
- **Q3. Failure cause for `planned_restart`?** Recommend: map to the existing
  `interrupted_graceful`, so the observability taxonomy (#70) does not change;
  split by `error_code` where needed. Alternative: a new cause `interrupted_planned`,
  which needs a change to the run-usage records and their docs.
- **Q4. How many resumes?** Recommend: one per `planned_restart` ending, with a cap
  of 3 in a row on one retry chain; after that, the normal transient retry and its
  escalation.
- **Q5. Grace and timing defaults?** Recommend: grace 5 minutes (maximum 30), expiry
  `deadline + 30 minutes`, alert at `deadline + 10 minutes`, poll every 5 seconds.
- **Q6. Native-runner runs?** Recommend: not ended and not waited for; counted as
  `nativeRuns` in the status.
- **Q7. Stranded-issue sweep.** Recommend: the other change treats `planned_restart`
  like `server_shutdown_interrupted` in `reconcileStrandedAssignedIssues`, and does
  not dispatch an issue whose `planned_restart_resume` row is still pending. This
  plan's D2 waits for that change to merge.
- **Q8. Drain state on `GET /api/health`?** Recommend: no. The health route is
  public. The deploy job uses the authorized `GET /api/instance/task-drain`.
- **Q9. `stop_grace_period` in `deploy/compose.yaml`?** Recommend: set it in D2 to
  the longest adapter `graceSec` plus 30 seconds (for example 60 seconds), as the net
  for a stop with no drain. The deploy job's own stop timeout must also be at least
  that; it is outside this repository.
- **Q10. Deploy job credential?** Recommend: the existing Cloud control assertion
  where the instance has a Cloud identity; otherwise an instance-admin board API key
  stored as a deploy secret. Never an agent key.

## Appendix A. Code anchors on `main` at `38819d350`

| Fact | Where |
|---|---|
| Task-drain state and status | `server/src/services/heartbeat.ts:1404-1486` (`taskDrainState`, `readTaskDrain`, `startTaskDrain`, `stopTaskDrain`, `getTaskDrainStatus`) |
| Admission switch | `heartbeat.ts:9781` (`resolveHeartbeatSchedulingSuppression`, reason `task_drain`) |
| Wakes stay queued during a drain | `heartbeat.ts:28782-28800` |
| Dispatch: start a queued run | `heartbeat.ts:21627` (`startNextQueuedRunForAgent`); slot check `:21647-21652` |
| Dispatch: claim (budget, queued→running) | `heartbeat.ts:18305` (`claimQueuedRun`); budget `:18330`; update `:18693-18705` |
| Claimed run put back on suppression | `heartbeat.ts:21895-21905`, `:18971` |
| Task-drain routes | `server/src/routes/instance-settings.ts:305` (GET), `:310` (POST), `:367` (DELETE); request schema `packages/shared/src/validators/instance.ts:127-131` |
| Cloud control actions | `server/src/middleware/cloud-control.ts:11-15` |
| OpenAPI entries | `server/src/routes/openapi.ts:6395-6425` |
| Signal handlers and shutdown order | `server/src/index.ts:2091-2096`, `shutdown` `:1985-2089`; finalizer timeouts `server/src/shutdown.ts:17`, `:61` |
| Writer of `server_shutdown_interrupted` | `heartbeat.ts:15462` (`drainRunningRunsForShutdown`); status write `:15593-15608`; retry `:15629` |
| Shutdown retry spends the failure budget | `heartbeat.ts:14796` (`enqueueProcessLossRetry`) → `:16091` (`scheduleBoundedRetryForRun`); budget `:869-879` |
| Writer of `process_lost` | `heartbeat.ts:20051` (`reapOrphanedRuns`); write `:20456-20480`; startup call `index.ts:1554`, tick `:1831` |
| Writer of `orphaned_running_run` | `server/src/services/recovery/service.ts:5983` (`terminalizeOrphanedRunningRun`), code `:6076-6077` |
| Failure-cause map | `packages/shared/src/run-failure-cause.ts:33-34` |
| Run statuses; `error_code` free text | `packages/shared/src/constants.ts:919-928`; `packages/db/src/schema/heartbeat_runs.ts:68` |
| Retry accounting that does not spend failures | `server/src/services/execution-recovery-attempt.ts:54-65` |
| Stranded-issue sweep and its re-dispatch | `recovery/service.ts:4409` (`reconcileStrandedAssignedIssues`), `:1900` (`enqueueStrandedIssueRecovery`), budget-spent escalation `:1949-1961`; wiring `heartbeat.ts:9904-9924` |
| Startup recovery order; skipped while suppressed | `index.ts:1497-1637` (`:1501`) |
| Scheduled retries promoted | `heartbeat.ts:17460` (`promoteDueScheduledRetries`) |
| Activity log is company-scoped | `packages/db/src/schema/activity_log.ts:10` |
| Banners | `ui/src/components/Layout.tsx:636-637` |
| Attention source kinds | `packages/shared/src/types/attention.ts:8` |
| Instance CLI group | `cli/src/commands/client/access.ts:265-283` |
| Compose: no stop grace period | `deploy/compose.yaml:4`, `:40-45` |
| Hot-restart path | `cli/src/commands/service.ts:204`; `index.ts:2005-2007` |
