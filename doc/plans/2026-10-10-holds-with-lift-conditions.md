# Holds with lift conditions: a pause that says when it may end, and a system that says when it can

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
Decisions: the eight questions of the first draft were answered on 2026-10-10 (section 8). One answer changed the plan: the no-condition nudge is on by default, as slice H1b.
Branch: `docs/holds-with-lift-conditions`
Code anchors: `main` at `3fca7f35e` (see Appendix A). Line numbers drift; names do not.

## 1. Goal and constraints

Operators pause things: an agent, a routine, a company, a subtree of issues.
Today a pause is a bare flag. When the reason for the pause ends, nothing says so.
A pause can stay on for hours after its cause is gone. Nobody sees it, because a
paused thing looks quiet, not broken. (This is an operator report, not something
measured here.)

**Goal.** A hold can carry a *lift condition* that the system can check. When the
condition is met and the hold is still on, the system raises a visible alert. The
system never lifts a hold silently. Lifting stays a deliberate act, unless the
hold says `auto_lift: true`.

Constraints, all binding:

- **Company scope.** Every row, query, alert and API call is company-scoped.
- **Web, API (listed in OpenAPI) and CLI** for every capability, in the same
  slice or with a named follow-up. Parity of surfaces is not parity of permissions.
- **Every mutation writes an activity log entry**, including the ones the system makes.
- **No new permission.** Slice 1 adds none (section 3.10). If a later slice needs
  one, it gets its own plan with a security gate.
- **Fail open.** The checker never starts, stops, delays or retries a run. If it
  fails, holds stay exactly as they are.
- **Additive, just-in-time migration.** H1 adds one new table. H2 adds nullable
  columns to `routines`. Nothing alters a hot table or widens a constraint later:
  the closed sets are enforced by the shared schema (section 3.2). The migration
  numbers are assigned when the manager names each slice next.
- **Public repository.** No instance, host or company names in this document.

Not in scope (section 8 lists the decisions that touch them):

- New kinds of pause, and any change to the budget pause logic.
- The process-wide scheduler switch (`HEARTBEAT_SCHEDULER_ENABLED`).
- Pause-like states of plugin jobs, chat channels and status cards.
- Disk-aware dispatch. That is a separate plan. It *uses* this one: a disk hold is
  a hold whose lift condition is "disk under the threshold" (section 3.6, slice 3).
- Letting one agent wake another agent's issue. That is a permission change.

## 2. Where holds exist today

Seven places behave like a hold. The first five store a hold. The last two do not: one is a consumer of holds, and one is a process setting.

| Site | State | Reason / time / actor on the row | Set by | Lifted by | Surfaces | Activity |
|---|---|---|---|---|---|---|
| **Agent** | `agents.status = 'paused'` | `pause_reason` and `paused_at`. The reason is **free text in practice**: `manual` and `budget` from the pause route and the budget service, `import` from company import, `company_archived` from archive, and sentences from built-in and plugin-managed provisioning (for example "Built-in … is disabled until explicitly configured"). `system` is documented but no agent path writes it. No actor. | `POST /agents/:id/pause` (board only: `assertBoard`, and `getAccessibleAgent`, which also needs company write access and the `agents:create` manage check); plugin host services; built-in and plugin-managed provisioning; budget service; company archive and import | `POST /agents/:id/resume` (a board user passes the same `getAccessibleAgent` chain; an agent actor needs the `agent_config:update` change grant, and an explicit target grant for itself; the route also refuses a resume when the org chain is invalid); plugin host services; budget service `resumeScopeFromBudget` | API, CLI `agent pause` and `agent resume`, web `AgentActionButtons` | `agent.paused`, `agent.resumed` |
| **Company** | `companies.status = 'paused'` | `pause_reason` and `paused_at`, **written only by the budget service**. A manual `PATCH` with `status: "paused"` leaves both NULL, and `PATCH` with `status: "active"` does not clear them: the update schema has no pause fields and the service applies the patch as it is. No actor. | Budget service; `PATCH /companies/:id` with `status: "paused"` (the validator accepts it) | `PATCH /companies/:id` with `status: "active"`; budget service | API; CLI `company update --payload-json` (JSON only); **no web control to pause or resume** | `company.updated` |
| **Project** | `projects.pause_reason`, `projects.paused_at` | Reason and time. No actor. | Budget service only. No pause API exists. | Budget service only | None for pausing | None |
| **Routine** | `routines.status = 'paused'` | **Nothing.** No reason, no time, no actor. | `PATCH /routines/:id` (needs `assertCanManageExistingRoutine`, so the assignee agent can pause its own routine); a draft routine with no default agent is normalized to `paused` by `normalizeDraftRoutineStatus`; built-in routines through `setRoutineSchedule` | `PATCH /routines/:id` (activating also needs `assertBoardCanAssignTasks`, the `tasks:assign` check) | API; web routine detail (the automation on/off toggle) | `routine.updated` |
| **Issue tree hold** | `issue_tree_holds` row, `mode = 'pause'`, `status = 'active'` | Reason, `release_policy`, creator and releaser columns, run ids | `POST /issues/:id/tree-holds` | `POST /issues/:id/tree-holds/:holdId/release` | API, CLI `issue tree-hold:create`, `:get`, `:release`, web issue detail | `issue.tree_hold_created`, `issue.tree_hold_released` |
| **Dispatch gates** | consumers of holds, not holds: `decideScheduledRetryGate` (scheduled retries), the wake queue (`getPauseHoldFacts`), and `getActivePauseHoldGate` in the heartbeat | n/a | n/a | n/a | n/a | n/a |
| **Process switch** | env `HEARTBEAT_SCHEDULER_ENABLED` | n/a | Operator, at start-up | Operator, at restart | Start-up banner and failure diagnostics only | None |

How the holds reach dispatch:

- The issue tree hold is the hold that blocks *dispatch*. `getActivePauseHoldGate`
  walks from an issue up its parents (at most 100 levels). Three places use the
  result: `decideScheduledRetryGate` refuses a scheduled retry with the code
  `issue_paused`; the wake queue defers a wake (`getPauseHoldFacts` in
  `modules/wake-queue/adapters/postgres.ts`); and the heartbeat consults the gate.
- A paused project makes the routine scheduler record a suppressed run with the
  reason `paused` instead of firing the routine.
- A paused agent is not invokable (`agent-invokability` returns `paused`).
- A wake for a company that is not `active` is suppressed, and the reason is
  recorded ("Wake suppressed because company status is paused", in the wake path
  of `heartbeat.ts`).

### Findings

- **F1. Only the budget pause has any lift logic**, and it is tied to a budget
  decision (`resumeScopeFromBudget` matches `pause_reason = 'budget'`). No general
  condition exists.
