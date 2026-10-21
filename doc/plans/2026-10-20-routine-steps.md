# Plan: Routine steps

Status: PR 1 (steps) and PR 2 (start on a task) implemented. Loop slice 1 (send back) implemented. PR 3 (conditions) and loop slices 2 to 4 are planned.

## Context

Teams repeat multi-step work, for example implement, review, QA, parallel lens reviews, release gate. Today that sequence lives as prose in skills and routine prompts. Agents read the prose and create child issues by hand, so the shape is unvalidated and hard to change safely.

The pipelines tutorial (`docs/pipelines-tutorial.md`) models multi-stage work with pipelines and routines and calls task templates a convention. This plan turns that convention into a primitive: a routine gets a `steps` list. A run creates the run's task plus one child task per step, linked by blockers. Existing machinery then runs it. A pipeline stage can run such a routine through the existing `run_routine`.

In plain words: a routine says "create this task". With steps it says "create this task and its sub-tasks, in this order, for these agents".

### Reused as-is

| Need | Existing mechanism |
|---|---|
| Parallel tasks and wait-for-all | blockers (`blockedByIssueIds`) and the `issue_blockers_resolved` wake |
| Parent waits for its steps | blocker edges from the run's task to its children, plus `issue_children_completed` (both collapse into one wake) |
| Step fields | `createChildIssueSchema` and `issueService.createChild` |
| Revise and re-review | `executionPolicy` review stages, bounded by `maxReviewRounds` |
| Approval gate | an `executionPolicy` approval stage on the agent step being gated |
| Skills per step | `skill://` mentions in the step instructions |
| Versioning, variables, triggers, UI, API, CLI | routines |
| Cancel a whole run | the tree control on the run's task |

Not built: new tables, a general workflow engine, OR-joins, loops over lists, data mapping between steps.

## PR 1: steps (implemented)

### Step template (`packages/shared/src/routine-steps.ts`)

A step reuses the child-issue fields (`title`, `description`, `assigneeAgentId`, `priority`, `labelIds`, `executionPolicy`, `acceptanceCriteria`) and adds:

- `key`: a lowercase slug, unique in the routine
- `after`: `string[]`, the keys of the steps it waits for. Conditions on an edge (`when`) arrive in PR 3, which changes this field then; PR 1 has no `when` form in the type, the schema or the API.

