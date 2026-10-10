# Holds with lift conditions: a pause that says when it may end, and a system that says when it can

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
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
- **Additive, just-in-time migration.** One new table. No `ALTER` of a hot table.
  The migration number is assigned when the manager names this slice next.
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
| **Agent** | `agents.status = 'paused'` | `pause_reason` (`manual`, `budget`, `system`, `company_archived`, `import`), `paused_at`. No actor. | `POST /agents/:id/pause` (board only, `assertBoard`); budget service; company archive | `POST /agents/:id/resume` (an agent actor needs the `agent_config:update` change grant, and an explicit target grant for itself; the route also refuses a resume when the org chain is invalid); budget service `resumeScopeFromBudget` | API, CLI `agent pause` and `agent resume`, web `AgentActionButtons` | `agent.paused`, `agent.resumed` |
| **Company** | `companies.status = 'paused'` | `pause_reason`, `paused_at`. No actor. | Budget service; `PATCH /companies/:id` with `status: "paused"` (the validator accepts it) | `PATCH /companies/:id` with `status: "active"`; budget service | API; CLI `company update --payload-json` (JSON only); **no web control to pause or resume** | `company.updated` |
| **Project** | `projects.pause_reason`, `projects.paused_at` | Reason and time. No actor. | Budget service only. No pause API exists. | Budget service only | None for pausing | None |
| **Routine** | `routines.status = 'paused'` | **Nothing.** No reason, no time, no actor. | `PATCH /routines/:id`; a draft routine with no default agent is normalized to `paused` by `normalizeDraftRoutineStatus` | `PATCH /routines/:id` | API; web routine detail (the automation on/off toggle) | `routine.updated` |
| **Issue tree hold** | `issue_tree_holds` row, `mode = 'pause'`, `status = 'active'` | Reason, `release_policy`, creator and releaser columns, run ids | `POST /issues/:id/tree-holds` | `POST /issues/:id/tree-holds/:holdId/release` | API, CLI `issue tree-hold:create`, `:get`, `:release`, web issue detail | `issue.tree_hold_created`, `issue.tree_hold_released` |
| **Dispatch gates** | pure function `decideScheduledRetryGate` | n/a | n/a | n/a | n/a | n/a |
| **Process switch** | env `HEARTBEAT_SCHEDULER_ENABLED` | n/a | Operator, at start-up | Operator, at restart | Start-up banner and failure diagnostics only | None |

How the holds reach dispatch:

- The issue tree hold is the hold that blocks *dispatch*. `getActivePauseHoldGate`
  walks from an issue up its parents (at most 100 levels). If an ancestor has an
  active pause hold, `decideScheduledRetryGate` refuses the run with the code
  `issue_paused`.
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
  actor. The other stored holds keep a reason and a time. **No site records who
  paused it on the row**; only the activity log knows.
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
| `scope_type` | text, not null, `CHECK` | `agent`, `routine`, `company`, `project`, `issue_tree_hold`. Reserved, not accepted in slice 1: `environment` (for disk-aware dispatch) |
| `scope_id` | uuid, not null | The target. The service checks it belongs to `company_id` |
| `status` | text, not null, default `armed` | `armed`, `met`, `lifted`, `withdrawn`, `superseded` |
| `condition_type` | text, not null | `time`, `review_date`, `issue_closed` in slice 1 |
| `condition_params` | jsonb, not null | A closed shape per type, validated by a zod discriminated union (section 3.6) |
| `auto_lift` | boolean, not null, default `false` | Section 3.7 |
| `note` | text, null, at most 500 characters | Operator text, handled like `issue_tree_holds.reason` |
| `held_since` | timestamptz, not null | The target's own `paused_at` (or the tree hold's `created_at`) when the condition was attached. **The generation key** (section 3.3) |
| `held_reason` | text, null | The target's `pause_reason` at attach time, when it has one |
| `met_at` | timestamptz, null | First time the checker saw the condition true. **Sticky.** It never moves back |
| `last_evaluated_at` | timestamptz, null | |
| `last_observed` | jsonb, null | Bounded. For a metric: value, unit, sample time. Never free text |
| `last_error` | text, null | A closed code: `issue_not_found`, `metric_stale`, `lift_failed`, `target_gone` |
| `created_by_*` | actor type, agent id, user id, run id | Same shape as `issue_tree_holds` |
| `closed_at`, `closed_by_*`, `close_reason` | | `close_reason`: `manual_lift`, `auto_lift`, `withdrawn`, `superseded`, `target_gone` |
| `created_at`, `updated_at` | timestamptz | |