- **F2. The routine records nothing about its pause**: no reason, no time, no
  actor. A manual company pause records nothing either: the time and reason fields
  exist but only the budget service writes them. **No site records who paused it
  on the row**; only the activity log knows.
- **F2b. The agent pause reason is free text in practice**, not the documented
  enum. Built-in and plugin-managed agents write sentences, and no agent path
  writes `system`. Any rule that depends on the reason must use an allowlist.
- **F3. Nothing tells anyone when a cause ends.** The attention feed has
  `budget_alert` and `agent_error_alert`. It has nothing for "this agent is paused
  and could resume".
- **F4. A lift field already exists, and it is half dead.**
  `issue_tree_holds.release_policy` holds `{ strategy: "manual" | "after_active_runs_finish", note }`.
  The validator accepts it and the row stores it. The server never reads
  `strategy` (no code path evaluates `after_active_runs_finish`). The idea is
  right. The implementation stops at the column.
- **F5. There are many resume paths** (the agent route, the budget
  service, the company update, the routine update, the tree-hold release). Any
  design that must hook *every* one of them will miss one. The design must stay
  safe when a path is missed.

## 3. Design

### 3.1 Principle: the hold stays the target's own state

The pause flag stays where it is, on the agent, the company, the routine and the
issue tree hold. Nothing about how a pause *works* changes. A hold with no lift
condition behaves exactly as it does today.

A new record, the *lift condition*, only describes **when the hold may end** and
remembers **whether that moment has come**. One table serves all scopes. One
checker evaluates it. One adapter per scope knows how to read "is it held" and how
to lift it.

Why not the other shapes (section 7): a generic `holds` table that becomes the
source of truth would touch every pause site, the budget service and the dispatch
gates. Columns on each table would need four migrations and four checkers.

### 3.2 Data model: table `hold_lift_conditions`

One additive `CREATE TABLE`. The SQL uses `IF NOT EXISTS` guards, like the usage
record migration. The table has a foreign key to `companies` with `ON DELETE
CASCADE`, and **no foreign key to the target** (the target is polymorphic). The
company removal path deletes these rows in its own transaction. A test proves it.

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid, primary key | |
| `company_id` | uuid, not null, FK `companies`, cascade | Every query filters on it |
| `scope_type` | text, not null | `agent`, `routine`, `company`, `project`, `issue_tree_hold`. Reserved, not accepted in slice 1: `environment`. The set is closed by the shared schema, not by a database `CHECK`, so adding a value is not a migration |
| `scope_id` | uuid, not null | The target. Every read and write matches it on `(scope_id, company_id)` |
| `status` | text, not null, default `armed`, `CHECK` | `armed`, `met`, `lifted`, `withdrawn`, `superseded`. This set never changes |
| `condition_type` | text, not null | `time`, `review_date`, `issue_closed` in slice 1. Closed by the shared schema |
| `condition_params` | jsonb, not null | A closed shape per type, validated by a zod discriminated union (section 3.6) |
| `auto_lift` | boolean, not null, default `false` | Section 3.7 |
| `note` | text, null, at most 500 characters | Operator text, handled like `issue_tree_holds.reason` |
| `held_since` | timestamptz, not null | The target's own `paused_at`, or the tree hold's `created_at`. **The generation key** (section 3.3) |
| `held_reason` | text, null | The target's `pause_reason` at attach time, when it has one. Slice 1 accepts only `manual` (section 3.7) |
| `met_at` | timestamptz, null | First time the checker saw the condition true. **Sticky** until the row is replaced |
| `last_evaluated_at` | timestamptz, null | Written only when `met_at`, `last_error` or `last_observed` changes, and otherwise at most once every 15 minutes (section 3.5) |
| `last_observed` | jsonb, null | Bounded. For a metric: value, unit, sample time. Never free text |
| `last_error` | text, null | A closed code: `issue_not_found`, `metric_stale`, `lift_failed`, `auto_lift_not_authorized` |
| `created_by_*` | actor type, agent id, user id, run id | Same shape as `issue_tree_holds`. This is the **setter**: `created_by_user_id` is checked again before an automatic lift (section 3.7) |
| `closed_at`, `closed_by_*`, `close_reason` | | `close_reason`: `manual_lift`, `auto_lift`, `withdrawn`, `superseded`, `target_gone` |
| `created_at`, `updated_at` | timestamptz | |

Indexes:

- **Unique, partial:** `(company_id, scope_type, scope_id) WHERE status IN ('armed','met')`.
  One active condition per hold. A second attach is a 409. Use the replace route
  (section 4.1).
- `(company_id, status)` for the list and the alert query.
- **Partial:** `(status) WHERE status IN ('armed','met')` for the checker. It visits
  **both** states (section 3.5).

Rows are small and are kept. Closed rows are the history of how holds ended.

### 3.3 Generation and compare-and-set: a condition lifts only the hold it was made for

The danger of a stored condition is a stale one. An agent is paused with a
condition. Someone resumes it by another path. Later it is paused again, for a
different reason. The old condition must not lift the new hold. And the check must
not be separable from the lift, or a resume and a new pause between the two would
still be lifted by the old condition.

`held_since` and `held_reason` are the generation key. Each scope defines "the
same hold" as a predicate on the target:

| Scope | Same hold when |
|---|---|
| `agent` | `status = 'paused'` and `paused_at = held_since` and `pause_reason = held_reason` |
| `issue_tree_hold` | `status = 'active'` and `mode = 'pause'`. A new hold has a new id, so the id is already the generation and the key adds nothing here |
| `company` (H2) | `status = 'paused'` and `paused_at = held_since` |
| `routine` (H2) | `status = 'paused'` and `paused_at = held_since` |

The predicate is used in two ways:

1. **To decide `superseded`.** The checker applies it to `armed` **and** `met` rows.
   Target not held, or a different generation: close the row as `superseded` (or
   `target_gone` when the target is terminated or deleted). No alert. No lift.
   When the target is *still held under a new generation*, the close writes the
   activity entry `hold.condition_closed` with the reason, so the change is visible
   and the nudge (section 3.12) covers the new hold.
2. **As the guard of the lift itself.** A lift is a **compare-and-set**: one
   transaction that locks the target row and the condition row (`FOR UPDATE`), or
   one `UPDATE` whose `WHERE` holds `id`, `company_id` and the predicate. It marks
   the condition `lifted` in the same transaction. Zero rows updated means the hold
   changed: close as `superseded` and lift nothing. Reading the target "just before"
   the lift is **not** enough, because the existing resume functions are plain
   `UPDATE ... WHERE id = ?` with no generation predicate. The human "Lift now"
   uses the same compare-and-set.

