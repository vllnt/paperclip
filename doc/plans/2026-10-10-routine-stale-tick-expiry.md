# Routine stale-tick expiry: a stuck tick must not block every later tick

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
Branch: `docs/routine-stale-tick-expiry`
Code anchors: `main` at `38819d350` (see Appendix A). Line numbers drift; names do not.

## 1. Goal and constraints

A routine fires a *tick*. Each tick creates one issue and wakes the assignee agent.
The routine setting `concurrencyPolicy` decides what a new tick does while an earlier
tick issue is still active:

- `skip_if_active` drops the new tick (the run is recorded as `skipped`);
- `coalesce_if_active` merges it into the active issue (`coalesced`);
- `always_enqueue` never blocks.

An operator reports that one tick issue left without progress for 60 minutes or more
blocks every later tick of that routine. Nothing expires it, so the routine stays
quiet until a person notices.

**Goal.** A routine can carry a timeout. When a blocking tick has made no progress for
that long, the system expires it *visibly* (a reason and an activity entry) and the
next tick runs. The system never expires a tick that is waiting for a good reason:
a hold, a wait, a pending decision, a board recovery action.

Constraints, all binding:

- **Company scope.** Every row, query and API call is company-scoped.
- **Web, API (listed in OpenAPI) and CLI** for every capability, in the same slice or
  with a named follow-up. Parity of surfaces is not parity of permissions.
- **Every mutation writes an activity log entry**, including the ones the system makes.
- **No new permission.** Section 3.7.
- **No new telemetry event.** Expiry writes to the instance's activity log only. It does
  not touch the first-party telemetry path or the OpenTelemetry path.
- **Fail open.** If the check fails, the tick behaves as it does today.
- **Additive, just-in-time migration.** One nullable column on `routines`. The number is
  assigned just in time, when the slice is next to land.
- **Public repository.** No instance, host or company names in this document.

Not in scope:

- Re-dispatching an assigned issue that has no live run. That is PR #104. This plan
  runs after it (section 3.5).
- Holds and their lift conditions. That is PR #102. This plan obeys holds and
  never lifts one.
- Changing what `concurrencyPolicy` means for a healthy tick.
- Stale locks that point at a finished run. The stale-lock sweep already clears them.

## 2. How a tick blocks the next one today

Verified by reading `main`. **Not reproduced**: no test or production data confirms the
state that the report describes (see Q1 in section 7).

The dispatch decision is in `dispatchRoutineRun` (`routines.ts`). It holds a row lock
on the routine, then asks `findLiveExecutionIssue` for a *blocking* issue. An issue
blocks only if all of these hold:

- its `origin_kind` and `origin_id` match the dispatch origin. That is `routine_execution` and the routine id. A managed plugin routine on the `plugin_operation` surface uses `plugin:<key>:operation` and the template's origin id (`routines.ts:1770-1773`);
- its status is open (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`);
- it is not hidden;
- it matches the tick's dispatch fingerprint (webhook ticks can differ by payload);
- **a heartbeat run in status `queued`, `running` or `scheduled_retry` is attached to
  it**, through `issues.execution_run_id` or through `contextSnapshot.issueId`.

So the state matters. The table lists the states a tick issue can be in.

| State | Blocks the next tick? | Who clears it today |
|---|---|---|
| **S1.** Open issue, with a `queued` or `scheduled_retry` run that never starts (agent cannot start, wake held, retry far away) | **Yes.** The run counts as live. | Nobody, unless the agent starts. A `queued` run is "legitimately waiting" for the orphan reaper |
| **S2.** Open issue, with a `running` run whose process is gone | Yes, until the reaper acts | The orphan reaper and the stale-lock sweep, after a staleness threshold |
| **S3.** Open issue, `execution_run_id` points at a finished run | No at dispatch. The next tick's issue is created. Its checkout through the route can then fail with a 409 on `issues_open_routine_execution_uq`. The claim path, which binds the lock for a wake, was not traced | The stale-lock sweep clears the lock |
| **S4.** Open issue with **no run and no lock** | **No.** `findLiveExecutionIssue` finds nothing, so the next tick creates another issue. Open ticks pile up | Nobody. PR #104 re-dispatches an assigned issue with no live run |

Two findings follow:

1. The report says "an issue with no run blocks later ticks". On `main`, exactly that
   state (S4) does *not* block. The blocking states are S1, and S2 for a short time.
   The plan therefore defines staleness on the blocker that dispatch returns, and it
   asks for production data before any code (Q1, Appendix B).
2. S1 is the gap. The run is "live" by status, so neither the reaper nor PR #104 acts
   on it, and `findLiveExecutionIssue` keeps returning the issue.

## 3. Design

### 3.1 Principle: expire at dispatch, under the lock that dispatch already holds

Slice 1 adds no job. The check runs inside `dispatchRoutineRun`, after
`findLiveExecutionIssue` returns a blocker and before the tick is skipped or coalesced.
Dispatch already holds the routine row lock, so two ticks cannot expire the same issue,
and the new tick runs in the same call.

Why not a sweeper: a sweeper needs the hold rules, the ordering with PR #104 and its
own alert. A routine only suffers when a tick arrives. The lazy check fires exactly then.
Visibility *between* ticks comes from the preview (section 3.6), not from a job.

### 3.2 Data model: one nullable column

`routines.stale_tick_timeout_minutes integer null`.

- `null` means off. This is the default, and no existing routine changes.
- A value is a whole number from **30** to **10080** (7 days). The range is enforced by
  the shared validator, not by the database, so a later change needs no migration.
- The routine revision snapshot (`RoutineRevisionSnapshotV1`) gains the optional field
  `staleTickTimeoutMinutes`. Old snapshots do not have it. **Restoring an old revision
  sets the column to `null`**, which is faithful: the setting did not exist then.

No new table. No instance setting in slice 1 (Q2).

### 3.3 What "stale" means

A blocking tick issue is **stale** when all of these hold:

1. The routine's policy is `skip_if_active` or `coalesce_if_active` (Q3), the routine
   has a timeout, and the blocker is a `routine_execution` tick issue. Managed plugin
   routines (`plugin:<key>:operation`) are left to R3 (Q10): the unique index and the
   run-status sync below do not cover them.
2. The issue is the blocker that `findLiveExecutionIssue` returned for this tick.
3. **No run of the issue is `running`.** A running run belongs to the orphan reaper and
   the silent-run watchdog (Q6).
4. **No progress for the timeout.** Progress is the latest of: a run of the issue
   reaching `running` (its `started_at`), any comment on the issue, an issue status
   change, and the issue's creation. The `issues` table keeps no status-change time, so
   R1 reads it from the activity log (`issue.updated` entries that change `status`). A wake that is queued again, or a re-dispatch by
   PR #104, is **not** progress. Without this rule, a loop of failed wakes would reset
   the clock for ever.
5. **Not held and not waiting** (the exemptions below).
6. **Nothing holds it now.** The exemptions below are checked at the moment of the
   tick. A hold that was lifted earlier is not remembered (the known gap in section 3.5).

**Exemptions.** The tick is never stale while any of these is true. In each case the
silence is explained, and expiry would destroy a waiting state:

| Exemption | Signal on `main` |
|---|---|
| An armed issue monitor or wait | `issues.monitor_next_check_at` is not null |
| A board or agent recovery action is open on the issue | an `issue_recovery_actions` row with status `active` or `escalated` |
| A held scope: the routine is paused, or its project, company or assignee agent is paused | `routines.status`, `projects.paused_at`, `companies.paused_at`, `agents.paused_at` (the scheduler already reads the project one) |
| The issue sits in an issue-tree hold | the tree-hold check that automatic recovery already uses |
| A pending decision | a pending issue-thread interaction, or an `in_review` stage with a pending participant |
| The assignee is over budget | the budget hard-stop check that wake dispatch already uses |
| A deferred wake waits for the issue's own lock | an `agent_wakeup_requests` row in `deferred_issue_execution` |

This list is long on purpose. The cost of a false expiry (cancelled work) is higher than
the cost of a late one.

### 3.4 What expiry does

Expiry is one function, used by dispatch and by the manual action (section 3.6). In order:

1. **Re-check under the issue's own lock** that no run became `running` and no exemption
   appeared. If one did, abort. The tick is skipped or coalesced as before.
2. **Cancel the issue's live runs** (`queued`, `scheduled_retry`) with the reason
   `routine_tick_expired`, and with the flag that suppresses automatic continuation.
   Cancelling the issue's status alone is not enough: the run cancel for a cancelled
   issue lives in the **route layer** (`shouldCancelActiveRunForCancelledStatus`), not
   in the issue service. The route finds only the run in `execution_run_id` or the agent's *running* run
   (`resolveActiveIssueRun`), so it would miss a `queued` run that is bound only through
   `contextSnapshot.issueId` (state S1). The issue service cancels only a native-question
   run (`executeIssuePostCommitActions`). The expiry function calls the heartbeat cancel
   directly.
3. **Set the issue to `cancelled`** through the issue service, and add a system comment:
   the timeout, the last progress time and the run states that were found.
4. **End the originating routine run the way a cancelled tick issue ends it.** Call
   `routinesSvc.syncRunStatusForIssue(issueId)`. The issue routes call it after a status
   change, but the issue service does not, so expiry must call it. For a cancelled issue
   it sets the run to `failed`, with the existing cancelled-issue reason and a
   `transientFailure` payload. Then add `triggerPayload.tickExpired =
   { source, timeoutMinutes, expiredAt }`. No new run status is added, and no custom
   reason text. Reusing the sync also keeps a later route-driven change (a reopen, for
   example) consistent, because the same function handles it (Q7).
5. **Write the activity entries** (section 3.8).
6. Return to dispatch, which looks for a blocker again, finds none, and creates the new
   tick's issue in the normal way. The new tick is **not** recorded as `skipped`.

Expiry never deletes an issue, a run or a comment.

### 3.5 Order with the other recovery paths, and with holds

When a tick looks stuck, the paths act in this order. The first one that applies wins.
Each later one sees the result of the earlier ones.

| Order | Path | Handles | Leaves for the next |
|---|---|---|---|
| 1 | Orphan reaper, silent-run watchdog | A `running` run (S2) | Everything else |
| 2 | Stale-lock sweep (`sweepStaleIssueLocks`) | A lock that points at a finished run (S3) | |
| 3 | **PR #104 re-dispatch** | An assigned open issue with **no live run** (S4). It wakes the issue within one sweep interval plus a grace period | An issue whose wake produced a run that never progresses (S1) |
| 4 | **PR #102 holds** | A held scope. Nothing below runs for it | |
| 5 | **This plan** | S1: a live-status run with no progress for the timeout | |

Two rules make the ordering hold:

- **PR #104 goes first.** The minimum timeout (30 minutes) is larger than any
  re-dispatch grace period, and re-dispatch is not progress (section 3.3, rule 4). So
  an S4 issue is re-dispatched. It is expired only if the wake it gets still produces
  nothing for the whole timeout.
- **A held routine never expires a tick.** The exemption check is what guarantees it,
  for every way a tick can arrive. The scheduler already stops some ticks first: it
  selects only routines with `status = 'active'` (`routines.ts:3197`), and for a paused
  project it records the run as `skipped` with the last-run label `skipped_paused`
  (`routines.ts:3212`, `3251`). But manual, API, webhook and pipeline-stage dispatch do
  not check the project pause (`runRoutine`, `runPipelineStageEntryRoutine`, and the
  active check in `dispatchRoutineRun` that applies to webhook and schedule only). So
  the exemption must hold on its own.

**Known gap: a lifted hold is not remembered.** Agents, companies and projects have
`paused_at`, and a routine will have one after PR #102 slice H2. None of them keeps
the time a hold *ended*. So R1 checks holds only at the moment of the tick. A tick
issue that waited out a hold, longer than the timeout, can expire on the first tick
after the hold lifts.

R1 accepts this gap, for these reasons:

- The timeout is opt-in (default off), and the minimum is 30 minutes.
- Only a tick with **no progress at all** can expire. The next tick recreates the same
  work at once, so no work is lost.
- The activity entry records the expiry and the run states, so the case is visible.

The fix is to read a lift time once one exists for every hold. Q11 asks the reviewer to
confirm that this is enough for R1.

### 3.6 Surfaces

**API** (every route listed in OpenAPI, company-scoped):

| Route | Purpose |
|---|---|
| `POST /companies/:companyId/routines`, `PATCH /routines/:id` | Accept `staleTickTimeoutMinutes` (`null` or 30..10080). The response returns it |
| `GET /routines/:id`, the routine list item | Add `blockingTick`: `{ issueId, state, lastProgressAt, staleAt, exempt }`, where `exempt` names the exemption or is `null` |
| `GET /companies/:companyId/routines/stale-ticks` | **Preview.** Every routine whose blocking tick is past its timeout or would be, with the reason it is exempt. Read only |
| `POST /routines/:id/ticks/expire` | **Manual expire** (slice R2). Body `{ issueId, reason }`. Ignores the timeout. Refuses (409) when a run is `running` |

**CLI.** The setting goes through the existing generic path
(`routine create` and `routine update` with `--payload-json`, `routine-api.ts`). Two new
commands: `routine ticks:stale` (the preview) and `routine tick:expire <routineId>`.

**Web.** In the routine edit form, next to the concurrency policy: a field "Expire a
stuck tick after (minutes)", empty means off, with help text that says what counts as
stuck. On the routine list and detail pages: a "Blocked by a stuck tick" badge with
the age, the exemption if any, and an **Expire** button. The routines page gets a
"Stuck ticks" filter backed by the preview.

### 3.7 Authorization: no new permission

- **Setting the timeout** needs the routine's existing manage check
  (`assertCanManageExistingRoutine`) **and a board user** (Q4). The assignee agent can
  manage its own routine today, but it should not be able to set a timer that cancels
  issues. This is the same stance as `auto_lift` in PR #102.
- **Manual expire** is a board action in company scope.
- **Reading** the preview and `blockingTick` follows the routine read check.
- The system's own expiry runs as the actor `routine-scheduler`, like the existing
  `routine.run_triggered` entry.

### 3.8 Activity log

| Action | When | Entity |
|---|---|---|
| `routine.updated` (existing) | The setting changes. `details` carry the old and the new value | routine |
| `routine.tick_expired` | A tick is expired by the timeout (`source: "timeout"`) or by a board user (`source: "manual"`) | issue, with `routineId`, `routineRunId`, `timeoutMinutes`, `lastProgressAt`, `runStatuses`, `cancelledRunIds`, `nextRunId` |
| `routine.revision_created` (existing) | The setting changes, because it is part of the snapshot | routine |

The issue also gets the system comment from section 3.4. The run event of each
cancelled run carries the reason `routine_tick_expired`.

### 3.9 Edge cases

| Case | Behavior |
|---|---|
| A webhook tick has a different fingerprint than the blocker | `findLiveExecutionIssue` already matches by fingerprint. Only the blocker for the same fingerprint can expire |
| A run turns `running` between the check and the cancel | The re-check in section 3.4 step 1 aborts the expiry |
| Two ticks arrive together | The routine row lock serializes them. The second finds no blocker |
| `coalesce_if_active` ticks that merged into the expired issue | Their rows keep `coalescedIntoRunId`. They are history; nothing changes |
| The routine's project is paused | A scheduled tick is recorded as `skipped` (label `skipped_paused`) before any expiry check. A manual, API or webhook tick reaches the check, and the "held scope" exemption stops it |
| The cancel throws | The tick falls back to skip or coalesce. The failure is logged and recorded in a `routine.tick_expiry_failed` activity entry. The next tick tries again |
| The setting is lowered below the age of a blocker | The next tick expires it. That is the intent |
| `always_enqueue` | Never blocks. The setting is stored but has no effect, and the form says so |

## 4. Slice plan

| Slice | Content | Surfaces |
|---|---|---|
| **R1** | The column (migration), shared validator and snapshot field, the staleness function, dispatch-time expiry, the `blockingTick` field, activity entries | API (PATCH and read), CLI (`--payload-json`), web (the form field) |
| **R2** | The preview route, the manual expire route, the badge and button, the "Stuck ticks" filter | API, CLI (`ticks:stale`, `tick:expire`), web |
| **R3** | Managed and plugin routine manifests may set the timeout. An instance-wide default, only if the preview data from R1 and R2 supports one | API, CLI, web |

R1 is the only slice with a migration. Parity: R1 ships the setting on all three
surfaces. R2 is the named follow-up for the preview and the manual action.

## 5. Verification per slice

**R1**, on embedded Postgres unless noted:

- The staleness function, as a pure table test: every exemption, the clock rules, the
  `running` exclusion, the held-now rule.
- A stale `queued` run: the tick expires it, cancels the run with no continuation wake,
  and the new tick creates one issue and one live run. **Red at `main`:** the tick is
  skipped.
- A stale `scheduled_retry` run: same.
- Each exemption: the tick is skipped as before (one test per row of section 3.3).
- An S4 issue (no run): PR #104's re-dispatch acts, and expiry does not.
- A re-dispatch does not reset the progress clock.
- A held agent, project or company: no expiry while it is held.
- The re-check race: a run that becomes `running` aborts the expiry.
- A routine with `null` timeout: behavior is identical to `main` (a regression test).
- Revision snapshot: an old snapshot restores to `null`. A new one round-trips.
- Validation: 29, 30, 10080, 10081, a string, a negative number.
- Company scope: a routine of another company returns 404.
- Activity: `routine.updated` on change, `routine.tick_expired` on expiry, the system
  comment, and the originating run ended by `syncRunStatusForIssue` with `tickExpired`
  in its payload. A later reopen of the expired issue leaves the run consistent.
- OpenAPI listing test and the CLI parity test still pass.
- The new database tests are listed in the PR body. They cannot join the `Dockerfile`
  `vitest run` list.

**R2:** the preview matches the dispatch decision for the same fixtures (one shared
function). Manual expire: board only, 409 on a `running` run, one activity entry. UI
component tests for the badge and the button.

**R3:** manifest validation, and the default-value behavior if a default ships.

## 6. Alternatives considered

| Alternative | Why not |
|---|---|
| A sweeper job that expires stale ticks on a timer | More moving parts (hold rules, ordering, alert), and it acts when no tick waits. The lazy check acts when it matters. A sweeper can come later if the preview shows blocked routines that no tick reaches |
| Make `findLiveExecutionIssue` ignore a live run that has not started | Changes the meaning of "live" for every caller (the list view, the 409 path). Wider than the problem |
| Cancel the blocking run only, keep the issue | The issue stays open and still holds the routine's open-execution slot. The next tick would coalesce into a dead issue |
| A new routine run status `expired` | The shared status list is read by the UI and by clients. `failed` through the existing cancelled-issue sync needs no contract change |
| Expire by the issue's `updated_at` alone | System writes (re-dispatch, sweeps) touch `updated_at`. The clock would never run out |
| Default on, with a value | Expiry cancels work. A wrong default hurts real routines on the day of the deploy. Preview first (Q2) |

## 7. Open questions

Each has a recommendation. The reviewer should check the ones marked **for the reviewer**.

| ID | Question | Recommendation |
|---|---|---|
| **Q1** | **For the reviewer.** The report says "an issue with no run blocks later ticks". On `main`, that state (S4) does not block; S1 does. Which states exist in production? | Run the read-only queries in Appendix B before R1 starts. The plan covers S1 and leaves S4 to PR #104. If production shows a blocking state that none of S1 to S4 explains, stop and revise the plan |
| **Q2** | Default: off, or a value? Instance-wide default or per routine? | Per routine only in R1, `null` (off). No instance default. Decide a default in R3 from the preview data. A guard that is off will not catch the next incident, so R2's preview and badge are the answer to that, not a hidden default |
| **Q3** | Should `coalesce_if_active` expire too? It has the same block: ticks merge into the stuck issue | Yes. Only `always_enqueue` is excluded |
| **Q4** | Who may set the timeout? | Board users only, on top of the routine manage check. An agent should not set a timer that cancels issues |
| **Q5** | The range | 30 to 10080 minutes. 30 keeps the timeout above PR #104's re-dispatch grace period. 7 days covers weekly routines |
| **Q6** | **For the reviewer.** A `running` run is excluded from expiry. Is that right? | Yes in R1. The reaper and the silent-run watchdog own `running`. A running run with output is not stuck, and a dead one is the reaper's. Revisit only if the data shows a `running` run that the watchdog does not catch |
| **Q7** | How should the originating routine run look after expiry? | Reuse `syncRunStatusForIssue`: `failed`, with the existing cancelled-issue reason, plus a `tickExpired` object in `triggerPayload` that says it was expiry. No new status and no new reason text |
| **Q8** | Lazy check or sweeper? | Lazy in R1 (section 3.1). Add a sweeper only if the preview shows blocked routines whose ticks are rare |
| **Q9** | Restoring an old revision | Sets the column to `null` (section 3.2) |
| **Q10** | **For the reviewer.** Managed plugin routines | Out of R1. Their tick issues use the origin kind `plugin:<key>:operation`, which the unique index and `syncRunStatusForIssue` do not cover. R3 extends both, and then manifests may set the timeout. The wiki plugin's routines use `skip_if_active` today, so they are the likely first users, and Appendix B1 counts them |
| **Q11** | **For the reviewer.** A lifted hold is not remembered (section 3.5, known gap). Is that acceptable for R1? | Yes for R1, for the three reasons in section 3.5. Fix it when a lift time exists for every hold. PR #102 stores one only for holds that carry a condition. Ask that plan to record the lift time of every hold, so this plan can read it |

## Appendix A. Code anchors on `main` at `38819d350`

| What | File and line |
|---|---|
| Policy values `coalesce_if_active`, `always_enqueue`, `skip_if_active` | `packages/shared/src/constants.ts:636` |
| Routine run statuses (`received` ... `failed`) | `packages/shared/src/constants.ts:657` |
| Routine columns `status`, `concurrency_policy`, `catch_up_policy` | `packages/db/src/schema/routines.ts:36-38` |
| Open-execution unique index (only rows with `execution_run_id` set) | `packages/db/src/schema/issues.ts:140-148` |
| `OPEN_ISSUE_STATUSES`, `LIVE_HEARTBEAT_RUN_STATUSES` | `server/src/services/routines.ts:85-86` |
| `findLiveExecutionIssue` (what "active" means) | `server/src/services/routines.ts:1514` |
| The list-time active-issue query (same rule) | `server/src/services/routines.ts:1150-1230`, `2178` |
| `dispatchRoutineRun`, the routine row lock | `server/src/services/routines.ts:1712`, `1791` |
| Skip or coalesce decision | `server/src/services/routines.ts:1879-1900`, `1937-1965` |
| Failed-dispatch branch (`failed` run, issue deleted) | `server/src/services/routines.ts:1997-2013` |
| `routine.run_triggered` activity entry (system actor) | `server/src/services/routines.ts:2021` |
| `skipped_paused` label, the scheduler's `routines.status = 'active'` filter, the project-pause check and the suppressed-run branch | `server/src/services/routines.ts:1471`, `3197`, `3212`, `3251` |
| Snapshot builder (`routineRevisionSnapshotRoutine`), snapshot schema | `server/src/services/routines.ts:556-577`, `packages/shared/src/validators/routine.ts:124` |
| Create and update validators (`concurrencyPolicy`) | `packages/shared/src/validators/routine.ts:75`, `102` |
| `tickScheduledTriggers` | `server/src/services/routines.ts:3176` |
| Routine routes: board check, manage check, list, create, get, update, run | `server/src/routes/routines.ts:89`, `108`, `149`, `157`, `194`, `363`, `629` |
| `routine.updated`, `routine.revision_created` | `server/src/routes/routines.ts:402`, `137` |
| OpenAPI routine entries (`registerPath`; the `1587` set lists POST routes that return 201) | `server/src/routes/openapi.ts:4755-4830` (list at `4757`), `10285-10288` (revisions), `1587-1627` |
| Generic routine CLI (`create`, `update`, `revisions`) | `cli/src/commands/client/routine-api.ts:21-40` |
| Concurrency field in the web form | `ui/src/components/routine-sections/editable-sections.tsx:36`, `492` |
| Dispatch origin kind and id (plugin-operation routines) | `server/src/services/routines.ts:1770-1773`, `packages/shared/src/constants.ts:418` |
| `syncRunStatusForIssue` (ends the routine run for a cancelled, blocked or done issue) | `server/src/services/routines.ts:3297-3360`, called from `server/src/routes/issues.ts:9572`, `13964` |
| The route's run lookup on cancel | `server/src/routes/issues.ts:6869` (`resolveActiveIssueRun`) |
| The issue service's one run cancel (native question) | `server/src/services/issues.ts:261-268` |
| Checkout 409 on the open-execution index | `server/src/routes/issues.ts:15187-15193` |
| Run cancel for a cancelled issue is in the route layer | `server/src/routes/issues.ts:12946`, `13170` (`shouldCancelActiveRunForCancelledStatus`) |
| Stale-lock sweep | `server/src/services/recovery/service.ts:6211` |
| Orphan reaper | `server/src/services/heartbeat.ts:20051` |
| Silent-run watchdog | `server/src/services/recovery/service.ts:2365` |
| Issue monitor column | `packages/db/src/schema/issues.ts:73` |
| Pause fields on agent and company; the project field the scheduler reads | `packages/db/src/schema/agents.ts:35-36`, `packages/db/src/schema/companies.ts:11-12`, `projects.pausedAt` (`server/src/services/routines.ts:3187`) |
| Recovery action table | `packages/db/src/schema/issue_recovery_actions.ts:16` |
| Plugin routines that use `skip_if_active` | `packages/plugins/plugin-llm-wiki/src/manifest.ts:245`, `272`, `299` |

## Appendix B. Read-only queries for Q1

Run these against production before R1 starts. They read only. They print counts and
ids, no content.

```sql
-- B1. Open tick issues by the state of their run and their lock. A live run wins
-- over a newer finished one, as in dispatch.
select
  case when i.origin_kind = 'routine_execution' then 'routine' else 'plugin operation' end as kind,
  case
    when r.id is null and i.execution_run_id is null then 'S4 no run, no lock'
    when r.id is null then 'lock points at a missing run'
    when r.status in ('queued', 'scheduled_retry') then 'S1 ' || r.status
    when r.status = 'running' then 'S2 running'
    else 'S3 lock on a finished run (' || r.status || ')'
  end as state,
  (i.monitor_next_check_at is not null) as has_wait,
  count(*) as issues,
  min(i.created_at) as oldest
from issues i
left join lateral (
  select hr.id, hr.status
  from heartbeat_runs hr
  where hr.company_id = i.company_id
    and (hr.id = i.execution_run_id
         or hr.context_snapshot ->> 'issueId' = i.id::text)
  order by (hr.status in ('queued', 'running', 'scheduled_retry')) desc, hr.created_at desc
  limit 1
) r on true
where (i.origin_kind = 'routine_execution' or i.origin_kind ~ '^plugin:[^:]+:operation')
  and i.hidden_at is null
  and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
group by 1, 2, 3
order by 4 desc;

-- B2. Routines whose latest ticks were mostly skipped or coalesced in 24 hours.
select rr.routine_id,
       count(*) filter (where rr.status = 'skipped') as skipped,
       count(*) filter (where rr.status = 'coalesced') as coalesced,
       count(*) filter (where rr.status = 'issue_created') as created
from routine_runs rr
where rr.created_at > now() - interval '24 hours'
group by 1
having count(*) filter (where rr.status in ('skipped', 'coalesced')) > 0
order by skipped desc, coalesced desc
limit 50;
```

If B1 shows the S1 rows with ages over the proposed minimum timeout, the plan is on the
right target. If it shows mostly S4 or S3, the fix belongs to PR #104 or to the
stale-lock sweep, and this plan should shrink.