Indexes:

- **Unique, partial:** `(company_id, scope_type, scope_id) WHERE status IN ('armed','met')`.
  One active condition per hold. A second attach replaces the first while it is
  `armed` (section 4.1).
- `(company_id, status)` for the list and the alert query.
- **Partial:** `(status) WHERE status = 'armed'` for the checker.

Rows are small and are kept. Closed rows are the history of how holds ended.

### 3.3 Generation: a condition lifts only the hold it was made for

The danger of a stored condition is a stale one. An agent is paused with a
condition. Someone resumes it by another path. Later it is paused again, for a
different reason. The old condition must not lift the new hold.

`held_since` (and `held_reason`) are the answer. Before the checker acts, and
again immediately before any lift, it re-reads the target through its adapter:

- Target no longer held → close the row as `superseded`. No alert. No lift.
- Target held, but `paused_at` differs from `held_since`, or the reason differs →
  close the row as `superseded`. No alert. No lift.
- Otherwise the row still describes this hold.

This makes the design safe when a resume path is missed (F5). The row is advisory.
The target's own state is the truth. Where it is cheap, a path also closes its
row at once (the agent resume and the tree-hold release in slice 1), so the alert
does not wait for the next check. The check is the guarantee. The early close is
only an optimization.

The routine has no `paused_at` today. Slice 2 adds one nullable column (and a
`pause_reason`) to `routines`, written by the routine update path, so every scope
has a generation key.

### 3.4 State machine

```
        attach (permission of pausing that scope)
 (none) ───────────────────────────────▶ armed ◀──┐ replace (armed only)
                                          │  │    │
                         checker: true    │  └────┘
                                          ▼
                        withdraw        met  (sticky; the alert exists while met)
              ┌────────── armed|met ──────┤
              ▼                           ├─ auto_lift = true ─ system lifts ─▶ lifted
          withdrawn                       ├─ "Lift now" (deliberate) ─────────▶ lifted
                                          └─ withdraw ────────────────────────▶ withdrawn

 armed|met ── target not held, or held again with a new generation ──▶ superseded
              (no alert, no lift)
```

`met` is sticky on purpose. A metric that dips below its threshold for one minute
must not make an alert appear and vanish. After `met`, the alert stays until a
person lifts the hold, withdraws the condition, or dismisses the alert.

### 3.5 The checker

A worker, built like the usage record worker:

- one unref'd, single-flight interval (default 60 seconds, configurable);
- a Postgres advisory lock, so only one instance works at a time;
- it reads armed rows in bounded batches through the partial index;
- it uses the **database clock** (`now()`), never a host clock;
- it evaluates each row by its condition type, re-reads the target (section 3.3),
  and writes only the condition row and the activity log;
- on a lift it calls the scope adapter (section 3.8), never raw SQL on the target;
- **an error is caught per row**, recorded as `last_error`, logged once per
  interval, and never reaches a run. A lagging or dead checker delays alerts. It
  changes no hold.

The checker never reads prompts, run output or issue text. It reads: the clock,
the target's pause columns, an issue's status, and (slice 3) a capacity sample.

### 3.6 Condition types

**Slice 1**

| Type | `condition_params` | Met when | `auto_lift` | Attach is refused when |
|---|---|---|---|---|
| `time` | `{ at: ISO-8601 }` | `now() >= at` | allowed | `at` is not in the future |
| `review_date` | `{ on: "YYYY-MM-DD" }` (UTC date) | the date has started | **never** (a person must look) | the date is not in the future |
| `issue_closed` | `{ issueId }` | the issue status is `done` or `cancelled` | allowed | the issue is in another company, does not exist, or is already closed |

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