Prerequisites, because the code does not allow this today:

- **H1.** Each scope's pause, resume and release logic becomes one shared function
  that takes an optional transaction and an optional expected generation. The
  existing routes call it without a generation (their behaviour does not change).
  The adapter calls it with one. For the agent, the route-level refusal of a resume
  when the org chain is invalid moves into the shared resume function, so that no
  caller can skip it.
- **H2, company.** Today `PATCH /companies/:id` with `status: "paused"` leaves
  `paused_at` and `pause_reason` NULL, and `status: "active"` does not clear them
  (only the budget service writes them). A pause, resume, pause cycle would give the
  same NULL key twice. H2 adds a dedicated company pause and resume path that the
  `PATCH` route uses when the status changes to or from `paused`: it sets
  `paused_at` and `pause_reason = 'manual'` on a pause and clears both on a resume.
  A company that was paused before this change has no `paused_at`. A condition
  cannot be attached to it until it is paused again, and the refusal says so.
- **H2, routine.** `routines.paused_at` and `routines.pause_reason` (nullable),
  written by the routine update path: `manual` for a `PATCH`, `system` for the
  draft normalization and for built-in routine scheduling.

**Attach binds to the hold the operator saw.** The request carries
`expectedHeldSince` (and `expectedHeldReason`). If the target's generation differs
(someone paused it again between the page render and the click), the answer is 409
and nothing is bound. Inside one transaction the attach also supersedes any stale
row for the same scope (different generation) before it inserts, so a stale `met`
row can never make the unique index refuse a new pause.

### 3.4 State machine

```
        attach (needs what pausing that scope needs)
 (none) ───────────────────────────────▶ armed ◀───────────────┐
                                          │                     │ replace (armed or met;
                         checker: true    │                     │ a met row goes back to armed,
                                          ▼                     │ met_at cleared)
                        withdraw         met ───────────────────┘
              ┌────────── armed|met ──────┤
              ▼                           ├─ auto_lift, setter still authorized ─▶ lifted
          withdrawn                       ├─ "Lift now" (deliberate) ────────────▶ lifted
                                          └─ withdraw ───────────────────────────▶ withdrawn

 armed|met ── target not held, or held again with a new generation ──▶ superseded
              (the checker visits armed AND met rows; no alert, no lift)
```

`met` is sticky on purpose. A metric that dips below its threshold for one minute
must not make an alert appear and vanish. After `met`, the alert stays until a
person lifts the hold, withdraws the condition, replaces it, or dismisses the
alert. Replacing a `met` condition is the **Keep holding** action: it sets a new
condition in one step and puts the row back to `armed`. Every transition is a
compare-and-set on the row (`UPDATE ... WHERE id = ? AND status IN (...)
RETURNING`). Only the caller that wins the update writes the activity entry, so two
callers cannot write two `hold.lifted` or two `hold.condition_met` entries.

### 3.5 The checker

A worker, built like the usage record worker, with two corrections:

- one unref'd, single-flight interval (default 60 seconds, configurable);
- single-flight by a **session-level** advisory lock held on one connection for the
  whole pass. Each row is handled in its **own** transaction, so one failed
  statement does not abort the pass (a transaction-level lock would);
- it reads rows in bounded batches through the partial index and makes **two
  passes**: `armed` rows (evaluate the condition) and `met` rows (re-check the
  generation, supersede a stale row, and retry an automatic lift that failed);
- it uses the **database clock** (`now()`), never a host clock;
- **an error is caught per row**, recorded as `last_error`, logged once per
  interval, and never reaches a run. A lagging or dead checker delays alerts. It
  changes no hold.

What the checker writes: the condition rows, the activity log, and, for an
automatic lift only, the target **through its scope adapter**. The adapter calls
the scope's own lift function, which writes the target's state and the target's own
activity entry. The checker writes nothing else and never wakes a run. An
automatic lift of an issue tree hold is a release **without** the optional wake
step: the release route runs that step only when `metadata.wakeAgents === true`,
after a `getExecutionBlocker` check. So the wakeups that the hold cancelled stay
cancelled, and `hold.lifted` says `wakesSent: false`. A person who wants the wake
uses **Lift now** and the existing option.

Write churn. `last_evaluated_at` would change every pass for every armed row. It is
bookkeeping, not a user-visible change. It is written only when `met_at`,
`last_error` or `last_observed` changes, and otherwise at most once every 15
minutes. This is the one exemption from the rule that every mutation writes an
activity entry. The state changes are not exempt.

The checker never reads prompts, run output or issue text. It reads: the clock,
the target's pause columns, an issue's status, and (slice 3) a capacity sample.

### 3.6 Condition types

**Slice 1**

| Type | `condition_params` | Met when | `auto_lift` | Attach is refused when |
|---|---|---|---|---|
| `time` | `{ at: ISO-8601 }` | `now() >= at` | allowed | `at` is not in the future |
| `review_date` | `{ on: "YYYY-MM-DD" }` (UTC date) | the date has started | **never** (a person must look) | the date is not in the future |
| `issue_closed` | `{ issueId }` | the issue status is `done` or `cancelled` | allowed | the issue does not exist **or belongs to another company** (one identical response), or is already closed |

`issue_closed` has one more rule. If the issue is deleted after the attach, the
condition can never be met. The checker sets `last_error = 'issue_not_found'`. The
alert then says the condition is *broken* (section 3.9), so a hold never waits on
a condition that cannot fire.

**Slice 3 (after the resource capacity plan lands on `main`)**

| Type | `condition_params` | Met when |
|---|---|---|
| `metric_below` | `{ metric: "environment_disk_used_percent", environmentId, threshold, forMinutes }` | the latest capacity samples have been below `threshold` for `forMinutes` |

Two safety rules for metrics. A sample older than twice the sampling interval
means *unknown*, not *met*: the checker sets `last_error = 'metric_stale'` and
never lifts on stale data. And `forMinutes` gives hysteresis, so a value that
bounces around the threshold does not trigger early.

**Slice 2 (issue tree holds only)**

| Type | `condition_params` | Met when | `auto_lift` | Attach is refused when |
|---|---|---|---|---|
| `active_runs_finished` | `{}` | no run is `queued` or `running` for any issue in the hold's tree | allowed | the scope is not `issue_tree_hold`, or no run is active already (it would be met at once) |

#### Retiring the unused release strategy

Today `issue_tree_holds.release_policy.strategy` can be `after_active_runs_finish`.
The validator accepts it and the row stores it, and **nothing reads it**. A hold
with that strategy behaves exactly like `manual`. Slice 2 replaces the field with
the condition type above. This is what happens to the data:

