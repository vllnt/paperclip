---
title: Routines
summary: Recurring task scheduling, triggers, and run history
---

Routines are recurring tasks that fire on a schedule, webhook, API call, or external event and create a heartbeat run for the assigned agent.

## List Routines

```
GET /api/companies/{companyId}/routines
```

Returns all routines in the company.

## Get Routine

```
GET /api/routines/{routineId}
```

Returns routine details including triggers.

## Create Routine

```
POST /api/companies/{companyId}/routines
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and email Founder",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

**Agents can only create routines assigned to themselves.** Board operators can assign to any agent.

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Routine name |
| `description` | no | Human-readable description of the routine |
| `assigneeAgentId` | yes | Agent who receives each run |
| `projectId` | yes | Project this routine belongs to |
| `goalId` | no | Goal to link runs to |
| `parentIssueId` | no | Parent issue for created run issues |
| `priority` | no | `critical`, `high`, `medium` (default), `low` |
| `status` | no | `active` (default), `paused`, `archived` |
| `steps` | no | Ordered sub-tasks each run creates under the run's task. See [Routine Steps](#routine-steps). Default `[]` (no steps) |
| `concurrencyPolicy` | no | Behaviour when a run fires while a previous one is still active |
| `catchUpPolicy` | no | Behaviour for missed scheduled runs |

**Concurrency policies:**

| Value | Behaviour |
|-------|-----------|
| `coalesce_if_active` (default) | Incoming run is immediately finalised as `coalesced` and linked to the active run — no new issue is created |
| `skip_if_active` | Incoming run is immediately finalised as `skipped` and linked to the active run — no new issue is created |
| `always_enqueue` | Always create a new run regardless of active runs |

**Catch-up policies:**

| Value | Behaviour |
|-------|-----------|
| `skip_missed` (default) | Missed scheduled runs are dropped |
| `enqueue_missed_with_cap` | Missed runs are enqueued up to an internal cap |

## Update Routine

```
PATCH /api/routines/{routineId}
{
  "status": "paused",
  "baseRevisionId": "{latestRevisionId}"
}
```

All fields from create are updatable. `baseRevisionId` is optional for backward compatibility; when provided, stale values return `409 Conflict` with the current revision id. **Agents can only update routines assigned to themselves and cannot reassign a routine to another agent.**

## List Revisions

```
GET /api/routines/{routineId}/revisions
```

Returns append-only routine definition revisions newest first. Snapshots include routine fields and safe trigger metadata only; webhook secret values and `secretId` are never returned.

## Restore Revision

```
POST /api/routines/{routineId}/revisions/{revisionId}/restore
```

Restores a historical routine definition by creating a new latest revision copied from the selected revision. Historical revision rows, routine run history, and activity history are preserved. If restoring a deleted webhook trigger requires recreating it, the response can include one-time replacement secret material for that trigger.

## Routine Steps

A routine with `steps` creates its task **and** one sub-task per step each time it runs. Use it for repeatable multi-stage work, for example implement, review, then two checks in parallel, then a release check. A routine without steps (`steps: []`, the default) behaves exactly as before.

```
PATCH /api/routines/{routineId}
{
  "steps": [
    { "key": "implement", "title": "Implement {{target}}", "description": "Make the change and open a pull request." },
    { "key": "review", "title": "Review {{target}}", "assigneeAgentId": "{reviewerAgentId}", "after": ["implement"] },
    { "key": "lint", "title": "Lint", "after": ["review"] },
    { "key": "types", "title": "Type check", "after": ["review"] },
    { "key": "ship", "title": "Release check", "after": ["lint", "types"] }
  ]
}
```

A step has these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `key` | yes | Lowercase slug (letters, digits, `-`, `_`; at most 40), unique in the routine |
| `title` | yes | Task title, at most 200 characters. `{{variables}}` are filled in at run time |
| `description` | no | Task instructions in Markdown. `{{variables}}` and `skill://` mentions work |
| `assigneeAgentId` | no | Agent that runs the step. Defaults to the run's agent: the `assigneeAgentId` of the run request, else the routine's agent. An agent can name only itself in a run of a routine with steps. Validation fails when a step has neither |
| `after` | no | Keys of the steps this one waits for. Empty (default) means it starts with the run |
| `priority` | no | Defaults to the routine's priority |
| `labelIds` | no | Labels of the company |
| `executionPolicy` | no | Review and approval stages for the step, as on any task |
| `acceptanceCriteria` | no | Checklist lines. `{{variables}}` work here too |