**Later:** `any_of` (several conditions, the first one wins) and
`active_runs_finished` for tree holds (section 8, Q5).

A hold that the system makes for a missing prerequisite has an obvious future
condition. A draft routine with no default agent is normalized to `paused`. The
natural lift is "an agent is assigned". That is a later condition type, not slice 1.

### 3.7 `auto_lift` rules

`auto_lift` is off by default. Each rule below is enforced by the service and has
a test.

1. Only a **board user** can set it. An agent actor cannot.
2. It is refused with `review_date`.
3. It is allowed only on holds whose reason is `manual` or `system`. It is
   refused on `budget`, `company_archived` and `import`, because those have their
   own owner and their own lift logic. Two owners for one hold would fight.
4. The generation check (section 3.3) runs immediately before the lift.
5. A failed lift leaves the hold on, the row `met`, `last_error = 'lift_failed'`,
   and the alert in place. A failed auto-lift is never silent.
6. A successful auto-lift writes `hold.lifted` with the actor `system` and
   `auto: true`. The operator pre-authorized the act, so no alert is needed. The
   trace is the activity entry.

### 3.8 Scope adapters

The scope adapter is the only code that knows what a scope is. It has two
methods:

```
isHeld(companyId, scopeId)  -> { held: boolean, since: Date | null, reason: string | null }
lift(companyId, scopeId, actor) -> Promise<void>
```

`lift` calls the scope's **own service function**, with the same validation and
side effects as the existing route. It does not write the target's columns itself.

| Scope | `isHeld` reads | `lift` calls |
|---|---|---|
| `agent` | `status = 'paused'`, `paused_at`, `pause_reason` | one shared resume function. Today the route runs the invalid-org-chain refusal *before* it calls the service `resume`, so a bare service call would skip it. H1 moves that refusal into the shared function, and both the route and the adapter call it |
| `issue_tree_hold` | `status = 'active'`, `mode = 'pause'`, `created_at` | the tree control service `releaseHold`, then the same wake step the route runs |
| `company` | `status = 'paused'`, `paused_at`, `pause_reason` | the company update with `status: "active"` |
| `routine` | `status = 'paused'`, `paused_at` (slice 2) | the routine update with `status: "active"` |
| `project` | `paused_at`, `pause_reason` | not exposed in slice 1: no pause API exists, and only the budget service writes it |

### 3.9 The alert surface

The inbox is the **attention feed**. It is computed on read from current state,
and only dismissals are stored (`inbox_dismissals`). The alert fits that shape.

Add one source kind, `hold_lift`, next to `budget_alert` and `agent_error_alert`.
It needs no new table, because the stored `met_at` is the only extra fact.

| Field | Value |
|---|---|
| `sourceKind` | `hold_lift` (ranked after `budget_alert`) |
| subject | the held thing: agent, routine, company or issue; `href` to its page |
| `whyNow` | "Lift condition met 3 hours ago. *Name* is still paused." |
| `entryRule` | the condition row is `met` and the target is still held (same generation) |
| `exitRule` | the hold is lifted, withdrawn or superseded, or the alert is dismissed |
| `dedupKey` | `hold_lift:<conditionId>` |
| `severity` | `medium` when the condition was just met, `high` once it has been met for one hour (a shared constant) |
| `decisionVerbs` | **Lift now** (resolvable inline), **Keep holding** (opens the condition editor to set a new condition), **Dismiss** (the existing inbox dismissal) |
| detail | condition type, `met_at`, `note`, `last_error` |

A second state uses the same kind: **broken**. The row is `armed` and
`last_error` is `issue_not_found` (or, in slice 3, `metric_stale` for longer than
a grace period). `whyNow` says the condition cannot be checked. Severity is
`medium`. The verbs are **Edit condition** and **Dismiss**.

Dismissing the alert does **not** hide the hold. The badge on the held thing stays
(section 4.3). The activity entry `hold.condition_met` (written once, by the
system) is the second surface, in the existing activity feed.

### 3.10 Authorization: no new permission