- **Existing rows.** One idempotent backfill runs in slice 2 (in the slice's
  migration or as a command; chosen then). For each hold that is **active**, has
  `mode = 'pause'`, stores `after_active_runs_finish` and has no condition, it
  creates an `active_runs_finished` condition with **`auto_lift = false`**.
  Released holds are not touched: they are history. The backfill lifts nothing.
- **Why `auto_lift = false`.** The strategy name suggests an automatic release, but
  that never happened. Making holds that have been inert for days release
  themselves would be a silent change of behaviour, which is what this plan
  exists to prevent. With `auto_lift = false`, the owner gets the `hold_lift` alert
  when the runs have finished and decides. A board user can then set `auto_lift`
  on the row.
- **New writes.** The column and the field stay (the migration rule is additive only,
  so the column is never dropped). For two releases the validator still accepts the
  strategy. It is marked deprecated in OpenAPI and in the CLI help. A create with it
  makes the same condition with `auto_lift = false`, in the same transaction, and the
  response carries a deprecation notice. After two releases the validator rejects it
  with 422 and a message that names `liftCondition`.
- **`manual` and the `note` field** are unchanged.

**Later:** `any_of` (several conditions, the first one wins).

A hold that the system makes for a missing prerequisite has an obvious future
condition. A draft routine with no default agent is normalized to `paused`. The
natural lift is "an agent is assigned". That is a later condition type, not slice 1.

### 3.7 `auto_lift` rules, and which holds may carry a condition

**Which holds.** Slice 1 accepts a condition only on a hold whose reason is
**exactly `manual`**. The agent `pause_reason` is free text in practice (section 2,
F2b), so a denylist of `budget`, `company_archived` and `import` would let
built-in and plugin-managed pauses through, and those have their own owner (the
provisioning code and the plugin host also pause and resume those agents). An
allowlist is the safe form. If a path starts writing `system` for agents, adding it
is a one-line decision then.

`auto_lift` is off by default. Each rule below is enforced by the service and has
a test.

1. Only a **board user** can set it. An agent actor cannot.
2. It is refused with `review_date`.
3. It is allowed only on a hold whose reason is `manual` (above).
4. **Compare-and-set at the lift** (section 3.3). A resume plus a new pause between
   the check and the lift cannot be lifted by the old condition.
5. **The setter is checked again.** `auto_lift` is a standing pre-authorization,
   and a person's rights can change after they set it. Before the lift, the checker
   asks the scope adapter whether the stored setter (`created_by_user_id`) still
   passes the scope's own resume check. If not, nothing is lifted, the row stays
   `met` with `last_error = 'auto_lift_not_authorized'`, and the alert says that
   the automatic lift is no longer authorized.
6. A failed lift leaves the hold on, the row `met`, `last_error = 'lift_failed'`,
   and the alert in place. A failed auto-lift is never silent.
7. A successful auto-lift writes `hold.lifted` with the actor `system` and
   `auto: true`, **and** the target's own entry (`agent.resumed`,
   `issue.tree_hold_released`, and so on). The operator pre-authorized the act, so
   no alert is needed. The trace is the activity entries.

### 3.8 Scope adapters

The scope adapter is the only code that knows what a scope is. It has three
methods:

```
isHeld(companyId, scopeId)
  -> { held: boolean, generation: { since: Date, reason: string | null } | null }
lift(companyId, scopeId, expected: Generation, actor, tx)
  -> "lifted" | "stale"        // a compare-and-set (section 3.3)
canLift(userId, companyId, scopeId) -> boolean
                               // the scope's own resume check for a user,
                               // without a request object (section 3.7 rule 5)
```

`lift` calls the scope's **own shared function** (section 3.3 prerequisites), with
the same validation and side effects as the route. It does not write the target's
columns itself. `canLift` is a request-free form of the check the route makes. H1
extracts it from the route helpers so that the route and the adapter share one
implementation.

| Scope | `isHeld` reads | `lift` calls | `canLift` is |
|---|---|---|---|
| `agent` | `status = 'paused'`, `paused_at`, `pause_reason` | the shared agent resume function (it now holds the invalid-org-chain refusal) | the checks of `getAccessibleAgent` for a board user: company access, write access, and the `agents:create` manage check |
| `issue_tree_hold` | `status = 'active'`, `mode = 'pause'` | the tree control `releaseHold`, **without** the wake step (section 3.5) | the tree-hold routes' access check and `assertBoard` |
| `company` (H2) | `status = 'paused'`, `paused_at` | the new company resume path (section 3.3). Lifting can also restore the agents that the archive paused with `company_archived`, and `hold.lifted` lists that cascade in its details | board with company access |
| `routine` (H2) | `status = 'paused'`, `paused_at` | the routine update with `status: "active"` | `assertCanManageExistingRoutine` and `assertBoardCanAssignTasks` |
| `project` | `paused_at`, `pause_reason` | not exposed in slice 1: no pause API exists, and only the budget service writes it | n/a |

### 3.9 The alert surface

The inbox is the **attention feed**. It is computed on read from current state,
and only dismissals are stored (`inbox_dismissals`). The alert fits that shape.

Add one source kind, `hold_lift`, next to `budget_alert` and `agent_error_alert`.
It needs no new table, because the stored `met_at` is the only extra fact.

| Field | Value |
|---|---|
| `sourceKind` | `hold_lift` (ranked after `budget_alert`) |
| subject | the **condition**: `kind: "hold"`, `id` = the condition id, the title is the held thing's name, and `href`, `scopeType` and `scopeId` are in the metadata. (`AttentionSubjectKind` has no `routine` or `company` today, and retention and triage key on the subject, so a per-condition subject keeps each alert independent.) |
| `whyNow` | "Lift condition met 3 hours ago. *Name* is still paused." |
| `entryRule` | the condition row is `met` and the target is still held (same generation). Evaluated by one batch read for each scope type inside the feed build |
| `exitRule` | the hold is lifted, withdrawn or superseded, or the alert is dismissed |
| `dedupKey` | the condition id. (The item id already starts with the kind, so a `hold_lift:` prefix would double it) |
| `severity` | `medium` when the condition was just met, `high` once it has been met for one hour (a shared constant) |
| `decisionVerbs` | **Lift now** (resolvable inline), **Keep holding** (opens the condition editor to set a new condition), **Dismiss** (the existing inbox dismissal) |
| detail | condition type, `met_at`, `note`, `last_error` |

A second state uses the same kind: **broken**. The row is `armed` and
`last_error` is `issue_not_found` (or, in slice 3, `metric_stale` for longer than
a grace period). `whyNow` says the condition cannot be checked. Severity is
`medium`. The verbs are **Edit condition** and **Dismiss**.

