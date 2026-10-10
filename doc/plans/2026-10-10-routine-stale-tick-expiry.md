# Routine stale-tick expiry: a stuck tick must not block every later tick

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
Branch: `docs/routine-stale-tick-expiry`
Code anchors: `main` at `38819d350` (see Appendix A). Line numbers drift; names do not.
Shared design: PR #113 (flow watchdog) defines, once, the **exemption set**, the **progress clock and clock source**, and the **atomic close step** (its section 6.1). They live in **one module, `server/src/services/flow-stall.ts`, which this plan's slice R1 builds first** and #113's S1 reuses (section 4). This plan refers to them and defines only what is routine-specific: the `staleTickTimeoutMinutes` setting, the binding to the routine's current blocker, the one-open-copy rule (section 3.10), and the surfaces.
Revision 3 (this one) applies the review decisions: the close uses a real compare-and-set on `status_version` (choice B, no migration); the exemption set gains open decisions, user-assigned reviews and stalled reviews; one shared module with one owner; at most one open copy per fingerprint; a bounded hold-lift floor; the queued human or resume wake rule.

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
- **There are two builders of this snapshot, and R1 changes both.** The routine service
  builds it (`routineRevisionSnapshotRoutine`, `routines.ts`). The pipeline service has
  its own copy (`routineRevisionSnapshotRoutine` in `pipelines.ts`) and writes a revision
  for a pipeline-generated routine (`appendPipelineAutomationRoutineRevision`). If only
  one is updated, a pipeline revision would omit the timeout, and restoring it would
  lose or wrongly keep the setting. R1 adds a test that both builders return the same
  key set for the same routine. Removing the copy is a cleanup for later.

No new table. No instance setting in slice 1 (Q2).

### 3.3 What "stale" means

A blocking tick issue is **stale** when all of these hold:

1. For this **live-blocker** expiry, the routine's policy is `skip_if_active` or `coalesce_if_active` (Q3; `always_enqueue` is covered by section 3.10 instead), the routine
   has a timeout, and the blocker is a `routine_execution` tick issue. Managed plugin
   routines (`plugin:<key>:operation`) are left to R3 (Q10): the unique index and the
   run-status sync below do not cover them.
2. The issue is the blocker that `findLiveExecutionIssue` returned for this tick.
3. **No run of the issue is `running`.** A running run belongs to the orphan reaper and
   the silent-run watchdog (Q6).
4. **No progress for the timeout.** Progress, the hold-lift floor and the clock source
   are defined in PR #113, section 6.1.2. A re-dispatch (#104) is not progress.
5. **Not held and not waiting** (the exemptions below).
6. **No exemption applies, evaluated under the issue lock** (the set in PR #113,
   section 6.1.1).