| Action | Who | Same check as |
|---|---|---|
| Attach, replace, withdraw a condition | A board user with access to the company | pausing that scope (`assertBoard` for an agent) |
| Set `auto_lift` | A board user | (stricter than pausing; section 3.7) |
| Lift now | The actor that may resume that scope | the scope's own resume or release route (for an agent: `assertCanResumeAgent`) |
| List and read | A board user with access to the company | the attention feed |
| Automatic lift | The system actor, only when the board user set `auto_lift` | n/a |

Agent actors get **no write** in slice 1, because agents cannot pause today.
Agent read access (so a paused agent's manager can see why) is a decision for
later (section 8, Q4). The service re-checks that every `scope_id`, and every
`issueId` in a condition, belongs to the caller's company.

### 3.11 Edge cases

| Case | Behaviour |
|---|---|
| Target resumed by another path | Next check closes the row as `superseded`. No alert |
| Target paused again later | New generation. The old row is closed. No lift |
| Target terminated, deleted or its company archived | Close as `target_gone` |
| Condition already true at attach | Refused with 422 and a message. No instant alert |
| Two attaches at once | The partial unique index decides. The loser gets 409 |
| Replace a `met` condition | Not allowed. Lift it, withdraw it, or set a new hold |
| Hold reason is `budget`, `company_archived` or `import` | Attach refused in slice 1 (their owner decides) |
| Company removed | Rows deleted in the removal transaction |
| Clock skew between instances | The checker uses the database clock only |
| Checker down | Alerts are late. No hold changes |

## 4. Surfaces

### 4.1 API

Resource name: *lift condition*. Paths are under the company, listed in OpenAPI,
and every response is company-scoped.

| Method and path | Purpose |
|---|---|
| `GET /companies/:companyId/lift-conditions` | List, joined with the live state of the target. Filters: `status`, `scopeType`, `scopeId`. Keyset pagination |
| `GET /companies/:companyId/lift-conditions/:id` | One condition |
| `POST /companies/:companyId/lift-conditions` | Attach to a held target: `{ scopeType, scopeId, condition, autoLift?, note? }`. 409 if one is active |
| `PATCH /companies/:companyId/lift-conditions/:id` | Replace the condition while it is `armed` |
| `POST /companies/:companyId/lift-conditions/:id/lift` | Deliberate lift. Calls the scope's own lift. Body: `{ reason? }` |
| `POST /companies/:companyId/lift-conditions/:id/withdraw` | Remove the condition. The hold stays |

For convenience, the existing routes accept the condition in the same call, in
one transaction with the pause itself: `POST /agents/:id/pause` and the tree hold
create route take optional `liftCondition` and `autoLift`. The company and routine
routes get the same in slice 2.

Activity entries (details are bounded: scope, condition type and params, actor):
`hold.condition_set`, `hold.condition_replaced`, `hold.condition_met` (system),
`hold.condition_withdrawn`, `hold.lifted` (with `auto`), `hold.condition_closed`
(for `superseded` and `target_gone`).

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

Each slice lands single, after its plan decisions are answered. Each carries its
own tests and docs.

| Slice | Scope | Needs |
|---|---|---|
| **H1** | Table and migration; shared contract; service; checker; agent and tree hold adapters; condition types `time`, `review_date`, `issue_closed`; API, OpenAPI, CLI; activity entries; the `hold_lift` alert; web: pause dialog for agents, badge, inbox card | none |
| **H2** | Company and routine adapters; `routines.paused_at` and `pause_reason` (a second, small migration); the lift conditions list page; the same options on the company and routine routes, CLI and dialogs | H1 |
| **H3** | `metric_below` on environment disk; the reserved `environment` scope; the link with disk-aware dispatch | H1 and the resource capacity samples on `main` |
| **Later** | `any_of`; `active_runs_finished` (and retire the unused `after_active_runs_finish` strategy); a nudge for old holds with no condition; agent read access | decisions Q5 to Q7 |

H1 is large because the rule is that each slice reaches all three surfaces. If the
reviewer prefers, H1 splits at the web work: API, CLI and the alert first, the
dialog and badge as a linked follow-up. The alert is useful on its own, but it is not
free on the web side: the UI keeps a per-kind map in `ui/src/lib/attention.ts`
(label, classification, status), and a new kind needs an entry there and a card
detail renderer. That is small. The pause dialog and the badge are the bigger part.

## 6. Verification per slice

Tests are written red first. Each bug-shaped rule below is a test that fails
without the code.

**H1**

- **Never silent.** With `auto_lift = false`, a met condition leaves the target
  exactly as it was. The test compares the target row before and after a check.
- **Generation.** Pause, attach, resume by another path, pause again with
  another reason: the old condition does not lift the new hold, and closes as
  `superseded`.
- **Each condition type**, met and not met, with the database clock faked; attach
  refusals (past time, closed issue, issue in another company).
- **`auto_lift` rules** one by one (section 3.7), including a failed lift that
  keeps the hold, the row and the alert.
- **Company isolation.** Company A cannot list, read, attach to, lift or withdraw
  anything in company B, through the API or the alert feed.
- **Alert.** Appears when `met` and held, disappears on lift, withdraw or
  supersede, survives a dismissal as a badge, and severity rises at one hour.
- **Checker fail-open.** A throwing adapter on one row does not stop other rows,
  and no run is touched. A single-flight test with two checkers.
- **Company removal** deletes the rows. **Migration** applies on a fresh chain and
  twice in a row. `pnpm run check:migrations` passes.
- **Parity.** A table test that every OpenAPI path under `/lift-conditions` has a
  CLI command and a web client method, and the OpenAPI route test passes.
- **Activity.** Every mutation, including the system's, writes one entry.
- **Web.** Desktop and mobile widths in a real browser, zero console errors.

**H2** repeats the generation and isolation tests for company and routine, and
tests the `routines` column migration on a table with rows.

**H3** adds the stale sample rule, the hysteresis test, and an end-to-end test
with a fixture capacity sample.

## 7. Alternatives considered

| Option | Why not |
|---|---|
| A generic `holds` table that becomes the source of truth (the pause columns become mirrors) | Touches five pause sites, the budget service, and the dispatch gates. Large behaviour risk for no user-visible gain over a side table |
| Lift columns on each target table | Four migrations, four checkers, four copies of the rules |
| Reuse `issue_tree_holds.release_policy` as the general model | It exists only for issue trees and nothing evaluates it. It stays as a scope adapter, and `after_active_runs_finish` maps to a later condition type |
| A stored alert table | The attention feed is derived from state. The stored `met_at` is the only extra fact |
| Evaluate conditions inside the attention read | Costly for metrics, and it cannot make `met` sticky |
| Hook every resume path to close the row, and rely on that | One missed path is a wrong lift. The generation check makes a missed path harmless (F5). The early close stays as an optimization |
| Lift automatically by default | The brief and the incident are both about holds that change without anyone knowing. Default stays deliberate |

## 8. Decisions needed

Each question has a recommendation. The slice plan assumes the recommendation.

- **Q1. Scopes in H1.** Agent and issue tree hold first, company and routine in
  H2 (recommended), or all four at once. Recommendation: two first, because the
  routine needs its own migration and the other three share an adapter shape.
- **Q2. Who may set `auto_lift`.** Board users only (recommended), or any actor
  that may resume the scope. An agent that can both set a condition and lift is a
  way around a human decision.
- **Q3. `review_date` never lifts automatically** (recommended). Its meaning is
  "a person must look".
- **Q4. Agent read access.** Board only in H1 (recommended). A later plan can let
  a manager agent read why a report is paused. That is related to the permission
  plan for agents acting on other agents' issues.
- **Q5. `after_active_runs_finish`.** Implement it as a condition type
  `active_runs_finished` and deprecate the unused field (recommended), or leave
  the field alone. Today it is stored and never read, which is a trap.
- **Q6. Holds with no condition.** A low-severity nudge after N days is a good
  guard against the original problem, but it is a different alert with its own
  noise risk. Recommendation: a separate follow-up, off by default.
- **Q7. Severity escalation.** One hour from `medium` to `high` (recommended).
  The value is a shared constant, easy to change.
- **Q8. External notification.** Inbox and activity only (the brief). A chat
  channel message is a follow-up.

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
| Resource capacity samples | **Not on `main`.** A separate open pull request adds them. H3 waits for it |