A third state, **no condition**, is the nudge for a hold that has no lift
condition at all (section 3.12).

Dismissing the alert does **not** hide the hold. The badge on the held thing stays
(section 4.3). The activity entry `hold.condition_met` (written once, by the
system) is the second surface, in the existing activity feed.

Four details decide whether the alert really behaves, and each follows from how
the feed works today:

- **`activityAt` is `met_at` and is never bumped.** A dismissal stays active only
  while `dismissedAt >= activityAt`. If `activityAt` followed `updated_at` or
  `last_evaluated_at`, every dismissal would come back on the next pass.
- **Retention must not archive a live alert.** The decision retention job
  auto-archives items idle for 90 days (`DEFAULT_DECISION_ARCHIVE_DAYS`). A `met`
  alert on a hold that is still on would silently leave the inbox. While the
  condition is `met` and the target is held, the item is kept (seeded as `keep` or
  skipped by the job). Because each alert has its own subject id, a later alert on
  the same target never inherits an archived state.
- **More code than the UI map.** The new kind touches the shared
  `ATTENTION_SOURCE_KINDS`, `AttentionItemDetail` and `AttentionSubjectKind`
  types, the `decisionAttentionSourceKindSchema`, the exhaustive switches in
  `services/decision-queues.ts` (`sourceIssueId` and `canReadDecisionSource`), the
  UI map in `ui/src/lib/attention.ts`, and handlers for the new verb ids.
- **Item shape tests.** The existing attention service test lists every source
  kind. It gets the new kind and the three states.

### 3.10 Authorization: no new permission

"No new permission" is true only if every action reuses the scope's **whole** check
chain, not just its headline check. Pausing an agent is not only `assertBoard`:
`getAccessibleAgent` also needs company write access (a viewer is refused) and the
`agents:create` manage check. Activating a routine needs `tasks:assign`. If the new
routes checked less than the old ones, any board member who may not pause an agent
could still set a condition on it, and with `auto_lift` the system would lift it
for them. So H1 extracts each chain into a helper that both the scope's own route
and the lift condition routes call.

| Action | Who | Same check as |
|---|---|---|
| Attach, replace, withdraw a condition | A board user | **pausing** that scope: for an agent `assertBoard` and `getAccessibleAgent`; for a tree hold the tree-hold routes' access check and `assertBoard`; for a routine `assertCanManageExistingRoutine`; for a company the company update route |
| Set `auto_lift` | A board user | stricter than pausing (section 3.7) |
| Lift now | The actor that may **resume** that scope | the scope's own resume or release route; for an agent actor `assertCanResumeAgent`, which needs the `agent_config:update` change grant and, for itself, an explicit target grant |
| List and read | A board user with access to the company | the attention feed |
| Automatic lift | The system actor, only when a board user set `auto_lift` and that user still passes `canLift` | section 3.7 rule 5 |

Agent actors get **no attach, replace or withdraw** in any slice of this plan, even
where an agent can pause something today (the assignee agent can pause its own
routine). An agent actor can call **Lift now** only where the scope's own resume
already allows it. That adds no power. Agent read access is a later decision (section 8, Q4).

Company isolation. Every `scope_id` and every `issueId` in a condition is matched
on `(id, company_id)`. A missing id and an id in another company give **one
identical response** (the same 404 pattern that `authz.ts` uses), so a caller cannot
probe issue ids across companies. Replace revalidates the same way. The checker
reads issues by `(id, company_id)`.

### 3.11 Edge cases

| Case | Behaviour |
|---|---|
| Target resumed by another path | The next check (armed **or** met row) closes the row as `superseded`. No alert |
| Target paused again later | New generation. The old row is closed as `superseded`, with a visible `hold.condition_closed` entry. No lift |
| A `met` row whose target was resumed, then paused again with a condition | The attach supersedes the stale row inside its own transaction. No 409 |
| Target terminated, deleted or its company archived | Close as `target_gone` |
| Condition already true at attach | Refused with 422 and a message. No instant alert |
| Two attaches at once | The partial unique index decides. The loser gets 409 |
| Attach after a re-pause the operator did not see | 409 on `expectedHeldSince`. Nothing is bound |
| Pause with a condition on an agent that is already paused | 409. A re-pause would rewrite the reason to `manual` and turn a budget, import or plugin hold into one that passes the allowlist |
| Hold reason is not `manual` | Attach refused in slice 1 (their owner decides) |
| Company paused before H2 (no `paused_at`) | Attach refused until it is paused again |
| Replace a `met` condition | Allowed. It is **Keep holding**: the row goes back to `armed` |
| The setter loses the right to resume | No automatic lift. The row stays `met`, `last_error = 'auto_lift_not_authorized'`, and the alert says so |
| Checker and a person act on one row at the same moment | The compare-and-set picks one winner. One activity entry |
| Company removed | Rows deleted in the removal transaction |
| Clock skew between instances | The checker uses the database clock only |
| Checker down | Alerts are late. No hold changes |

### 3.12 The no-condition nudge (slice H1b)

A hold with no lift condition is the case that the alert above cannot see: nothing
is armed, so nothing can become *met*. Operators report holds that stayed on for
hours with no condition, and nobody saw them. The nudge guards that case. **It is
on by default** (decision Q6), and it ships as slice H1b, right after H1. It stays
out of H1's diff.

Rules:

- **Which holds.** A hold that has been on for at least the threshold and has no
  `armed` or `met` condition. The scopes are the ones that have an adapter:
  agent and issue tree hold in H1b, company and routine when H2 lands. Only holds
  whose reason is `manual` count (the same allowlist as section 3.7). Built-in and
  plugin-managed agents are paused on purpose by their own provisioning, and the
  budget, archive and import pauses have their own owner, so a nudge there would
  only be noise.
- **Threshold.** The instance setting `holdNoConditionNudgeHours`. Default **24**.
  A whole number from 1 to 720. **0 turns the nudge off.** The setting lives in the
  `general` JSON of the instance settings, so it needs no migration: a field in the
  shared type and validator (with the default), the service normalizer, and the
  settings visibility list. It uses the surfaces that exist: `GET` and `PATCH
  /instance/settings/general`, the CLI `instance settings:general:update`, and the
  `InstanceGeneralSettings` web page. Changing it needs the existing
  `assertCanManageInstanceSettings`, and it writes the existing activity entry
  `instance.settings.general_updated`. **No new permission.**