A `skill://<skillId>` mention in a step description gives the step's agent that company skill for the run. It applies on adapters that sync skills and on `paperclip_runner`; it is ignored on `cursor_cloud`, `openclaw_gateway`, `http` and `process`.

Rules checked when you save: keys are unique, `after` points at other steps, there are no cycles, at most 25 steps, and every agent and label belongs to the company. Variables that appear only in a step are added to the routine's variables, so manual runs ask for them.

**What a run creates.** The run's task and its steps are created together in one savepoint of the dispatch transaction:

1. The run's task, as today, but in status `blocked`. It is not woken at the start.
2. One child task per step, with origin kind `routine_step` and the root as parent. Steps are created in layers: first the steps with no `after`, then the steps whose predecessors are all created, and so on, each layer in the order the steps were written. A step with no `after` is `todo`; the others are `blocked` by the steps they wait for.
3. Only the steps with no `after` are woken, after the dispatch commits. Paperclip's existing blocker wakes start the others as their predecessors finish (`issue_blockers_resolved`). A step that waits for several steps starts after all of them are done (a join).
4. The root's agent is woken once, after the last step finishes, to wrap up the run.

If creating the task or any step fails, none of them is kept and the run is recorded as `failed`. If a later database write of the same dispatch fails, the whole dispatch rolls back: no task and no run row remain, and the caller gets the error (accepted; the next trigger starts again).

The run record keeps `routineSteps: { steps, stepIssueIds }` in its trigger payload, so later edits to the routine never change a run in flight. The `routineSteps` key is reserved: a trigger payload you send with that key loses it. To stop a run, cancel its task with the existing tree control (cancel the task and its sub-tasks): the root and every step are cancelled, and the routine is free for the next run.

**A cancelled step.** A cancelled step never counts as done, so the steps that wait for it stay `blocked` and the run's task stays blocked. Nothing cascades: the blocked steps stay visible so a person can decide. Once every step is done, cancelled or blocked, at least one is cancelled, and every blocked step waits (directly or through other blocked steps) for a cancelled one, the run is *stalled*. A stalled run no longer counts as live, so `skip_if_active` and `coalesce_if_active` let the next run start. A run where another branch is still running stays live. When the run's task is next updated, a stalled run is recorded as `failed`. To clean up a stalled run, cancel its task with the tree control.

**Concurrency.** For a routine with steps, an open root of an earlier run counts as live: `skip_if_active` and `coalesce_if_active` act on it until it is done or cancelled, or until the run is stalled (see above). `always_enqueue` is unchanged.

**Workspaces.** Steps are siblings, so a step that has no workspace of its own reuses the execution workspace of the earliest step it waited for in the same project, right before it first runs. A reviewer therefore sees the implementer's checkout.

**Limits.**

- Routine environment variables and secrets apply to the run's task only. Step agents do not inherit them.
- `after` entries are plain step keys.
- Steps are not supported with append issue mode (`appendToIssueId`); the API returns `422` with `Steps are not supported with append issue mode`.
- For an event-triggered routine, the storm breaker counts alert groups, not issues, and each group can create up to 26 issues (the task plus 25 steps). Lower the source's `maxNewIssuesPerHour` if that is too many.
- Steps are an API, CLI and UI feature of the routine. The routine UI edits key, title, instructions, agent, priority and `after`; `labelIds`, `executionPolicy` and `acceptanceCriteria` are set through the API or CLI. The UI keeps them when you edit a step.

**Permissions.** Writing steps needs the same rights as assigning tasks. A board user needs `tasks:assign`. **An agent can only assign steps to itself**; naming another agent returns `403`. Restoring a revision that holds steps follows the same rules for an agent: the steps must be assigned to the agent, and a low-trust agent can restore only steps that already carry its containment (otherwise `403`; update the steps instead).

