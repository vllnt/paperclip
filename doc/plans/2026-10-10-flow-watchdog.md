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
| **Routine stale-tick expiry** (#105) | Expires a routine tick that blocks later ticks | **Shares one module, defined here.** The exemption set, the progress clock with its clock source, and the atomic close step are defined once in section 6.1. #105 refers to them and defines only what is routine-specific. Rule (a) reports. #105 closes. They do not fight: #105's setting is per routine and rule (a) never closes |
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
  `queued`, `running` or `scheduled_retry` attached to the issue, and no queued or
  deferred wake. It is evaluated again **under the subject issue's row lock** just
  before the action (section 6.3).
- *No progress* is the **progress clock** of section 6.1.2, not `issues.updated_at`.
  System writes touch `updated_at`, so the clock would never run out.
- The **exemption set** of section 6.1.1 applies.
- **The rule never watches its own output.** A subject is never an issue with the origin
  kind `flow_watchdog`, and never the issue of any open firing of any rule of the
  company. Without this, a watchdog issue whose wake was skipped would match the rule
  again and create a new issue on each cycle. A rule that wants to watch watchdog
  issues is not allowed in S1; a later opt-in needs its own bound and test.
- **The minimum `N` is a floor that this plan owns: 60 minutes.** It is a heuristic and
  not a guarantee. The earlier idea of deriving it from #104's
  `STRANDED_RECENT_PROGRESS_EXEMPTION_MS` is dropped: #104 uses that constant in one
  branch only (the repeated productive-continuation branch), and its ordinary stranded
  dispatch is separate. A guarantee that rests on a constant in another branch breaks
  when that branch or constant changes. What keeps the two from acting twice is the
  exemptions and the lock in section 9.2, not the size of `N`.
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
- **`failed_rate`:** #106's **scrap rate** is above `X` percent, with at least 5 runs in
  the window (#106's floor). It calls #106's measure function and re-derives nothing. A
  setting says whether #106's `restartLoss` runs count (section 6.6). It ships after
  #106's measure has landed.

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
| `enabled`, `version` | `version` starts at 1 and is bumped by every edit |
| `params` | jsonb, validated by a discriminated union per kind |
| `action` | jsonb: `{ type: "issue", ... }` or `{ type: "routine", ... }` (section 7) |
| `cooldown_minutes` | Default 120. Minimum time between two actions for one firing |
| `resolve_policy` | `comment` (default), `auto_close`, `none` (section 7.3) |
| `eval_interval_seconds` | Default 60. Minimum 30 (the scheduler tick) |
| `next_eval_at`, `claimed_at` | The claim columns (section 6.3) |
| `last_evaluated_at`, `last_status`, `last_error`, `last_observed` | `last_status` is `ok`, `error`, `truncated`, `skipped_held` or `unsupported` (a kind this server does not know, section 3.5). `last_error` is a closed code. `last_observed` holds counts only |
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
| `action_state` | `pending` (set in the firing transaction), `done`, `suppressed:<reason>`, `failed` |
| `action_attempts` | A counter, at most 5 |
| `last_wake` | `queued`, or `skipped:<reason>` |
| `rule_version`, `action_snapshot` | The rule's version and the action as it was when the firing opened (section 7.3) |
| `last_evidence` | jsonb, closed shape, at most 8 KiB |
| `clear_streak` | Consecutive evaluations that did not match (section 7.3) |
| `resolved_at`, `resolve_reason` | `condition_cleared`, `issue_closed`, `rule_disabled`, `rule_archived`, `rule_edited`, `subject_gone`, `manual` |

Indexes: **a unique partial index on `(rule_id, subject_key) WHERE status = 'open'`**,
which is the dedup guarantee; `(company_id, opened_at)` for the cap and the list;
`(issue_id)`.

### 5.3 `flow_watchdog_settings`

One row per company: `company_id` (primary key), `enabled` (the company kill switch,
**default false**), `max_actions_per_hour` (default 6, range 1 to 120),
`window_started_at`, `window_actions` (the counter for the cap, section 7.4),
`cap_logged_window` (the window for which the cap entry was written, section 7.4),
`updated_at`.

**Off behavior, defined once.** The watchdog does nothing unless **all three** hold:

1. **The instance experimental flag `enableFlowWatchdog` is on** (default off). It is
   read once at the top of each pass, with the same accessor as the other experimental
   flags (`instanceSettingsService(db).getExperimental()`, `instance-settings.ts:528`).
   Adding the flag means registering it in each place that `enableAgentChat` is: the type
   (`packages/shared/src/types/instance.ts:81`), the validator with a default
   (`validators/instance.ts:60`), the feature catalog with a title, description, tier and
   defaults (`feature-catalog.ts:148`, enforced by `feature-catalog.test.ts`), the
   normalizer and the defaults (`instance-settings.ts:240-264`, `284-308`), the settings
   page toggle (`ui/src/pages/InstanceExperimentalSettings.tsx`) and its test. The CLI
   reaches the flag through the generic `settings:experimental` commands When off, the pass returns
   at once: no claim, no evaluation, no recovery retry, no issue, no wake.
2. **The company has a settings row with `enabled = true`.** A missing row means off.
3. **The rule is enabled and not archived.**

The claim query joins the settings row (section 6.3), so a company that is off is never
claimed, whatever the rule says. Turning a switch off or rolling the release back stops
all new issues, wakes and routine runs. Open firings and their issues stay as they are.
Nothing is deleted or closed by a switch.

**Why a table and not a column on `companies`.** The cap needs an atomic counter, and a
counter on the `companies` row would make every watchdog action write that hot row. The
comment actions are not rows, so the cap cannot be counted from `flow_watchdog_firings`.

**Contract changes outside the new tables:** the shared list of issue origin kinds gains
`flow_watchdog`; the activity actions above are added; the shared schema gains the rule,
firing and settings types.

Whether the `issues` table gets a partial unique index for the origin kind is Q12.

## 6. Evaluation

### 6.1 The shared stall module: one path, one owner, built first by #105 R1

The module is **`server/src/services/flow-stall.ts`**. It holds the parts that #105
(routine stale-tick expiry) and rule (a) both need. **These parts are defined here,
once.** #105 refers to this section and does not repeat them. The module has three parts:
the exemption set (6.1.1), the progress clock (6.1.2) and the atomic close step (6.1.3).

**Owner and order.** **#105's R1 builds `flow-stall.ts` first**, because the pile-up of
open routine copies is live in production. #113's S1 then **reuses** it and adds the
watchdog parts. S1 never makes a second copy. If S1 needs a change in the module, it
changes that same file, with a test. Both plans and both pull request bodies name this
path. The exported API is:
`stallExemption(issue, now)`, `stallClock(issue, now)` and
`closeStalledIssue(input)`. The compare-and-set in `issueService.update` and the writer
audit test (6.1.3) are part of the same first slice.

#104's reconciler is left alone. Moving it onto this module is a later cleanup.

#### 6.1.1 The exemption set

`stallExemption(issue, now)` returns the name of the first exemption that applies, or
`null`. While one applies, the silence is explained, and closing the issue would destroy
a waiting state. The list is long on purpose: a false close costs more than a late one.

| Exemption | Signal on `main` | Used by |
|---|---|---|
| An armed issue monitor or wait | `issues.monitor_next_check_at` is not null | both |
| An open recovery action of any owner | `issue_recovery_actions` with status `active` or `escalated`. **The feed reader lists only user and board owned ones** (`attention.ts:1440`, `HUMAN_RECOVERY_OWNER_TYPES`), so the stall module has its own query for "any owner"; an agent-owned action is also a live recovery path | both |
| A held scope: the routine is paused, or its project, company or assignee agent is paused; an assignee agent in `error` | `routines.status`, `projects.paused_at`, `companies.paused_at`, `agents.paused_at`, `agents.status = 'error'`; and the holds of #102 once they exist | both |
| An issue-tree hold | the tree-hold check that automatic recovery already uses | both |
| **A pending interaction** of any kind | `issue_thread_interactions.status = 'pending'` | both |
| **A pending linked approval** | `issue_approvals` joined to `approvals` with `approvals.status = 'pending'`, both company-scoped. The feed shows an approval on its first linked issue only; the stall module exempts **every** linked issue, which is the safe side | both |
| **An open decision about the issue** | `decisions.status = 'open'` and `decisions.origin_issue_id` is the issue (feed source `decision`) | both |
| **A blocker that needs a person** | the issue is `blocked` with a human-owned `unblockDescriptor`, or it is a terminal blocker with a non-live blocker-attention state (feed source `blocker_attention`) | both |
| **An issue owned by a person** | `issues.assignee_user_id` is set. A user-assigned `in_review` issue is the case the feed lists | both |
| **A review that needs a person** | `in_review` with a pending human participant, or a **stalled review with no maintained path** (feed source `review`). The feed already shows the stalled review to the board, so closing it would hide it | both |
| A failed run whose bounded retry is exhausted | the feed source `failed_run` (a person must decide) | both |
| The assignee is over budget | the budget hard-stop check that wake dispatch already uses. The feed source `budget_alert` is scope level (a budget incident) and lists a hard incident, or a soft one at 85% of the limit; the issue exemption follows the hard stop only | both |
| An unresolved dependency | the issue is blocked by an open issue (`listDependencyReadiness`) | both |
| A deferred or queued wake waits for the issue | `agent_wakeup_requests` in `deferred_issue_execution` or `queued` for the issue | both |
| An active task watchdog watches the issue | `issue_watchdogs` with status `active` | rule (a) only |
| **A conversation issue** | `issues.conversation_agent_id` is set, or the origin kind is `chat_channel`. The issue service already refuses `done` and `cancelled` for these (section 6.1.3) | both |
| **A watchdog issue** | the origin kind is `flow_watchdog` (section 3.1) | rule (a) |

**The set is derived from the attention feed, so it cannot drift.** Two mechanisms:

1. **The stall module calls the feed's own readers** for the issue-scoped sources
   (pending approvals, pending interactions, open decisions, human-owned blockers,
   reviews that need a person, recovery actions, exhausted retries). It does not copy
   their predicates. A change to a reader reaches the stall module with no edit here.
2. **A compile-time table.** The stall module holds
   `Record<AttentionSourceKind, StallExemption | "not_issue_scoped">`.
   `ATTENTION_SOURCE_KINDS` is an exported tuple in `packages/shared` (`types/attention.ts:8-21`; the service holds a second array of the same name at `attention.ts:69`, and the stall module uses the shared one), so a new feed
   source makes this table fail to compile until someone decides how it is handled. The
   mapping today: `approval` and `issue_thread_interaction` and `decision` and
   `recovery_action` and `blocker_attention` and `review` and `failed_run` and
   `budget_alert` and `agent_error_alert` map to the rows above; `join_request` and
   `productivity_review` (legacy, no feed items) are `not_issue_scoped`.

R1 adds a runtime test too: it seeds one issue for each issue-scoped feed source and
asserts that `stallExemption` is not `null` for it.

#### 6.1.2 The progress clock, and the clock source

**Progress** is the latest of: a run of the issue reaching `running` (its `started_at`),
any comment on the issue, an issue status change (read from the activity log, because
`issues` stores no status-change time), the issue's creation, and the **hold-lift floor**
below. A re-dispatch (#104) or a requeued wake is **not** progress. Without that rule, a
loop of failed wakes would reset the clock for ever.

**The hold-lift floor, bounded.** Nothing stores the time a hold ended, but the activity
log records the actions that lift one. The progress clock never starts before the latest
**hold-lift event** that falls inside the timeout window. Only these events count:

- `agent.resumed` for the assignee agent (exact);
- `company.updated`, `project.updated` or `routine.updated` for the issue's company,
  project or routine, **only if its `details` show that the pause state changed to not
  paused**. S1 verifies the `details` shape on `main`. If the shape cannot identify a
  lift, these three are dropped, and only "held now" and `agent.resumed` remain. The
  known gap is then a tick that waited out a company, project or routine hold.

An ordinary edit of a company or routine is **not** a lift event. So an object that is
updated often cannot suppress detection: only a pause that is lifted often can, and a
pause that is on is already an exemption. A test pins this: a routine edited every
minute still becomes stale. The lookup uses the `(entity_type, entity_id)` index and a
time bound. When #102 lands, its lift time replaces this approximation.

**The clock source is the database clock.** The step reads `clock_timestamp()` once, at
the start, and uses that one value for the whole decision. It never mixes in the
application clock.

- A **backward jump** makes ages smaller, and an age below zero is treated as zero. The
  result is a late close, which is safe.
- A **forward jump** makes ages larger and can close early by the size of the jump. The
  atomic step therefore compares the database clock with the application clock and
  refuses when they differ by more than 5 minutes. It records `clock_skew` and takes no
  action. A smaller jump can close early by at most 5 minutes, and the close is visible
  and recoverable (the next tick or evaluation recreates the work).

#### 6.1.3 The atomic close step (choice B: the row lock and a compare-and-set on `status_version`)

`closeStalledIssue({ companyId, issueId, binding, observed, targetStatus, reason,
source })` closes one issue so that no wake can be promoted onto it afterwards.
#105 uses it with `targetStatus = cancelled`. This plan's `auto_close` (section 7.3)
uses it with `done` or `cancelled`.

**The version, and what `main` has.** Migration `0227_modern_pandemic.sql:146-158`
creates the function `paperclip_bump_issue_status_version()` and the trigger
`paperclip_issue_status_version_trigger` (`BEFORE UPDATE OF status ON issues`, for each
row). When `status` changes to a new value, it sets `status_version := old + 1`. No
later migration drops it, and `packages/db/src/client.test.ts:1895-1940` asserts that it
exists after a migration replay. So **every update that changes `status` bumps the
version, whatever code issues it**, including writers that bypass the issue service. The
application also bumps it for an assignee change and for a repeated `blocked` assertion
(`issues.ts:11025-11047`), in `settleConversationTurn` (`agent-conversations.ts:375`),
and through the native status-decision effect `increment_status_version`
(`status-decision-committer.ts:1214-1226`). So it is a "status or assignment changed"
counter. An extra bump only makes a compare refuse, never pass wrongly.

**What `main` lacks** is a writer that does the compare. Nothing runs
`… WHERE status_version = :seen`, and `issueService.update` takes no expected version
(`issues.ts:10654-10689`). The shared module slice adds it. It needs **no migration**.
(An earlier draft of this plan said that `status_version` is not a status version. That
was wrong: it read the application code and missed the trigger.)

**The compare-and-set, built in the shared module slice.**

1. `issueService.update` accepts an optional `expectedStatusVersion`. In `runUpdate`,
   after the `SELECT … FOR UPDATE` (`issues.ts:10981`), if the argument is given and the
   locked row's `status_version` differs, the update throws a conflict (`stale_view`) and
   writes nothing. A caller that omits the argument sees no change.
2. `closeStalledIssue` does the same compare itself, in its own transaction, because it
   needs the lock and the other checks around the write.

**What `observed` is.** The values that the evaluation or the preview saw:
`{ statusVersion, assigneeAgentId, assigneeUserId, executionRunId, checkoutRunId,
monitorNextCheckAt }`. The version covers the status. The other fields are compared by
value, because some writers change them without a bump (for example `access.ts` writes
assignee fields only). The API returns `observed` as an opaque `observedToken`, and a
person's manual call sends the token that the preview showed. A status that goes A, B, A
bumps the version twice, so the compare refuses: that is the safe direction.

**The lock, and the one shared helper.** The row lock must still be held when the compare
runs, and the execution columns must still hold what the decision saw.
`withIssueExecutionLock` does not give that: it takes the lock and then **clears
`execution_run_id`, `execution_locked_at` and `checkout_run_id`** before it calls its
callback (`wake-queue/adapters/postgres.ts:1171-1232`, the two updates after the lock).
So "take the issue lock first" through that helper does not keep what the close needs to
compare. There is **one lock-preserving, transaction-aware variant** of that helper.
**#103's plan (D1) owns its name, path and API, and no other plan defines or names
them.** The slice that needs it first implements it exactly to #103's spec: that is
#103 D1, or #105 R1 if R1 is ready earlier. The others reuse it unchanged. A change to it
goes through #103's plan. This plan, #105 and #113 S1 add no second variant and no copy,
and no slice waits for another slice's code only for this helper. Until #103's plan
defines it, the close step cannot be built, which is a dependency on the spec.

**The race it closes.** The heartbeat cancel ends a run and then runs
`releaseIssueExecutionAndPromote`, which takes the issue's row lock **under its own,
later transaction** and promotes the oldest deferred wake to a run. If the issue is
still open at that moment, the promoted run attaches to an issue that is about to be
cancelled. A check made before the cancel does not prevent that.

**The fix is an order, and a compare-and-set under the lock.** The issue is closed
first, under the row lock that promotion also takes. A promotion that comes later sees
a terminal issue and drops the wake. In order:

1. **Lock.** In one database transaction, take the routine row lock if the caller is a
   dispatch (dispatch already holds it), and then the issue row `FOR UPDATE` (with any
   issue that references the same live runs, in id order) through the lock-preserving
   variant above. The order is routine, then issue, then run, the same as the existing
   paths, so it cannot deadlock with them.
2. **Re-validate under the lock.** All of these must hold, or the transaction rolls back
   and the caller does what it did before (a skipped or coalesced tick, or a 409):
   - the **binding** predicate that the caller passed (for #105: the issue is the
     routine's current blocker, section 3.6 of #105);
   - **`status_version` equals `observed.statusVersion`**, and the other `observed`
     values equal the locked row (fail closed: any difference aborts);
   - no run of the issue is `running`;
   - `stallExemption` returns `null`, evaluated now, **under the lock**;
   - the clock decision (6.1.2) holds, and the skew guard passes.
3. **Close, in the same transaction:**
   - set the issue to `targetStatus` through the issue service, passing the transaction
     and `expectedStatusVersion`;
   - cancel every `deferred_issue_execution` wake of the issue, with the reason code;
   - add the system comment;
   - end the originating record (for #105, the routine run, through the existing
     run-status sync, which must accept the transaction);
   - write the activity entry.
4. **Commit.** From this point the issue is terminal.
5. **Deal with the remaining runs, after the commit.**
   - A `queued` run goes through the **existing staleness decision**
     (`cancelStaleQueuedRun`), which cancels a queued run on a terminal issue and
     **keeps one that carries a wake comment or a resume intent**
     (`run-dispatch/domain/policy.ts:610-625`). A kept run starts through the normal
     queue and is retried like any queued run. No sweep removes it. It reads the
     comment, and it cannot revive a cancelled issue unless it carries a reopen intent.
   - A `scheduled_retry` run is refused at promotion by the retry gate
     (`issue_cancelled`, `policy.ts:382-389`). The step also cancels it with the
     heartbeat cancel.
   - A run that started in the short window since step 2 is cancelled with the heartbeat
     cancel, unless it carries a wake comment or a resume intent. The cancel passes
     `suppressImmediateRecovery`.
   - Each cancel calls `releaseIssueExecutionAndPromote`. It finds a terminal issue and
     promotes nothing: `promoteDeferredWake` cancels a deferred wake for a terminal issue
     and its assignee.

**Why a writer that does not take the lock cannot fool the compare.** The trigger bumps
`status_version` for every status write, so a status change committed before the close
takes its lock is seen in step 2, whichever writer made it. A row update takes a row-level
write lock until its transaction ends, so an update that starts after the close has taken
the lock waits for the close to commit. Inserts into the tables that the exemptions read
(`issue_approvals`, `issue_thread_interactions`, `issue_recovery_actions`,
`issue_comments`, `decisions`) all have a foreign key to `issues`. Such an insert takes a
`KEY SHARE` lock on the issue row, and `FOR UPDATE` conflicts with it. So an approval or
interaction that is created while the close holds the lock waits, and one that was
committed before is seen by the exemption check. `agent_wakeup_requests` and
`heartbeat_runs` have no foreign key to issues: only the explicit locks protect them,
which is why step 3 cancels the deferred wakes inside the transaction and step 5 uses the
existing staleness decision. S1 proves these with race tests.

**The one hazard that remains: a writer that decides from an old read and writes after
the close.** Its update lands after the commit and could move a closed issue to another
status. This hazard exists today for every cancel, an operator's included. The compare
removes it for callers that pass `expectedStatusVersion`. For the others, the list below
is the audit.

**Writers of the compared fields.** Found by reading `main` at `d9804ac4f`, and checked
by a second reader. The list is a **lower bound**: a scan finds a status write only when
`status:` is in the `set` object. The shared module slice begins with an exhaustive audit
and a source test (below).

| Writer | Fields it changes | Row lock on `issues` |
|---|---|---|
| `issueService.update` (`issues.ts:10654`) | status, assignee, and the rest | **Yes**, at `10981` in `runUpdate`. **But** `existing` is read earlier without a lock (`:10685`), `assertTransition` (`:305`) only rejects an unknown status, and the write has no status predicate. A caller that decided from an old read can overwrite a just-closed issue. The new `expectedStatusVersion` closes this for callers that pass it |
| `issueService.release` (`issues.ts:11855-11905`) | assignee, locks | **Yes**, `select … for update` first. It keeps a terminal status |
| `issueService.checkout` (`issues.ts:11531`, `11655`) | assignee, status `in_progress`, locks | The write has `status in expectedStatuses`. The caller supplies that list, and the validator allows any status, so it protects against an old read only when the caller leaves out the terminal ones |
| Execution claim and release (`heartbeat.ts` `lockIssueExecutionClaim` at `18523`; `withIssueExecutionLock`, `postgres.ts:1171`) | `execution_run_id`, `execution_locked_at`, `checkout_run_id` | **Yes** |
| Execution-recovery settle (`execution-recovery-resolution.ts:487`) | status `blocked`, locks | **Yes**, the task row, `:410-419` |
| Pre-dispatch block (`heartbeat.ts:30215`) | status `blocked`, clears the locks | **Yes**: it is inside the admission transaction that runs `select id from issues … for update` at `:29160-29162` |
| Slack conversation wait and resume (`slack-conversation-lifecycle.ts:91`, `slack-conversation-state.ts:48`) | status `in_review`, `todo` | **Yes**: `:21-22`, and by the comment at `:44`. A caller of `resumeSlackConversation` at `chat-channels.ts:16319` is not verified |
| Conversation turns (`agent-conversations.ts:259`, `:371`) | `conversation_state`, status, `status_version` | **Yes**: `:128-132` and `:291-296` |
| Member archive (`access.ts:696`, `708`) | status, assignee | The lock at `:680` is on the membership row, not on `issues`. Both updates carry `status not in ('done','cancelled')` (`:688-692`), so they cannot move a closed issue |
| Tree-hold release (`issue-tree-control.ts:981`) | restores `cancelled` issues to their snapshot status | **No lock seen.** It restores by design. S1 audit decides whether a close by this module can be undone by a release, and records the answer |
| Monitor claim, trigger and clear (`heartbeat.ts:11927`, `12153`, `12189`) | the monitor columns and execution state, not `status` | The monitor column is an exemption that is re-read under the close lock |
| `cli/src/commands/worktree.ts:1334` | status | A local seeding command, not server runtime |

**Prerequisites from this audit, built in the shared module slice (#105 R1), each with its
own test:**

1. **The compare-and-set** (above): `issueService.update` with `expectedStatusVersion`,
   and the compare inside `closeStalledIssue`. Tests: a status change made by a writer
   that bypasses the service between the preview and the close makes the close refuse
   (the trigger bumped the version); an A, B, A status change refuses; a mismatch in
   `update` is a conflict and writes nothing.
2. **The audit is a test.** A source test lists the known direct writers of `issues.status`
   by file and function. A new unlisted writer fails the test and forces a decision.
3. **Conversation issues are never closed by this module.** An issue with a
   `conversation_agent_id`, or with the origin kind `chat_channel`, is an exemption
   (6.1.1). The issue service already refuses `done` and `cancelled` for a conversation
   issue.

**Why the run cancel stays outside the transaction.** The heartbeat cancel is not a
plain status update. It fences native sessions, records the cancellation, and stops
processes. The order above makes this safe: the issue is already terminal.

**What can still revive the issue.** `promoteDeferredWake` reopens a terminal issue for
a wake that carries a human comment or an explicit resume intent. That is a person
acting after the close, which is allowed. It is not a leak: it is a new, visible event.

**Tests (the shared module slice, #105 R1), on embedded Postgres:**

- a wake deferred before the close is cancelled, not promoted, and no run is attached to
  the closed issue;
- a wake that arrives between the lock and the commit waits for the lock, then sees a
  terminal issue;
- an interleaving test: the heartbeat cancel of a run races the close; the end state is
  one terminal issue and no live run on it;
- the compare-and-set tests of prerequisite 1;
- **a queued run that carries a wake comment or a resume intent is kept** after the close
  and starts through the normal queue; a queued run without one is cancelled;
- an approval, an interaction and a recovery action inserted while the close holds the
  lock each wait for it (the foreign key lock), and a close never leaves a pending one
  unseen;
- a run that turns `running` after the check: the transaction rolls back;
- a pending approval, a pending interaction, and an `in_review` participant each
  prevent the close;
- the skew guard, a backward jump and a forward jump.

### 6.2 Holds are exemptions

For every rule: a company that is held (paused or archived) is not evaluated. The firing
state is kept, and `last_status` is `skipped_held`. A held **subject** (a held agent, a
tree hold, a paused project) is an exemption for rule (a), through the exemption set
(6.1.1). A hold that ended recently is handled by the hold-lift floor (6.1.2), so a
tick that waited out a hold does not close on the first evaluation after it. #102 gives
each hold a reason and a time. When it lands, its lift time replaces the approximation.

### 6.3 Cadence, claim and single firing across processes

The watchdog pass is one more step on the scheduler tick (30 seconds by default, 10
seconds at minimum). It claims due rules with a row-level claim, the pattern that the
issue monitors already use:

```
UPDATE flow_watchdog_rules SET claimed_at = now()
 WHERE id IN (SELECT id FROM flow_watchdog_rules
               WHERE enabled AND archived_at IS NULL AND next_eval_at <= now()
                 AND EXISTS (SELECT 1 FROM flow_watchdog_settings s
                              WHERE s.company_id = flow_watchdog_rules.company_id AND s.enabled)
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
- **A crash between the firing and the action is recovered.** The firing is committed with
  `action_state = pending`. The wake or the routine run happens after the commit and sets
  `done`. Each pass first retries every open firing of an enabled company whose
  `action_state` is `pending` and that is older than 2 minutes, up to 5 attempts, before
  it evaluates rules. The retry is safe: the issue wake uses the assignment idempotency
  key (the issue and its assignee), and the routine run uses the key
  `flow-watchdog:<firing id>:<fire count>`, so a second attempt returns the first.
  After 5 attempts the firing becomes `failed`, the rule's `last_status` becomes
  `error`, and one `flow_watchdog.action_failed` entry is written. A pending firing whose
  wake was skipped for a hold is `suppressed:<reason>`, not retried.
- **Before the action, the pass takes the subject issue's row lock and re-checks** the
  exemptions and "no live run, no queued wake" (section 3.1). If the issue was woken
  meanwhile (by #104 or a person), the firing is recorded as `suppressed:woken` and the
  pass opens no second path.
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
rule still fires on what it saw.

**The title pattern is restricted and bounded.** The database regular expression engine
supports back-references, which can take exponential time. So a pattern is validated at
save: at most 200 characters, **no back-references**, and no group that contains a
quantifier and is itself quantified (a nested repetition such as `(a+)+`). The test match
at save runs on a sample with a statement timeout. At run time the pattern is applied
only to the already bounded rows (500 at most), under the 5 second statement timeout. A
**pass budget** of 30 seconds bounds the whole pass: when it is spent, the pass stops
claiming rules and the rest wait for the next tick, and `last_status` of the skipped
rules does not change. A rule whose query times out twice in a row moves to `error` and
stops until a person edits it.

**Evidence is rendered safely.** Issue text, titles and comments are written by agents
and plugins. Evidence and templates never insert them raw. Each field is cut to 200
characters, placed in a code span or quoted block with the markup escaped, stripped of
`@` mentions and automatic links, and never rendered as HTML. A template may name only
the fields of the closed context (section 7.1).

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

Rule (d) has two readings. They have different dependencies.

- **`provider_errors`** counts runs that ended with an error code from a closed list. It
  does not depend on #106. It is in S1.
- **`failed_rate`** uses **#106's definitions exactly as they are**, and calls #106's
  shared measure function. It does not re-derive anything. In #106, scrap is every
  `failed`, `timed_out` or `interrupted` terminal run, over every terminal run finished
  in the window, counted by `finished_at`, with at least 5 runs. Restart losses are a
  **separate report** in #106 (`restartLoss`, with its drain-window rule), not an
  exclusion inside the scrap rate. So the rule has a setting `restartLoss: include |
  exclude`. With `include` (the default) it reads `scrap.rate`. With `exclude` it reads
  `scrap.rate` minus the runs that #106's `restartLoss` classifies, using #106's own
  classification. The rule never lists restart error codes itself. **`failed_rate`
  ships after #106's measure function has landed** (S2 or later). Until then it is
  rejected at save with a clear message. #106's prerequisite F0 (the usage record
  misses `interrupted` runs) does not block it if the measure reads `heartbeat_runs`
  directly, as #106 plans.

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

- **It does not stop a paused routine, and a pre-check is not enough.** `runRoutine`
  rejects only an archived routine, and the "routine is active" check inside the
  dispatch transaction applies to the webhook and schedule sources only
  (`routines.ts:1789-1800`). A pause that commits after a watchdog pre-check and before
  the dispatch would still create and wake a run. So the check must be **inside the
  dispatch transaction, under the routine row lock**. S2 adds an input flag
  `requireActive` that `dispatchRoutineRun` honours after it takes that lock: it refuses
  with a conflict when the routine is not `active`, or when the routine's project is
  paused, whatever the source. Only the watchdog sets the flag, so a person can still
  run a paused routine by hand. The pre-check stays, to avoid a wasted call, and the
  dry run reports both. This is an S2 prerequisite with its own race test (a pause that
  commits between the pre-check and the dispatch makes no run).
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
  watchdog comment. **It closes through the atomic close step (section 6.1.3)**, with the
  binding "this is the firing's issue", the values that the watchdog last saw (`observed`),
  and the exemption set. The assigned agent may have woken on this issue, and a plain
  status write could leave a promoted wake on a closed issue. `none` writes nothing.
- **If the issue is closed by someone while the condition still holds:** the firing
  resolves with `issue_closed`. A new firing may open after the cooldown, counted from
  the closure. A closed issue means "seen", so the rule does not reopen it.
- **If a rule is edited while a firing is open.** A rule has a `version`, bumped by every
  edit. A firing keeps the `rule_version` and the `action_snapshot` it opened with, and
  uses that snapshot for every later action (the cooldown comment, `auto_close`, the
  routine fire). An edit to the **kind, the filter, the subject key or the action
  target** resolves the open firings with `rule_edited` and a comment. The next pass
  opens a new firing if the subject still matches. An edit to the cooldown or the
  resolve policy applies to open firings from the next action. No firing is ever
  applied to a configuration that it did not open under.
- **If the rule is disabled or archived:** its open firings resolve with `rule_disabled`
  or `rule_archived`, with a comment.
- **If the subject is deleted or hidden:** `subject_gone`.

### 7.4 Cooldown and the company cap

- **Per-rule cooldown** (`cooldown_minutes`, default 120): the minimum time between two
  actions for one firing.
- **The cap entry has one durable winner.** When an action meets the cap, the process
  runs `UPDATE flow_watchdog_settings SET cap_logged_window = window_started_at WHERE
  company_id = :c AND cap_logged_window IS DISTINCT FROM window_started_at RETURNING`.
  Only the process that gets a row back writes the `flow_watchdog.cap_reached` entry.
  The other processes record the suppression and write nothing. A new window starts
  with a new `window_started_at`, so the next window can log once more.
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
| **Shared module** (not a slice of this plan) | **Built first by #105 R1**: `server/src/services/flow-stall.ts`, the compare-and-set in `issueService.update`, the writer audit test and the conversation-issue exemption (section 6.1). It needs the lock-preserving variant that #103's plan (D1) defines | No | `heartbeat.ts` and the issue service are touched. A single |
| **S1** | **Starts after the shared module has landed** (#105 R1). Three tables, the experimental flag and the kill switch. The evaluator framework (claim, bounds, firing reconcile, the recovery of pending actions, cap). Rule (a) and rule (d) `provider_errors`. The issue action. Dry run. API, CLI and web | Yes | Risky slot. It adds a scheduler step, creates issues and wakes agents |
| **S2** | Rule (b) (sources `issue_done`, `external_object`, `work_product`), rule (c), rule (d) `failed_rate` (after #106's measure has landed), the routine action with the `requireActive` dispatch flag, agent read of open firings | No | The dispatch flag touches `routines.ts`. A single |
| **S3** | The `plugin_event` source: one event table written at the plugin bus | Yes | Single. Only if S2 is not enough |
| **Later** | Lane-health kinds (section 3.5). A hold action for rule (d) (section 9.4). XmR breach as a threshold. Moving #104's reconciler onto the shared stall module | Only for a new source table | |

### 9.2 Order with #104, #105 and the recovery sweeps

**Where the pass runs.** The periodic recovery chain in `server/src/index.ts` runs these
steps one after another: the orphan reaper, `promoteDueScheduledRetries`,
`resumeQueuedRuns` and the stranded-issue reconciliation (#104), the dependency-wake
reconciliation, the task-watchdog reconciliation, the silent-active-run scan, and the
stale-issue-lock sweep (`index.ts:1827-1873`). **The watchdog pass is the last step of
that chain**, so it sees the result of every sweep before it, when the chain reaches it.
Three limits of the chain are stated here, because the pass inherits them:

- **The chain stops at the first failing step.** A throw in an earlier step goes to the
  single `.catch` (`index.ts:1871`), and the later steps, the watchdog pass included, are
  skipped for that tick. (The #120 incident came from this: the claim error in
  `resumeQueuedRuns` skipped the stale-lock sweep that would have cleared the cause.) The
  watchdog pass therefore catches its own errors, and it does not rely on being reached
  every tick.
- **The interval callback has no in-flight guard** for this chain (`index.ts:1692`,
  `1214`), so two ticks can overlap in one process. The per-rule claims (6.3) and the
  per-subject lock re-check make an overlap safe. "In one process it sees every sweep
  first" is a best effort and not a guarantee.
- **The chain runs only when scheduling is not suppressed** (`index.ts:1712`). The
  watchdog inherits that.

**The startup chain is not extended.** A second chain runs once before the server listens
(`index.ts:1500-1631`). The watchdog is not added to it. The first pass runs at the first
periodic tick.

It keeps its own per-rule claims. Across processes, the per-subject check under the issue
lock covers what the order cannot.

| Step in the chain | What it does | How rule (a) avoids racing it |
|---|---|---|
| Orphan reaper | Ends a `running` run whose process is gone | Rule (a) needs "no live run", so it does not see a running issue. It runs after the reaper |
| #104 stranded-issue reconciliation | Wakes the **owner** of an assigned, open issue with no live run | A queued wake or an open recovery action is an exemption. The pass re-checks both under the subject issue's row lock (section 6.3). At worst both act once: #104 wakes the owner, and the watchdog opens one issue about the same subject, which the dedup key limits to one. #104's recent-progress constant is **not** relied on (section 3.1) |
| Dependency-wake reconciliation | Wakes issues whose blockers resolved | An unresolved dependency is an exemption. A resolved one produces a wake, which is the queued-wake exemption |
| Task-watchdog reconciliation | Opens the task watchdog issue for a watched subtree | An active task watchdog is an exemption for rule (a) |
| Silent-active-run scan | Reviews a `running` run with no output | Disjoint: rule (a) needs no live run |
| Stale-issue-lock sweep | Clears a lock that points at a finished run, or a missing run | The pass runs after it in the same chain. The "no active run" test reads run **status**, not the lock columns, so a lock that is not yet cleared does not hide a stall and does not create one. Across processes, the issue-lock re-check settles it |
| #105 stale-tick expiry | Closes a stuck routine tick at dispatch | #105 closes. Rule (a) only reports. A tick that #105 closed is a closed issue and is no longer a subject. Both use the same close step and exemption set (section 6.1) |
| #102 holds | A held scope | A hold is an exemption. The hold-lift floor (section 6.1.2) prevents a close right after a lift |

### 9.3 Tests per slice

**The shared module (#105 R1)**, on embedded Postgres: the compare-and-set and its tests;
the audit source test; the conversation-issue exemption; the atomic close step and the
exemption conformance test (sections 6.1.3 and 6.1.1); the clock source and the bounded
hold-lift floor, including a routine edited every minute that still becomes stale
(section 6.1.2). #113's S1 re-runs none of these and adds its own tests on top.

**S1**, on embedded Postgres:

- Rule (a): an issue past `N` with no progress fires once, with an issue assigned to the
  agent and a wake. **Red at `main`:** nothing fires. `N` below the 60 minute floor is
  rejected at save.
- **No self-recursion.** A watchdog issue whose wake was skipped is not a subject, and
  ten evaluations leave one issue.
- Each exemption of section 6.1.1, one test each, and the conformance test against the
  attention feed. No firing.
- A re-dispatch by #104 does not reset the clock. A wake that #104 queued between the
  evaluation and the action is seen under the issue lock: the firing is
  `suppressed:woken`, and no second path is opened.
- The pass runs as the last step of the recovery chain and does nothing while scheduling
  is suppressed.
- **Off behavior.** The experimental flag off: no claim, no issue, no wake. A company with
  no settings row, or `enabled = false`: not claimed. Turning a switch off leaves open
  firings and issues untouched.
- **A crash between the firing and the action.** A firing left `pending` is retried by
  the next pass with the same idempotency key and ends `done`. After 5 attempts it is
  `failed` and one `action_failed` entry exists.
- Dedup: 10 evaluations leave exactly one open firing and one issue. A second process
  claiming the same rule at the same time leaves one firing (two-client race).
- Cooldown: a second fire inside the cooldown only updates the evidence.
- The cap: the 7th action in the hour is suppressed, and **exactly one** `cap_reached`
  entry exists even when several processes meet the cap at the same moment.
- Clear: two clear evaluations resolve the firing with a comment. `auto_close` closes
  only an untouched issue, through the atomic close step.
- **Rule edits.** An edit of the filter resolves the open firing as `rule_edited`. An
  edit of the cooldown applies from the next action. A firing keeps its action snapshot.
- A paused assignee: the issue exists, the wake is skipped, `last_wake` says why. A held
  company: no evaluation.
- Restart: an overdue rule is evaluated once.
- Bounds: a seeded dataset past 500 rows gives `truncated`. A pattern with a
  back-reference or a nested repetition is rejected at save. The pass budget stops the
  pass and leaves the rest for the next tick. A rule that times out twice moves to
  `error`.
- **Evidence safety.** Issue text with an `@` mention, a link, markup and a very long
  line is rendered cut, escaped and inert.
- Rule (d) `provider_errors`: the count and the closed list of codes.
- Dry run: it matches the real evaluation for the same fixtures and writes nothing.
- Company scope: a rule and a firing of another company return 404.
- Validation: a bad template path, a bad pattern, an interval under 30 seconds.
- OpenAPI listing, CLI parity and the web component tests. The new database tests are
  listed in the pull request body. They cannot join the `Dockerfile` `vitest run` list.

**S2:** the `issue_done`, `external_object` and `work_product` sources (including the
never-seen baseline); starvation (the free-slot definition equals the scheduler's);
rule (d) `failed_rate` against #106's examples, with `restartLoss` included and
excluded; the routine action (the variables check, the idempotency key, the routine's
concurrency policy); **the pause race: a pause that commits between the pre-check and
the dispatch makes no run, because `requireActive` is checked under the routine lock**;
the agent read of open firings.

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
| Compare values only, without the version (choice A) | It works under the row lock, but the trigger already gives a version for every status writer at no cost. A value compare cannot tell that a status went A, B, A, and cannot see a change by a writer that leaves the compared fields alone. The version plus a value compare of the other fields is stronger (section 6.1.3) |
| Evaluate in the unclog agent | That is the cost this plan removes |
| Create a new issue on every fire | A persistent clog would flood the board |

## 12. Open questions

Each has a recommendation. The reviewer should check the ones marked **for the reviewer**.

| ID | Question | Recommendation |
|---|---|---|
| **Q1** | **For the reviewer.** Share the stall module with #105 and not with #102? | Yes. Define the exemption set, the progress clock and the atomic close step once, here (section 6.1). **#105 R1 builds `server/src/services/flow-stall.ts` first and #113 S1 reuses it.** No "whoever lands first". Share conventions with #102. Do not reuse #102's checker. Leave #104 alone until later. Whoever lands first creates the module |
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
| **Q23** | **For the reviewer.** The atomic close contract on what `main` provides: **choice B**, the issue row lock plus a compare-and-set on `status_version`. The trigger of migration `0227_modern_pandemic.sql:146-158` bumps it on every status change, so no migration is needed | B (section 6.1.3). `main` lacks only a writer that does the compare. The shared module slice adds `expectedStatusVersion` to `issueService.update` and the compare in the close step. Values of the non-status fields are compared too, because some writers change them without a bump |
| **Q24** | The clock source and the hold-lift floor | The database clock, a 5-minute skew guard, and a floor taken from `agent.resumed` and the `*.updated` entries of the company, project and routine (section 6.1.2). #102's lift time replaces it later |
| **Q22** | A terminated or pending assignee at fire time | Take no action. Record `suppressed: assignee_unavailable` and put the rule in an error state that the rules page shows |
| **Q25** | **For the reviewer.** Where is the exemption set derived from? | From the attention feed: the stall module calls the feed's readers, and a `Record<AttentionSourceKind, …>` table fails to compile when the feed gains a source (section 6.1.1) |
| **Q26** | Rule (a) and its own output | A subject is never a `flow_watchdog` issue or the issue of an open firing. No opt-in in S1 (section 3.1) |
| **Q27** | The floor for `N` | 60 minutes, a floor this plan owns. It is a heuristic and not a guarantee against #104. The guarantee is the exemptions and the issue lock (sections 3.1 and 9.2) |
| **Q28** | **For the reviewer.** Rule (d) and #106 | Use #106's measure function and definitions as they are. `provider_errors` is S1. `failed_rate` ships after #106's measure has landed (section 6.6) |
| **Q29** | The routine pause race | An S2 prerequisite: `requireActive` is honoured by `dispatchRoutineRun` under the routine lock, set only by the watchdog (section 7.2) |
| **Q30** | Off behavior | An instance flag `enableFlowWatchdog` (default off), and a company settings row with `enabled` (a missing row means off). Both are in the claim (section 5.3) |
| **Q31** | The hold-lift floor | Only real lift events: `agent.resumed`, and the company, project or routine update entries that show an unpause. S1 verifies the `details` shape; if it cannot be read, those three are dropped (section 6.1.2) |
| **Q32** | A crash between the firing and the action | `action_state = pending`, retried by the next pass with an idempotency key, at most 5 attempts (section 6.3) |
| **Q33** | Who builds the shared module, and in which order? | #105 R1, first, as a single, at `server/src/services/flow-stall.ts`. #113 S1 reuses it (sections 6.1 and 9.1) |
| **Q34** | The lock-preserving variant of `withIssueExecutionLock` | One variant, owned by #103 D1. The first slice that needs it implements it to #103's spec; the others reuse it unchanged (section 6.1.3) |

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
| Attention feed sources and their entry rules (used for the exemption set) | `server/src/services/attention.ts:1152` (approval), `1255` (interaction), `1313` (decision), `1440` (recovery action), `1502`, `1555` (blockers), `1610-1652` (review, stalled), `1740` (failed run), `1794` (budget), `1848` (agent error); `packages/shared/src/types/attention.ts:8-22` (`ATTENTION_SOURCE_KINDS`) |
| The recovery chain in the periodic pass (reaper, #104 reconciliation, dependency wakes, task watchdogs, silent-run scan, stale-lock sweep) | `server/src/index.ts:1827-1873` |
| Experimental flags: the type, the validator, the default, the catalog | `packages/shared/src/types/instance.ts:81`, `packages/shared/src/validators/instance.ts:60`, `server/src/services/instance-settings.ts:240`, `284`, `packages/shared/src/feature-catalog.ts:148` (`enableAgentChat` is the model for `enableFlowWatchdog`) |
| Dispatch checks the routine is active only for webhook and schedule, inside the routine row lock | `server/src/services/routines.ts:1789-1800`, `2854-2879` |
| Direct writers of `issues.status` without a row lock seen | `server/src/services/heartbeat.ts:30215`, `server/src/services/agent-conversations.ts:259`, `server/src/services/slack-conversation-lifecycle.ts:91` |
| #104 (read at head `3777001734`): ordinary stranded dispatch, and the productive-continuation branch that alone uses the 30 minute constant | `server/src/services/recovery/service.ts:4537-4557`, `5407-5417`, `5652-5680` (at that head) |
| #106 (read at head `87a95007f`): scrap, `restartLoss`, the drain window | `doc/plans/2026-10-10-company-flow-metrics.md:164-176`, `188-215` (at that head) |
| The comment wake lives in the route; the service comment does not wake | `server/src/routes/issues.ts:17358`, `18233-18236`; `server/src/services/issues.ts:12211` |
| Pull-request events stored in `external_objects` (`data.mergedAt`, `last_changed_at`) | `server/src/services/github-connection-events.ts:200-260`; `packages/db/src/schema/external_objects.ts` |
| Recovery progress exemption (an environment value) | `server/src/services/recovery/service.ts:189-192` |
| The issue lock that promotion takes (`FOR UPDATE` on the issue rows, in id order) | `server/src/modules/wake-queue/adapters/postgres.ts:1171` (`withIssueExecutionLock`) |
| Release and promote: the drain, and the terminal-issue branch of a promotion | `server/src/modules/wake-queue/application/use-cases.ts:145` (`runReleaseDrain`), `378` (`promoteDeferredWake`), `1024` (`releaseIssueExecution`) |
| A queued run on a terminal issue is cancelled at the claim (with a bypass for a wake comment or resume intent) | `server/src/modules/run-dispatch/domain/policy.ts:497` (`decideQueuedRunStaleness`), `614-623` |
| The scheduled-retry gate returns `issue_cancelled` | `server/src/modules/run-dispatch/domain/policy.ts:382-389` |
| The heartbeat cancel (native fence, process stop) | `server/src/services/heartbeat.ts:31507` (`cancelRunInternal`) |
| Pending linked approvals (the pair that attention reads) | `packages/db/src/schema/issue_approvals.ts:7-22`, `packages/db/src/schema/approvals.ts:5-19`, `server/src/services/attention.ts:1591-1617` |
| Pause and resume are logged (`agent.paused`, `agent.resumed`) | `server/src/routes/agents.ts:5915`, `5950` |
| The status-version trigger: bumps on every status change; asserted after migration replay | `packages/db/src/migrations/0227_modern_pandemic.sql:146-158`; `packages/db/src/client.test.ts:1895-1940` |
| Other bumps of the version (assignee change, repeated `blocked`, conversation turn, native status effect); the issue service takes `FOR UPDATE` at the start of its write | `server/src/services/issues.ts:11025-11047`, `10981`; `agent-conversations.ts:375`; `native-runtime/status-decision-committer.ts:1214-1226` |
| `withIssueExecutionLock` clears the execution and checkout columns before its callback | `server/src/modules/wake-queue/adapters/postgres.ts:1171-1232` |
| Tree-hold release restores cancelled issues | `server/src/services/issue-tree-control.ts:981` |
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