- **Shape.** The same `hold_lift` kind with the state `no_condition`. Severity is
  **low**, which ranks below every other kind. `whyNow`: "*Name* has been paused
  for 26 hours with no lift condition." Verbs: **Set lift condition** (opens the
  editor) and **Dismiss**.
- **Once per hold, dismissible per hold.** `dedupKey` is
  `hold_no_condition:<scopeType>:<scopeId>:<heldSince>`. One item per hold
  generation. A dismissal hides that item only. A new pause is a new generation and
  a new key. Setting a condition removes the item (the exit rule). A dismissed
  nudge never hides a later `hold_lift` alert, because the keys differ.
- **Derived, not stored.** The nudge is computed on read from the target's own pause
  time. It stores nothing and changes nothing, so it writes no activity entry.
- **Noise.** The risk is a company with many pauses that are on purpose. The
  answers are low severity, a dismissal per hold, a threshold that an operator can
  raise, and 0 to turn it off for the instance. The threshold is instance wide, but
  each company sees only its own holds.
- **Cost.** One indexed read per scope for the held targets of a company
  (`agents (company_id, status)` and `issue_tree_holds (company_id, status, mode)`
  both exist). No checker work.

## 4. Surfaces

### 4.1 API

Resource name: *lift condition*. Paths are under the company, listed in OpenAPI,
and every response is company-scoped.

| Method and path | Purpose |
|---|---|
| `GET /companies/:companyId/lift-conditions` | List, joined with the live state of the target. Filters: `status`, `scopeType`, `scopeId`. Keyset pagination |
| `GET /companies/:companyId/lift-conditions/:id` | One condition |
| `POST /companies/:companyId/lift-conditions` | Attach to a held target: `{ scopeType, scopeId, expectedHeldSince, expectedHeldReason, condition, autoLift?, note? }`. 409 if the generation differs or a condition is active already (use `PATCH`). 422 if the reason is not `manual` or the condition is already met |
| `PATCH /companies/:companyId/lift-conditions/:id` | Replace the condition while it is `armed` or `met`. A `met` row goes back to `armed` (**Keep holding**) |
| `POST /companies/:companyId/lift-conditions/:id/lift` | Deliberate lift. Calls the scope's own lift. Body: `{ reason? }` |
| `POST /companies/:companyId/lift-conditions/:id/withdraw` | Remove the condition. The hold stays |

For convenience, the existing routes accept the condition in the same call:
`POST /agents/:id/pause` and the tree hold create route take optional
`liftCondition` and `autoLift`. The company and routine routes get the same in
slice 2. **Same transaction is a prerequisite, not a given.** Today the agent
`pause` function uses the database handle directly, the route then cancels active
work and writes the activity entry, and `createHold` opens its own transaction.
H1 makes both accept an optional transaction. A pause with a condition on a target
that is **already paused** is refused with 409.

Activity entries (details are bounded: scope, condition type and params, actor):
`hold.condition_set`, `hold.condition_replaced`, `hold.condition_met` (system),
`hold.condition_withdrawn`, `hold.lifted` (with `auto`, `wakesSent` and any
cascade), `hold.condition_closed` (for `superseded` and `target_gone`). The entries
use the **target's** `entityType` and `entityId`, so they appear on the target's own
timeline. A lift writes `hold.lifted` **and** the target's own entry
(`agent.resumed`, `issue.tree_hold_released`, `company.updated`, `routine.updated`).
The new route file is added to the `apiPrefixes` map and to the coverage in
`server/src/__tests__/openapi-routes.test.ts`, and the routes use the cross-company
404 pattern.

### 4.2 CLI

| Command | Maps to |
|---|---|
| `paperclipai lift-condition list [--status] [--scope-type] [--scope-id] [--json]` | `GET` list |
| `paperclipai lift-condition get <id>` | `GET` one |
| `paperclipai lift-condition set --scope-type agent --scope-id <id> --type time --at <iso> [--auto-lift] [--note]` (also `--type issue-closed --issue <id>`, `--type review-date --on <date>`) | `POST` |
| `paperclipai lift-condition lift <id> [--reason]` | `POST .../lift` |
| `paperclipai lift-condition withdraw <id>` | `POST .../withdraw` |
| `paperclipai agent pause <agentId> [--lift-at <iso> \| --lift-when-issue-closed <id> \| --review-on <date>] [--auto-lift]` | `POST /agents/:id/pause` with the condition |

Every command takes `--json` and the common client options. The existing
`agent pause` sends an empty body today, so its option parsing is a small change.
`company update` takes a JSON payload only, so slice 2 adds the condition to that
payload and to `lift-condition set`, not a new flag.

### 4.3 Web