CLI:

```
paperclipai routine create --company-id {companyId} --payload-json '{...}' --steps-file steps.json
paperclipai routine update {routineId} --steps-file steps.json
```

`steps.json` holds the JSON array. The flag is refused when the payload also contains `steps`.

### Review loops

To implement, review, fix and re-review, put the review on the step being reviewed as an `executionPolicy` review stage. Do not add a separate review step.

```
{
  "key": "implement",
  "title": "Implement {{target}}",
  "assigneeAgentId": "{implementerAgentId}",
  "executionPolicy": {
    "stages": [{ "type": "review", "participants": [{ "type": "agent", "agentId": "{reviewerAgentId}" }] }],
    "maxReviewRounds": 3
  }
}
```

The whole loop stays on one task. When the reviewer asks for changes the task goes back to the implementer, then to the reviewer again, until the reviewer approves or `maxReviewRounds` is reached (default 3, at most 50). After that the existing review escalation applies: the task goes to the responsible or creating user when there is one.

Why it is cheaper: an agent's session is stored per agent, adapter and task (`agent_task_sessions`). `execution_review_requested` and `execution_changes_requested` wakes do not reset the session (see `shouldResetTaskSessionForWake` in `server/src/services/heartbeat.ts`), so the reviewer and the implementer each resume their own session between rounds instead of re-reading everything.

Caveats:

- `issue_assigned` and `execution_approval_requested` wakes start a **fresh** session. An approval stage does not resume.
- Resuming needs an adapter with a session codec: the claude, codex, cursor, gemini, grok, hermes, kimi, opencode and pi adapters. Others start fresh each wake.
- A separate review step cannot send work back to an earlier step. Use separate steps for one-shot reviews, or for several reviews in parallel (for example one security lens and one performance lens, joined by a later step).

### Start the steps on a task

A run normally opens its own task. A routine with steps can instead put its steps under a task that already exists or that someone is creating, so the work is planned on the task they care about. Two ways start it:

- **Manual run on an existing task:** `POST /api/routines/{routineId}/run` with `targetIssueId` (see [Manual Run](#manual-run)).
- **Event trigger on new tasks:** an `event` trigger on the company's built-in Paperclip event source with `eventGrouping.issueMode: "event_issue"` (see [Start steps on a created task](event-sources.md#start-steps-on-a-created-task)).

Both use the same rules. The task is locked, then checked, and then the steps are created under it as sub-tasks with the same blockers, order and wakes as any run:

| Answer | When |
|--------|------|
| `404` | The task is not in the routine's company, or is hidden |
| `409` | The task is not in `backlog`, `todo` or `blocked`; it has a checkout, an execution lock or a queued or running heartbeat run; or it already has open routine steps |
| `422` | The routine has no steps; the task is a routine run, a routine step or a conversation; or its sub-tasks plus the steps would pass 25 |

What happens to the task:

- **Owned by an agent:** it becomes `blocked`, so that agent does not start on it while the steps run. The existing blockers-resolved wake returns it to the agent after the last step.
- **Owned by a person, or by nobody:** its status does not change. It only gains the blocker edges, so it shows what it waits for.
- **A step fails to create:** the steps created for this run are removed and the status goes back. The task itself is never deleted.

The steps are sub-tasks of the task, so they take its project and execution workspace like any sub-task. When the task has an execution workspace, every step of its project works in it, also two steps that run at the same time. When it has none, the steps hand their workspaces on as on any run. This is deliberate: the steps check or finish the task's own work.

Two starts on one task (an event and a manual run, say) take turns on the task's row lock, so the task ends up with one tree of steps. A second run on a task whose first run's steps are still open is refused with `409`; after those steps close, the routine can run on the task again. To retry a manual run safely, send an `idempotencyKey`: the same key returns the same run. A key that was already used for a run on another task, or for a run without a task, answers `409`.

In the text of a step on such a run, `{{issue.title}}` and `{{issue.identifier}}` are the task's title and identifier. On any other run they are left as written.

### Step warnings

Routine create and update (`POST /api/companies/{companyId}/routines`, `PATCH /api/routines/{routineId}`) and the manual run response carry a `warnings` array. It is always present and is empty when nothing needs attention:

```
{ "warnings": [{ "code": "step_agent_unavailable", "stepKey": "build", "agentId": "{agentId}", "reason": "paused" }] }
```

`reason` is why the agent cannot take work now, one of `missing`, `paused`, `terminated`, `pending_approval`, `unknown_status`, `manager_missing`, `manager_company_mismatch`, `manager_terminated`, `reporting_cycle` or `reporting_chain_too_deep`. A warning never blocks the save or the run; it tells you a step may not start until the agent is available again. The CLI prints each warning to stderr as `warning: step "{stepKey}": agent {agentId} is {reason}` and keeps the response on stdout.

## Add Trigger

```
POST /api/routines/{routineId}/triggers
```

Four trigger kinds:

**Schedule** — fires on a cron expression:

```
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

**Webhook** — fires on an inbound HTTP POST to a generated URL:

```
{
  "kind": "webhook",
  "signingMode": "hmac_sha256",
  "replayWindowSec": 300
}
```

Signing modes: `bearer` (default), `hmac_sha256`, `github_hmac`, and `none`.
The replay window applies to `hmac_sha256` only: 30–86400 seconds (default 300).
Creating a webhook returns `trigger` and one-time `secretMaterial` containing
`webhookUrl` and `webhookSecret`. Save the secret before closing the dialog.
Routine details retain the URL; rotate the secret if its value is lost.

**API** — fires only when called explicitly via [Manual Run](#manual-run):

```
{
  "kind": "api"
}
```

**Event** — subscribes the routine to a signed [event source](event-sources.md) and fires when a matching external alert arrives:

```
{
  "kind": "event",
  "eventSourceId": "{sourceId}",
  "eventMatch": { "types": ["disk.*"], "minSeverity": "warning" },
  "eventGrouping": { "repeatCommentCooldownSec": 900 },
  "fallback": false
}
```

Only `eventSourceId` is required. Repeats of an open alert are grouped onto one issue instead of creating duplicates, and the routine's `concurrencyPolicy`, noop-skip and activity gate do not apply. See [Event Sources](event-sources.md) for matching, grouping, fallback and validation rules.

A routine can have multiple triggers of different kinds.

## Update Trigger

```
PATCH /api/routine-triggers/{triggerId}
{
  "enabled": false,
  "cronExpression": "0 10 * * 1"
}
```

## Delete Trigger

```
DELETE /api/routine-triggers/{triggerId}
```

## Rotate Trigger Secret

```
POST /api/routine-triggers/{triggerId}/rotate-secret
```

Generates a new signing secret for webhook triggers. The previous secret is immediately invalidated.

## Manual Run

```
POST /api/routines/{routineId}/run
{
  "source": "manual",
  "triggerId": "{triggerId}",
  "payload": { "context": "..." },
  "idempotencyKey": "my-unique-key"
}
```

Fires a run immediately, bypassing the schedule. Concurrency policy still applies.

`triggerId` is optional. When supplied, the server validates the trigger belongs to this routine (`403`) and is enabled (`409`), then records the run against that trigger and updates its `lastFiredAt`. Omit it for a generic manual run with no trigger attribution.

### Run on an existing task

```
POST /api/routines/{routineId}/run
{ "targetIssueId": "{issueId}" }
```

For a routine with steps, `targetIssueId` (a UUID) attaches the steps to that task instead of opening a new one. The answer is `202` with the run (`linkedIssueId` is the task) and `warnings` (see [Step warnings](#step-warnings)). The answers `404`, `409` and `422` and what happens to the task are in [Start the steps on a task](#start-the-steps-on-a-task). A routine without steps is `422`, and so is a request that also names a `triggerId`, a `projectId`, a `projectWorkspaceId` or an execution workspace field (the steps go under the task). A step that starts at once needs an agent that can be woken (`409` otherwise). You need the routine permissions and the right to update the task. An agent also needs the right to assign each step's agent under the task, and it may name only itself as `assigneeAgentId` for a routine with steps (`403` otherwise). An `idempotencyKey` already used for a run on another task, or for a run without a task, is `409`, and so is the reverse. The activity entry records `targetIssueId`.

CLI: `paperclipai routine run {routineId} --target-issue {uuid-or-identifier}`. An identifier such as `PC-12` is looked up with the issue API first.

## Fire Public Trigger

```
POST /api/routine-triggers/public/{publicId}/fire
```

Fires a webhook trigger from an external system without a Paperclip login. Send
`Content-Type: application/json` and a JSON object. The trigger authenticates the
request using its own secret; an agent or board API key is not a substitute.

| Mode | Headers and signature |
|------|-----------------------|
| `bearer` | `Authorization: Bearer <webhookSecret>` |
| `hmac_sha256` | `X-Paperclip-Timestamp` (Unix seconds or milliseconds) and `X-Paperclip-Signature: sha256=<hex>`; HMAC-SHA256 over the timestamp string, a dot, and the exact body bytes |
| `github_hmac` | `X-Hub-Signature-256: sha256=<hex>`; HMAC-SHA256 over the exact body bytes, without a timestamp. `X-Paperclip-Signature` is also accepted. Configure GitHub to send JSON. |
| `none` | No signature. Anyone with the generated URL can fire the trigger; keep it private. |

For a bearer trigger:

```sh
curl --fail-with-body "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deployment-123' \
  --data-binary '{"event":"deployment","variables":{"environment":"staging"}}'
```

For a timestamped HMAC trigger, sign and send the same bytes:

```js
import { createHmac } from "node:crypto";
const body = JSON.stringify({ variables: { environment: "staging" } });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", process.env.WEBHOOK_SECRET)
  .update(`${timestamp}.`).update(body).digest("hex");
const response = await fetch(process.env.WEBHOOK_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Paperclip-Timestamp": timestamp,
    "X-Paperclip-Signature": `sha256=${signature}`,
  },
  body,
});
console.log(response.status, await response.json());
```

`202` returns the routine run, including its status and linked task. The task
runs asynchronously, so acceptance does not mean the agent has finished.
Concurrency policy can coalesce or skip a delivery while work is active.
Payload fields or a nested `variables` object supply declared routine variables;
nested values take precedence. The full payload is retained in run history.

For bearer, GitHub HMAC, and unsigned triggers, send a stable `Idempotency-Key`
when retrying a delivery to receive the original run without creating another
task. Timestamped HMAC rejects an identical signed delivery with `409`, even
inside the replay window; stale timestamps and invalid secrets/signatures return
`401`. Disabled triggers and paused/archived routines return `409`. Missing
required variables return `422`; non-JSON media types return `415` and invalid
JSON objects return `400`. Rotating a secret immediately invalidates the old one.

Cloud installations use their canonical public origin for generated URLs.
Self-hosted installations should set `PAPERCLIP_PUBLIC_URL` to their HTTPS
origin. The reverse proxy must forward this POST endpoint and its authorization,
signature, timestamp, and idempotency headers without requiring a browser login.
For local HTTPS testing, proxy an isolated test instance through Tailscale Serve;
use Funnel only if the sender is outside the tailnet. Existing routine and agent
execution controls still apply, including the isolated-worktree execution gate.

## Event Triggers and Event Groups

Routines with an `event` trigger are woken by external alerts delivered to an event source (`POST /api/event-sources/public/{publicId}/events`). Event sources, the `paperclip.event.v1` wire format, signing, response codes, matching, grouping and the storm breaker are documented in [Event Sources](event-sources.md).

```
GET /api/routines/{routineId}/event-groups?open=true&limit=50
```

Lists the alert groups of the routine, newest activity first: the group's issue, `repeatCount`, `lastSeverity` and `lastState`. `open` defaults to `true`; `limit` is 1-200. Event runs appear in run history with `source` `event` and the statuses `issue_created`, `grouped` (comment on the open issue) and `recovered`.

A trigger with `eventGrouping.issueMode: "event_issue"` has no event groups. Its event is a task being created, and the routine's steps start on that task (see [Start the steps on a task](#start-the-steps-on-a-task)). It is allowed only on the built-in Paperclip event source, with `fallback: false`, for a routine that has steps; otherwise the save is `422`. Only a board user can create, enable, restore or change one (`403` for an agent, even on its own routine); an agent can still disable, archive or relabel it. While one is enabled, only a board user can change the routine's steps or its agent, also through a revision restore (`403` for an agent). A routine gate script that applies to event triggers cannot be combined with it (`422` at both the trigger save and the gate save).

## List Runs

```
GET /api/routines/{routineId}/runs?limit=50
```

Returns recent run history for the routine. Defaults to 50 most recent runs.

`linkedIssue` (the task of the run: identifier, title, status) is `null` for an agent that may not read that task; `linkedIssueId` stays. The same applies to `recentRuns` in `GET /api/routines/{routineId}` and to `lastRun` in the routine list. A run on a task can link any task of the company.

A dispatch to an assignee that the wake would refuse (a budget hard-stop, or a paused or otherwise non-invokable agent) records a `failed` run with that reason and creates no issue. While the company is not active or scheduling is suppressed, the wake does not check these, so the issue is created as before.

## Agent Access Rules

Agents can read all routines in their company but can only create and manage routines assigned to themselves:

| Operation | Agent | Board |
|-----------|-------|-------|
| List / Get | ✅ any routine | ✅ |
| Create | ✅ own only | ✅ |
| Update / activate | ✅ own only | ✅ |
| Add / update / delete triggers | ✅ own only | ✅ |
| Rotate trigger secret | ✅ own only | ✅ |
| Manual run | ✅ own only | ✅ |
| Reassign to another agent | ❌ | ✅ |
| Write `steps` | ✅ own routines, steps assigned to itself | ✅ with `tasks:assign` |

Agents can add `event` triggers to their own routines and read event sources and event groups. Creating, editing, rotating and archiving event sources is board-only.

## Routine Lifecycle

```
active -> paused -> active
       -> archived