Validation: unique keys, `after` points at existing keys, no cycles, at most 25 steps, every step resolves to an agent (its own or the routine's; there are no unowned or user-owned steps because they would never be woken), agents and labels belong to the company. `{{variables}}` work through `interpolateRoutineTemplate`, and a variable that appears only in a step is added to the routine's variables.

### Storage

- `routines.steps jsonb not null default '[]'` (migration 0315, additive), also in routine revision snapshots.
- `routine_step` joins `ISSUE_ORIGIN_KINDS`.
- The run's `triggerPayload.routineSteps` stores `{ steps, stepIssueIds }`, so a run is self-contained and later edits do not change it.

### Dispatch

`attachRoutineSteps` in `server/src/services/routine-steps.ts` is the single function that builds the graph. `dispatchRoutineRun` and the event dispatcher (for a new event group) both call it. Repeat, recovery and append events never attach steps.

1. The run's task and all steps are created inside one savepoint of the dispatch transaction, before any wake. A failure in creating them rolls the savepoint back and the existing failed-run handling records the run. A later database failure of the same dispatch rolls back the whole dispatch, with no run row (accepted).
2. The run's task is created `blocked` and is not woken. It is woken once by the existing wakes after the last step.
3. Steps are created in layers (first those with nothing to wait for, then those whose predecessors are all created, each layer in written order) through `createChild(root.id, ..., tx)`: `blockParentUntilDone`, blockers from `after`, `todo` without `after` and `blocked` otherwise, idempotency key `routine-run:{runId}:{stepKey}`, `originKind: "routine_step"`.
4. After commit, only the steps without predecessors are woken.
5. For a routine with steps, an open, visible run task of an earlier run counts as live for `skip_if_active` and `coalesce_if_active`, unless `isRoutineStepRunStalled` (`packages/shared/src/routine-steps.ts`) says the run cannot move on its own: a cancelled step never resolves its dependents, so a run whose remaining steps are all blocked behind a cancelled one is not live. PR 3 reuses the same function for skipped steps.
6. Routine env and secrets stay on the `routine_execution` run task. Step agents do not inherit them (least privilege; can be extended if a real workflow needs it).

Steps use `routine_step`, not `routine_execution`, because the unique index on open routine executions would make parallel steps collide and `findLiveExecutionIssue` would mistake a step for the routine's live run.

Sweeps: the stranded sweep re-dispatches a `todo` step whose wake was lost; the orphan-blocker sweep never matches a step because every step has an agent; the dependency backstop covers blocked steps and the run's task.

### Workspace handoff

Steps are siblings and the run's task never runs, so a step has no workspace to inherit from it. Before a step first runs, `inheritRoutineStepWorkspace` points it at the execution workspace of its earliest predecessor in the same project. A reviewer then sees the implementer's checkout.

### Surfaces

- REST and OpenAPI: `steps` on routine create, update, get and revisions.
- CLI: `--steps-file` on `routine create` and `routine update`.
- UI: a Steps section on routine detail (key, title, instructions, agent, priority, starts-after). Labels, execution policy and acceptance criteria are API and CLI fields; the UI preserves them.
- Permissions: existing routine rules plus the task-assignment permission for writing steps. An agent can only assign steps to itself.

### Review loops

A review is an `executionPolicy` review stage on the step being reviewed, not a separate step. The loop stays on one task, and sessions are stored per agent, adapter and task, so the reviewer and implementer resume their sessions between rounds. See `doc/execution-semantics.md`.

## PR 2: start on a task (implemented)

No new trigger kind. The existing `event` trigger does the work: `eventMatch`, the `event_deliveries` ledger, the storm limiter and the trigger UI, API and CLI already exist. A routine can now start its steps on a task that is created, or on a task that already exists.

### Built-in Paperclip event source

- One per company, created lazily by `POST /companies/:companyId/event-sources/paperclip` (idempotent; board access like the other event-source writes). The response is the `EventSource`: `normalizer: "paperclip_v1"`, `ingressUrl: null`, `secretId: null`, name "Paperclip (built-in)". `GET /companies/:companyId/event-sources` lists it once it exists.
- Paperclip manages it. `PATCH` (except `enabled`), `DELETE`, secret rotation and the dry-run test answer 409. Public ingress on its id answers 404, like an unknown source. `paperclip_v1` is not in `EVENT_SOURCE_NORMALIZERS`, so create and update refuse it.
- It publishes one event type, `issue.created`: `source: "paperclip"`, severity `info`, state `info`, `dedupeKey` the task id, `title` empty. Every agent of the company can read deliveries and runs, also of tasks it may not read, so the event names the task by id only; the steps read the title from the task. Labels for `eventMatch`:
  - `project`: the project id, only when the task has one
  - `created_by`: `user` or `agent`
  - `label_<slug>`: `"true"` for each label of the task. The slug is the label name lowercased, every run of characters outside `[a-z0-9_]` turned into one `_`, trimmed of `_`, and cut so the key stays within 64 characters. At most 30 task labels, sorted by slug; the rest are dropped.
- No event for hidden tasks, tasks of origin `routine_execution`, `routine_step` or `chat_channel`, conversations, tasks below a `routine_execution` or `routine_step` task, or tasks created in a heartbeat run whose task is one of those or below one (`contextSnapshot.issueId` or `taskId`; the create routes pass the request's run). The walk covers 50 levels and fails closed beyond them. A step's agent therefore cannot start a loop with the tasks it creates, wherever it puts them.

### `issueMode: "event_issue"`

- Board only: an agent that creates, enables, un-archives, restores from a revision or changes the event fields of such a trigger gets 403, even on its own routine. The trigger starts steps on every matching task of the company, including tasks of other agents and people. An agent can still disable, archive or relabel it. While such a trigger is enabled, an agent that changes the routine's steps, its variables (whose defaults fill in the step text) or its agent, also through a revision restore, gets 403. These checks run under the routine row lock, which every trigger write takes.
- Valid only on a trigger of the built-in source (422 on any other), with `fallback: false`, for a routine that has steps (422 otherwise; a routine update that would empty the steps while such a trigger is enabled is 422 too).
- A routine gate script that applies to event triggers cannot combine with an `event_issue` trigger (422 at the trigger save and at the gate save). The start is synchronous and a gate would have to park it. Dispatch fails permanently if it still meets the pair.
- The event's subject task is the root. No `routine_event_groups` row is written. The storm limiter still spends a slot: when the budget is gone the delivery is `storm_folded` with note `new_issue_budget_spent` and nothing is attached.
- Recommended filter: `labels: { created_by: "user" }`. A trigger without it also fires for tasks that agents create.

### Starting on the created task

`eventSourceService.publishInternal` (server only, no HTTP auth) reuses routing, the ledger and dispatch. The issue-create routes call it synchronously, before the assignment wake:

1. Fast path: if the company has no enabled event trigger on its built-in source, it returns at once. No source is created and no delivery row is written, so ordinary task creation is unchanged.
2. The delivery key is derived from the source, the event type and the task id, so the same task never starts twice.
3. If the steps were attached, the root wake is skipped (the steps without predecessors are woken after commit) and the 201 response carries the re-read task.
4. It never throws into the create request. A failure is logged and recorded on the delivery, and the task gets its normal wake. When the task has open routine steps anyway (a manual run attached them first, so this event's attach was refused), the publish reports the steps as attached and the assignee stays asleep.

The delivery outcome is `issue_created` with `issueId` the task, the `runId`, and note `steps_attached`. A task refused by a guard below is `failed_permanent` with the guard's message.

### Attaching to an existing task

`attachRoutineStepsToIssue` in `server/src/services/routine-steps.ts` is the one function behind both the event and the manual run. It is built on `createRoutineRunIssues`, so the steps, blockers and wakes are the PR 1 ones. In one savepoint, after locking the task row:

- not in the company or hidden: 404
- origin `routine_execution`, `routine_step` or `chat_channel`, or a conversation: 422
- status not `backlog`, `todo` or `blocked`: 409 (blocking an active task would clear its checkout)
- a checkout, an execution lock or a queued or running heartbeat run on the task: 409
- open `routine_step` children already: 409
- existing subtasks plus the steps over 25: 422

An agent-owned task is set to `blocked` so its agent does not start on it. A user-owned task keeps its status and only gains the blocker edges. On failure the savepoint removes the steps created for this run and restores the status; the user's task is never deleted.

Two attaches on one task (an event and a manual run) take turns on the row lock, so there is exactly one tree. `{{issue.title}}` and `{{issue.identifier}}` are available in step text on these runs; on any other run the placeholder is left as written.

### Manual run

`POST /routines/:id/run` takes `targetIssueId` (a UUID). It answers 202 with the run, `linkedIssueId` the task, and `warnings`. Errors: 404 (task not in the routine's company), 409 and 422 as above, 409 when a step that starts at once has an agent that cannot be woken, 422 when the routine has no steps, and 422 when the request also names a `triggerId`. A second run on a task whose first run's steps are still open is refused with 409 by the open-steps check; after those steps close, the routine can run on the task again. A caller `idempotencyKey` returns the same run on a repeat, and 409 when it was used for another task or for a run without a task. The request cannot also name `projectId`, `projectWorkspaceId` or execution workspace fields (422). Permissions: the existing routine rules, the right to update the target task (403 for an agent that may not), and for every caller, board users too, the `tasks:assign` decision under the task for each step agent (403 when the task or its project blocks the assignment). The activity entry records `targetIssueId`.

The steps are created as sub-tasks of the task, so they inherit its execution workspace like any sub-task: when the task has one, every step in its project works in it, parallel branches too, and `inheritRoutineStepWorkspace` changes nothing. When it has none, the steps hand workspaces on as on any run. This is deliberate: the steps check or finish the work of the task, in its checkout.

### Warnings

Routine create, update and run responses carry `warnings: RoutineStepWarning[]` (always present, often empty): `{ code: "step_agent_unavailable", stepKey, agentId, reason }`. The reason is the one the agent-invokability check reports (`missing`, `paused`, `terminated`, `pending_approval`, `unknown_status`, `manager_missing`, `manager_company_mismatch`, `manager_terminated`, `reporting_cycle` or `reporting_chain_too_deep`). A warning never blocks the save or the run.

### Surfaces

- UI: the trigger wizard offers "Paperclip (built-in)" as an event source. Choosing it fixes the mode to "Attach the steps to the created task", hides grouping and fallback, presets `issue.created` and offers the project, creator and label filters. The issue page has "Run routine on this task"; the dialog lists routines with steps and shows the 409 or 422 reason inline. Warnings show as a banner on routine detail and a toast.
- CLI: `paperclipai event-sources ensure-paperclip -C <companyId>`, `paperclipai routine run <id> --target-issue <uuid-or-identifier>`, and warnings on stderr as `warning: step "<key>": agent <id> is <reason>`. Event triggers with `issueMode: "event_issue"` go through `routine trigger:create`.
- REST and OpenAPI: the ensure endpoint, `targetIssueId`, `warnings`, `event_issue`, and the 404, 409 and 422 answers.

### Verification (PR 2)

- Server (embedded Postgres): attach and event paths, guards, ledger dedupe, no recursion, concurrent attach, rollback keeping the task, warnings.
- UI and CLI unit tests; `openapi-routes.test.ts`; a real-browser check of the wizard and the issue dialog.

## PR 3: conditions (planned)

- A step's outcome is its terminal status, `done` or `cancelled`. A reviewer asking for changes does not end a step; only a board cancel does.
- An edge is dead when its `when` does not match its source's outcome, or its source was skipped. A step whose incoming edges are all dead is cancelled with "Skipped: condition not met", and the rule repeats downstream. Plain edges from a cancelled step are not dead, so a human cancel never silently cascades.
- Skipped steps are removed from every blocker set in the run, then `issue_blockers_resolved` wakes go out for steps that became ready.
- A reconcile action runs when a `routine_step` issue reaches a terminal status, with a small periodic backstop. Reconcile is idempotent: it locks the root and re-derives everything from `triggerPayload.steps` and current statuses.
- `when` is allowed only on `after` entries; the editor warns about a step that would always be skipped.

## Loops, step results, stalled runs and the steps-run hint (planned 2026-10-21)

Four slices, one PR each, in this order. Each ships with REST/OpenAPI, CLI, UI, the paperclip skill, tests and docs. Slice 2 builds the outcome part of PR 3; PR 3's plain `done`/`cancelled` rules stay as written above.

### Slice 1: bounded loop back ("send back")

A later step sends the work back to an earlier step of the same run, for example `qa` back to `implement`. The earlier step reopens with the same agent and resumes that agent's session on it. The steps after it wait again and wake again when it is done again. Rounds are capped.

- **Step fields.** `sendBackTo: string[]` (default `[]`) names the steps this step may send work back to. Each key must be a step this step waits for, directly or through other steps; a step can never send work forward or to itself. `maxSendBacks` (1 to 10, default 2) caps the rounds on each of those edges. Both are stored with the steps in the run, so a later routine edit does not change a running loop.
- **Call.** `POST /issues/{id}/routine-step/send-back` with `{ toStepKey, comment }`, where `{id}` is the step that sends the work back. The comment is required and says what to fix. The caller is the step's agent (from its run), or a board user. In one transaction, under a lock on the routine run row:
  1. Refusals: 404 for an unknown or hidden issue; 422 when the issue is not a step of a run or `toStepKey` is not in its `sendBackTo`; 403 for an agent that is not the step's assignee; 409 when the step is not `todo`, `in_progress` or `blocked`, when the run's root is closed, or when the target or a step of the loop (below) is not `done`.
  2. The **loop** is the target, every step between the target and the sender (steps that wait for the target and that the sender waits for), and the sender. Only the loop runs again. A step outside it keeps its status, also a done step on a parallel branch that waits for the target: with `implement → [docs, qa]`, `qa` sending back to `implement` leaves a finished `docs` finished. A step that must see every new round belongs on the path to the sender (make the sender wait for it). This keeps a round as small as the loop and leaves running parallel work alone.
  3. The target goes from `done` to `todo` with the same assignee. Its execution state is cleared, so its review stages run again.
  4. Every other step of the loop, the sender included, goes to `blocked` and gets a new `blockedTransitionAt`, so the `issue_blockers_resolved` wake for the next "target done" is a new wake and is not deduplicated against the first round. Their execution state is cleared too. They resume their own sessions when woken, and their rounds count toward no cap.
  5. The comment is posted on the target, and the run records `{ fromStepKey, toStepKey, actorType, actorId, commentId, at, outcome: "sent_back" }` in `triggerPayload.routineSteps.sendBacks`.
  6. After commit the target's agent is woken with `issue_reopened_via_comment` (payload `reopenedFrom: "done"` and `routineStepSendBack`). That reason does not force a fresh session, and the session row is keyed per agent, adapter and issue, so the agent resumes its session on the target.
- **The sender's own run after a send-back.** The sender is `blocked` on a target that is open again, and its checkout is released. A later `status: "done"` from that same run is refused (409), so the sender is never marked done while the work it sent back is open. It finishes in the round after the target is done again.
- **Cap and escalation.** An agent's send-back on an edge that already has `maxSendBacks` agent send-backs since the last board send-back on that edge is refused with 409 (`code: "send_back_cap_reached"`). The sending step is set to `blocked` with `unblockDescriptor: { owner: "board", action }`, where the action names the cap. That is the existing board-owned block item of the attention inbox (`blocker_attention`, "blocked issue has a human-owned unblockDescriptor"). The agent's comment is posted on the sending step, and the run records `outcome: "cap_reached"`. A board user may then send back again (that resets the edge's count, as human review decisions reset review rounds), or finish or cancel the step. Until then, an agent's send-back from a step with a board-owned block is refused with 409 and writes nothing, so a retrying agent cannot pile up comments or cap entries.
- **Surfaces.** OpenAPI for the route and the step fields; CLI `paperclipai issue send-back <issue> --to <stepKey> --body <text>` and the fields in `--steps-file`; UI: "Can send back to" and a round cap in the step editor, and a run panel on a step issue with every step's status, the send-back history and a "Send back" form for the board, read from `GET /issues/{id}/routine-step` (CLI `paperclipai issue routine-step <issue>`); the skill tells a step agent when and how to send work back.
- **Not in slice 1.** Sending back to a step of another run, a cancelled target, or automatic send-back from a result (slice 2).

### Slice 2: step outcome

- A step may declare `outcomes: string[]` (slugs, at most 10), for example `["confirmed", "not_reproduced"]`. Finishing such a step requires one of them; the result is stored on the run (`triggerPayload.routineSteps.outcomes[stepKey]`) and shown on the step.
- PR 3's `when` arrives on `after` entries: `{ key, when: ["confirmed"] }`. An edge is dead when its source finished with another outcome, was cancelled through a condition, or was skipped. A step whose incoming edges are all dead is cancelled with "Skipped: condition not met", and the rule repeats downstream, as PR 3 describes. Plain edges keep today's meaning.
- A `sendBackTo` entry may name an outcome: finishing `qa` with `not_fixed` performs the slice 1 send-back to `implement` with the finishing comment, under the same cap.

### Slice 3: a stalled run wakes its root once

- When a step is cancelled or skipped and `isRoutineStepRunStalled` says nothing else can move, the root's agent is woken once with `routine_steps_stalled`, the stalled and cancelled step keys in the payload, and an idempotency key derived from the run and its step statuses (a later, different stall wakes again).
- The root's agent may then close the root although steps are open (today 409), because the run cannot move. A small periodic backstop covers a lost wake.

### Slice 4: steps-run hint

- The heartbeat context of an issue carries its origin kind and those of its ancestors (`routine_execution`, `routine_step`), and for a steps run a summary: the run id, the root issue and per step its key, issue and status, plus counts of open, done and cancelled steps.
- An agent's preflight can then tell a steps root (blocked on its own steps by design) apart from real work in progress.

### Verify in production (each slice)

A `[qa-test]` routine in a test company runs implement, then qa, then a send back, then implement resuming the same session (`sessionIdBefore` of its second run equals the first run's session), then qa again, then done, within the cap. Test issues are cancelled and the test routine paused afterwards.

## Follow-ups (not scheduled)

- Read-only step stats per routine and step key (run count, duration, token cost, review rounds, changes-requested rate), derived from existing rows.
- Eval-based conditions, once company evals ship.

## Verification (PR 1)

- Unit: step validator (cycles, unknown `after`, duplicate keys, more than 25), layered order, stalled-run check, UI step helpers, CLI `--steps-file`.
- Integration (embedded Postgres): run task `blocked` with correct parent, blockers, statuses and origin; fork and join; only starting steps woken; atomic rollback with a failed run; coalesce, skip and always-enqueue; workspace handoff; event-triggered routine (new group gets steps, repeat adds none); a routine without steps behaves exactly as before.
- Surfaces: `openapi-routes.test.ts`, route permission tests, and a UI check in a real browser at desktop and mobile widths with no console errors.
- Full check: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, `pnpm check:token-gates`.

## Risks

- Migration numbering can collide with another open migration; renumber and regenerate.
- A run task left open keeps the routine "live" until it is done or cancelled, except a stalled run (see Dispatch, item 5).
- A rollback to a previous image runs a routine with steps as one plain task and cannot restore a revision that holds steps (see `doc/DATABASE.md`).
- Step wakes on the event path are queued after commit and are best effort; the stranded sweep recovers a lost wake.
- `routineSteps` and `targetIssueId` are reserved keys in a run's trigger payload: a caller's payload loses them, so a run without a task cannot pass for a run on a task.
- An `event_issue` trigger without a `created_by: "user"` filter also fires for tasks that agents create; the storm limiter is the only brake. The UI suggests the filter and warns without it.
- The start is synchronous in the task-create request. The work is small (one savepoint), but a slow attach slows that create; a failure never fails it.
