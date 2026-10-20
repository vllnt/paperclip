# Plan: Routine steps

Status: PR 1 (steps) implemented. PRs 2 and 3 are planned.

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
- `after`: `Array<string | { step, when }>`. PR 1 accepts only plain keys; the `when` form exists in the type and is rejected with "Step conditions (when) are not supported yet".

Validation: unique keys, `after` points at existing keys, no cycles, at most 25 steps, every step resolves to an agent (its own or the routine's; there are no unowned or user-owned steps because they would never be woken), agents and labels belong to the company. `{{variables}}` work through `interpolateRoutineTemplate`, and a variable that appears only in a step is added to the routine's variables.

### Storage

- `routines.steps jsonb not null default '[]'` (migration 0315, additive), also in routine revision snapshots.
- `routine_step` joins `ISSUE_ORIGIN_KINDS`.
- The run's `triggerPayload.routineSteps` stores `{ steps, stepIssueIds }`, so a run is self-contained and later edits do not change it.

### Dispatch

`attachRoutineSteps` in `server/src/services/routine-steps.ts` is the single function that builds the graph. `dispatchRoutineRun` and the event dispatcher (for a new event group) both call it. Repeat, recovery and append events never attach steps.

1. The run's task and all steps are created inside one savepoint of the dispatch transaction, before any wake. A failure rolls the savepoint back and the existing failed-run handling records the run. No issue is left behind.
2. The run's task is created `blocked` and is not woken. It is woken once by the existing wakes after the last step.
3. Steps are created in dependency order through `createChild(root.id, ..., tx)`: `blockParentUntilDone`, blockers from `after`, `todo` without `after` and `blocked` otherwise, idempotency key `routine-run:{runId}:{stepKey}`, `originKind: "routine_step"`.
4. After commit, only the steps without predecessors are woken.
5. For a routine with steps, an open, visible run task of an earlier run counts as live for `skip_if_active` and `coalesce_if_active`.
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

## PR 2: start on a created task (planned)

No new trigger kind. The existing `event` trigger does the work: `eventMatch`, grouping, the `event_deliveries` ledger, the storm limiter and the trigger UI, API and CLI already exist.

- A built-in Paperclip event source per company, created lazily, with no secret and no ingress URL. For `issue.created` it publishes a normalized event whose labels `eventMatch` can filter (project, creator, issue labels).
- A producer entry point on `eventSourceService` that reuses routing, the ledger and dispatch, but not HTTP auth. The issue-create routes call it synchronously before the assignment wake, so a task that gets steps never starts its own run first.
- `issueMode: "event_issue"` on triggers of the built-in source: the event's subject issue is the root, and `attachRoutineSteps` attaches steps to it in a savepoint.
- The root is set to `blocked` only when an agent owns it; otherwise only the blocker edges are added. On failure only the steps created for this run are removed; the user's task is never deleted.
- Manual equivalent for parity: `targetIssueId` on `POST /routines/:id/run` and "Run routine on this task" on the issue page. A target that is not backlog, todo or blocked without a live run returns 409.
- Guards: idempotency key `issue:{issueId}`, refuse when the root already has open `routine_step` children, skip issues of origin `routine_execution` or `routine_step`, count existing children against the 25 cap.

## PR 3: conditions (planned)

- A step's outcome is its terminal status, `done` or `cancelled`. A reviewer asking for changes does not end a step; only a board cancel does.
- An edge is dead when its `when` does not match its source's outcome, or its source was skipped. A step whose incoming edges are all dead is cancelled with "Skipped: condition not met", and the rule repeats downstream. Plain edges from a cancelled step are not dead, so a human cancel never silently cascades.
- Skipped steps are removed from every blocker set in the run, then `issue_blockers_resolved` wakes go out for steps that became ready.
- A reconcile action runs when a `routine_step` issue reaches a terminal status, with a small periodic backstop. Reconcile is idempotent: it locks the root and re-derives everything from `triggerPayload.steps` and current statuses.
- `when` is allowed only on `after` entries; the editor warns about a step that would always be skipped.

## Follow-ups (not scheduled)

- Read-only step stats per routine and step key (run count, duration, token cost, review rounds, changes-requested rate), derived from existing rows.
- Eval-based conditions, once company evals ship.

## Verification (PR 1)

- Unit: step validator (cycles, unknown `after`, duplicate keys, more than 25, conditions rejected), topological order, UI step helpers, CLI `--steps-file`.
- Integration (embedded Postgres): run task `blocked` with correct parent, blockers, statuses and origin; fork and join; only starting steps woken; atomic rollback with a failed run; coalesce, skip and always-enqueue; workspace handoff; event-triggered routine (new group gets steps, repeat adds none); a routine without steps behaves exactly as before.
- Surfaces: `openapi-routes.test.ts`, route permission tests, and a UI check in a real browser at desktop and mobile widths with no console errors.
- Full check: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, `pnpm check:token-gates`.

## Risks

- Migration numbering can collide with another open migration; renumber and regenerate.
- A run task left open keeps the routine "live" until it is done or cancelled.
- Step wakes on the event path are queued after commit and are best effort; the stranded sweep recovers a lost wake.
- `routineSteps` is a reserved key in a run's trigger payload.