- **Pause dialog** (agent in slice 1; the routine toggle in slice 2): an optional
  section *Lift when*. Choices: Never (today's behaviour), At a time, When an
  issue closes, Review on a date. A checkbox *Lift automatically* (board only,
  hidden for Review on a date). A short note field.
- **Badge on the held thing** (agent header and list, tree hold panel on issue
  detail; routine page and company banner in slice 2): "Paused since *date*.
  Lifts when *condition*." When the condition is met: "Condition met 2 hours ago."
  with a **Lift now** action.
- **Inbox card** for `hold_lift` with the verbs in section 3.9.
- **Lift conditions list** (slice 2): one company page with the armed and met
  conditions, linked from the badge and from the inbox card.
- **Company.** The web has no company pause control today. Slice 2 adds the badge
  and **Lift now** for a paused company. A *pause with a condition* for a company
  stays on the API and the CLI. A web control to pause a company is a product
  choice and not part of this plan.

Web checks follow `AGENTS.md`: token-only styling (`pnpm check:token-gates`), a
real browser at desktop and mobile widths, zero console errors.

## 5. Slice plan

Each slice lands single, after this plan is approved and merged. Each carries its
own tests and docs. Each migration is numbered just in time.

| Slice | Scope | Needs |
|---|---|---|
| **H1** | Table and migration; shared contract; service; checker; agent and tree hold adapters; condition types `time`, `review_date`, `issue_closed`; API, OpenAPI, CLI; activity entries; the `hold_lift` alert; web: pause dialog for agents, badge, inbox card | none |
| **H1b** | The no-condition nudge (section 3.12): the `no_condition` state of the `hold_lift` alert, the instance setting `holdNoConditionNudgeHours` (default 24, 0 turns it off) in the API, the CLI and the web settings page. No migration. Kept out of H1's diff | H1 |
| **H2** | Company and routine adapters; `routines.paused_at` and `pause_reason` (a second, small migration); the lift conditions list page; the same options on the company and routine routes, CLI and dialogs; `active_runs_finished`, the backfill, and the deprecation of `after_active_runs_finish` (section 3.6); the nudge for the company and routine scopes | H1 |
| **H3** | `metric_below` on environment disk; the reserved `environment` scope; the link with disk-aware dispatch | H1 and the resource capacity samples on `main` |
| **Later** | `any_of`; the condition "an agent is assigned" for system-paused draft routines; agent read access (with the plan for agents acting on other agents' work); a chat message for an alert | n/a |

**H1 prerequisites** (they come first inside H1, and each is its own commit):

1. Shared pause, resume and release functions per scope that take an optional
   transaction and an optional expected generation, with the invalid-org-chain
   refusal inside the shared agent resume.
2. Request-free `canLift` predicates extracted from the route helpers.
3. The shared types, the `decision-queues` cases and the UI map for the new kind
   (section 3.9).

H1 is large because the rule is that each slice reaches all three surfaces. If the
reviewer prefers, H1 splits at the web work: API, CLI and the alert first, the
dialog and badge as a linked follow-up. The alert is not free on the web side
(section 3.9), but the pause dialog and the badge are the bigger part.

**Metric conditions.** The lead example of the brief, "worker disk under N%", has
no path in H1 or H2, because the samples it needs are not on `main` yet. `time`,
`review_date` and `issue_closed` cover the other examples. Reserving the
`metric_below` member of the zod union in H1 only to reject it adds noise, so this
plan does not.

## 6. Verification per slice

Tests are written red first. Each bug-shaped rule below is a test that fails
without the code.

**H1**

- **Never silent.** With `auto_lift = false`, a met condition leaves the target
  exactly as it was. The test compares the target row before and after a check.
- **Generation.** Pause, attach, resume by another path, pause again with
  another reason: the old condition does not lift the new hold, and closes as
  `superseded`.
- **Compare-and-set.** Interleave the checker's lift with a human resume and a new
  pause between its read and its write: the old condition lifts nothing. The test
  uses a barrier, not a sleep.
- **Stale `met` row.** Pause, condition met, resume by another path, pause again
  with a condition: no 409, and the old row is `superseded`. The checker visits
  `met` rows.
- **Bound to the hold the operator saw.** An attach with a stale `expectedHeldSince`
  is a 409 and binds nothing. A pause with a condition on an already-paused agent is
  a 409.
- **Reason allowlist.** A built-in, a plugin-managed, a `budget` and an `import`
  pause all refuse a condition.
- **Setter re-check.** The setter loses the resume right: no automatic lift, the
  row stays `met` with `auto_lift_not_authorized`, and the alert says so.
- **Authorization parity.** For each scope, a user who cannot pause it cannot attach
  to it, and a user who cannot resume it cannot lift it. A viewer is refused.
- **No cross-company oracle.** A missing issue id and an issue id in another
  company return the same response.
- **One winner.** Two simultaneous transitions write one activity entry.
- **Each condition type**, met and not met, with the database clock faked; attach
  refusals (past time, closed issue, issue in another company).
- **`auto_lift` rules** one by one (section 3.7), including a failed lift that
  keeps the hold, the row and the alert.
- **Company isolation.** Company A cannot list, read, attach to, lift or withdraw
  anything in company B, through the API or the alert feed.
- **Alert.** Appears when `met` and held, disappears on lift, withdraw or
  supersede, survives a dismissal as a badge, and severity rises at one hour.
  A dismissal stays dismissed across checker passes (`activityAt` is `met_at`).
  A `met` alert on a held target is not auto-archived after 90 days.
- **Checker fail-open.** A throwing adapter on one row does not stop other rows,
  and no run is touched. A single-flight test with two checkers.
- **Company removal** deletes the rows. **Migration** applies on a fresh chain and
  twice in a row. `pnpm run check:migrations` passes.
- **Parity.** A table test that every OpenAPI path under `/lift-conditions` has a
  CLI command and a web client method, and the OpenAPI route test passes.
- **Activity.** Every mutation, including the system's, writes one entry (the
  `last_evaluated_at` bookkeeping excepted, section 3.5). A lift writes `hold.lifted`
  and the target's own entry. An automatic lift of a tree hold sends no wake.
- **Web.** Desktop and mobile widths in a real browser, zero console errors.

**H1b**

- **Threshold.** With a fake clock, the nudge is absent at 23 hours 59 minutes and
  present at 24 hours. A setting of 0 removes it. A setting of 1 or 720 works, and
  721 and a negative number are refused by the validator.
- **Allowlist.** Only a hold whose reason is `manual` gets a nudge. Built-in,
  plugin-managed, `budget`, `company_archived` and `import` pauses never do.
- **Per hold.** Dismissing one nudge leaves another hold's nudge. A second pause of
  the same target after a resume gives a new item.
- **Removal.** Attaching a condition, lifting the hold, or resuming it by another
  path removes the item.
- **Read only.** Reading the feed changes no row and writes no activity entry.
- **Instance setting.** The default is 24 on an instance that never set it. The
  update needs `assertCanManageInstanceSettings` and writes
  `instance.settings.general_updated`. The CLI and the web page round-trip the value.
- **Company isolation.** A company never sees another company's nudge, whatever the
  instance threshold.

**H2** repeats the generation and isolation tests for company and routine, and
tests the `routines` column migration on a table with rows. It also tests:

- **Backfill.** It creates one `active_runs_finished` condition with
  `auto_lift = false` for each active pause hold that stores the old strategy and has
  no condition. It is idempotent (a second run adds nothing). It skips released
  holds and holds that already have a condition. It lifts nothing.
- **Deprecation.** A create with the old strategy makes the same condition in the
  same transaction and returns the notice. The OpenAPI document marks the field
  deprecated.
- **`active_runs_finished`.** Not met while a run is queued or running anywhere in
  the tree, met when the last one ends, and refused on any other scope.

**H3** adds the stale sample rule, the hysteresis test, and an end-to-end test
with a fixture capacity sample.

## 7. Alternatives considered

| Option | Why not |
|---|---|
| A generic `holds` table that becomes the source of truth (the pause columns become mirrors) | Touches five pause sites, the budget service, and the dispatch gates. Large behaviour risk for no user-visible gain over a side table |
| Lift columns on each target table | Four migrations, four checkers, four copies of the rules |
| Reuse `issue_tree_holds.release_policy` as the general model | It exists only for issue trees and nothing evaluates it. It stays as a scope adapter, and `after_active_runs_finish` becomes the condition type `active_runs_finished` (section 3.6) |
| A stored alert table | The attention feed is derived from state. The stored `met_at` is the only extra fact |
| Evaluate conditions inside the attention read | Costly for metrics, and it cannot make `met` sticky |
| Hook every resume path to close the row, and rely on that | One missed path is a wrong lift. The generation check makes a missed path harmless (F5). The early close stays as an optimization |
| Lift automatically by default | The brief and the incident are both about holds that change without anyone knowing. Default stays deliberate |

## 8. Decisions

The eight questions of the first draft were answered on 2026-10-10. The plan above
follows the answers.

| ID | Decision |
|---|---|
| Q1 | H1 covers the agent and the issue tree hold. H2 covers the company and the routine |
| Q2 | Only board users may set `auto_lift` |
| Q3 | `review_date` never lifts automatically |
| Q4 | Read access is board only in H1. Agent read access goes with the later plan for agents acting on other agents' work |
| Q5 | Implement `active_runs_finished` and retire the unused field. Existing rows are handled in section 3.6 |
| Q6 | **Changed from the draft's recommendation.** The nudge is **on by default**, as slice **H1b** right after H1: low severity, one item per hold after 24 hours with no condition, dismissible per hold, and the threshold is an instance setting (section 3.12). *Why:* the problem behind this plan is a hold with no condition that nobody saw for hours. A guard that is off by default would not have caught it. The draft recommended a separate follow-up that is off by default |
| Q7 | Escalate from `medium` to `high` after one hour, with a shared constant |
| Q8 | Inbox and activity only. A chat message is a follow-up |

Choices this plan made that the answers did not cover. The reviewer should check
them:

- The backfill makes `auto_lift = false` conditions for old holds (section 3.6).
- The old strategy is accepted for two releases and then rejected (section 3.6).
- The nudge setting is a whole number from 1 to 720, and 0 means off (section 3.12).
- Only holds whose reason is exactly `manual` can carry a condition or get a nudge
  (sections 3.7 and 3.12). This is narrower than the draft, and the reason is that
  the agent pause reason is free text in practice.
- Replacing a `met` condition is allowed and is the **Keep holding** action.
- The lead example of the brief, a disk metric, ships in H3, after the capacity
  samples land (section 5).

## Appendix A. Code anchors on `main` at `3fca7f35e`

| Fact | Where |
|---|---|
| Agent pause columns | `packages/db/src/schema/agents.ts` (`pauseReason`, `pausedAt`) |
| Company and project pause columns | `packages/db/src/schema/companies.ts`, `projects.ts` |
| Pause reasons | `PAUSE_REASONS` in `packages/shared/src/constants.ts` |
| Agent pause, resume, clear-error | `server/src/services/agents.ts` (`pause`, `resume`, `clearError`); routes in `server/src/routes/agents.ts` (`/agents/:id/pause` uses `assertBoard`; resume uses `assertCanResumeAgent`) |
| Budget pause and resume | `server/src/services/budgets.ts` (`pauseScopeForBudget`, `resumeScopeFromBudget`) |
| Company resume | `server/src/routes/companies.ts` (`PATCH` with `status: "active"`) |
| Routine status | `ROUTINE_STATUSES` in `packages/shared/src/constants.ts`; `normalizeDraftRoutineStatus` in `server/src/services/routines.ts`; `PATCH /routines/:id` in `server/src/routes/routines.ts` |
| Project pause in the routine scheduler | `server/src/services/routines.ts` (`projectPaused`, `recordSuppressedAutomaticRun`, reason `paused`) |
| Issue tree hold tables | `packages/db/src/schema/issue_tree_holds.ts`, `issue_tree_hold_members.ts` |
| Release policy type and validator | `packages/shared/src/types/issue-tree-control.ts`, `validators/issue-tree-control.ts`, `ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES` in `constants.ts` |
| Tree hold service and gate | `server/src/services/issue-tree-control.ts` (`getActivePauseHoldGate`, `releaseHold`, `MAX_PAUSE_HOLD_ANCESTOR_DEPTH`) |
| Tree hold routes and CLI | `server/src/routes/issue-tree-control.ts`; `cli/src/commands/client/issue.ts` (`tree-hold:create`, `:get`, `:release`) |
| Dispatch gate | `server/src/modules/run-dispatch/domain/policy.ts` (`decideScheduledRetryGate`, error code `issue_paused`); facts loaded in `adapters/postgres.ts` |
| Attention feed | `server/src/services/attention.ts` (`ATTENTION_SOURCE_KINDS`, `SOURCE_RANK`, the `budget_alert` and `agent_error_alert` blocks); route `server/src/routes/attention.ts`; dismissals in `packages/db/src/schema/inbox_dismissals.ts` |
| Process switch | `heartbeatSchedulerEnabled` in `server/src/config.ts` |
| Instance settings (the nudge threshold) | `general` JSON in `packages/db/src/schema/instance_settings.ts`; type in `packages/shared/src/types/instance.ts`; validator in `validators/instance.ts`; normalizer in `server/src/services/instance-settings.ts`; visibility list in `packages/shared/src/settings-visibility.ts`; route `GET` and `PATCH /instance/settings/general` in `server/src/routes/instance-settings.ts` (`assertCanManageInstanceSettings`; activity `instance.settings.general_updated`); CLI `instance settings:general` and `settings:general:update` in `cli/src/commands/client/access.ts`; web `ui/src/pages/InstanceGeneralSettings.tsx` |
| Indexes the nudge reads | `agents_company_status_idx` in `schema/agents.ts`; `issue_tree_holds_company_status_mode_idx` in `schema/issue_tree_holds.ts` |
| Resource capacity samples | **Not on `main`.** A separate open pull request adds them. H3 waits for it |
| Agent access chain | `getAccessibleAgent` and `assertBoardCanManageAgentsForCompany` in `server/src/routes/agents.ts` |
| Routine access chain | `assertCanManageExistingRoutine`, and `assertBoardCanAssignTasks` on activation, in `server/src/routes/routines.ts` |
| Agent pause reasons written outside the pause route | `server/src/services/built-in-agents.ts`, `plugin-managed-agents.ts` (`managedAgentPauseReason`), `company-portability.ts` (`import`) |
| Wake deferral by a tree hold | `getPauseHoldFacts` in `server/src/modules/wake-queue/adapters/postgres.ts` |
| Dismissal and retention of attention items | `activeDismissalState` in `server/src/services/attention.ts`; `DEFAULT_DECISION_ARCHIVE_DAYS` and `autoArchive` in `server/src/services/decision-retention.ts`; the exhaustive switches in `server/src/services/decision-queues.ts` |
| Tree hold release and its optional wake | `server/src/routes/issue-tree-control.ts` (the wake step runs only when `metadata.wakeAgents === true`) |
| Company update | `updateCompanySchema` in `packages/shared/src/validators/company.ts` (a `status` field only); `companyService.update` in `server/src/services/companies.ts` |
