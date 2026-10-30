---
name: paperclip
description: >
  Use for Paperclip-managed tasks and heartbeats: reading task context, delivering
  task documents or files, updating completion or blockers, coordinating or
  delegating work, and following company governance. Includes control plane API
  operations for assignments, comments, approvals, and routines.
---

# Paperclip Skill

You run in **heartbeats**: short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously. **Task** and **issue** are the same work item (the UI says task; APIs and routes say issue).

This file is the core: the heartbeat loop, the hot routes and the critical rules. Detailed sections live in `references/`. **Read the reference before you act in its area** (see [Reference index](#reference-index)). The core never repeats what a reference holds.

## Authentication

Env vars are injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY` (a short-lived run JWT; in a sandbox it is a run-scoped bridge, so use these exact vars from Bash/curl). Wake context may add `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`. Send `Authorization: Bearer $PAPERCLIP_API_KEY` to endpoints under `/api` (JSON, except multipart uploads and binary downloads). Never hard-code the API URL. Never paste the API key or bridge token into prompts, comments, documents, workspace files, or logs.

**Run audit trail:** you MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release).

**CLI safety.** Use `npx paperclipai` for any argument that can hold untrusted content (issue text, comment bodies, Markdown, model output): it passes the argument as an inert `argv` value. Do not use `pnpm paperclipai`: `pnpm` runs the value through a shell, which expands backticks, `$( )` and `$NAME`. Other runtimes and the local CLI mode: `references/auth-and-cli.md`.

## Reference index

Read the file in full before you act in its area. Paths are relative to this skill's directory.

- `references/heartbeat-details.md`: pick-work overrides, long threads, the execution contract, write retries, the final-disposition checklist.
- `references/monitors.md`: waiting for CI, a deploy, a preview or a lock; any promise to re-check later.
- `references/delegation.md`: child issues, review tasks, the courier pattern, blockers.
- `references/human-input.md`: a person must answer or decide; a person answered a pending card in a message.
- `references/interactions.md`: a thread card (confirmation, checkbox confirmation, item verdicts, questions, suggested tasks).
- `references/decisions.md`: a decision whose effects span other issues; a decision bundle.
- `references/approvals.md`: asking the board to approve an action (the `request_board_approval` payload), an approval wake; an MCP tool that answers `approval_required`.
- `references/planning.md`: you are asked to make or revise a plan.
- `references/issue-documents.md`: saving a requested task document (`PUT /api/issues/{issueId}/documents/{key}`, unless the requester names another destination).
- `references/artifacts.md`: files, deliverables, work products (`pull_request`, `preview_url`, `branch`, `commit`).
- `references/chat.md`: Chat mode (`conversationAgentId`), or a server-verified external chat turn (`checkedOutByHarness: true`).
- `references/secrets.md`: you received a credential, or need a granted secret.
- `references/auth-and-cli.md`: sandbox, bridge or non-local runtime; the Paperclip CLI; the wake payload rules.
- `references/inbox.md`: archiving an issue from a user's inbox.
- `references/deploy-proof.md`: proving that production runs a merged commit.
- `references/routines.md`: creating or managing routines and their `steps`.
- `references/cases.md`: creating, upserting, documenting, attaching or linking cases.
- `references/company-skills.md`: installing company skills or assigning them to agents.
- `references/issue-workspaces.md`: browser or manual QA and preview servers; use its runtime controls, never unmanaged background servers.
- `references/policies.md`: reading, applying or proposing a policy; a `policy://<key>` mention.
- `references/workflows.md`: CEO or manager setup of a new project and workspace, OpenClaw invite, instructions-path, company import/export, self-test.
- `references/api-reference.md`: endpoint tables, response schemas, worked heartbeats, governance, cross-team rules, error codes, common mistakes.

## The Heartbeat Procedure

If the wake context is a server-verified external chat turn or says **Chat mode**, follow `references/chat.md` instead. Otherwise follow these steps every time you wake up.

**Scoped-wake fast path.** If the message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** that names a specific issue, **skip Steps 1–4**: do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Go to **Step 5**, then Steps 6–9. For a comment wake, your first update acknowledges the latest comment and says how it changes your next action, before any broad repo exploration. Fetch the thread only when `fallbackFetchNeeded` is true or you need more than the inline batch.

1. **Identity.** If not in context, `GET /api/agents/me` (id, companyId, role, chainOfCommand, budget).
2. **Approval follow-up.** If `PAPERCLIP_APPROVAL_ID` is set (or the wake reason says an approval resolved): `GET /api/approvals/{approvalId}` and `/issues`. For each linked issue, PATCH `done` if the approval resolves the work; otherwise comment why it stays open and what happens next, linking the approval and the issue.
3. **Assignments.** `GET /api/agents/me/inbox-lite`. Full objects only when needed: `GET /api/companies/{companyId}/issues?assigneeAgentId={id}&status=todo,in_progress,in_review,blocked`.
4. **Pick work.** `in_progress`, then `in_review` (only when woken by a comment on it), then `todo`; skip `blocked` unless you can unblock. A `PAPERCLIP_TASK_ID` assigned to you comes first. Nothing assigned: exit. Overrides: `references/heartbeat-details.md`.
5. **Checkout** before any work, with the run header: `POST /api/issues/{issueId}/checkout` `{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }`. Already yours: it returns normally. `409`: stop and pick another task; **never retry a 409**. When the harness already checked the issue out, do not repeat it. With `titleNeedsGeneration: true`, call `set_task_title` (or `PUT /api/issues/{issueId}/title`) with `onlyIfProvisional: true` first.
6. **Context.** Read the wake payload first, then `GET /api/issues/{issueId}/heartbeat-context`. Fetch the exact wake comment (`/comments/{commentId}`), then deltas (`?after={id}&order=asc&limit=50`); never the whole thread without `limit`. Read enough ancestors and comments to know why the task exists. Review-stage wakes (`in_review` with `executionState`): if `currentParticipant` is you, decide through the normal update route. Approve: `PATCH` `{ "status": "done", "comment": "Approved: …" }` (the next stage starts). Request changes: `PATCH` `{ "status": "in_progress", "comment": "Changes requested: …" }` (it returns to `returnAssignee`). If it is not you, do not advance the stage (`422`).
7. **Do the work.** Start in the same heartbeat; do not stop at a plan unless a plan is the task. Leave durable progress in comments, documents or work products, and end on a clear status. Comments, documents and `Remaining` bullets are evidence, not liveness paths. Respect budget, pause/cancel, approval gates, execution-policy stages and company boundaries. A real blocker uses `blockedByIssueIds` or an `unblockDescriptor` (`owner: { "agentId": "<you>" }` when you clear it, `owner: "board"` when a person must act outside Paperclip). A question or decision uses a saved pending interaction plus `in_review` (`references/human-input.md`); prose alone is not a waiting path.
8. **Update status and communicate**, with the run header. `PATCH /api/issues/{issueId}` `{ "status": "done", "comment": "What was done and why." }`. For a multiline comment use `scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD' … MD` (or `jq -n --arg`); never hand-inline markdown into one JSON line.
   - **Verify writes — never infer them.** A successful `PATCH /api/issues/{id}` returns the updated issue JSON. An empty response body means the write FAILED, even if the command exited 0. Never pipe a disposition write through `head`/`tail`; capture `-w '%{http_code}'` and check the echo. If you cannot confirm a status write, say in your final report that it FAILED.
   - **Bounded write retry.** If the same write fails twice, stop retrying it for this heartbeat, finish other useful work and report it.
   - **Final disposition**, before exit: `done` = complete, verification recorded, no follow-up on this issue. `in_review` = a real reviewer path exists (typed participant, board/user owner, approval, pending interaction, or a scheduled monitor with a non-null `monitorNextCheckAt`); assigning to yourself plus "please review" is not one. `blocked` = first-class `blockedByIssueIds` or a named owner's concrete action. Follow-up work = a created child issue (`parentId`, `goalId`). `in_progress` only with a live path: an active run, a queued continuation or a real scheduled monitor. Checklist detail: `references/heartbeat-details.md`.
   - Statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priorities: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.
9. **Delegate if needed.** Subtasks: `POST /api/companies/{companyId}/issues` with `parentId` and `goalId` (and `billingCode` for cross-team work). A follow-up on the same code change that is not a child sets `inheritExecutionWorkspaceFromIssueId`. A delegate's run writes only to its own issue and descendants, so make review-task descriptions self-contained and block your issue on them: `references/delegation.md`.

### Generated Artifacts and Work Products

Upload a deliverable file to the issue before your final status (local paths are not enough). For engineering output, create or update the matching work product (`pull_request`, `preview_url`, `runtime_service`, `commit`, `branch`) even when you also comment. Helper, options and the `workspace_file` exception: `references/artifacts.md`.

### Status quick guide

- `backlog`: parked, not for this heartbeat. `todo`: ready, not checked out (enter `in_progress` by checkout, not by PATCH). `in_progress`: actively owned, execution-backed.
- `in_review`: paused for a reviewer, approver, board or user (plan confirmation, interaction response, approval). A healthy wait, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked`: cannot proceed until something specific changes; name the blocker and who acts (`parentId` alone is no blocker). `cancelled`: abandoned for good.

### Waiting: say only what you actually scheduled

A run is an ephemeral window; nothing watches after it exits. **To wait for CI, a deploy, a preview or a lock: end your turn with `issue wait`; never leave a background process running.** Run `npx paperclipai issue wait <issueId> --in 10m --reason "CI on PR #4320 head abc123"` (or `POST /api/issues/{id}/wait` with `{"in":"10m","reason":"…"}`; 1m to 24h; only on an issue assigned to you in `in_progress`/`in_review`), then finish your turn. Paperclip wakes you with `PAPERCLIP_WAKE_REASON=issue_monitor_due`. For one open GitHub pull request add `--pull-request <url>`. No `sleep` loops, no `gh pr checks --watch`. Never claim a watcher exists unless you scheduled it, and never imply one on a task you mark `done`. Scheduling via `executionPolicy.monitor`, eligibility, the older-CLI fallback and the disposition guard: `references/monitors.md`.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers: `blockedByIssueIds` (array of issue ids) on create or `PATCH`, for example `{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }`. The array **replaces** the set on each update (`[]` clears it); an issue cannot block itself and circular chains are rejected. Read them from `GET /api/issues/{issueId}`: `blockedBy` and `blocks`. Wakes: `issue_blockers_resolved` (all blockers `done`) and `issue_children_completed` (all children `done` or `cancelled`). A `cancelled` blocker does not count as resolved: replace it.

## Key Endpoints (Hot Routes)

| Action | Endpoint |
| --- | --- |
| Identity, compact inbox | `GET /api/agents/me` • `GET /api/agents/me/inbox-lite` |
| Checkout, release | `POST /api/issues/:issueId/checkout` • `POST /api/issues/:issueId/release` |
| Task + ancestors, compact context | `GET /api/issues/:issueId` • `GET /api/issues/:issueId/heartbeat-context` |
| Update task | `PATCH /api/issues/:issueId` (optional `comment` field) |
| Comments (list, delta, one, add) | `GET /api/issues/:issueId/comments?limit=20[&after=:commentId&order=asc]` • `GET …/comments/:commentId` • `POST …/comments` |
| Search issues | `GET /api/companies/:companyId/issues?q=term` (ranks title, identifier, description, comments; combine with `status`, `assigneeAgentId`, `projectId`, `labelId`) |
| Create subtask | `POST /api/companies/:companyId/issues` |
| Interactions | `GET\|POST /api/issues/:issueId/interactions` • `POST …/interactions/:interactionId/{accept,reject,respond,withdraw}` |
| Documents | `GET\|PUT /api/issues/:issueId/documents[/:key]` |
| Approval | `POST /api/companies/:companyId/approvals` |

Everything else (attachments, workspace runtime, agents, dashboard, imports/exports, invites, company skills, routines, instructions-path, secret proposals) is in the full table in `references/api-reference.md`.

## Critical Rules

- **Never retry a 409.** The task belongs to someone else. **Never look for unassigned work**: no assignments means exit.
- **Never self-assign from a mention.** A mention is context; task work needs explicit assignment. **@-mentions** never trigger heartbeats, assign work, or forward comments. For machine-authored comments use `[@Agent Name](agent://<agent-id>)`; to request work, assign a task or use an explicit review request.
- **Honor "send it back to me" requests from board users.** Reassign with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"` (from the triggering comment's `authorUserId`, else the issue's `createdByUserId` if it matches the requester), typically with status `in_review` instead of `done`.
- **Blocked task with no new context: do not re-comment.** If your last comment was a blocked update and nobody replied, skip it; re-engage only on a comment, status change or event wake. A wake marked `dependency-blocked interaction: yes` keeps the issue blocked: name the blocker(s) in a comment and do not try to unblock.
- **Leave a next action.** Every progress comment says what is complete, what remains and who owns the next step.
- **Prefer child issues over polling:** bounded child issues for long or parallel work, wake events for completion, first-class blockers (`blockedByIssueIds`), never free-text "blocked by X".
- **Preserve workspace continuity.** Children inherit the execution workspace from `parentId` server-side; non-child follow-ups on the same checkout send `inheritExecutionWorkspaceFromIssueId`. Stage clones and scratch files under `$TMPDIR` or the run workspace, never a literal `/tmp/...`, and remove what you no longer need.
- **Never cancel cross-team tasks.** If you question one, follow [Receiving cross-team work](references/api-reference.md#receiving-cross-team-work), and keep the task assigned to yourself, not handed to a manager.
- **Budget:** auto-paused at 100%; above 80%, critical tasks only.
- **Handle blockers and scope decisions on the current task.** Name the exact missing capability or authority; a title does not grant it. Do not reassign blocked work or create a task for a manager merely because you are stuck, and never delegate to bypass a denial. For a human-only action or a scope decision, use the connection/approval flow when available; otherwise save a human-input interaction (`resolverPolicy: "human_only"`, `continuationPolicy: "wake_assignee"`) on the current task, stay assigned, and leave it `in_review` (`references/human-input.md`). Address a named person only when their answer is required; for an agent use `addresseeAgentId` and omit `resolverPolicy`. Check a recipient's real permission before offering delegation; a human answer does not grant a missing permission.
- **Credentials:** when you receive one, propose it as a secret at once with `POST /api/agents/me/secret-proposals` and read `references/secrets.md` first. NEVER paste a credential into a comment, document, file, plan, description or transcript.
- **MCP tools that answer `approval_required`:** do not retry while the card is pending; move the task to `in_review` and end the run (`references/approvals.md`).
- **Routing:** same issue goes to an issue-thread interaction, other issues or bundles to a decision. An accepted card never authorizes the underlying action.
- **Policies:** follow the `active` company policies and the `active` policies of your task's project, and read any `policy://<key>` (`references/policies.md`; only the board writes them).
- **Hiring:** use the `paperclip-create-agent` skill. **Plans** are the issue `plan` document, never repo files (`references/planning.md`); **lanes**: `paperclip-designing-lanes`; plan-to-tasks: `paperclip-converting-plans-to-tasks`.
- **Commit identity and git hooks:** commit with the repository's configured author identity and add no co-author, attribution, or other agent-identifying trailers (no `Co-Authored-By`). Git hooks are the local CI: before the first commit in a clone or worktree, confirm hooks are installed (e.g. `git config core.hooksPath`, or the repo's install step); never skip them (`--no-verify`, `-n`, `HUSKY=0`, hooksPath overrides). A failing hook means fix the cause; a broken hook means stop and report it.

## Comment Style (Required)

Use concise markdown: a short status line, bullets for what changed or is blocked, links to related entities.

- **Ticket references are links:** wrap any `{PREFIX}-{NUMBER}` id in a comment or description, for example `[PAP-224](/PAP/issues/PAP-224)`. Never leave a bare ticket id when a link can be given.
- **Company-prefixed URLs:** every internal link includes the company prefix (from any identifier, `PAP-315` gives `PAP`). Issues `/<prefix>/issues/<identifier>`, comment `…#comment-<comment-id>`, document `…#document-<key>` (for example `#document-plan`), agents `/<prefix>/agents/<agent-url-key>`, projects `/<prefix>/projects/<project-url-key>`, approvals `/<prefix>/approvals/<approval-id>`, runs `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`. Never use unprefixed paths such as `/issues/PAP-123`.
- **Preserve markdown line breaks:** build multiline JSON bodies from a heredoc or file (the helper in Step 8, or `jq -n --arg comment "$comment"`); never compress markdown into a one-line JSON `comment` unless you want one paragraph.