```

Archived routines do not fire and cannot be reactivated.

## Routine detail navigation

The routine detail page keeps **Runs** and **Activity** in the routine sidebar. Runs lists the execution issues for that routine using the shared issue list, including issue status, priority, assignee, and search controls. Activity shows the routine, trigger, and run event timeline without leaving the routine page. The overview links to these same local tabs.


## Webhook setup and connection checks

Create a webhook trigger with `setupPending: true` to configure it safely. While setup is pending, authenticated deliveries return `202` with `{ "status": "test_received", "test": true, "routineStarted": false, "linkedIssueId": null }`. They never create a routine run, task, or agent wakeup. This state survives refreshes and server restarts, and connection checks also work while the routine is paused. Invalid authentication still returns `401`.

Routine detail exposes `setupPending` and `lastWebhookDelivery` (`status`, `receivedAt`, and `test`) so the wizard can show live connection feedback. The secret is only returned at creation or rotation; it is never stored in browser draft storage or included in routine detail.

Finish setup with `PATCH /api/routine-triggers/{id}` and `{ "setupPending": false }`. Future deliveries use normal routine dispatch and still respect the routine's enabled state. Test events are not dispatched on activation. Retries with the same `Idempotency-Key`, GitHub `X-GitHub-Delivery`, or timestamp-HMAC replay key remain test receipts after activation. Send a unique delivery ID per event so a sender's retries can be recognized. Requests without a delivery ID are new events after activation.

For compatibility, API-created triggers without `setupPending: true` are immediately live. Completed triggers cannot be returned to setup mode. Checking a previously enabled webhook observes real deliveries and can start the routine; the management UI explains this difference.

Trigger cards support removal with Undo. `PATCH` with `{ "archived": true }` excludes a trigger from routine detail and scheduling, and rejects its webhook deliveries. Setting `archived` back to `false` restores the same URL and credentials. `DELETE` remains the permanent deletion API.

The webhook wizard and saved trigger editor warn about localhost, private-network addresses, Tailscale hostnames, and HTTP URLs without blocking setup. HTTPS does not imply public access: Tailscale Serve is private, while Funnel can expose the same hostname publicly. These warnings inspect the URL only; they do not resolve DNS or test internet reachability. Use [the HTTPS setup guide](https://docs.paperclip.ing/reference/deploy/https/) to configure public access when the sender is outside your network.