**Exemptions.** The exemption set is defined **once**, in PR #113, section 6.1.1. In
short: an armed wait; an open recovery action; a held scope or a hold (#102); an
issue-tree hold; a pending interaction; an `in_review` stage with a pending participant;
a **pending linked approval**; an **open decision about the issue**; an issue
**assigned to a person** (a user-assigned `in_review` issue); a **stalled review** with
no maintained path; a blocker that needs a person; a conversation issue; an exhausted
budget; a deferred or queued wake. This plan adds no exemption of its own and does not
repeat the signals. The set is derived from the attention feed and has a conformance
test (PR #113, section 6.1.1), which R1 runs through the routine path.

**A queued human or resume wake.** A queued run that carries a wake comment or a resume
intent is not dropped by the close: the existing staleness decision keeps it
(`run-dispatch/domain/policy.ts:610-625`). Before the close, a person's comment is
progress (PR #113, section 6.1.2), so a tick with a fresh human comment is not stale.
After the close, the kept run starts through the normal queue and the queued-run
starter retries it on every pass, like any queued run of that agent. This plan adds no
sweep for it. R1 tests that the kept run starts, and that it does not revive the closed
issue unless it carries a reopen intent. A resume intent without a comment sets no
progress time, so before the close it relies on the exemption row for a queued wake
(PR #113, section 6.1.1), and after the close on the keep rule above. A routine that is paused is a held
scope. A change to the set is made in #113 and reaches this plan.

### 3.4 What expiry does

Expiry calls the **atomic close step** of PR #113, section 6.1.3, with these inputs:

| Input | Value |
|---|---|
| `binding` | The issue is the routine's **current blocker** (section 3.6), or the open copy of section 3.10 |
| `expectedStatusVersion` | From the issue that dispatch just read, or from the request of the manual call. **It is a real compare-and-set (choice B).** Migration `0227_modern_pandemic.sql:146-158` already bumps `status_version` on every status change. Main lacks only the writer that compares it, which R1 adds in `flow-stall.ts` and `issueService.update` (PR #113, section 6.1.3). No migration for it |
| `targetStatus` | `cancelled` |
| `reason`, `source` | `routine_tick_expired`; `timeout` or `manual` |

The step closes the issue first, under the issue row lock, and compares the status
version. It then cancels the issue's live runs after the commit. A wake that was
deferred before the close is cancelled, not promoted. This closes the race where a wake
arrives after the re-check and is promoted onto an issue that is then cancelled. The
step, its order and its tests are in #113 and are not repeated here.

**The lock helper is not defined here.** `withIssueExecutionLock` clears `execution_run_id`, `execution_locked_at` and `checkout_run_id` before it calls its callback (`wake-queue/adapters/postgres.ts:1171-1232`), so it cannot hold the issue lock for the close. There is **one lock-preserving, transaction-aware variant**, and **PR #103's plan (D1) owns its name, path and API**. The first code slice that needs it implements it exactly to that spec. R1 does so only if R1 is ready before #103 D1. #105 R1 and #113 S1 otherwise reuse it unchanged. This plan adds no second variant and no copy, and no slice waits for another's code only for this helper.

**What is routine-specific, inside the same transaction as the close:**

1. **End the originating routine run.** Call the existing run-status sync
   (`syncRunStatusForIssue`). The issue service does not call it, only the routes do, so
   expiry must. It must accept the transaction: R1 gives it an optional executor (the
   `finalizeRun` helper under it already takes one). For a cancelled issue it sets the
   run to `failed`, with the existing cancelled-issue reason and a `transientFailure`
   payload. Expiry then adds `triggerPayload.tickExpired = { source, timeoutMinutes,
   expiredAt, invocationRepeated }`. No new run status and no custom reason text (Q7).
   The routine run **keeps its original `triggerPayload`**, so the expired invocation is
   never deleted (section 3.9).
2. **Add the system comment:** the timeout, the last progress time, the run states found
   and the result of the check against the new tick.
3. **Write the routine's activity entry** (section 3.8).

**After the commit,** dispatch looks for a blocker again, finds none, and creates the new
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

**Hold lifts.** A hold that ended recently is handled by the **hold-lift floor** of PR
#113, section 6.1.2. The progress clock never starts before the latest **real lift
event** inside the timeout window. Only these count: `agent.resumed` for the assignee,
and a `company.updated`, `project.updated` or `routine.updated` entry whose `details`
show that the pause state changed to not paused. An ordinary edit of a routine or
company is not a lift. So each lift delays an expiry by **at most one timeout**, and a
routine that is edited often cannot suppress expiry. A tick that waited out a hold does
not expire on the first tick after the hold lifts. When #102 lands, its lift time
replaces the approximation.

### 3.6 Surfaces

**API** (every route listed in OpenAPI, company-scoped):

| Route | Purpose |
|---|---|
| `POST /companies/:companyId/routines`, `PATCH /routines/:id` | Accept `staleTickTimeoutMinutes` (`null` or 30..10080). The response returns it |
| `GET /routines/:id`, the routine list item | Add `blockingTick`: `{ issueId, state, lastProgressAt, staleAt, exempt }`, where `exempt` names the exemption or is `null` |
| `GET /companies/:companyId/routines/stale-ticks` | **Preview.** Every routine whose blocking tick is past its timeout or would be, with the reason it is exempt. Read only |
| `GET /companies/:companyId/routines/stale-ticks`, `GET /routines/:id` | Each blocker also returns its `statusVersion` |
| `POST /routines/:id/ticks/expire` | **Manual expire** (slice R2). Body `{ issueId, expectedStatusVersion, reason }`, all required. Ignores the timeout. See "The manual call is bound to the blocker" below |

**The manual call is bound to the blocker.** A body with only an issue id could cancel
unrelated work in the same company, so the server does not trust it. Under the routine
row lock, it checks that the issue is the routine's **current blocker** by running the
blocker query (`findLiveExecutionIssue`) with the routine, the dispatch origin and the
**issue's own fingerprint**, and requiring that it returns exactly this issue. That one
query carries the checks: the same company, an open status, the same origin kind and id,
not hidden, the same fingerprint, and a live run. If the issue is not the current
blocker (it is closed, it moved, another issue of the company, or it has no live run),
the answer is **409 `not_current_blocker`**. A `statusVersion` that differs from
`expectedStatusVersion` is **409 `stale_view`**. A pending exemption (section 3.3) is
**409 `exempt`** with the exemption's name. A run in `running` is **409 `run_active`**.
The routine must belong to the company in the path, or the answer is 404. Only a board
user may call it (section 3.7).

**CLI.** The setting goes through the existing generic path
(`routine create` and `routine update` with `--payload-json`, `routine-api.ts`). Two new
commands: `routine ticks:stale` (the preview, which prints the `statusVersion`) and
`routine tick:expire <routineId> --issue <id> --status-version <n>`.

**Web.** In the routine edit form, next to the concurrency policy: a field "Expire a
stuck tick after (minutes)", empty means off, with help text that says what counts as
stuck. On the routine list and detail pages: a "Blocked by a stuck tick" badge with
the age, the exemption if any, and an **Expire** button that sends the `statusVersion` it showed. The routines page gets a
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

The `details` of `routine.tick_expired` also carry `invocationRepeated`, `startedInWindow` (the run ids that started after the check) and the check that blocked or allowed the close. The issue gets the system comment from section 3.4. The run event of each
cancelled run carries the reason `routine_tick_expired`. A refused manual call (409) writes
no entry.

### 3.9 Edge cases

| Case | Behavior |
|---|---|
| A webhook tick has a different fingerprint than the blocker | `findLiveExecutionIssue` already matches by fingerprint. Only the blocker for the same fingerprint can expire |
| A run turns `running` between the check and the close | The close step re-checks under the issue lock and rolls back (PR #113, section 6.1.3). After the commit, a run that started in the short window is cancelled with the others and listed in `startedInWindow` |
| A wake arrives after the re-check | The issue is already terminal when the wake is promoted, so the wake is dropped. A person's comment with a resume intent can still reopen the issue. That is allowed and visible |
| A pending approval, interaction or review participant | Exempt (PR #113, section 6.1.1). No expiry |
| The database and application clocks differ by more than 5 minutes | No expiry. `clock_skew` is recorded (PR #113, section 6.1.2) |
| Two ticks arrive together | The routine row lock serializes them. The second finds no blocker |
| `coalesce_if_active` ticks that merged into the expired issue | Their rows keep `coalescedIntoRunId`. They are history; nothing changes |
| The routine's project is paused | A scheduled tick is recorded as `skipped` (label `skipped_paused`) before any expiry check. A manual, API or webhook tick reaches the check, and the "held scope" exemption stops it |
| The run cancel throws after the commit | The issue is already cancelled. The failure is logged and written as `routine.tick_expiry_failed` with the run ids. The queued run is cancelled at its claim by the staleness check, or by the next sweep. The new tick runs |
| The close step rolls back (a check failed) | The tick is skipped or coalesced, as before. Nothing changed |
| **The expired invocation.** The tick that created the expired issue, and the new tick, may carry different payloads | The expired routine run **keeps its payload and variables**, so nothing is deleted and a person can replay it. The new tick repeats the same invocation only when the two **dispatch fingerprints are equal**. `findLiveExecutionIssue` also accepts a blocker whose fingerprint is `default`. In that case, the invocation is not repeated, and the entry says `invocationRepeated: false`. The claim "no work is lost" therefore means: no record is deleted, and a repeated invocation is repeated automatically. Nothing is claimed beyond that |
| The setting is lowered below the age of a blocker | The next tick expires it. That is the intent |
| `always_enqueue` | It does not block on a live run, so the live-blocker expiry of section 3.3 does not apply. **But the one-open-copy rule of section 3.10 does apply when the setting is set:** an exempt or not-yet-stale open copy makes the tick skip with a run-log reason, and a stale one is expired before the new copy is created. The form says so. With the setting `null`, nothing changes |

### 3.10 At most one open copy per fingerprint

**Why.** On `main`, an open copy with no live run (state S4) does not block a tick
(section 2), so each tick adds another open copy. A production routine reached three
open copies of one fingerprint, and a wake of the oldest copy failed with a duplicate
key until PR #120 made the claim cancel that later run
(`routine_execution_superseded`). Closing the cause needs the tick to see idle copies.

**The rule, when `staleTickTimeoutMinutes` is set.** Under the routine row lock, before
the live-blocker check of section 3.3, dispatch looks for an **open copy** of the same
routine, origin and fingerprint, whatever the state of its runs. The query is the one
that `findLiveExecutionIssue` runs, without the live-run join, and it is one shared
function. If one exists:

| The older copy is | The tick does |
|---|---|
| **Exempt** (PR #113, section 6.1.1) | **Skipped**, recorded as `skipped` with the reason `open_copy_exempt` and the exemption's name. The copy is not touched. No second open copy is created |
| Not exempt, and **stale** (no progress for the timeout) | The copy is **expired** with the atomic close step (section 3.4), then the new tick creates its issue. There is then one open copy |
| Not exempt, **not yet stale** | The tick **never creates a second open copy, under any concurrency policy**. `skip_if_active` skips it. `coalesce_if_active` merges it into the open copy. `always_enqueue`, which normally never blocks, **skips** it. Every skip or merge writes a run-log reason (`open_copy_not_stale`, with the copy's id and age) |

**This rule applies to all three policies.** Section 3.3 (the live-blocker check) and
the policy values `skip_if_active` and `coalesce_if_active` still decide what happens
when a copy has a live run. But the one-open-copy rule is about open copies, not live
runs, so it does not look at the policy to decide whether a second copy may be created:
it may not. It looks at the policy only to choose between skip and merge, and
`always_enqueue` has no merge, so it skips (Q17). When the setting is `null`, no policy
changes behavior, including `always_enqueue`.

The last row is a deliberate choice, and **the reviewer should confirm it (Q14)**. The
review decision reads "if the older copy is not exempt, expire it atomically, then
create the new one". Expiring a copy that has no progress for less than the timeout
would also cancel an issue that PR #104's re-dispatch is about to wake (section 3.5). The
grace window is the same `staleTickTimeoutMinutes`, so no new setting exists. If the
reviewer wants immediate expiry, the change is one condition in the table (the clock
test is dropped for copies with no live run), and the tests of section 5 change with it.

**Race and lock order.** The routine row lock serializes ticks. The close takes the issue
lock after it (routine, then issue, then run, the order in PR #113, section 6.1.3). If
the close refuses (a changed status version, a new exemption, a run that is `running`),
the tick is skipped or coalesced, as in section 3.4.

**How it works with PR #120.** #120 does not close anything. It makes a claim lose the
slot cleanly: when another open copy of the same routine holds the slot through a live
run, the later queued run is cancelled with `routine_execution_superseded`. This rule
removes the cause: at most one open copy stays beside a new tick, so the case #120 handles
no longer arises from the schedule trigger. #120 stays as the **backstop** for the cases
this rule does not cover: a routine with the setting off, copies that were created before
the rule, and a race between a wake and a tick. An expired copy is terminal, so a queued
run of the older copy meets the terminal-status rule of the staleness decision
(`policy.ts:631` in #120 at `8dcc3e0f9`) before the superseded rule (`policy.ts:704`, the same file). R1 has a test for each of
these. The two changes do not share code, and neither needs the other to land first.

**Not covered.** Managed plugin routines (Q10). Webhook ticks with a different
fingerprint than the open copy: each fingerprint has its own open copy.

## 4. Slice plan

| Slice | Content | Surfaces |
|---|---|---|
| **R1** | The column (migration), shared validator and snapshot field **in both builders**, the dispatch-time expiry on top of the shared stall module and atomic close step of PR #113, the run-status sync with an executor, the `blockingTick` field, activity entries | API (PATCH and read), CLI (`--payload-json`), web (the form field) |
| **R2** | The preview route, the manual expire route, the badge and button, the "Stuck ticks" filter | API, CLI (`ticks:stale`, `tick:expire`), web |
| **R3** | Managed and plugin routine manifests may set the timeout. An instance-wide default, only if the preview data from R1 and R2 supports one | API, CLI, web |

**R1 builds the shared module first.** `server/src/services/flow-stall.ts` (PR #113, section 6.1) is created by R1 with `stallExemption`, `stallClock` and `closeStalledIssue`, and #113's S1 reuses it. No order is left open. R1 also carries what the module needs, each with its own test (PR #113, section 6.1.3): the compare-and-set in `issueService.update` (`expectedStatusVersion`, no migration), the writer audit test, and the conversation-issue exemption. The lock-preserving variant of `withIssueExecutionLock` is not R1's design: PR #103's plan (D1) owns it, and R1 implements it to that spec only if R1 is ready first. R1 is the only slice with a migration (the column). Parity: R1 ships the setting on all three
surfaces. R2 is the named follow-up for the preview and the manual action.

## 5. Verification per slice

**R1**, on embedded Postgres unless noted:

- The staleness function, as a pure table test: the routine-specific rules (policy, the
  blocker, the timeout). The exemptions, the clock and the atomic close step are tested
  once, in PR #113 (section 6.1), and R1 adds one test per exemption through the routine
  path.
- A stale `queued` run: the tick expires it, cancels the run with no continuation wake,
  and the new tick creates one issue and one live run. **Red at `main`:** the tick is
  skipped.
- A stale `scheduled_retry` run: same.
- Each exemption of PR #113, section 6.1.1, **including a pending linked approval**: the tick is skipped as before.
- The atomic close through dispatch: a wake deferred before the close is not promoted, and no run is attached to the expired issue.
- An S4 issue (no run): PR #104's re-dispatch acts, and expiry does not, until the timeout passes.
- **One open copy per fingerprint (section 3.10),** on embedded Postgres, red at `main` where the tick adds a copy:
  - an older copy with no live run, not exempt, no progress for the timeout: it is expired, the new tick creates its issue, and one open copy remains;
  - the same copy with progress inside the timeout, **one test per policy**: `skip_if_active` skips, `coalesce_if_active` merges into the copy, `always_enqueue` skips. In each, no second open copy exists afterwards and the run log carries `open_copy_not_stale`. Each of the three is red at `main` for `always_enqueue` (a second copy is created) and for the other two when the copy has no live run;
  - an older copy that is stale, one test per policy: the copy is expired and one new copy is created, also under `always_enqueue`;
  - the older copy is exempt, once for each of: an open decision, a user-assigned review, a stalled review, an armed wait, a pending approval: the tick is `skipped` with `open_copy_exempt`, and the copy is untouched;
  - a different fingerprint keeps its own copy;
  - the setting is `null`: behavior is identical to `main`;
  - PR #120 still holds as the backstop: with the setting off, waking the older copy beside a live newer copy cancels the run `routine_execution_superseded`; an expired copy's queued run is cancelled by the terminal-status rule instead.
- **The shared module, built in R1:** the conformance test of the exemption set (one issue for each issue-scoped feed source, `stallExemption` is not `null`), the compare-and-set (a status change by a writer that bypasses the service makes the close refuse; an A, B, A change refuses), and the writer audit test.
- **A queued human or resume wake:** a queued run with a wake comment or a resume intent is kept after the close and starts; one without is cancelled. A human comment resets the progress clock.
- **The hold-lift floor is bounded:** a routine edited every minute still expires; one real lift delays the expiry by at most one timeout.
- A re-dispatch does not reset the progress clock.
- A held agent, project or company: no expiry while it is held.
- The re-check race: a run that becomes `running` rolls the close back.
- Both revision snapshot builders return the same key set, and a pipeline revision round-trips the timeout.
- `syncRunStatusForIssue` with an executor: the run is ended inside the close transaction, and rolls back with it.
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
function). Manual expire: board only; **409 `not_current_blocker`** for another issue of the company, a closed issue, an issue of another routine, and an issue with another fingerprint; **409 `stale_view`**; **409 `exempt`**; **409 `run_active`**; 404 for a routine of another company; one activity entry on success. UI
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
| **Q1** | **Decided, with one point to confirm (Q14).** The report said "an issue with no run blocks later ticks". On `main`, that state (S4) does not block; S1 does. Production then showed S4 piling up: three open copies of one fingerprint, with no live run on two of them. | At most one open copy per fingerprint (section 3.10). An exempt older copy makes the tick `skipped`. A stale, non-exempt one is expired atomically, then the new tick runs. PR #120 stays as the backstop. Appendix B still gives the counts before R1 starts |
| **Q14** | **For the reviewer.** A non-exempt older copy that is not yet stale. The decision says to expire it at once | **Accepted by the manager (18:29), with a condition:** until the timeout, the tick skips or merges and never creates a second open copy, under any policy including `always_enqueue` (section 3.10, Q17). Plan: wait for the timeout (section 3.10). Reason: PR #104's re-dispatch may be about to wake it. Immediate expiry is one condition away if the reviewer prefers it |
| **Q15** | Who owns the shared module and the lock helper? | `flow-stall.ts` is built first by R1 (section 4). The lock-preserving variant of `withIssueExecutionLock` is owned by PR #103's plan (D1); the first slice that needs it implements it to that spec, the others reuse it |
| **Q16** | The queued human or resume wake | Kept after the close by the existing staleness decision (section 3.3). A human comment is progress. No new sweep |
| **Q2** | Default: off, or a value? Instance-wide default or per routine? | Per routine only in R1, `null` (off). No instance default. Decide a default in R3 from the preview data. A guard that is off will not catch the next incident, so R2's preview and badge are the answer to that, not a hidden default |
| **Q3** | Should `coalesce_if_active` expire too? It has the same block: ticks merge into the stuck issue | Yes, for the live-blocker expiry (section 3.3). `always_enqueue` has no live-blocker expiry, but it **is** covered by the one-open-copy rule (section 3.10, Q17) |
| **Q17** | An open copy that is not stale, under `always_enqueue` (manager decision with Q14) | The tick never creates a second open copy under any policy. `always_enqueue` skips, because it has no merge. Reviewer: confirm skip, or ask for a merge into the copy |
| **Q4** | Who may set the timeout? | Board users only, on top of the routine manage check. An agent should not set a timer that cancels issues |
| **Q5** | The range | 30 to 10080 minutes. 30 keeps the timeout above PR #104's re-dispatch grace period. 7 days covers weekly routines |
| **Q6** | **For the reviewer.** A `running` run is excluded from expiry. Is that right? | Yes in R1. The reaper and the silent-run watchdog own `running`. A running run with output is not stuck, and a dead one is the reaper's. Revisit only if the data shows a `running` run that the watchdog does not catch |
| **Q7** | How should the originating routine run look after expiry? | Reuse `syncRunStatusForIssue`: `failed`, with the existing cancelled-issue reason, plus a `tickExpired` object in `triggerPayload` that says it was expiry. No new status and no new reason text |
| **Q8** | Lazy check or sweeper? | Lazy in R1 (section 3.1). Add a sweeper only if the preview shows blocked routines whose ticks are rare |
| **Q9** | Restoring an old revision | Sets the column to `null` (section 3.2) |
| **Q10** | **For the reviewer.** Managed plugin routines | Out of R1. Their tick issues use the origin kind `plugin:<key>:operation`, which the unique index and `syncRunStatusForIssue` do not cover. R3 extends both, and then manifests may set the timeout. The wiki plugin's routines use `skip_if_active` today, so they are the likely first users, and Appendix B1 counts them |
| **Q11** | **For the reviewer.** A lifted hold is not remembered | Closed for R1 by the bounded hold-lift floor (PR #113, section 6.1.2). Only `agent.resumed` and the update entries that show an unpause count, so one lift delays an expiry by at most one timeout. #102's lift time replaces it |
| **Q12** | **For the reviewer.** One definition of the exemptions and the atomic close | Yes: in PR #113, section 6.1, in `flow-stall.ts`. **R1 builds it first** and S1 reuses it. The compare is choice B (section 3.4) |
| **Q13** | What does a manual expire need to prove? | The issue is the routine's current blocker, the status version matches, no exemption applies, and no run is `running` (section 3.6). Anything else is a 409 |

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
| Pipeline-generated routine revisions: a second snapshot builder and the revision writer | `server/src/services/pipelines.ts:1164-1186`, `2678-2700` |
| The issue lock and the promotion that the atomic close must beat | `server/src/modules/wake-queue/adapters/postgres.ts:1171`; `server/src/modules/wake-queue/application/use-cases.ts:145`, `378`, `1024` |
| Pending linked approvals | `packages/db/src/schema/issue_approvals.ts:7-22`, `packages/db/src/schema/approvals.ts:5-19`, `server/src/services/attention.ts:1591-1617` |
| Dispatch origin kind and id (plugin-operation routines) | `server/src/services/routines.ts:1770-1773`, `packages/shared/src/constants.ts:418` |
| `syncRunStatusForIssue` (ends the routine run for a cancelled, blocked or done issue) | `server/src/services/routines.ts:3297-3360`, called from `server/src/routes/issues.ts:9572`, `13964` |
| The route's run lookup on cancel | `server/src/routes/issues.ts:6869` (`resolveActiveIssueRun`) |
| The issue service's one run cancel (native question) | `server/src/services/issues.ts:261-268` |
| Checkout 409 on the open-execution index | `server/src/routes/issues.ts:15187-15193` |
| Run cancel for a cancelled issue is in the route layer | `server/src/routes/issues.ts:12946`, `13170` (`shouldCancelActiveRunForCancelledStatus`) |
| Stale-lock sweep | `server/src/services/recovery/service.ts:6211` |
| Orphan reaper | `server/src/services/heartbeat.ts:20051-20098` |
| Silent-run watchdog | `server/src/services/recovery/service.ts:2365` |
| Issue monitor column | `packages/db/src/schema/issues.ts:73` |
| Pause fields on agent and company; the project field the scheduler reads | `packages/db/src/schema/agents.ts:35-36`, `packages/db/src/schema/companies.ts:11-12`, `projects.pausedAt` (`server/src/services/routines.ts:3187`) |
| Recovery action table | `packages/db/src/schema/issue_recovery_actions.ts:16` |
| The `status_version` trigger (bumps on every status change) and its test | `packages/db/src/migrations/0227_modern_pandemic.sql:146-158`, `packages/db/src/client.test.ts:1895-1940` |
| The issue update, its row lock, and the missing expected-version argument | `server/src/services/issues.ts:10654-10689`, `10981` |
| `withIssueExecutionLock` clears the execution columns before its callback | `server/src/modules/wake-queue/adapters/postgres.ts:1171-1232` |
| Attention feed source kinds (the base of the exemption set) | `packages/shared/src/types/attention.ts:8-21` |
| Queued run kept for a wake comment or resume intent; terminal-status rule | `server/src/modules/run-dispatch/domain/policy.ts:610-625` (on `main`); `631` and `704` (the superseded rule) are in PR #120 at `8dcc3e0f9` |
| Plugin routines that use `skip_if_active` | `packages/plugins/plugin-llm-wiki/src/manifest.ts:245`, `272`, `299` |

## Appendix B. Read-only queries for Q1

Run these against production before R1 starts, **once per company** (replace
`:company_id`). They read only. They print counts and ids, no content.

```sql
-- B1. Open tick issues by the state of their run and their locks. A live run wins over
-- a newer finished one, as in dispatch. A checkout lock counts as a lock.
select
  case when i.origin_kind = 'routine_execution' then 'routine' else 'plugin operation' end as kind,
  case
    when r.id is null and i.execution_run_id is null and i.checkout_run_id is null
      then 'S4 no run, no lock'
    when r.id is null and i.execution_run_id is null and i.checkout_run_id is not null
      then 'S4b no run, checkout lock only'
    when r.id is null then 'lock points at a missing run'
    when r.status in ('queued', 'scheduled_retry') then 'S1 ' || r.status
    when r.status = 'running' then 'S2 running'
    else 'S3 lock on a finished run (' || r.status || ')'
  end as state,
  (i.monitor_next_check_at is not null) as has_wait,
  (i.execution_locked_at is not null) as has_execution_lock_time,
  count(*) as issues,
  min(i.created_at) as oldest
from issues i
left join lateral (
  select hr.id, hr.status
  from heartbeat_runs hr
  where hr.company_id = i.company_id
    and (hr.id = i.execution_run_id
         or hr.id = i.checkout_run_id
         or hr.context_snapshot ->> 'issueId' = i.id::text)
  order by (hr.status in ('queued', 'running', 'scheduled_retry')) desc, hr.created_at desc
  limit 1
) r on true
where i.company_id = :company_id
  and (i.origin_kind = 'routine_execution' or i.origin_kind ~ '^plugin:[^:]+:operation')
  and i.hidden_at is null
  and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
group by 1, 2, 3, 4
order by 5 desc;

-- B2. Routines whose ticks were skipped or coalesced, with the share of all ticks.
-- "Mostly" is a share of at least 0.5 over at least 6 ticks in 24 hours.
select rr.routine_id,
       count(*) as ticks,
       count(*) filter (where rr.status = 'skipped') as skipped,
       count(*) filter (where rr.status = 'coalesced') as coalesced,
       count(*) filter (where rr.status = 'issue_created') as created,
       round((count(*) filter (where rr.status in ('skipped', 'coalesced')))::numeric
             / nullif(count(*), 0), 2) as blocked_share
from routine_runs rr
where rr.company_id = :company_id
  and rr.created_at > now() - interval '24 hours'
group by 1
having count(*) >= 6
   and (count(*) filter (where rr.status in ('skipped', 'coalesced')))::numeric
       / nullif(count(*), 0) >= 0.5
order by blocked_share desc, ticks desc
limit 50;
```

If B1 shows the S1 rows with ages over the proposed minimum timeout, the plan is on the
right target. If it shows mostly S4 or S3, the fix belongs to PR #104 or to the
stale-lock sweep, and this plan should shrink.
