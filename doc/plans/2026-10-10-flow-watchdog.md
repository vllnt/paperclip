# Flow watchdog: server-side stall rules that open one issue or fire one routine when a flow clogs

Date: 2026-10-10
Status: Plan only. This pull request changes no code and claims no migration number.
Branch: `docs/flow-watchdog-plan`
Code anchors: `main` at `d9804ac4f` (see Appendix A). Line numbers drift; names do not.
Related plans and pull requests: #102 (holds with lift conditions), #104 (re-dispatch of stranded issues), #105 (routine stale-tick expiry), #106 (company flow metrics).

## 1. Goal and constraints

Today a company that wants to find clogs in its flow runs an agent on a timer. The
agent polls every 15 minutes (96 polls a day). Most polls find nothing, and each empty
poll costs one agent run.

**Goal.** A company configures *stall rules*. The server evaluates them with **no
language model**. When a rule fires, the server does one of two things:

- it creates, or updates, **one deduplicated issue** whose title comes from a template
  and whose body holds the evidence. The issue is assigned to an agent, so the
  assignment wakes that agent; or
- it fires **one routine trigger** with variables.

The agent that handles clogs then wakes only when there is a clog.

Constraints, all binding:

- **No language model in the evaluation.** Rules are data. The evaluator is SQL and
  plain code.
- **Company scope.** Every row, query, route and action is company-scoped.
- **Web, API (listed in OpenAPI) and CLI** for every capability, with a dry run on all
  three. Parity of surfaces is not parity of permissions.
- **Every mutation writes an activity log entry**, including the ones the system makes.
- **Never bypass a wake policy or a hold.** The assignment goes through the existing
  wake path. A paused or held target is skipped and the skip is recorded.
- **Bounded cost.** Each evaluation reads a bounded number of rows, with a statement
  timeout. A broken rule cannot flood the board (a company-wide cap).
- **Safe with many server processes, and across restarts.** State lives in the
  database. A rule fires once, not once per process.
- **No new permission** (section 8.4).
- **No new telemetry event.** Firings go to the activity log of the instance only.
- **Additive, just-in-time migration.** Slice S1 adds three tables. No number is claimed
  here. The number is assigned when the slice is next to land.
- **Public repository.** No instance, host, company or agent names. This plan says
  "an unclog agent".

Not in scope:

- Pausing dispatch when a hard stop fires. That is a hold (#102). It is named as a later
  option in section 9.4, not built.
- Letting an agent wake another agent's issue. That is a permission change.
- Natural-language rules, or any rule that calls a model.
- A general business-rules engine. There are four rule kinds.

## 2. What exists today, and what each piece becomes

The plan adds a new evaluator only where nothing can be reused. This table is the map.

| Piece | Today | In this plan |
|---|---|---|
| **Stranded-issue reconciler** (#104) | A hard-coded form of rule (a). It re-dispatches an assigned issue that has no live run, to its **owner**, within one sweep. It respects the pause hold, the wake policy, free slots, open recovery actions, a queued wake and the budget | **Stays as it is.** It acts on the owner. Rule (a) acts on a **third party**, and only after the owner had its chance. The two share the same gates (sections 6.1 and 7.1) |
| **Task watchdog** (`issue_watchdogs`, `task-watchdogs.ts`, the origin kind `task_watchdog`) | The closest precedent. A person or agent watches **one issue's subtree**. When the subtree has stopped (a stable stop fingerprint), the server opens **one deduplicated watchdog issue** assigned to a watchdog agent. It dedups by "observed" and "reviewed" fingerprints, and `issues_active_task_watchdog_uq` is a partial unique index on `issues` | **Stays as it is.** It is per issue and set by hand. The flow watchdog is company-wide rules over many subjects, events and capacity. They copy the same pattern: server-side classifier, one open issue per key, a unique partial index, an assigned agent that wakes. An issue that an **active task watchdog** already watches is an exemption for rule (a), so the two do not report the same stop twice |
| **Routine stale-tick expiry** (#105) | Expires a routine tick that blocks later ticks. Defines a *progress clock* and a list of *exemptions* | **Shares its evaluator.** The progress clock and the exemptions become one module that #105 and rule (a) both call (section 6.1). Rule (a) reports. #105 cancels. They do not fight: #105's setting is per routine and rule (a) never cancels |
| **Holds with lift conditions** (#102) | Evaluates conditions on a hold with a checker worker. The checker is built for hold scopes, not for general predicates | **Shares conventions, not the evaluator.** Both use a single-flight worker, the database clock, closed error codes and a generation key in the dedup key. A hold is also an **exemption** for every rule (section 6.2). The checker is not reused because a hold condition is a state machine on one target, and a rule is a query over many subjects |
| **Flow metrics** (#106) | A read-only report: throughput, scrap by error code, runs per done issue, cost. Defines the scrap classes, the failed-run rate and limits (XmR) | **Source of truth for rule (d).** The failed-run rate is #106's *scrap rate* (section 6.6). The shared function lives in one place. XmR breach is a later threshold type |
| **Routine triggers** | `routines.runRoutine(id, { variables, payload, idempotencyKey, source })` and a public fire route | **The routine action** (section 7.2). The routine's own concurrency policy and holds still apply |
| **Scheduler tick** | An interval (30 s by default) that runs the timers, the routine triggers and the recovery passes | **Hosts the watchdog pass** as one more step (section 6.3) |
| **Issue dedup** (#40 duplicate detection, the title dedup on create) | Lexical and semantic matching for new issues, and a recent-open-title dedup | **Not used.** A title match could merge two different rules' issues. The watchdog dedups by an explicit key in a firing row (section 5) |
| **Activity log** | `logActivity` for every mutation | One entry per rule change and per firing (section 8.5) |
| **Issue assignment wake** | `queueIssueAssignmentWakeup`, used by routines and the issue routes | **The issue action's wake** (section 7.1) |
| **Origin fields on issues** | `origin_kind`, `origin_id`, `origin_fingerprint`. Some origin kinds have a partial unique index | The watchdog issue uses `origin_kind = 'flow_watchdog'` and `origin_id = <rule>:<subject>` so a person can see and filter where it came from |

## 3. Rule kinds

Every rule has a common shape (section 5) and kind-specific *parameters*. The kinds are
a closed set in the shared schema.

### 3.1 (a) Stuck issue

**Parameters.** A filter (project, a title pattern, priority list, assignee agent or
role), a list of statuses `S`, and a duration `N` minutes.

**Fires for each issue** that matches the filter, sits in a status in `S`, has **no
active run**, and has **made no progress for `N` minutes**.

- *No active run* is the same test that routines use for "live": no heartbeat run in
  `queued`, `running` or `scheduled_retry` attached to the issue, and no deferred wake.
- *No progress* is the **progress clock** of #105 (section 6.1), not `issues.updated_at`.
  System writes touch `updated_at`, so the clock would never run out.
- The **exemptions** of #105 and #104 apply: an armed wait, an open recovery action, a
  held scope, a tree hold, a pending decision, an exhausted budget. Rule (a) adds one:
  an issue that an **active task watchdog** already watches.
- **The minimum `N` is computed, not fixed.** #104's re-dispatch must always go first.
  Its recent-progress exemption (`STRANDED_RECENT_PROGRESS_EXEMPTION_MS`) is 30 minutes
  by default, it is set by an environment variable, and it is floored at 60 seconds.
  So the effective minimum is **twice that value, plus two scheduler ticks** (about 61
  minutes by default). The API returns the effective minimum, and a rule with a smaller
  `N` is rejected at save. The check is made again at each evaluation, in case the
  environment value changed.
- Like #104's pass, the watchdog pass **does not run while scheduling is suppressed**.

**Subject key.** The issue id. Each stuck issue gets its own firing.

### 3.2 (b) Missing event

**Parameters.** A source, a filter, and a duration `N`.

**Fires when** no event from the source happened in the last `N` minutes. Sources:

| Source | Slice | Answered by |
|---|---|---|
| `issue_done`: any issue reaching `done`, under a project or title filter | S2 | `issues.completed_at` (section 4.1) |
| `external_object`: a GitHub pull request reaching `merged`, for a company that connects GitHub through the core connection | S2 | `external_objects` (`data.mergedAt`, `last_changed_at`; section 4.2) |
| `work_product`: a work product of a given type reaching a status, for a company that uses the plugin sync | S2 | `issue_work_products` (section 4.2) |
| `plugin_event`: any event a plugin emits | S3, only if S2 is not enough | A new durable event record (section 4.3) |

A rule that has never seen an event uses the rule's creation time as the baseline, so a
new rule does not fire at once. An optional *active hours* window stops the rule from
firing outside working hours (Q10).

**Subject key.** The empty string (one firing per rule).

### 3.3 (c) Starvation

**Parameters.** A role `R`, a priority floor `P`, and a duration `N`.

**Fires when** every invokable agent of role `R` is at its `maxConcurrentRuns`, **and**
an issue of priority `P` or higher, assigned to an agent of that role, has a run waiting
in `queued` for more than `N` minutes.

The free-slot definition is the one the scheduler uses (`maxConcurrentRuns` minus the
agent's `running` runs). #104 uses the same definition for its deferred-for-capacity
count. A rule that defined it another way would contradict #104.

**Subject key.** The role.

### 3.4 (d) Hard stop

Two sub-kinds, both over a rolling window (default 60 minutes):

- **`provider_errors`:** at least `K` runs ended with an error code from a closed list
  chosen at rule creation (for example the provider quota and rate-limit codes). The API
  lists the codes seen in the last 7 days.
- **`failed_rate`:** the **scrap rate** of #106 is above `X` percent, with at least 5
  runs in the window (the same floor as #106). Restart losses inside a planned drain
  window are excluded, once #106 defines that window (section 6.6).

**Fires an issue or a routine only.** It never pauses dispatch (section 9.4).

**Subject key.** The empty string.

### 3.5 Adding a rule kind: a registry entry, no new table

The four kinds are the first entries of a **registry**. A later kind is added without a
new table and without a migration. To add one:

1. **Shared schema** (`packages/shared`): a kind constant, a `params` schema (Zod) and
   an evidence shape. The rule's `params` is a discriminated union keyed by the kind.
   Nothing changes in the database: `kind` is text, `params` and `last_evidence` are
   jsonb, and `subject_key` is text.
2. **One server evaluator** that implements this interface:

   ```
   RuleKindEvaluator<Params> {
     kind, paramsSchema,
     evaluate(ctx: { db, companyId, now, rowBudget, statementTimeout }, params)
       -> { subjects: [{ key, evidence }], rowsRead, truncated }
     explain?(...)            // extra detail for the dry run
   }
   ```

   The framework (the claim, the bounds, the firing reconcile, the cooldown, the cap,
   the actions, the activity entries and the dry run) is shared. It knows nothing about
   any kind.
3. **The surfaces read the registry.** The OpenAPI schema, the CLI JSON validation and
   the fields of the web editor come from the kind's schema. There is no route per kind.
4. **Tests:** a table test for the evaluator, and a conformance test that every
   registered kind validates a sample, returns bounded evidence and writes nothing in a
   dry run.

A kind needs its own plan section only if it **reads new data** (a new source table, as
in S3) or **needs a new permission or a hold action**. Otherwise it is a normal pull
request. A new data source may add a source table. It never adds a rules or firings
table.

**Unknown kinds are skipped, not fatal.** A server that reads a rule whose kind it does
not know (after a rollback, for example) skips it, sets `last_status = unsupported` and
`last_error = unknown_kind`, shows it as "unsupported" in the API, and leaves its firings
alone. A closed set that is enforced in the shared code, with a reader that tolerates a
value it has not seen, keeps a rollback safe.

**Lane-health checks as rule kinds.** A separate planning effort proposes
"lane health" checks. They are rule kinds that depend on this plan. They are not a
separate checker. A *lane* is any filter the issue filter can express: project, label,
priority, assignee or role, title pattern. The filter set for rule (a) therefore includes
labels (the `issue_labels` table exists) and "no assignee".

| Lane check | As a rule | Reads | New kind? |
|---|---|---|---|
| Missing owner | Rule (a) with the filter "no assignee" | `issues` | No: a filter on (a) |
| Stalled case | Rule (a) | `issues` | No |
| Paused agent | `blocked_owner`: an agent that is paused or not invokable still has open assigned issues after `N` minutes | `agents.paused_at`, `issues` | Yes |
| Missing approver | `approval_gap`: an issue waits for a review or approval stage that no eligible participant can act on | The issue's execution state (review participants), approvals | Yes |
| Failed automation | `automation_failing`: a routine's last `K` runs failed | `routine_runs` (`status = 'failed'`) | Yes, or rule (d) scoped to one routine |
| WIP exceeded | `limit_exceeded` with the measure `wip`: open issues in a lane per assignee or role above a limit | `issues` (the company, assignee, status index) | Yes |
| Budget exceeded | `limit_exceeded` with the measure `budget` | The budget policy and incident tables. The kind **reads** an incident that the budget service already opens, and does not recompute the budget | Yes |

None of these is in S1 to S3. Each is added after S1 as a registry entry. The data sources
are named here as a guide and are confirmed when each kind is specified.

## 4. Event source for rule (b)

**Finding.** No durable, kind-queryable record of plugin events exists today.

- A plugin emits an event through the host (`events.emit`). The plugin event bus is an
  in-memory map. Nothing is written to the database
  (`plugin-event-bus.ts` `emit`).
- The GitHub plugin emits no event at all. Its manifest does not hold the emit
  capability. The name `github.pull_request.merged` does not exist in the code. The
  plugin subscribes only to core `issue.updated` and project events.
- Core events already land in the `activity_log`. That table has no index on action or
  kind. Its useful index is `(company_id, created_at)`.
- The plugin webhook delivery rows record "a webhook arrived". The insert leaves out the
  company and the external id, and the payload is an unindexed jsonb column.

### 4.1 Issue status changes cover the issue case

`issues.completed_at` is set when an issue reaches `done`. It is company-scoped and it
carries the project and the title. A query for "the newest `completed_at` under a filter"
needs no new storage. There is no index on `completed_at`. At the size of one company the
query is bounded by `issues_company_status_idx` and the row budget (section 6.4). #106 may
add a partial index `(company_id, completed_at) WHERE status = 'done'`. If it does, this
plan reads it.

One caveat: reopening an issue clears `completed_at`. A done-then-reopened issue inside
the window is not seen. That is acceptable for "no issue done for `N` minutes".

### 4.2 Pull requests are already stored, in two places

Which one a company has depends on how it connects GitHub.

- **The core GitHub connection** writes each pull-request event into `external_objects`:
  `data.merged`, `data.mergedAt` (the **true merge time** from GitHub), `is_terminal`,
  and `last_changed_at` (the time the server applied the event). The table is
  company-scoped and indexed on `(company_id, provider_key, status_category)`. There is
  no time index, so the query reads at most the row budget (section 6.4) of one
  provider and type. The rule uses `data.mergedAt` when it is there, and
  `last_changed_at` otherwise.
- **The plugin sync** stores `issue_work_products` with `type = 'pull_request'` and
  `status = 'merged'`. It is company-scoped and indexed on `(company_id, updated_at)`.
  The merge time is **not** stored, and `updated_at` changes on any edit. A later edit of
  a merged row looks like a new event. That is a false negative (a late "recent event"),
  not a false alarm.

So a "no pull request merged for `N` minutes" rule needs no new storage in either case.

### 4.3 The smallest durable record for plugin events (S3, only if needed)

If a real need remains after S2, add **one** company-scoped table, written at the single
choke point that every plugin emit passes through (`createPluginEventBus.emit`):
`(company_id, kind, occurred_at, source_plugin, subject_ref)` with an index on
`(company_id, kind, occurred_at)`. It would store the kind and the time only, not the
payload. The GitHub plugin would also have to emit a merge event. That change belongs to
the plugin and is a separate pull request.

## 5. Data model

Three tables in S1. All are company-scoped, with `company_id` as a foreign key that
cascades on delete. Closed sets (kinds, statuses, reasons) are enforced by the shared
schema, not by database checks, so a later addition needs no migration.

### 5.1 `flow_watchdog_rules`

| Column | Notes |
|---|---|
| `id`, `company_id` | |
| `name` | Unique per company among active rules |
| `kind` | Text. The kinds are a registry in the shared code (section 3.5), not a database check |
| `enabled` | |
| `params` | jsonb, validated by a discriminated union per kind |
| `action` | jsonb: `{ type: "issue", ... }` or `{ type: "routine", ... }` (section 7) |
| `cooldown_minutes` | Default 120. Minimum time between two actions for one firing |
| `resolve_policy` | `comment` (default), `auto_close`, `none` (section 7.3) |
| `eval_interval_seconds` | Default 60. Minimum 30 (the scheduler tick) |
| `next_eval_at`, `claimed_at` | The claim columns (section 6.3) |
| `last_evaluated_at`, `last_status`, `last_error`, `last_observed` | `last_status` is `ok`, `error`, `truncated` or `skipped_held`. `last_error` is a closed code. `last_observed` holds counts only |
| `created_by_*`, `created_at`, `updated_at`, `archived_at` | |

Indexes: `(company_id, enabled)`, and a partial index on `next_eval_at` for enabled,
unarchived rules, which the claim query uses.

### 5.2 `flow_watchdog_firings`

One row per *open clog*, not per evaluation.

| Column | Notes |
|---|---|
| `id`, `company_id`, `rule_id` | `rule_id` cascades on delete |
| `subject_key` | The issue id, the role, or the empty string |
| `status` | `open`, `resolved` |
| `opened_at`, `last_fired_at`, `fire_count` | |
| `cooldown_until` | |
| `issue_id`, `routine_run_id` | At most one is set. `issue_id` is set null if the issue is deleted |
| `last_wake` | `queued`, or `skipped:<reason>` |
| `last_evidence` | jsonb, closed shape, at most 8 KiB |
| `clear_streak` | Consecutive evaluations that did not match (section 7.3) |
| `resolved_at`, `resolve_reason` | `condition_cleared`, `issue_closed`, `rule_disabled`, `rule_archived`, `subject_gone`, `manual` |

Indexes: **a unique partial index on `(rule_id, subject_key) WHERE status = 'open'`**,
which is the dedup guarantee; `(company_id, opened_at)` for the cap and the list;
`(issue_id)`.

### 5.3 `flow_watchdog_settings`

One row per company: `company_id` (primary key), `enabled` (a kill switch), `max_actions_per_hour`
(default 6, range 1 to 120), `window_started_at`, `window_actions` (the counter for the
cap, section 7.4), `updated_at`.

**Why a table and not a column on `companies`.** The cap needs an atomic counter, and a
counter on the `companies` row would make every watchdog action write that hot row. The
comment actions are not rows, so the cap cannot be counted from `flow_watchdog_firings`.

**Contract changes outside the new tables:** the shared list of issue origin kinds gains
`flow_watchdog`; the activity actions above are added; the shared schema gains the rule,
firing and settings types.

Whether the `issues` table gets a partial unique index for the origin kind is Q12.

## 6. Evaluation

### 6.1 One stall evaluator, shared with #105

A pure function (a new module, for example `flow-stall.ts`) that takes an issue and its
context and returns `{ stalled, sinceMs, exemption }`. It owns:

- the **progress clock**: the latest of a run reaching `running`, a comment, a status
  change (from the activity log, because `issues` stores no status-change time), and the
  issue's creation. A re-dispatch or a requeued wake is **not** progress;
- the **exemption list**: an armed issue monitor or wait, an open recovery action of any
  owner, a held scope, a tree hold, a pending decision, an exhausted budget, a deferred
  wake.

#105's routine check and rule (a) call it. #104's reconciler is left alone in this plan.
Moving it onto the shared module is a later cleanup, after both have landed.

### 6.2 Holds are exemptions

For every rule: a company that is held (paused or archived) is not evaluated. The firing
state is kept, and `last_status` is `skipped_held`. A held **subject** (a held agent, a
tree hold, a paused project) is an exemption for rule (a). #102 gives each hold a
reason and a time. Until it lands, "held" means "held now", with the same known gap as
#105 (a lifted hold is not remembered).

### 6.3 Cadence, claim and single firing across processes

The watchdog pass is one more step on the scheduler tick (30 seconds by default, 10
seconds at minimum). It claims due rules with a row-level claim, the pattern that the
issue monitors already use:

```
UPDATE flow_watchdog_rules SET claimed_at = now()
 WHERE id IN (SELECT id FROM flow_watchdog_rules
               WHERE enabled AND archived_at IS NULL AND next_eval_at <= now()
                 AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
               ORDER BY next_eval_at LIMIT :rulesPerPass FOR UPDATE SKIP LOCKED)
RETURNING *;
```

After the evaluation, in the same write that records the result, the process **releases
the claim and schedules the next one**: `claimed_at = NULL`, `next_eval_at = now() +
eval_interval_seconds`. Without the release, a rule would run only once per 5 minutes.

The batch form with `FOR UPDATE SKIP LOCKED` has precedent in
`chat-run-publications.ts` and `execution-recovery-resolution.ts`. The issue monitors use
a single-row conditional update with a 5-minute stale threshold and clear their claim
when they finish. The watchdog takes that stale-claim idea and the release, and batches
the claim.

- Two processes cannot claim the same rule. A crashed process leaves a claim that
  expires after 5 minutes.
- `next_eval_at` is persisted. After a restart, an overdue rule is evaluated **once**.
  Missed intervals are not replayed.
- The firing is created inside one transaction with the unique partial index on
  `(rule_id, subject_key) WHERE status = 'open'`. If two processes did race, the second
  insert fails and its transaction (and its issue) rolls back.
- A global advisory lock is not needed. (The usage-record worker uses one because it
  writes aggregates. Per-rule claims are finer.)

### 6.4 Bounds

| Bound | Default |
|---|---|
| Rows read per rule | 500 (`ORDER BY` the oldest first, `LIMIT 500`) |
| Rules per pass | 20 |
| Rows read per pass | 5,000 |
| Statement timeout per rule query | 5 seconds |
| Evidence stored per firing | 8 KiB, closed shape |
| Title pattern | At most 200 characters, compiled at save (a test match in a savepoint) |

When a bound cuts the result, `last_status` is `truncated`, the evidence says so, and the
rule still fires on what it saw. The pattern engine of the database does not backtrack
catastrophically, and the timeout bounds the rest.

### 6.5 Query cost and indexes

| Rule | Access path |
|---|---|
| (a) | `issues_company_status_idx` (company, status), then the project index when a project is set, then the oldest-first limit. The title pattern is applied last, on the bounded rows. The progress clock is computed for the limited set only |
| (b) `issue_done` | `issues_company_status_idx`, then `completed_at` |
| (b) `work_product` | `(company_id, updated_at)` on `issue_work_products` |
| (c) | Agents by role (a company-sized set). `maxConcurrentRuns` is not a column: it is `agents.runtime_config.heartbeat.maxConcurrentRuns`, read with `parseHeartbeatPolicy`. `queued` runs through `heartbeat_runs_company_status_last_output_idx` (company, status, last output), which does **not** cover the age of a queued run, so the age is filtered on the bounded rows |
| (d) | A windowed count over `heartbeat_runs` by `finished_at`. #106 decides whether it adds an index. This plan reads the same measure function |

S1 includes an `EXPLAIN` check per rule on a seeded dataset. If any path misses a one
second budget, the S1 migration adds a partial index for it (Q11).

### 6.6 Rule (d) and #106

The failed-run rate is #106's **scrap rate**: the runs that ended `failed`, `timed_out` or
`interrupted`, divided by **every terminal run** finished in the window (#106's `runs`),
counted by `finished_at`, with at least 5 runs. Cancelled runs are in the denominator and
not in the numerator. The function is one shared function. If
#106 has not landed, S1 carries a private copy of the same definition and a test that
pins it to #106's examples. Restart losses are excluded by their error codes until
#106's drain window exists. #106's prerequisite F0 (the usage record misses
`interrupted` runs) matters only if the rule reads the usage record. S1 reads
`heartbeat_runs` directly, so F0 does not block it.

### 6.7 Dry run

The same evaluator, with a flag. It claims nothing, writes nothing and calls nothing. It
returns, for a saved rule or for an unsaved draft: the subjects that would fire now, the
evidence for each, whether each would be suppressed (cooldown, cap, an existing open
firing), what the wake would do (`queued` or the skip reason), and the rows read. It is
available on all three surfaces.

## 7. Actions, dedup and lifecycle

### 7.1 Issue action

**Fields.** `titleTemplate`, `introTemplate`, `assigneeAgentId`, `priority`, `projectId`
(optional), `responsibleUserId` (optional; the company default otherwise).

**Templates** are plain strings with `{{path}}` lookups into a closed context (rule name,
subject, evidence fields). They are validated at save. An unknown path is rejected. There
is no code in a template.

**The assignee.** It is checked at save with the same assignability check that issue
creation uses (it rejects a terminated or pending agent, and it does not reject a paused
one). It is checked again at fire time. If the agent has become unavailable, the action
is **not** taken: the firing records `suppressed: assignee_unavailable` and the rule's
`last_status` becomes `error`, so a person sees it on the rules page.

**Create.** In one database transaction: insert the firing; create the issue with the
issue service, **passing the transaction** (`issueSvc.create(companyId, data, tx)`; the
routine dispatch does not, and cleans up by hand, so "as routines do" is not enough);
set `firing.issue_id`. A failure rolls back both. The issue has these properties:

- status **`todo`**. The assignment wake skips a `backlog` issue, and #104 re-dispatches
  only `todo`, `in_progress` and `in_review`. A `backlog` issue would get neither;
- `origin_kind = 'flow_watchdog'` (added to the shared list of issue origin kinds) and
  `origin_id = <rule id>:<subject key>`;
- the body: the intro plus an evidence block.

**Wake.** After the commit, `queueIssueAssignmentWakeup` with the context source
`flow_watchdog`, **`requestedByActorType: "system"`** (the skip receipt for an agent that
cannot be invoked is written only for a non-user actor) and **`rethrowOnError: true`**
(otherwise the helper swallows the refusal and returns nothing). All the usual gates
apply: the on-demand wake policy, the daily cap, the agent's pause and invokability, and
the budget. `last_wake` is `queued`, or `skipped:<reason>` taken from the refusal. A
silent non-queue (a policy skip that returns nothing) is recorded as `not_queued`. The
dry run runs the same gate functions first, so it can say what the wake would do.

**A paused or held assignee.** The issue is still created and assigned, so a person can
see it. The wake is skipped and the reason is recorded. #104's re-dispatch picks up an
assigned, open issue with no run once the agent is invokable again, so the watchdog needs
no retry code of its own. A held **company** is not evaluated at all.

### 7.2 Routine action

**Fields.** `routineId` and a `variables` map from the routine's declared variable
names to templates over the same closed context. The names are checked against the
routine's variable list at save.

**Fire.** `routines.runRoutine(routineId, { source: "api", variables, payload, idempotencyKey })`.
The payload carries `{ ruleId, firingId, fireCount, evidence }`. The idempotency key is
`flow-watchdog:<firing id>:<fire count>`, so a retry of the same firing cannot run the
routine twice.

**What `runRoutine` does not do, and the watchdog must.**

- **It does not stop a paused routine.** `runRoutine` rejects only an archived routine.
  The "routine is active" check applies to the webhook and schedule sources, and the
  project-pause check is in the scheduler tick. So the watchdog checks the routine's
  `status`, and its project's pause, **before** the call. A paused routine is skipped,
  and the firing records `suppressed: routine_paused`. A routine hold (#102) is the same
  state.
- **It writes no activity for a service call.** The `routine.run_triggered` entry for an
  API run comes from the route. The watchdog's own `flow_watchdog.fired` entry is the
  record, and it carries the routine run id.
- **An actor name has no effect** on a service call with source `api`. The system actor
  `flow-watchdog` is used only for the watchdog's own activity entries.

The routine's own concurrency policy applies (it may skip or coalesce the run). The
result (the routine run id and its status) goes to the firing.

### 7.3 Dedup and lifecycle

- **One open firing per rule and subject** (the unique partial index). It owns **one
  issue** (or one routine run per fire).
- **Firing again** while the firing is open: update `last_evidence` and `fire_count`. Add
  a comment with the new evidence only after `cooldown_until`, and then set the next
  `cooldown_until`. **Never a second issue.** The comment is a **system comment added
  through the issue service**, which does not wake the assignee (the wake for a comment
  lives in the comment route, not in the service; the duplicate-detection service already
  posts this way). A rule can opt in to a wake at each cooldown with `refireWake:
  each_cooldown`. The default is `never` (Q6).
- **When the condition clears** (the subject no longer matches in 2 consecutive
  evaluations, to avoid flapping): resolve the firing, with a **comment** on the issue
  ("cleared: ..."). **Recommendation:** the default is `comment`. The issue stays open
  for the agent or a person to close, because closing hides the evidence. `auto_close`
  is opt-in per rule, and it only closes an issue that nobody has touched since the last
  watchdog comment. `none` writes nothing.
- **If the issue is closed by someone while the condition still holds:** the firing
  resolves with `issue_closed`. A new firing may open after the cooldown, counted from
  the closure. A closed issue means "seen", so the rule does not reopen it.
- **If the rule is disabled or archived:** its open firings resolve with `rule_disabled`
  or `rule_archived`, with a comment.
- **If the subject is deleted or hidden:** `subject_gone`.

### 7.4 Cooldown and the company cap

- **Per-rule cooldown** (`cooldown_minutes`, default 120): the minimum time between two
  actions for one firing.
- **Company cap** (`max_actions_per_hour`, default 6): an *action* is an issue create, a
  comment or a routine run. The counter lives in the settings row and resets with the
  window. The check and the increment are one atomic update. When the cap is reached,
  the firing is still recorded (the evidence is updated), but the action is **suppressed**.
  One `flow_watchdog.cap_reached` entry is written per window. The entry is visible in
  the activity log and the rules page.
- The worst case at the default cap is 144 actions a day, which is **above** the 96
  polls it replaces. So the cap is a safety limit and not a target. The real count is
  the number of clogs (section 10). A company can raise or lower the cap.

## 8. Surfaces

### 8.1 API (all routes in OpenAPI, all company-scoped)

| Route | Purpose |
|---|---|
| `GET`, `POST /companies/:companyId/flow-watchdog/rules` | List and create |
| `GET`, `PATCH`, `DELETE /flow-watchdog/rules/:id` | Read, update, archive |
| `POST /flow-watchdog/rules/:id/dry-run`, `POST /companies/:companyId/flow-watchdog/dry-run` | Dry run for a saved rule or an unsaved draft |
| `GET /companies/:companyId/flow-watchdog/firings` | Filter by rule, status, time |
| `POST /flow-watchdog/firings/:id/resolve` | Manual resolve |
| `GET`, `PUT /companies/:companyId/flow-watchdog/settings` | The kill switch and the cap |
| `GET /companies/:companyId/flow-watchdog/error-codes` | The run error codes seen in the last 7 days, for rule (d) |

### 8.2 CLI

`flow-watchdog rule list|get|create|update|delete|dry-run`, `flow-watchdog firings`,
`flow-watchdog resolve <firingId>`, `flow-watchdog settings`. Create and update accept
the same JSON as the API, like the routine commands.

### 8.3 Web

A "Flow watchdog" page in the company navigation, near Routines. It has a rule list
(state, last evaluation, last result), an editor per kind with a **dry-run panel** ("this
rule would fire now on: ..."), a firings table that links to the issues, and the cap
status. The sidebar and the page exist in two variants (the streamlined and the
production surface), so S1 ships both.

### 8.4 Permissions

- **Create, edit, enable, archive a rule, and change the settings:** a **board user**
  who may assign tasks (the check that routines use). A rule creates issues and wakes
  agents, so it needs the assign right. No new permission.
- **Agents cannot create or edit rules.** The assign check returns early for an agent
  actor and does not reject it, so the routes also call `assertBoard` explicitly.
- **Read:** the board reads rules and firings. **Recommendation:** an agent may read the
  **open firings** of its company (a list with the evidence and the issue link), and
  **not** the rule parameters, so the unclog agent can see all open clogs in one call.
  This ships in S2. In S1 the issue carries the evidence. (Q8)

### 8.5 Activity log

| Action | When |
|---|---|
| `flow_watchdog.rule_created`, `rule_updated`, `rule_archived`, `rule_enabled`, `rule_disabled` | A rule changes. `details` carry the changed fields |
| `flow_watchdog.settings_updated` | The cap or the kill switch changes |
| `flow_watchdog.fired` | A firing opens (issue created or routine run started) |
| `flow_watchdog.refired` | A cooldown comment was added |
| `flow_watchdog.resolved` | A firing resolves, with the reason |
| `flow_watchdog.suppressed` | The cap or a held target suppressed an action |
| `flow_watchdog.cap_reached` | Once per window |
| `flow_watchdog.evaluation_failed` | Once when a rule moves to an error state |

The system actor is `flow-watchdog`. The entities are the rule, or the issue.

## 9. Slices

### 9.1 Table

| Slice | Content | Migration | Lane |
|---|---|---|---|
| **S1** | Three tables. The evaluator framework (claim, bounds, firing reconcile, cap). Rules (a) and (d). The issue action. The dry run. API, CLI and web for rules, firings and settings. Activity entries | **Yes** (three tables, the partial unique indexes) | Adds a step to the scheduler tick and creates issues through the wake path. It touches `index.ts` and the issue wake. It does not change `recovery/service.ts` or the reconciler. **Single, in a risky slot** |
| **S2** | Rule (b) with the `issue_done` and `work_product` sources. Rule (c). The routine action. Agent read of open firings | No | Normal. Reads `heartbeat_runs`, `issues`, `issue_work_products` |
| **S3** | The `plugin_event` source: one event table, written at the bus choke point | **Yes** (one table) | Touches the plugin bus. Single. Only if S2 is not enough |
| **Later** | The lane-health kinds (section 3.5). A hold action for rule (d) (section 9.4). XmR breach as a threshold type. Moving #104's reconciler onto the shared stall module | Only if a kind adds a source table | |

### 9.2 Order with #104 and #105

When a clog appears, the paths act in this order:

1. #104 re-dispatches an assigned open issue that has no run, to its owner, within one
   sweep.
2. Rule (a) fires after `N` minutes (at least 30) with no progress. It reaches only the
   clogs that #104 cannot fix: an assignee who cannot be woken, an unassigned issue, a
   run that is live in status but never starts.
3. #105 (if the routine has the setting) expires a stuck routine tick. Rule (a) can also
   see that tick and open an issue about it. The two do not cancel each other: #105
   acts at dispatch, and the rule only reports.

The shared stall module (section 6.1) makes the three agree on "no progress".

### 9.3 Tests per slice

**S1**, on embedded Postgres:

- Rule (a): an issue past `N` with no progress fires once, with an issue assigned to the
  agent and a wake. **Red at `main`:** nothing fires.
- Each exemption: an armed wait, an open recovery action, a held agent, a tree hold, a
  pending decision, an exhausted budget, a deferred wake. No firing.
- A re-dispatch by #104 does not reset the clock.
- Dedup: 10 evaluations leave exactly one open firing and one issue. A second process
  claiming the same rule at the same time leaves one firing (two-client race).
- Cooldown: a second fire inside the cooldown only updates the evidence.
- The cap: the 7th action in the hour is suppressed, and one `cap_reached` entry exists.
- Clear: two clear evaluations resolve the firing with a comment. `auto_close` closes
  only an untouched issue.
- A paused assignee: the issue exists, the wake is skipped, `last_wake` says why. A held
  company: no evaluation.
- Restart: an overdue rule is evaluated once.
- Bounds: a seeded dataset past 500 rows gives `truncated`.
- Rule (d): the scrap rate matches the examples of #106. Under 5 runs, it does not fire.
- Dry run: it matches the real evaluation for the same fixtures and writes nothing.
- Company scope: a rule and a firing of another company return 404.
- Validation: a bad template path, a bad pattern, an interval under 30 seconds.
- OpenAPI listing, CLI parity and the web component tests. The new database tests are
  listed in the pull request body. They cannot join the `Dockerfile` `vitest run` list.

**S2:** the `issue_done` and `work_product` sources (including the never-seen baseline),
starvation (the free-slot definition equals the scheduler's), the routine action (the
variables check, the idempotency key, the routine's concurrency policy), the agent read
of open firings.

**S3:** the event table is written once per emit, is company-scoped, and stores no payload.

### 9.4 Later option: a hold from a hard stop

A hard-stop rule could later also set a hold (for example, pause dispatch for a provider)
through #102. That needs #102's scope adapters, a new permission check for a *system*
actor, and a lift condition (the error rate falls under a threshold). It is named here
and **not** built in S1 or S2.

## 10. Expected effect

**Assumptions.** One empty poll costs one agent run. The polling agent runs every 15
minutes (96 a day). A clog that fires the watchdog wakes the agent once. A cooldown comment does not wake
the agent by default (section 7.3).

| Clogs a day | Agent runs a day with the watchdog | Runs saved | Share saved |
|---|---|---|---|
| 2 | 2 | 94 | 98% |
| 6 | 6 | 90 | 94% |
| 12 | 12 | 84 | 88% |

With the default cap of 6 an hour, the worst case is 144 actions a day. That is above
the polling cost (96), so the cap is a safety limit and not a target. A rule that opts in
to `refireWake: each_cooldown` adds up to 12 wakes a day for one lasting clog at the
default 120-minute cooldown. The number that matters is
the real count of clogs. **Appendix B has a query** for it: the share of the past polls
that produced an action. The estimate must be redone with that number.

**Time to detect a clog.**

- *Polling:* the clog waits for the next poll. Mean wait 7.5 minutes, worst case 15
  minutes, plus the run start.
- *Watchdog:* the rule's own threshold `N`, plus at most one evaluation interval (60
  seconds by default) and one scheduler tick (30 seconds by default). That is under 2
  minutes after the threshold.
- The threshold `N` is the same in both. The saving is the 0 to 15 minutes of waiting
  for the next poll, and the runs.

## 11. Alternatives considered

| Alternative | Why not |
|---|---|
| A rule engine inside #102's checker | The checker is built for one hold target at a time. Rules are queries over many subjects. A shared evaluator would bend both |
| Use `activity_log` as the event store for rule (b) | It has no index on the action. A plugin event does not reach it. For issues, `completed_at` is simpler |
| Fire one routine per rule, with a template issue | Too narrow: rule kinds that need dedup state and evidence would each need code in the routine |
| Dedup by title or by #40 duplicate detection | A title match can merge issues of two rules. Semantic matching is the wrong tool for a key we control |
| Rely on the firing row's index alone, with no index on `issues` | It works, but `issues` already has narrow partial unique indexes for other origin kinds (`task_watchdog`, `harness_liveness_escalation`). The same index here guards any path that creates such an issue outside the firing transaction (Q12) |
| A global advisory lock for the pass | One process evaluates everything. Per-rule claims scale with the rules and survive a crashed process |
| Evaluate in the unclog agent | That is the cost this plan removes |
| Create a new issue on every fire | A persistent clog would flood the board |

## 12. Open questions

Each has a recommendation. The reviewer should check the ones marked **for the reviewer**.

| ID | Question | Recommendation |
|---|---|---|
| **Q1** | **For the reviewer.** Share the stall evaluator with #105 and not with #102? | Yes. Share the progress clock and the exemptions with #105, and the conventions with #102. Do not reuse #102's checker. Leave #104 alone until later. Whoever lands first creates the module |
| **Q2** | "No update for `N` minutes": the progress clock or `issues.updated_at`? | The progress clock. System writes touch `updated_at` |
| **Q3** | **For the reviewer.** Event source for pull-request merges | S2 reads `external_objects` for a company on the core GitHub connection (it has the true merge time in `data.mergedAt`) and `issue_work_products` for a company on the plugin sync (no merge time). A generic event table is S3, only if needed |
| **Q4** | What happens when the condition clears? | `comment` and resolve the firing. The issue stays open. `auto_close` is opt-in and closes only an untouched issue |
| **Q5** | Default company cap | 6 actions an hour, adjustable from 1 to 120 |
| **Q6** | Does a cooldown comment wake the agent? | No by default. A system comment added through the issue service does not wake (the wake is in the route). A rule may opt in with `refireWake: each_cooldown` |
| **Q7** | A paused or held assignee | Create the issue, skip the wake, record the reason. Do not re-route. A held company is not evaluated |
| **Q8** | Agent read access | Board reads rules and firings. Agents read **open firings only**, from S2. Agents never edit rules |
| **Q9** | Who edits rules? | Board users with the assign right. No new permission |
| **Q10** | Active hours for rule (b) | An optional `activeHours` window per rule. Off by default. In S2 |
| **Q11** | **For the reviewer.** Do the rule queries need new indexes? | Prove it with `EXPLAIN` in S1. Add a partial index in the S1 migration only for a path that misses the one-second budget |
| **Q12** | **For the reviewer.** A partial unique index on `issues` for the origin kind `flow_watchdog`? | Yes, in the S1 migration, with the shape of `issues_active_task_watchdog_uq` (company, origin kind, origin id, where not done or cancelled). There are two precedents, so it is not a new kind of change. The firing index stays the primary guard |
| **Q13** | Failed-run rate definition | #106's scrap rate, at least 5 runs, restart losses excluded until the drain window exists |
| **Q14** | Routine action variables | Validate the variable names against the routine at save |
| **Q15** | **For the reviewer.** Lane for S1 | A risky slot: it adds a scheduler step, creates issues and wakes agents. It does not touch the reconciler |
| **Q16** | Evaluation interval | Default 60 seconds, minimum 30 (the scheduler tick) |
| **Q17** | Rows read per rule and per pass | 500 and 5,000, with a 5 second timeout. Tune from the S1 measurements |
| **Q18** | **For the reviewer.** How is a new rule kind added? | As a registry entry: a shared params schema, one evaluator, form fields from the schema. No new table (section 3.5) |
| **Q19** | Lane-health checks from a separate planning effort | They are rule kinds that depend on this plan: two are filters on rule (a), five are new kinds after S1 (section 3.5). The filter set gets `labelIds` and "no assignee" |
| **Q20** | The existing task watchdog | Keep it. Add "watched by an active task watchdog" as an exemption for rule (a) |
| **Q21** | A paused or archived routine as a routine-action target | The watchdog checks the routine and its project itself, and skips (section 7.2) |
| **Q22** | A terminated or pending assignee at fire time | Take no action. Record `suppressed: assignee_unavailable` and put the rule in an error state that the rules page shows |

## Appendix A. Code anchors on `main` at `d9804ac4f`

| What | File and line |
|---|---|
| Scheduler interval (default 30 s, minimum 10 s) | `server/src/config.ts:96`, `383`; `server/src/index.ts:1214` |
| Timers tick, scheduled routine triggers tick | `server/src/index.ts:1714`, `1740` |
| Single-writer worker lock (usage records) | `server/src/services/run-usage-records.ts:33`, `390` |
| Row-claim pattern (issue monitors) | `server/src/services/heartbeat.ts:12284-12301` |
| Stranded-issue reconciler, active-path helper | `server/src/services/recovery/service.ts:4409`, `1080` |
| `maxConcurrentRuns` parsed from `runtime_config` (`parseHeartbeatPolicy`); the subtraction | `server/src/services/heartbeat.ts:17721-17731`; `21012`, `21698` |
| Wake policy block, invokability | `server/src/services/heartbeat.ts:9960`, `11002` |
| Issue assignment wake | `server/src/services/issue-assignment-wakeup.ts:144` |
| Routine manual and API run, with variables; it rejects only an archived routine | `server/src/services/routines.ts:2854-2857`; the active check for webhook and schedule only: `1795-1800`; `Actor`: `185` |
| Routine run route, public fire route | `server/src/routes/routines.ts:629`, `656` |
| Routine dispatch (issue create plus wake in one lock) | `server/src/services/routines.ts:1712-2020` |
| Origin fields on issues; a partial unique index on an origin kind | `packages/db/src/schema/issues.ts:62-67`, `149-155` |
| Issue indexes (status, updated, project, origin, priority) | `packages/db/src/schema/issues.ts:106-142` |
| `completed_at` set on done | `packages/db/src/schema/issues.ts:88`; `server/src/services/issues.ts:321-323` |
| Issue dedup on create: the title dedup; the child-issue idempotency replay | `server/src/services/issues.ts:9834`; `9319` |
| Duplicate detection services | `server/src/services/duplicate-detection.ts` and its siblings |
| Work products (type, status, `updated_at`, index) | `packages/db/src/schema/issue_work_products.ts:18-63` |
| Activity log table and indexes; the writers | `packages/db/src/schema/activity_log.ts:23-35`; `server/src/services/activity-log.ts:160` (`persistActivity`), `217` (`logActivity`) |
| Plugin event bus (in memory) and its `emit` | `server/src/services/plugin-event-bus.ts:149`, `172`, `251-279` |
| Plugin emit entry point | `server/src/services/plugin-host-services.ts:1600-1606` |
| Core event names | `packages/shared/src/constants.ts:1689-1722` |
| GitHub plugin manifest (no emit capability), sync | `packages/plugins/plugin-github/src/manifest.ts:7`; `src/sync.ts:398`, `518-563` |
| Plugin webhook delivery insert (no company id) | `server/src/routes/plugins.ts:2768-2778` |
| Agent role, pause fields; the run `error_code` column; the status/last-output index | `packages/db/src/schema/agents.ts:22`, `35-36`; `packages/db/src/schema/heartbeat_runs.ts:68`, `136-140` |
| Provider quota classification (the union member, the classifier) | `server/src/services/recovery/service.ts:248`, `385-399` |
| Board and company guards | `server/src/routes/authz.ts:32`, `48`, `75` |
| Task watchdog: table, service, origin kind, partial unique index | `packages/db/src/schema/issue_watchdogs.ts`; `server/src/services/task-watchdogs.ts`; `packages/shared/src/constants.ts:356-368`; `packages/db/src/schema/issues.ts:173` |
| Issue origin kinds (the list gains `flow_watchdog`) | `packages/shared/src/constants.ts:356-368` |
| Assignability check on issue create | `server/src/services/agent-assignability.ts:104-170` |
| Issue create accepts a transaction as the third argument | `server/src/services/issues.ts:9804-9808` |
| Wake gates in `enqueueWakeup` (budget, invokability, wake policy) | `server/src/services/heartbeat.ts:29038-29070` |
| `rethrowOnError`, and the swallow when it is not set | `server/src/services/issue-assignment-wakeup.ts:229-235` |
| The comment wake lives in the route; the service comment does not wake | `server/src/routes/issues.ts:17358`, `18233-18236`; `server/src/services/issues.ts:12211` |
| Pull-request events stored in `external_objects` (`data.mergedAt`, `last_changed_at`) | `server/src/services/github-connection-events.ts:200-260`; `packages/db/src/schema/external_objects.ts` |
| Recovery progress exemption (an environment value) | `server/src/services/recovery/service.ts:189-192` |
| Scheduling suppression gate on the recovery pass | `server/src/index.ts:1827` |
| Batch claim with `FOR UPDATE SKIP LOCKED` (precedent) | `server/src/services/chat-run-publications.ts:334`; `server/src/services/execution-recovery-resolution.ts:326` |
| Labels on issues | `packages/db/src/schema/issue_labels.ts`, `labels.ts` |
| Routine routes: board assign check, manage check | `server/src/routes/routines.ts:89`, `108` |
| OpenAPI registration of a company resource | `server/src/routes/openapi.ts:4757-4770` |
| Generic CLI resource helpers | `cli/src/commands/client/routine-api.ts:97`, `119` |
| Web route and sidebar entry (two variants) | `ui/src/App.tsx:334`; `ui/src/components/Sidebar.tsx:235`; `ui/src/components/Sidebar.production.tsx:187` |

Pull requests, read at their heads through the REST API: #102 (`11a80448c`), #104
(`377700173`), #106 (`87a95007f`), #105 (`be6ce3f71`).

## Appendix B. Read-only queries for the estimate

Run them against production before S1 starts. They read only and print counts.

```sql
-- B1. Runs of the polling agent per day, and how many of them did anything.
-- Replace :agent_id. "Did something" = the run wrote at least one issue activity entry.
select date_trunc('day', r.created_at) as day,
       count(*) as runs,
       count(*) filter (where exists (
         select 1 from activity_log a
         where a.run_id = r.id
           and a.action in ('issue.created', 'issue.updated', 'issue.comment_added')
       )) as runs_that_acted
from heartbeat_runs r
where r.agent_id = :agent_id
  and r.created_at > now() - interval '14 days'
group by 1
order by 1 desc;

-- B2. The error codes of failed runs in the last 7 days (for rule (d)).
select error_code, count(*)
from heartbeat_runs
where status in ('failed', 'timed_out', 'interrupted')
  and finished_at > now() - interval '7 days'
group by 1
order by 2 desc
limit 30;
```

`runs_that_acted` over `runs` is the share of useful polls. The clogs a day in section 10
should use it.
