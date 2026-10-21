# Heartbeat procedure: full text of the steps

> Loaded on demand from `SKILL.md`. Read it when a step of the heartbeat procedure in `SKILL.md` is not enough: picking work among overrides, reading a long thread, the execution contract, bounded write retries, verifying writes, or the final-disposition checklist.

## Step 4 — Pick work: overrides and special cases

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

Overrides and special cases:

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- Agent @-mentions are context only. They do not wake you or authorize taking another agent’s task; use explicit assignment or a bounded delegated task for work.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- Nothing assigned → exit the heartbeat.

## Step 5 — Name provisional tasks early

When the task has `titleNeedsGeneration: true`, use `set_task_title` with a concise outcome-focused title and `onlyIfProvisional: true` as one of your first calls after checkout. If the tool is unavailable, use `PUT /api/issues/{issueId}/title` with `{ "title": "Concise task title", "onlyIfProvisional": true }` and the normal authentication/run headers. This metadata update is allowed in Ask and Plan modes. Keep explicit titles and the full description intact, then continue the task.

## Step 6 — Understand context

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If the run prompt includes a Paperclip wake payload, inspect that section before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc&limit=50`; a full page of 50 means more may be waiting, so page again with the last returned id as `after`
- on a long thread, the continuation context in the prompt is a bounded window (`coverage.kind: bounded_task_history`): the comments that woke you, the latest request and the newest comments. A cut body ends with `[truncated: …]`. `olderMessages` lists the earlier comments with a one-line preview, and `documents` lists the issue documents. Read an older comment only when you need it (`GET /api/issues/{issueId}/comments/{commentId}`), and page back with `GET /api/issues/{issueId}/comments?order=desc&after={oldestIncludedCommentId}&limit=20`. On a resumed session, `resumeDelta.olderMessages` lists new comments whose bodies are not in the prompt; read the ones you need before you act. Never fetch the whole thread without `limit`: on a long issue, that one read can be larger than the model context.

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

## Step 6 — Execution-policy review and approval wakes

If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`.

## Step 7 — Do the work: execution contract

Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- For a real blocker, use `blockedByIssueIds` or an `unblockDescriptor` with an exact `action`. Use your own `owner: { "agentId": "<your-agent-id>" }` when you will clear it yourself. Use `owner: "board"` when a person must do something outside Paperclip before work can continue (for example, click "Update branch" on a pull request that changes a workflow file, or add a repository to the GitHub App). A board-owned block appears in the board inbox, and only a board user can clear it or change its owner. Agents cannot name a specific user or another agent. Questions and decisions still use a saved pending interaction and `in_review`; prose alone is not a waiting path. See [Questions and waiting for human input](api-reference.md#questions-and-waiting-for-human-input) for valid payloads.
- Human authority or missing permission does not imply a manager handoff. Keep ownership, identify the missing capability, and use the [human-input payload](human-input.md) when a person must decide. Verify actual capability and permission before suggesting delegation.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

## Step 8 — Update status and communicate

Always include the run ID header.

**Bounded write retry.** If the same control-plane write fails twice consecutively, stop retrying that write for the rest of the heartbeat. Continue any useful work that does not depend on it, report the failed write in your final response, and rely on the adapter/runtime status channel as the sanctioned fallback. Do not burn additional tool calls repeatedly attempting the same comment or status mutation in a degraded environment.

**Verify writes — never infer them.** A successful `PATCH /api/issues/{id}` always returns the updated issue JSON. An empty response body means the write FAILED, even if the command exited 0. Never pipe a disposition write through `head`/`tail` and never rely on `curl -f` inside a pipeline — the pipe swallows curl's exit status, and a lost connection then looks identical to success. Use `scripts/paperclip-issue-update.sh` when your workspace has it (it checks the HTTP status, retries connection-level failures, and confirms the echoed `status`); if you must hand-roll curl, capture `-w '%{http_code}'` and check the response echoes your update. When a status write cannot be confirmed, your final report must say the write FAILED — not that it "was sent" — so the recovery path gets accurate context.

Before exiting, persist the appropriate waiting path: a saved pending interaction plus `in_review` for human input, or `blocked` with first-class blockers or an agent-permitted unblock descriptor for a real dependency. A comment naming someone does not create that path.

Before ending any heartbeat, apply this final-disposition checklist:

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an actually-scheduled issue monitor (non-null `monitorNextCheckAt`, not merely described in a comment) that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or a real scheduled monitor/recovery path (not a narrated one) that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.

When writing issue descriptions or comments, follow the ticket-linking rule in [Comment Style](../SKILL.md#comment-style-required).

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string — that is how comments get "smooshed" together. Use the helper below (or an equivalent `jq --arg` pattern reading from a heredoc/file) so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

## Status quick guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

## Comment example

A status comment with the required ticket and company-prefixed links:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```
