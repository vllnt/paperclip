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
3. After the restart, each `planned_restart` run that the existing reconciliation
   gate allows to run again is **resumed once** on the same issue, with a note that
   a planned restart interrupted it. The resume respects free run slots and
   budgets, and it does not spend the retry budget. A run that the gate holds keeps
   its hold (section 2.5).
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
  It keeps working as today (section 2.6).
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
  attempts, 30 seconds apart. It is scheduled only when the reconciliation gate
  passes (section 2.5); otherwise the run gets no retry at all.
- The loop is written for a process that is about to exit. It kills the child
  first and writes the row afterwards. It does not settle the executor, abort an
  in-process adapter, or fence a run that is still preparing. In a live process,
  the executor would see the kill first and record its own ending.

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
budget ("Resource waits, repairs and productive continuations do not spend
failures"). There are two patterns:

- `max_turns_continuation` has a stored counter, `maxTurnContinuations`, in
  `ExecutionRetryAccounting` (which holds only that and `failureRetries`).
- `workspace_busy` and `ai_connection_busy` have **no** stored counter. They count
  consecutive attempts of the same reason from `scheduledRetryAttempt`, and they
  snapshot the failure count from before the wait
  (`failureRetriesBeforeWorkspaceWait`), so the wait does not raise it.

A planned-restart resume follows the second pattern (section 4.5). It must be
added to every place that lists these reasons, or `historicalFailureCount` falls
back to `scheduledRetryAttempt` and counts the resume as a failure.

When the budget is spent, the stranded-issue sweep escalates the issue to
`blocked`. A comment in `enqueueStrandedIssueRecovery` records the incident that
made this rule: "three deploy restarts in a row spent the budget and the issue sat
in_progress with no run".

### 2.5 Which interrupted runs may be run again

`scheduleBoundedRetryForRun` refuses a retry (`not_scheduled`,
`legacy_execution_requires_reconciliation`) when
`legacyExecutionNeedsReconciliationWithEvidence` is true. For a legacy run that
ended `interrupted`, `failed` or `cancelled`, that is true unless:

- the run has a conversation-continuation policy (a fresh conversation turn lets
  the agent decide what remains), or
- bootstrap evidence proves the provider never started, or
- one of a few resource-wait shapes applies.

It is also true once `executionFailureRetryCount` reaches 2. A run that needs
reconciliation gets a recovery hold that an operator resolves, because its tool
actions may already have happened. Native runs (`runtimeMode: "native"`) have
their own fenced same-run controller and get no retry from this path.
Chat-completion deliveries own their own bounded retry.

So "resume every interrupted run" is not safe. The plan resumes the runs that
this gate already allows, and leaves the others to the existing hold (section 4.5).

### 2.6 Hot-restart adoption

Service-manager installs have `paperclipai service restart --wait`. It writes a
hot-restart intent, and the next process adopts or drains the runs
(`reconcileHotRestartAdoption`, `skipHeartbeatDrain`). That path does not apply to
a container stop, and this plan does not change it.

## 3. Design overview

```
deploy job            server (old process)                     server (new process)
----------            --------------------                     --------------------
drain start  ──────▶  drain row opened, admission held,
                      one timer armed for the deadline
                      runs finish ...  (live runs ↓)
drain wait   ◀──────  status: phase, live runs, deadline
                      deadline: still-alive runs are
                      stopped through cancelRunInternal
                      with planned_restart; resumable runs
                      get a planned_restart_resume retry
                      row (scheduled_retry, due now)
stop app     ──────▶  SIGTERM: a run still alive is ended
                      as planned_restart; the old process
                      closes its row: process_stopped
start app    ──────────────────────────────────────────────▶  closes any row left open by an
                                                               older boot; admission is open
                                                               promoteDueScheduledRetries
                                                               → resumeQueuedRuns → claim
                                                               (free slots, budget) → run
                                                               with the restart note
```

The drain row is the durable record. The in-process state stays the admission
switch, so the hot path does not read the database. **This assumes one server
process per instance**, which is true today (the API and the scheduler run in one
process). A second process would not see the drain; splitting them needs its own
plan.

## 4. Design

### 4.1 Drain mode

A drain has a **reason**, a **deadline** and an **expiry**:

| Field | Meaning |
|---|---|
| `reason` | `planned_restart` (the deploy job) or `manual` (an operator, or today's callers) |
| `deadlineAt` | `startedAt + graceMs`. When it passes, the server stops the runs that are still alive (section 4.2). Null for `manual` |
| `expiresAt` | when the drain lifts by itself. For `planned_restart` it is required: `deadlineAt + 30 minutes` by default. This is the safety net when the deploy job dies |

Defaults: `graceMs` 5 minutes, maximum 30 minutes (an instance setting,
`plannedRestartGraceMs`, in the `general` JSON; no migration for the setting).

**One owner for timed events.** The periodic tick cannot run them, because the
tick is gated on scheduling suppression (`index.ts:1827`). On start, the server
arms one in-process timer for the next event of the open drain: the deadline, the
alert time (`deadlineAt + 10 minutes`) and the expiry. Each event re-arms it for
the next. The timer writes the activity rows, closes the row on expiry, and logs
the `warn` line at the alert time. Today's lazy expiry in `readTaskDrain` stays as
a guard for admission; it is synchronous and on the hot path, so it only wakes the
timer, which closes the row and writes the activity.

**What a drain holds, as on `main`:**

- A queued run does not start, and a just-claimed run goes back to `queued`.
- A wake from `enqueueWakeup` stays queued (it is not skipped). Routines still
  trigger and queue their wakes.
- **Not queued:** `tickTimers` returns early, so timer heartbeats are not written.
  The native-session resume dispatch, `resumeExecutionWaitComments` and
  `sweepDeferredWakes` also do nothing while suppressed. After a restart they run
  from the durable state. If a drain is cancelled without a restart, they resume on
  the next tick. A drain does not lose them; it delays them.

**Starting a drain that is already on.** Today a `POST` replaces the drain, so a
caller that posts `{ ttlMs }` again extends it. That stays true for `manual`, so
the current Cloud control caller sees no change.

| Open drain | Request | Result |
|---|---|---|
| none | any | start it |
| `manual` | `manual` (`{ ttlMs }`) | replace it, as today |
| `manual` | `planned_restart` | **upgrade** it: set the reason, the deadline and the expiry; keep `startedAt`; log `started` with `upgradedFrom: "manual"` |
| `planned_restart` | `planned_restart` | return it with `alreadyActive: true`; do not move the deadline |
| `planned_restart` | `manual` | `409`: a planned restart is in progress; cancel it first |

Body rules (the schema stays `.strict()`): `graceMs` is allowed only with
`reason: "planned_restart"`. `ttlMs` sets the expiry for either reason; for
`planned_restart` it must be later than the deadline, else `422`. A body with
neither field and no reason is a `manual` drain with no expiry, as today.

### 4.2 The deadline: stop the remaining runs through the live-process path

When `deadlineAt` passes and the drain is still on, the server stops every run
that this boot still runs, except native-runner (`paperclip_runner`) runs.

**Path.** `cancelRunInternal`, not the shutdown loop. It is the path that stops a
run inside a live process: it aborts in-process adapters, waits for a child to
exit, and fences a run that is still preparing. The shutdown loop (section 2.2)
does none of this and would race the executor.

**`cancelRunInternal` alone is not enough.** It has two branches, and in both the
ending and the successor can be written by someone other than the caller:

- For an adapter with an in-process stop handle (`onCancellationReady`, for
  example the acpx engine and `grok-local`), it aborts and waits; the **executor**
  then writes the ending (`cancelled`) and releases the issue **without**
  `suppressImmediateRecovery`, so the release queues a recovery run first.
- For a child-process adapter, it registers a settlement and writes the ending
  itself, then calls `releaseIssueExecutionAndPromote`. That release promotes the
  issue's next deferred wake into a queued run that takes the issue lock, before
  any resume exists.

In both cases the `retryOfRunId` dedup would then hand the resume call an existing
successor of the wrong kind, or the resume would meet a lock held by another run.

**The stop intent.** So a planned-restart stop records an intent first, and every
path that finalizes the run honours it:

1. **Record.** Before it aborts or signals anything, the deadline caller records
   `{ kind: "planned_restart", drainId }` for the run, in a process-local map next
   to `processRunCancellationSettlements`, and in the run's `resultJson`
   (`plannedRestartStop`) so the record survives if the executor reads the row.
2. **Stop.** It calls `cancelRunInternal` with `errorCode: "planned_restart"`, the
   adapter's own grace period, and a new option `terminalStatus: "interrupted"`.
3. **Finalize, in whichever path writes the ending** (`cancelRunInternal`'s own
   write, or the executor's ending write after an abort). When it sees the intent,
   it writes `status: "interrupted"`, `errorCode: "planned_restart"`, and the stop
   metadata with outcome `interrupted` (not `cancelled`), including the
   `runUsedConversationAdapter` result that the shutdown loop passes today, so the
   class test of section 4.5 reads the same facts. **No path releases the issue or
   schedules a successor** until step 4 decides. This is enforced at two choke
   points, not at each caller (section 4.2.1 lists every path). The issue lock
   stays on the stopped run for now. The sweeps that could take it (stale lock,
   deferred wake) and queue starts are suppressed during the drain.
4. **Decide, in one place: the deadline caller, after `cancelRunInternal`
   returns.** That function waits for the adapter to settle, and the executor
   settles after its lease release, which is where a remote ACP run's stop proof
   is written (`releaseEnvironmentLeasesForRun` calls `acknowledgeRemoteStop`).
   Local in-process adapters (acpx, `grok-local`) carry the proof in their result
   earlier. So when the caller decides, every kind of run has its proof or has
   failed to get it. The caller:
   - **requires a stop proof.** One of two facts that the code records today:
     - **acknowledged:** `executionCancellation.state` is `"acknowledged"`.
       `cancelRunInternal` writes it with the ending for a child process with a
       real pid or process group, after `terminateHeartbeatRunProcess` returns;
       `acknowledgeRemoteStop` writes it for a remote ACP run; local in-process
       adapters return it in their result. The intent path keeps this field when
       it switches the metadata outcome to `interrupted`;
     - **never started:** a run fenced while still preparing has no child and no
       acknowledgment. The startup-cancellation fence only records the stop
       request; it is not the proof. The proof is the executor's settled receipt
       `startupPreparationSettledAt`, or bootstrap evidence with
       `providerWorkStarted: false`. Step 4 runs after the executor settles, so the
       receipt exists by then. That receipt is written today only where the run's
       status is `cancelled`; the intent path widens the condition to `interrupted`
       with `plannedRestartStop`, as it does for `acknowledgeRemoteStop`.

     Without either, the run goes to `reconciliation`.
   - **keeps the stop-proof contract.** Today a stop that cannot be verified is a
     conflict ("provider termination could not be verified"), and for a remote ACP
     run the proof (`executionCancellation.state: "acknowledged"`, and with it the
     conversation-continuation policy) is written only by `acknowledgeRemoteStop`,
     which accepts only `status: "cancelled"`. The plan extends that check and
     `acknowledgeRemoteStop` to accept `interrupted` with `plannedRestartStop`. A run
     whose stop is not proven goes to the `reconciliation` class: no resume,
     because the provider may still be working and the same work could run twice.
     The caller records this outcome and does not surface the conflict as an error;
   - re-reads the run and the issue. If the run ended `cancelled` by another writer
     (an agent pause, a budget stop), it is `operator_stop`. If the issue lock no
     longer points at the run, or a successor already exists, it is `superseded`.
     Neither gets a resume, and step 4 releases as today for that ending;
   - classifies the run (section 4.5);
   - when it is `resumed`, schedules the resume. `scheduleBoundedRetryForRun` moves
     the issue lock to the resume row in the same transaction that creates it
     (`executionRunId` set to the resume, only where it still points at the
     stopped run), so the resume's claim keeps it and the stale-lock sweep leaves it
     (the resume is not terminal). This matches the shutdown loop's rule today
     (release only when no retry was made);
   - otherwise releases the issue with `suppressImmediateRecovery: true`.

   **Undecided.** If the wait for the adapter times out (`waitForAdapterStop`
   gives up after 60 seconds and throws), the caller does not decide: no resume and
   no release. The run counts as undecided in the status. The same holds when the
   process dies between steps 3 and 4. Either way the lock points at a terminal
   run; after the restart, the startup stale-lock sweep clears it and the
   stranded-issue sweep is the net (section 5.3), **with the same proof rule**.
5. **Clear** the intent from the map after step 4. The durable marker in
   `resultJson` stays.

So the resume is always the first successor, it holds the issue lock from the
moment it exists, it exists only when the stop is proven, and the ending is the
same whichever path wins. Section 9 tests both
branches.

#### 4.2.1 Every path that can end a run or release its issue

The intent must hold against every writer, not only the two branches of
`cancelRunInternal`. On `main` at `d47df97f0`, `heartbeat.ts` has 21 call sites
of `releaseIssueExecutionAndPromote` and several functions that write a terminal
status on a live run. Gating each caller would miss the next one. So the plan
gates two choke points that every one of them passes through, and states how the
rest behave.

**Choke point A: the release.** `releaseIssueExecutionAndPromote`
(`heartbeat.ts:28464` at `d47df97f0`) is the only caller of the wake-queue
`releaseIssueExecution` (`modules/wake-queue/application/use-cases.ts:1024`),
which is the only code that promotes a deferred wake into the lock and the only
code that queues an immediate recovery successor (`wake-queue adapters/postgres.ts`
`:659-763`). While `resultJson.plannedRestartStop` is set and
`plannedRestartStop.decidedAt` is null, it returns at once: no release, no
promotion, no recovery successor. It reads the durable marker, not the in-memory
map. Step 4 sets `decidedAt` and then calls it with its own options.

**Choke point B: the retry successor.** `scheduleBoundedRetryForRun`
(`heartbeat.ts:16123` at `d47df97f0`) refuses (`not_scheduled`, reason
`planned_restart_pending`) for a run with an undecided intent, unless the caller is
step 4 with the reason `planned_restart_resume`. So the reaper, the shutdown loop,
the provider-capacity cancel, the stranded sweep and every other retry caller
cannot write the first successor.

**Each path, and how it is gated:**

| Path (at `d47df97f0`) | What it does to a live run | Gate |
|---|---|---|
| `cancelRunInternal` (`:31507`), both branches | ends the run, then releases | ending honours the intent (step 3); release at A |
| Executor ending write and its release (`:27492`, `:27924`, `:28198`) | ends the run, then releases | ending honours the intent; release at A |
| Executor late path in `finally` (`:28435-28439`) | when a wake is pending for the issue, either releases (`releaseIssueExecutionAndPromote`) or resumes a queued-comment interrupt (`resumeQueuedCommentInterrupt`, `:10796`), which clears the lock through its own adapter (`queued-comment-postgres.ts` `clearExecutionLockAndTouchIssue`) and so **does not pass A** | the late path checks the durable marker first and does neither while the intent is undecided; step 4 resumes the interrupt after its decision, the same way it releases |
| `cancelActiveForAgentInternal` (`:31809`; release `:31879`), used by agent pause (`cancelActiveForAgent`, `:32555`), budget pause (`cancelBudgetScopeWork`), invokability loss (`:21687`) and bulk cancel (`cancelInvocationsForAgentsInternal`) | writes `cancelled` on each active run, then releases | its terminal write is guarded by status, so the first writer wins; release at A. If it wins, the run is `cancelled` by the operator: step 4 classifies it `operator_stop` (no resume) and releases it with today's options for that ending |
| Provider-capacity stop (the retry-ceiling stop near `:17480`) | ends through `cancelRunInternal` with `suppressImmediateRecovery` | ending honours the intent; release at A |
| Busy-wait deferrals (`finalizeAiConnectionBusyDeferral` `:17126`, release `:17161`; `finalizeWorkspaceBusyDeferral` `:17178`, release `:17266`) and the daily-cap cancel of a queued run (`cancelQueuedRunForHeartbeatDailyCap` `:17901`, release `:17944`) | act on runs that have not started provider work; may schedule a retry | retry at B; release at A. They act on queued or deferring runs, which the deadline does not stop, so they meet the intent only if a run is stopped while deferring |
| Shutdown loop (`drainRunningRunsForShutdown`, `:15494`; release `:15663`) | ends the run, schedules a retry or releases | inside a drain it is a planned-restart finalizer (below); otherwise unchanged. Retry at B, release at A |
| Reaper (`reapOrphanedRuns`, `:20098`; release `:20570`) | ends `running` rows whose process is gone | the deadline runs in a live process, so the reaper sees only runs of an older boot; A and B still apply |
| Other release callers (`:21228`, `:21269`, `:21300` in recovery passes; `:22128`, `:22146`, `:22160`, `:24413`, `:24905` inside `executeRunAttempt` on dispatch failure, reset or abort) | release on dispatch, reset, repair or abort outcomes | A |
| Writers that clear `issues.executionRunId` without promotion: issue status and assignee changes (`issues.ts`), tree holds (`issue-tree-control.ts`), membership removal (`access.ts`), watchdog, run dispatch, recovery resolution, execution-control reconciliation | clear the lock as part of an operator or domain action | not gated: the operator action wins. Step 4 re-reads the issue; if the lock no longer points at the stopped run, it classifies the run `superseded` and schedules nothing. The retry row's lock transfer is already conditional on the old holder (`:16916`) |
| New wakes from `enqueueWakeup` (comments, assignments, timers) | a new request, not a successor of this run (no `retryOfRunId`) | not gated: during a drain they stay queued behind the lock |
| Operator-chosen successors: resolving a recovery action (`execution-recovery-resolution.ts:263`), an authorized chat retry (`chat-channels.ts`) | an operator decision | not gated: an operator action wins, as today; step 4 then finds the successor and classifies `superseded` |

A test exercises each gated row (section 9).

**Concurrency.** At most 8 runs are stopped at a time, so the deadline does not
start dozens of terminations at once; each run's grace period still applies.

The process keeps running, with the drain on. The deploy job stops it when it
likes. Nothing else starts in between: `startNextQueuedRunForAgent` and
`sweepDeferredWakes` are suppressed during the drain.

**A stop before the deadline.** The shutdown loop also writes `planned_restart`
(not `server_shutdown_interrupted`) for a run that it ends while a
`planned_restart` drain is open. Today that loop writes no stop proof. Inside a
drain it writes `executionCancellation.state: "acknowledged"` after
`terminateHeartbeatRunProcess` returns for a real pid or process group, as
`cancelRunInternal` does. It then applies the class rules and the same proof rule,
and schedules the resume in place of the transient retry, with its existing lock
rule. In-process and remote runs that the loop cannot prove stopped go to
`reconciliation`. The process exits right after, so
the race above does not apply. Without a drain, shutdown is unchanged (section 5.1).

Why stop the runs at the deadline, and not at the stop: the stop is controlled by
the deploy job and the container runtime. A short stop timeout kills the process
before the sequential shutdown loop finishes (section 2.2), and those runs become
`process_lost`. Stopping them at the deadline, inside a live process, makes the
clean ending independent of the stop timeout.

### 4.3 The deploy hook contract

The deploy job calls these, in order:

1. **Start.** `POST /api/instance/task-drain`
   `{ "reason": "planned_restart", "graceMs": 300000 }` → `200`
   `{ drainId, reason, startedAt, deadlineAt, expiresAt, alreadyActive, upgradedFrom }`.
2. **Wait.** Poll `GET /api/instance/task-drain` every 5 seconds until `phase` is
   `quiescent` or `ended_at_deadline`.
3. **Stop** the app.

The status response adds `drainId`, `reason`, `deadlineAt`, `phase`, `liveRuns`,
`nativeRunnerRuns` and `plannedRestartRuns` (by class, section 4.5):

- `liveRuns`: this boot's runs in `running` status, read from the database, except
  native-runner runs.
- `nativeRunnerRuns`: native-runner runs, counted, not waited for (section 4.6).
- `phase`: `idle`, `draining`, `ending_at_deadline`, `quiescent`,
  `ended_at_deadline`.
- `quiescent` means **both** `liveRuns` is 0 and today's in-process counts
  (`activeRunExecutionPromises`, `activeWakeupPromises`) are 0. A row can reach a
  terminal status while its executor still finalizes (workspace sync, log upload);
  a stop at that moment would hit the 5-second finalizer timeout.
  `ended_at_deadline` uses the same rule after the deadline stop.

Authorization: an instance-admin board credential, or the existing Cloud control
assertion (`task-drain:read|start|stop`). An agent key never works.

**CLI** (wraps the same calls):

```
paperclipai instance drain start [--grace 5m] [--reason planned_restart|manual] [--ttl 35m]
paperclipai instance drain status [--json]
paperclipai instance drain wait [--timeout 7m] [--json]
paperclipai instance drain cancel
paperclipai instance drain run [--grace 5m] [--timeout 7m]   # start + wait, for scripts
paperclipai instance drain history [--limit 20]
```

Each HTTP request times out after 10 seconds. A failed poll is retried on the next
interval until `--timeout`. `--timeout` defaults to `graceMs` plus 2 minutes, so a
deadline that passes always ends the wait. `wait` follows the `drainId` it was
given (or read at its first poll). With `--json` the CLI prints one JSON line per
poll.

Exit codes a script can rely on:

| Code | Command | Meaning | What the deploy job should do |
|---|---|---|---|
| `0` | `wait`, `run` | Quiescent: every run finished in the grace period | Stop |
| `10` | `wait`, `run` | The deadline passed; the remaining runs were stopped as `planned_restart` | Stop |
| `20` | all | The request failed for a reason other than authentication: `409`, `422`, `5xx`, server unreachable on a `start` or `cancel` | Its own policy; a stop now loses runs as today |
| `21` | `wait`, `run` | No poll succeeded for `--timeout` (network) | Stop is allowed; the drain expires by itself |
| `22` | `wait`, `run` | The drain ended under the wait: cancelled, expired, or replaced by another `drainId` | Do not stop without a decision |
| `23` | `wait`, `run` | Polls succeeded, but `--timeout` passed before `quiescent` or `ended_at_deadline` (for example a stop at the deadline that has not finished) | Stop is allowed; say so in the job log |
| `24` | all | Any request returned `401` or `403` | Fix the credential; do not stop |

The codes are disjoint. Authentication is checked first: a `401` or `403` is
always `24`, on any command, and never `20`. Then, for `wait` and `run`: `22`
(the drain ended under the wait) before `21`, `23` and `20`. A deploy wrapper that
stops only on `0`, `10`, `21` or `23` never stops after a credential failure.

`start` and `cancel` exit `0` on success (including `alreadyActive`, and a cancel
with no drain open) and `20` on failure.

### 4.4 Data

**Run ending.** `heartbeat_runs.error_code` is free text, so the new code
`planned_restart` needs no migration. Status is `interrupted` (section 4.2). In
`run-failure-cause.ts` it maps to the existing cause `interrupted_graceful`
(question Q3), and `RUN_FAILURE_CAUSE_RULES_VERSION` is bumped, as that file
requires for a rule change. Every consumer of `server_shutdown_interrupted` gains
the new code next to it:

- `run-cancellation.ts` (cancellation `source: "shutdown"`, `expected: true`; the
  new code gets `source: "planned_restart"`);
- `heartbeat.ts` executor `finally` (`settleInterruptedNativeBootstrap`);
- `legacy-execution-recovery.ts` (the interrupted native-bootstrap check);
- `execution-recovery-resolution.ts` (the native-bootstrap failure block);
- the run-stop metadata.

`conversation-continuation.ts` already matches on `status = interrupted`, so it
needs no change.

**Drain record.** One new table, `instance_drains` (instance-level, like
`instance_settings`; it holds no company data):

| Column | Type | Note |
|---|---|---|
| `id` | uuid | `drainId` |
| `reason` | text | `planned_restart` or `manual` |
| `started_at`, `deadline_at`, `expires_at` | timestamptz | `deadline_at` is null for `manual` |
| `ended_at` | timestamptz | null while open |
| `end_reason` | text | `cancelled`, `expired`, `process_stopped`, `replaced` |
| `boot_id` | text | the process that opened it (`legacyControllerBootId`) |
| `closed_by_boot_id` | text | the process that closed it |
| `planned_restart_runs` | jsonb | counts by class: `resumed`, `reconciliation`, `native`, `no_issue` |
| actor columns | | as `activity_log`: actor type and id |

At most one open row (a partial unique index on `ended_at is null`). The in-memory
state is set from the row when the row is opened and cleared when it is closed.

**Who closes the row at a restart.** The old process closes it with
`process_stopped` in its shutdown handler, after the run loop. If the old process
was killed first, the new process closes every open row whose `boot_id` is not its
own, with `process_stopped`, as the first step of startup recovery: inside the
block that runs only when scheduling is **not** suppressed (`index.ts:1501`), and
before the reap (`index.ts:1554`), because D2 reads it there. A suppressed process
(a worktree instance, a database restore) never closes a row: it may share the
database with a live instance whose drain is open. It **never**
re-applies a drain from the table. A drain that survived a restart would hold
admission and skip startup recovery.

Why a table and not only memory: the alert (section 6) and the status need the
deadline; the history shows how often and how long the instance drained; and D2
needs to know that the last process stopped inside a drain (section 5.2). Why not
the `general` JSON: that is settings, not events, and it has no history.

### 4.5 Resume after restart

**Which runs are resumed.** A run stopped as `planned_restart` falls in one class:

| Class | Test | What happens |
|---|---|---|
| `resumed` | legacy run, has an `issueId`, and `legacyExecutionNeedsReconciliationWithEvidence` is false (a conversation-continuation adapter, or the provider never started) | one `planned_restart_resume` retry (below) |
| `reconciliation` | legacy run for which that gate is true, or any run whose stop is not proven | the recovery that applies to a restart-orphaned run (below). A planned restart does **not** bypass it: the run's tool actions may already have happened, and nothing proves otherwise |
| `operator_stop`, `superseded` | another writer ended the run or took the issue first (section 4.2.1) | nothing from this plan; the operator's action stands |
| `native` | `runtimeMode: "native"` (not the native runner) | its own fenced same-run recovery, unchanged |
| `no_issue` | no `issueId` (a timer heartbeat) | nothing; the next timer tick covers it |

**The decided restart rule (#99 and #104).** The manager decided the conflict
between #99 and #104 (landing order **#74 → #99 → #104**). For a run orphaned by a
restart:

- a **conversation adapter** gets the bounded transient retry (2 attempts), then
  the issue goes to `blocked` (#104);
- **every other adapter** keeps #99's one stable board-owned hold.

This plan follows that rule and adds one case before it: a `planned_restart` run
with a **proven stop** whose reconciliation gate allows a retry gets the
`planned_restart_resume`, which does not spend the failure budget. In practice
those are conversation adapters, plus runs that never started. Every other
`planned_restart` run, and every run whose stop is not proven, gets the decided
rule above: a conversation adapter gets #104's bounded retry, and any other
adapter gets #99's hold. The `reconciliation` row of the table means exactly that.

Chat-completion deliveries keep their own bounded retry. The status and the drain
row count the classes, so the operator sees how much work needed a hold. The
grace period makes all four classes small: most runs finish before the deadline.
How large `reconciliation` is in production is not known (question Q12).

**Path.** `scheduleBoundedRetryForRun`, the function the shutdown path and the
stranded-issue sweep already use, with a new retry reason `planned_restart_resume`,
delay 0, and the wake reason `planned_restart_resume`. It writes a
`scheduled_retry` row. After the restart, `promoteDueScheduledRetries` and
`resumeQueuedRuns` start it through the normal claim. No new dispatcher. Its
`retryOfRunId` dedup means the reaper, the shutdown loop and the stranded sweep
cannot schedule a second successor for the same run. The dedup returns **any**
existing successor, whatever its reason, so the resume must be the first successor
written. The stop intent of section 4.2 guarantees this: whichever path
writes the ending also writes the resume, before any release (section 9 tests
both branches).

**Slots and budget.** The claim enforces them: `startNextQueuedRunForAgent` checks
`maxConcurrentRuns`, and `claimQueuedRun` checks `budgets.getInvocationBlock` and
cancels the run on a hard stop, as for any queued run.

**Retry accounting.** `planned_restart_resume` follows the busy-wait pattern
(section 2.4), in all five places:

1. the `nonFailureLane` list in `executionRetryAccounting`;
2. `historicalFailureCount`, with a snapshot `failureRetriesBeforePlannedRestart`;
3. `executionRetryAttemptCount`, which counts consecutive `planned_restart_resume`
   attempts from `scheduledRetryAttempt`;
4. the exclusion in `accountingForScheduledRetry`;
5. the snapshot that `scheduleBoundedRetryForRun` writes into the retry's context.

So the resume does not raise `failureRetries`, `transientRetryBudgetSpent` stays
false, and the reconciliation gate's `>= 2` failure check is not reached by
restarts alone.

**Cap.** Three `planned_restart_resume` attempts in a row on one chain. On the
fourth, `scheduleBoundedRetryForRun` returns `retry_exhausted` for this reason, and
the caller explicitly falls back to the normal transient retry (and its budget), so
a loop of restarts ends in the existing escalation (question Q4).

**Note.** The resumed run's context carries
`resume: { reason: "planned_restart", interruptedRunId }`. The prompt builder adds
one line: "A planned restart interrupted your previous run on this task. Continue
from where it stopped." A wake that arrives during the drain can coalesce into the
resume row; `mergeCoalescedContextSnapshot` must keep `resume` and the wake reason.

**Ownership.** A run that was not the assignee's (a comment or review wake of
another agent) is resumed only if the existing ownership gate still allows it, as
for every retry. Otherwise that gate suppresses it, as today.

**Holds.** A pause hold, an operator Stop, a board-owned recovery action or a
paused agent keeps the resume parked, by the same checks that apply to every retry.
A drain is not one of these (section 6).

The resume row is written **before** the process exits, at the deadline or at the
stop. If the process dies before it writes the row, the run ends after the restart
as today (section 5.2), and the stranded-issue sweep is the net (section 5.3).

### 4.6 Native-runner runs

`drainRunningRunsForShutdown` detaches native `paperclip_runner` runs and the next
process re-attaches them. A drain does not wait for them and does not stop them.
The status counts them as `nativeRunnerRuns`, so the deploy job can see them.

## 5. Restarts without a drain, and the safety nets

### 5.1 An unplanned restart (crash, or a stop with no drain)

Unchanged. A `SIGTERM` with no drain open writes `server_shutdown_interrupted`. A
crash leaves `running` rows that the reaper ends as `process_lost`, or the stale
lock sweep ends as `orphaned_running_run`. These runs keep the bounded transient
retry and its budget (when the reconciliation gate allows it, section 2.5), and the
stranded-issue path (section 5.3).

The only change: `orphaned_running_run` gains a mapping to `interrupted_crash` in
`run-failure-cause.ts`, so it stops reading as `unknown`. This is a rule change, so
it shares the `RUN_FAILURE_CAUSE_RULES_VERSION` bump with section 4.4.

### 5.2 A planned stop that the server could not finish

If the process is killed during a drain before the deadline (a stop timeout shorter
than the grace period), some runs end after the restart as `process_lost` or
`orphaned_running_run`. Slice D2 classifies them. At startup, after it closes the
old rows and before the reap (section 4.4), the new process keeps the set of boot
IDs whose `planned_restart` row it closed with `process_stopped`. A run whose
`controllerBootId` is in that set and that the reaper ends gets the error code
`planned_restart`, so the counts are honest. Its recovery follows the class rules of
section 4.5 **and the same stop proof**: a hard kill usually leaves none, so such a
run gets the decided restart rule (#104's bounded retry for a conversation adapter,
#99's hold for any other). Only a run with a proof already on its row (an
acknowledgment, or a settled never-started receipt) gets the
`planned_restart_resume`. A run of a boot with no such row is unchanged
(`process_lost`).

### 5.3 The stranded-issue sweep is the net, not a second path

Another change (#104) fixes `reconcileStrandedAssignedIssues` so that an
`in_progress` issue with no live run is re-dispatched once or escalated, never left
invisible, under the decided rule of section 4.5.
This plan does not touch that sweep, and the resume is not a second path: both
reach `scheduleBoundedRetryForRun`, and its `retryOfRunId` dedup keeps one
successor per run.

One gap: the sweep calls `scheduleRecoveryRetry`, which schedules with the default
transient reason and so **spends the failure budget**. If a resume row is lost and
the sweep schedules the successor of a `planned_restart` run, it must pass
`planned_restart_resume` as the reason, **and only when the stop was proven**
(the same stop proof that section 4.2 step 4 defines: acknowledged, or never
started). A `planned_restart` run with no proof
goes to the `reconciliation` class and its existing hold, never to a resume:
its provider may still be working. The same rule applies to every fallback that
can see a `planned_restart` run (the D2 startup classification too). That is a one-line wiring change in
`heartbeat.ts` (where the sweep's `scheduleRecoveryRetry` is built), owned by this
plan's D1, so the other change does not need to know about it (question Q7).

## 6. A drain is not a hold, and a drain left on

A drain holds **admission for the whole instance** for minutes. It is not a hold on
a thing (an agent, an issue tree) with a lift condition, as in the holds plan
(#102). It does not use `hold_lift_conditions`.

A drain left on (the deploy job died after "start") is noticed in four ways, all in
D1:

1. **It ends by itself.** A `planned_restart` drain must have an expiry
   (`deadlineAt + 30 minutes` by default). At expiry the timer (section 4.1) lifts
   the drain, closes the row with `expired`, and writes the activity entry.
2. **An alert.** When `now > deadlineAt + 10 minutes` and the drain is still open,
   the attention feed shows a new source kind `instance_drain` in every company's
   feed, for instance admins only: "New runs are paused for a planned restart that
   has not happened. The drain lifts by itself at 12:35." Severity `high`. Verbs:
   **Lift drain** (the `DELETE`), **Dismiss**. It is derived on read from the open
   row, so it needs no stored alert. A `manual` drain gets no alert (it has no
   deadline); its banner shows how long it has been on.
3. **The banner** turns to the warning style (section 7.3).
4. **The log.** The timer writes one `warn` line at `deadlineAt + 10 minutes`.

## 7. Surfaces

### 7.1 API (all listed in OpenAPI)

| Method and path | Change | Who |
|---|---|---|
| `POST /api/instance/task-drain` | Body adds `reason` and `graceMs` (section 4.1). Response adds `drainId`, `reason`, `deadlineAt`, `alreadyActive`, `upgradedFrom`. `{ ttlMs }` alone still works as today | instance admin (as today) |
| `GET /api/instance/task-drain` | Response adds `drainId`, `reason`, `deadlineAt`, `phase`, `liveRuns`, `nativeRunnerRuns`, `plannedRestartRuns`. No actor fields | board access (as today), so the banner works for every board user |
| `DELETE /api/instance/task-drain` | Unchanged; closes the row with `cancelled` | instance admin (as today) |
| `GET /api/instance/task-drains` | New: the history, newest first, paginated, with actor fields | **instance admin only**: it shows who drained the instance and instance-wide counts |

`GET /api/health` does not get drain fields (question Q8). The OpenAPI entries get
real response schemas, not the generic `r.ok()`.

### 7.2 CLI

`paperclipai instance drain start|status|wait|cancel|run|history`, in the existing
`instance` command group (`cli/src/commands/client/access.ts`). Exit codes in
section 4.3.

### 7.3 Web

- **Banner**, in `Layout.tsx` next to `WorktreeBanner`, for every board user in
  every company while a drain is open: "New runs are paused for a planned restart.
  4 runs are finishing. Deadline 12:05." It turns to the warning style after
  `deadlineAt + 10 minutes`. Instance admins see **Lift drain**. Data: the existing
  query client reads `GET /api/instance/task-drain` every 60 seconds, and every
  5 seconds while a drain is open.
- **Control**, on the instance general settings page (instance admins): the drain
  status, **Start drain** (grace period choice, reason `manual` or
  `planned_restart`), **Lift drain**, and the history list.

### 7.4 Activity log

`activity_log.company_id` is required and there is no instance activity table. Each
drain event fans out one row per company in one transaction, as the task drain does
today:

| Action | Actor |
|---|---|
| `instance.task_drain.started` (exists; details add `reason`, `deadlineAt`, `upgradedFrom`) | the caller |
| `instance.task_drain.stopped` (exists) | the caller |
| `instance.task_drain.deadline_reached` (details: `plannedRestartRuns` by class) | system |
| `instance.task_drain.expired` | system |
| `instance.task_drain.closed_by_restart` | system, at shutdown or at startup |

The fan-out is one row per company per event; five event kinds keep it small. The
startup write is one transaction, and it only runs when an open row exists.

Each `planned_restart` run also writes a run event, and its resume writes the
normal retry event, in the run's own company.

## 8. Slice plan

| Slice | Content | Depends on |
|---|---|---|
| **D1** | `instance_drains` table and migration; `reason`, `graceMs`, deadline and expiry, and the timer that owns them; the start/upgrade rules; the deadline stop through `cancelRunInternal` with the planned-restart stop intent honoured by both finalize paths (section 4.2), and the shutdown ending inside a drain; the two choke points of section 4.2.1; `planned_restart` code, its consumers and the cause-rules bump; the run classes with the decided restart rule; the `planned_restart_resume` retry reason in all five accounting places, the cap and the fallback; the stranded-sweep reason wiring (section 5.3); the resume note; the `instance_drain` attention item; API and OpenAPI; CLI `instance drain` with the exit codes; web banner and control; activity entries | #74, #99 and #104 merged |
| **D2** | Startup classification of runs killed during a drain (section 5.2); `orphaned_running_run` cause mapping; `stop_grace_period` in `deploy/compose.yaml` (question Q9) | D1 |

**Order: #74 → #99 → #104 → D1 → D2.** D1 depends on all three:

- #74's deferred-wake sweep and its holds are what choke point A must not bypass;
- the `reconciliation` class hands runs to #99's stable hold and to #104's bounded
  retry, so both behaviours must be on `main` for D1's tests to assert them;
- the stranded-sweep wiring of section 5.3 edits the sweep that #104 changes.

D2 depends on D1. D1 is useful alone: the deploy job can drain, and the runs end
clean and resume.

## 9. Verification per slice

D1, embedded Postgres unless noted:

- A drain start holds admission; a queued run does not start; a wake that arrives
  stays queued; cancel lets it start.
- The start table of section 4.1, one test per row, including the upgrade from
  `manual`, the `409` and the `422`; `{ ttlMs }` alone still replaces a `manual`
  drain as today.
- **The deadline race, both branches.** (a) A child-process adapter run and (b) an
  in-process-stop adapter run (the acpx engine) are stopped at the deadline. For
  each: the row ends `interrupted` / `planned_restart` (not `failed` or
  `cancelled`), the stop metadata outcome is `interrupted`, exactly one successor
  exists and it is `planned_restart_resume` (not a recovery run or
  `transient_failure`), and the issue lock has moved to the resume row. (c) A run
  that is claimed but still preparing is fenced and resumed on its never-started
  proof. (d) A remote ACP run whose
  stop is proven (the acknowledgment arrives at its lease release) gets the resume.
  (e) A remote ACP run whose stop is not proven gets no resume, lands in
  `reconciliation`, and the deadline caller sees no `409`. (f) The executor's late
  release in its `finally` block does not clear the lock or promote a deferred wake
  while the intent is set.
- **Every gated path** of section 4.2.1, one test each: with an undecided intent on
  the run, (a) `cancelActiveForAgent` (an agent pause) races the deadline: if it
  wins, the run is `cancelled`, the deferred wake is **not** promoted before
  step 4, and step 4 classifies `operator_stop` and releases as today; if the
  deadline wins, the pause cancels nothing and the resume holds the lock;
  (b) a budget pause (`cancelBudgetScopeWork`), the same; (c) the provider-capacity
  stop, the reaper and the stranded sweep each get `not_scheduled` from choke point
  B; (d) a direct call to `releaseIssueExecutionAndPromote` returns without
  releasing, and the executor's late path with a pending queued-comment interrupt
  neither releases nor resumes the interrupt until step 4; (e) an issue closed or reassigned during the deadline stop makes step
  4 classify `superseded` and schedule nothing. For each: at most one successor
  exists, and when it exists it is the `planned_restart_resume`.
- **The decided restart rule, across PRs** (after #99 and #104 are on `main`): a
  `planned_restart` conversation-adapter run with a proven stop gets the
  `planned_restart_resume`, not #104's bounded retry; with no proof it gets #104's
  bounded retry, then `blocked`; a non-conversation run gets #99's stable hold
  whether or not the stop is proven.
- **No promotion into the lock.** An issue with a parked deferred wake: after the
  deadline stop, the wake is still parked and the lock is not held by a new run;
  after the restart, the resume runs first.
- At the deadline, a native-runner run is not stopped; `phase` becomes
  `ended_at_deadline` only after the in-process counts reach 0.
- **Classes.** A conversation-continuation run gets the resume. A legacy run that
  needs reconciliation gets the existing hold and no resume. A run with no
  `issueId` gets nothing. The status counts each class.
- A `SIGTERM` during a `planned_restart` drain writes `planned_restart` with the
  acknowledged proof for a child-process run, which is resumed, and sends an
  in-process or remote run to `reconciliation`; without a drain it writes
  `server_shutdown_interrupted` (unchanged).
- After a simulated restart (new service instance, open row of another boot): the
  row closes with `process_stopped` before the reap; a suppressed process (worktree
  flag set) leaves the row open; the in-memory drain is off,
  startup recovery runs, the resume starts on the same issue with the note,
  `failureRetries` is unchanged, `transientRetryBudgetSpent` stays false, and the
  reconciliation gate does not trip.
- A wake that coalesces into the resume row keeps `resume` and the wake reason.
- The resume waits for a free slot (agent at `maxConcurrentRuns`) and is cancelled
  by a budget hard stop, as any queued run.
- The cap: a fourth `planned_restart` in a row on one chain falls back to the
  transient retry.
- The stranded sweep, given a `planned_restart` run with no successor and a proven
  stop, schedules `planned_restart_resume`, not `transient_failure`. Given one
  with no proof (a timed-out wait), it schedules nothing and the run gets the
  reconciliation hold.
- The timer: deadline, alert and expiry fire once each, write their activity rows,
  and close the row on expiry. The alert appears only for instance admins and
  disappears when the drain lifts.
- Authorization: an agent key and a non-admin board user get `403` on writes and on
  the history; the Cloud control assertion works on the three methods; another
  company sees only its own activity rows.
- CLI: each exit code from a stubbed server (`0`, `10`, `20`, `21`, `22`, `23`,
  `24`), and the 10-second request timeout.
- Web: the banner shows and hides (desktop and mobile widths, no console errors),
  the control starts and lifts a drain.
- Tests that do not need embedded Postgres go on the Dockerfile `vitest run` list.
  The embedded-Postgres suites cannot run as root in the image build; they follow
  the shared non-root CI job proposed as #74's follow-up F1.

D2:

- **Proven stop.** A run of a boot whose `planned_restart` row was closed at
  startup, found by the reaper, with an acknowledgment or a settled never-started
  receipt on its row: `planned_restart`, and the `planned_restart_resume` when its
  class allows.
- **No proof (the important case).** The container stop kills the process during
  the drain, before any acknowledgment or settled receipt (a stop timeout shorter
  than the grace period): the run gets `planned_restart` as its code but **no**
  resume. A conversation adapter gets #104's bounded retry, any other adapter gets
  #99's hold. The test asserts that no `planned_restart_resume` row exists.
- A run of a boot with no drain row gets `process_lost` (unchanged);
  `orphaned_running_run` classifies as `interrupted_crash`.
- The real two-stop sequence (the backup stop, then the restart) is an integration
  dependency outside this repository: it gains nothing unless the deploy job drains
  before **each** stop.

## 10. Alternatives considered

| Alternative | Why not |
|---|---|
| A new drain mode next to the task drain | Two admission switches for one need. The task drain already holds admission correctly, including queued wakes |
| End the runs only at the stop | The stop timeout is outside the server's control; a short one turns the clean ending into `process_lost` (section 2.2) |
| Reuse the shutdown loop at the deadline | It races the executor in a live process (section 2.2); `cancelRunInternal` is the live-process path |
| Call `cancelRunInternal` with options only | Its in-process-stop branch lets the executor write the ending and queue a recovery run, and its release promotes a deferred wake into the lock first (section 4.2); a stop intent that every finalizer honours is needed |
| Persist the drain and re-apply it after a restart | A drain that survives the restart would skip startup recovery and hold admission with no deploy job left to lift it |
| Resume every interrupted run | A run that needs reconciliation may have done its tool actions already; running it again could repeat them (section 2.5) |
| Resume through a new wake and not a retry row | A second dispatch path. The retry row already has the issue, the agent and the slot and budget checks at claim |
| Count the resume in the failure budget | Three deploys in a row escalate a healthy issue (section 2.4) |
| Model the drain as a hold (#102) | A hold targets one thing and waits for a condition; a drain targets admission for minutes and ends with the process |

## 11. Open questions, each with a recommendation

- **Q1. Where runs end: at the deadline, or at the stop?** Recommend: at the
  deadline, in the live process, through `cancelRunInternal` (section 4.2), plus the
  shutdown ending inside a drain for a stop before the deadline.
- **Q2. Durable drain record?** Recommend: the small `instance_drains` table
  (section 4.4). Memory-only cannot classify runs killed during a drain (D2) and has
  no history.
- **Q3. Failure cause for `planned_restart`?** Recommend: map to the existing
  `interrupted_graceful`, so the observability taxonomy (#70) does not change;
  split by `error_code` where needed. Alternative: a new cause `interrupted_planned`,
  which needs a change to the run-usage records and their docs.
- **Q4. How many resumes?** Recommend: one per `planned_restart` ending, with a cap
  of 3 in a row on one retry chain; after that, an explicit fallback to the normal
  transient retry and its escalation.
- **Q5. Grace and timing defaults?** Recommend: grace 5 minutes (maximum 30), expiry
  `deadline + 30 minutes`, alert at `deadline + 10 minutes`, poll every 5 seconds,
  at most 8 runs stopped at a time.
- **Q6. Native-runner runs?** Recommend: not stopped and not waited for; counted as
  `nativeRunnerRuns` in the status.
- **Q7. Stranded-issue sweep.** Decided by the manager: #104 lands before D1
  (order #74 → #99 → #104 → D1). D1 owns the one-line wiring that makes the sweep
  schedule `planned_restart_resume` for a `planned_restart` predecessor with a proven
  stop (section 5.3); otherwise the sweep applies #104's decided rule. Choke point B
  and the `retryOfRunId` dedup prevent a double successor.
- **Q14. A board pause or budget stop that races the deadline?** Recommend: the
  first terminal write wins, as today. If the operator's write wins, the run is
  `operator_stop`: no resume, and its release runs at step 4 with today's options,
  so the deferred wake is promoted only once and only after the decision
  (section 4.2.1).
- **Q8. Drain state on `GET /api/health`?** Recommend: no. The health route is
  public. The deploy job uses the authorized `GET /api/instance/task-drain`.
- **Q9. `stop_grace_period` in `deploy/compose.yaml`?** Recommend: set it in D2 to
  the longest adapter `graceSec` plus 30 seconds (for example 60 seconds), as the net
  for a stop with no drain. The deploy job's own stop timeout must also be at least
  that; it is outside this repository.
- **Q10. Deploy job credential?** Recommend: the existing Cloud control assertion
  where the instance has a Cloud identity; otherwise an instance-admin board API key
  stored as a deploy secret. Never an agent key.
- **Q11. Status of a run stopped at the deadline?** Recommend: `interrupted`,
  through the stop intent and a `terminalStatus` option on `cancelRunInternal`
  (section 4.2), with the stop metadata outcome following it. `cancelled` would
  read as an operator decision, and the conversation-continuation rule matches
  `interrupted`. Alternative: keep `cancelled` and teach each consumer about
  `planned_restart`; more places to change.
- **Q12. Runs that need reconciliation?** Recommend: keep the existing hold; a
  planned restart does not bypass it. Before D1 is built, measure in production how
  many of the restart-ended runs had a conversation-continuation policy (a
  read-only query), so the expected benefit is known. If most runs need
  reconciliation, the grace period, not the resume, carries the benefit.
- **Q13. A `planned_restart` start on an open `manual` drain?** Recommend: upgrade it
  (section 4.1), so a deploy that finds an operator's drain still gets a deadline
  and a clean ending. The upgrade is logged with `upgradedFrom`.

## Appendix A. Code anchors on `main` at `38819d350`

The captain's review verified every anchor below as true at `38819d350`. Section
4.2.1 cites `main` at `d47df97f0` (after #28 and #86), where `heartbeat.ts` moved by
about 30 to 50 lines; names are unchanged.


| Fact | Where |
|---|---|
| Task-drain state and status | `server/src/services/heartbeat.ts:1404-1486` (`taskDrainState`, `readTaskDrain`, `startTaskDrain`, `stopTaskDrain`, `getTaskDrainStatus`) |
| Admission switch | `heartbeat.ts:9781` (`resolveHeartbeatSchedulingSuppression`); the `task_drain` check `:9801` |
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
| Retry accounting that does not spend failures | `server/src/services/execution-recovery-attempt.ts`: `historicalFailureCount` `:29-40`, `nonFailureLane` `:45`, `executionRetryAttemptCount` `:59-65`, `accountingForScheduledRetry` `:67-72`; the snapshot written by `scheduleBoundedRetryForRun` `heartbeat.ts:16343-16351` |
| Reconciliation gate for a retry | `server/src/services/legacy-execution-recovery.ts:19-56` (`legacyExecutionNeedsReconciliation`); refusal in `scheduleBoundedRetryForRun` `heartbeat.ts:16224-16233`; native and chat exclusions `:14802-14808` |
| Child-process stop acknowledgment | `heartbeat.ts:31676-31685` (written with the ending at `:31656`, after termination `:31603-31614`); none in the shutdown loop `:15593-15608` |
| Never-started proof | settled receipt `startupPreparationSettledAt` `heartbeat.ts:28360-28369` (written only for `cancelled` today); bootstrap evidence `legacy-execution-recovery.ts:52-55`; the startup-cancellation fence `:31515-31527` is the request, not the proof |
| Live-process stop | `heartbeat.ts:31460` (`cancelRunInternal`), options `:31438-31447` (`errorCode`, `suppressImmediateRecovery`, `terminationGraceMs`); settlement map `:1370`, used by the executor `:26938` |
| Settlement only for child-process adapters | `heartbeat.ts:31545-31550` (`!control`); in-process stop handle registered at `:26586` (`onCancellationReady`); the control branch returns when the executor already finalized `:31628-31646` |
| Executor's own release (no suppression for a stop) | `heartbeat.ts:27445-27452` |
| Shutdown keeps the lock when a retry is scheduled | `heartbeat.ts:15629-15634` |
| The retry row takes the issue lock in its own transaction | `heartbeat.ts:16879-16902` |
| Stop proof: conflict when not acknowledged; remote acknowledgment only for `cancelled` | `heartbeat.ts:31626-31643`; `acknowledgeRemoteStop` `:10634-10657`, called from the lease release `:10631` in the executor's `lease_release` phase `:28284` |
| Executor's late release in `finally` | `heartbeat.ts:28383-28395` |
| A late release cannot promote past a live successor | wake-queue `adapters/postgres.ts:1229-1236`, `:1283-1290` |
| Release promotes the next deferred wake | wake-queue `application/use-cases.ts` (`runReleaseDrain`), lock write in `adapters/postgres.ts` |
| Retry dedup by `retryOfRunId` | `heartbeat.ts:16446-16461` (returns any existing successor, whatever its reason) |
| Consumers of `server_shutdown_interrupted` | `run-cancellation.ts:50`; `heartbeat.ts:28354`; `legacy-execution-recovery.ts:190`; `execution-recovery-resolution.ts:501`; `conversation-continuation.ts:80` (matches status) |
| Periodic recovery gated on suppression | `index.ts:1827`; timers return early `heartbeat.ts:32304-32311` |
| Cause-rules version | `packages/shared/src/run-failure-cause.ts:26` |
| Stranded-issue sweep and its re-dispatch | `recovery/service.ts:4409` (`reconcileStrandedAssignedIssues`), `:1900` (`enqueueStrandedIssueRecovery`), budget-spent escalation `:1949-1961`; wiring `heartbeat.ts:9904-9924` |
| Startup recovery order; skipped while suppressed | `index.ts:1497-1637` (`:1501`) |
| Scheduled retries promoted | `heartbeat.ts:17460` (`promoteDueScheduledRetries`) |
| Activity log is company-scoped | `packages/db/src/schema/activity_log.ts:10` |
| Banners | `ui/src/components/Layout.tsx:636-637` |
| Attention source kinds | `packages/shared/src/types/attention.ts:8` |
| Instance CLI group | `cli/src/commands/client/access.ts:265-283` |
| Compose: no stop grace period | `deploy/compose.yaml:4`, `:40-45` |
| Hot-restart path | `cli/src/commands/service.ts:204`; `index.ts:2005-2007` |
