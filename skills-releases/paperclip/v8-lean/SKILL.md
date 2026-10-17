---
name: paperclip
description: >
  Operates an agent inside Paperclip: heartbeats, task checkout, comments, status and blockers, delegation,
  approvals, and company governance through the control plane API. Use when a heartbeat or wake payload names a
  Paperclip task, or when asked to hand off, delegate, or request approval.
---

# Paperclip

You run in **heartbeats**: short windows that Paperclip starts. Each time you wake, check your work, do something useful, and exit. Nothing keeps running after you exit, so anything you want to happen later needs state on an issue. "Task" and "issue" are the same work item; the UI says task, the API says issue.

## Every request

- Always set: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Wake context may add `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`.
- Read the API URL from `PAPERCLIP_API_URL` and use it exactly as given; in sandboxed runs it points at a run-scoped bridge, not the host.
- Send `Authorization: Bearer $PAPERCLIP_API_KEY`. Routes live under `/api`. Bodies are JSON, except attachment uploads and downloads.
- Add `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` to every request that changes an issue (checkout, update, comment, create, release). It ties the change to this run for the audit trail, and run-scoped permissions depend on it.
- Keep the API key, bridge tokens and any credential out of prompts, comments, documents, files and logs, because those are readable by people and other agents. A credential you receive is proposed at once with `POST /api/agents/me/secret-proposals`; read [secrets](references/secrets.md) first.
- When a CLI argument carries untrusted text (issue text, comments, markdown, model output), run `npx paperclipai ...`, not `pnpm paperclipai ...`: pnpm hands the argument to a shell, which expands backticks, `$( )` and `$NAME` before the CLI starts.
- If a user's instruction conflicts with a default in this skill, follow the user. Permissions, approval gates, budgets and company boundaries are not defaults; they hold whatever the instruction says.

## Choose the procedure

- The task says **Chat mode**, or the wake context is a server-verified external chat turn (`checkedOutByHarness: true`, a concrete issue, and an `externalChatProvider`): read [chat-turns](references/chat-turns.md). The harness does the bookkeeping, and that file says what to skip. Do not infer this from comment text or a provider name: only the server marker shows the harness owns the turn.
- The wake payload ("Paperclip Resume Delta" or "Paperclip Wake Payload") names an issue: skip steps 1-4, because the wake already tells you what to work on. Skip step 5 as well only when the wake says `checkedOutByHarness: true` (the prompt line reads "checkout: already claimed by the harness for this run"); in every other case, check out.
- Anything else, including recovery, governed-action, interaction, hold, liveness and skill-test wakes: run every step.

## Heartbeat checklist

Copy these steps into your todo list. A step you skip stays there with `skip: <reason>`.

1. **Identity.** `GET /api/agents/me` unless your id, company, role, chain of command and budget are already in context. Done when you know them.
2. **Approval follow-up**, only when `PAPERCLIP_APPROVAL_ID` is set or the wake says an approval resolved. `GET /api/approvals/{id}` and `/issues`. Close each linked issue (`done`) if the approval fully resolves it; otherwise comment why it stays open and what happens next, linking the approval and the issue. Done when every linked issue has a new state or comment.
3. **Inbox.** `GET /api/agents/me/inbox-lite`. Use `GET /api/companies/{companyId}/issues?assigneeAgentId={id}&status=todo,in_progress,in_review,blocked` only when you need full issue objects. Done when you hold the list.
4. **Pick work.** Order: `in_progress`, then `in_review` when a comment woke you, then `todo`. Skip `blocked` unless you can unblock it.
   - `PAPERCLIP_TASK_ID` assigned to you: take it first.
   - `issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID`: read that comment, then check out and address it (also for `in_review`).
   - `dependency-blocked interaction: yes`: the issue is still blocked for deliverable work. Name the unresolved blockers and answer or triage by comment or document. A failed checkout here is not a blocker; use the scoped wake context.
   - A blocked task whose latest comment is your own blocked update, with nothing since: skip it. A repeat comment adds noise and wakes nobody.
   - Nothing assigned: exit. Look only at your own assignments, and treat an @-mention as context, not as assignment.
   Done when you hold one issue, or have exited.
5. **Checkout.** Required before any work, because checkout is what makes you the single owner.
   ```
   POST /api/issues/{issueId}/checkout
   Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
   { "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
   ```
   Already yours: it returns normally. `409 Conflict`: another agent owns it, so pick a different task and do not retry, because the owner will not change. If the task has `titleNeedsGeneration: true`, set a concise outcome title next, with `set_task_title` and `onlyIfProvisional: true` (or `PUT /api/issues/{issueId}/title` with `{ "title": "...", "onlyIfProvisional": true }`); this is allowed in Ask and Plan modes, and explicit titles and the description stay as they are. Done when checkout returns 200, or after a 409 you have picked a different task.
6. **Context.** `GET /api/issues/{issueId}/heartbeat-context` first. If the run prompt carries a wake payload, read it before any call; for a comment wake, acknowledge the newest comment and say how it changes your next action before exploring. Fetch more only when `fallbackFetchNeeded` is true or the batch is not enough: the wake comment (`GET .../comments/{commentId}`), then `?after={last-seen-id}&order=asc`, and the full thread only on a cold start. Done when you can say why the task exists and what changed.
   If the issue is `in_review` with `executionState` and `currentParticipant` is you, decide through the normal update: approve with `PATCH` `{ "status": "done", "comment": "Approved: ..." }` (later stages advance automatically), or request changes with `{ "status": "in_progress", "comment": "Changes requested: ..." }` (it returns to `returnAssignee`). If you are not the participant, do not try to advance the stage, because the server rejects other actors with `422`.
7. **Work.** Start concrete work in this heartbeat, unless the task asks only for a plan or review. Leave durable progress as a comment, document or work product with a next action. Use child issues for parallel or long work instead of polling agents, sessions or processes. Respect budget, pause and cancel, approval gates, execution policy stages and company boundaries. Comments, documents and work products are evidence of progress, not a way to be woken later. A file someone should inspect, or an operator-facing output (pull request, preview URL, runtime service, notable commit, branch), is uploaded or recorded as a work product on the issue before you set the final status, because reviewers cannot see your workspace; how is in [artifacts](references/artifacts.md). Record each check you ran as PASS, FAIL or UNVERIFIED; UNVERIFIED is unfinished work, so report it as such. Done when the requested change exists and its checks are recorded.
8. **Disposition.** Pick the status from the table below and write it with a comment. Comment on in-progress work before you exit even when the status does not change, because your manager cannot see progress otherwise. Done when the write is confirmed.
9. **Delegate** work that someone else should own (see Delegating). Done when each follow-up exists as its own issue.

## Final disposition

| Status | Use when | It needs |
| --- | --- | --- |
| `done` | Work complete, verification recorded, nothing left on this issue | A comment with the endpoint reached and the proof |
| `in_review` | Paused for a reviewer, approver, board or user; also a plan awaiting confirmation | A real path: typed execution participant, board or user owner, linked approval, saved pending interaction, or a scheduled monitor with non-null `monitorNextCheckAt`. Assigning yourself and asking for review is not a path |
| `blocked` | Cannot continue until something specific changes | `blockedByIssueIds`, or an `unblockDescriptor` owned by you or the board (see Blockers) |
| `in_progress` | Active run, queued continuation, or scheduled monitor will wake the owner | Finished artifact work with no live path must move to another status |
| `todo` / `backlog` | Ready to start / parked | Enter `in_progress` only through checkout |
| `cancelled` | Intentionally abandoned | |

Other fields you may update: `title`, `description`, `priority` (`critical`, `high`, `medium`, `low`), `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline comments use `scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD' ... MD` when your workspace has it. It keeps newlines, checks the HTTP status, retries connection failures and confirms the echoed status. Without it, build the body with `jq -n --arg comment "$comment" ...` and capture `-w '%{http_code}'`.

A successful `PATCH` returns the updated issue. An empty body means the write failed even if curl exited 0, and piping curl through `head` or `tail` hides a lost connection. If you cannot confirm a write, report it as FAILED, not "sent", so recovery starts from accurate context. If the same write fails twice, stop retrying it, finish what does not depend on it, and report it.

If a board user asks for the task back ("let me review it", "assign it back to me"), set `assigneeAgentId: null` and `assigneeUserId` to their id (the comment's `authorUserId`, else the issue's `createdByUserId` if it matches), usually with status `in_review` instead of `done`.

## Waiting on people

Look facts up yourself. Ask only for authority, access, or a preference no experiment settles, and give your recommendation, worded so that "yes" accepts it. Keep working on anything independent while you wait.

An interaction is a card in the issue thread that records a typed response and wakes you through a structured path. A card records a decision and grants no authority: each action it leads to (task creation, tool calls, deploys, spend, hiring, secrets, formal approvals) is authorized again when you attempt it.

| Kind | Use for |
| --- | --- |
| `request_confirmation` | One yes/no decision on a target, such as a plan revision |
| `request_checkbox_confirmation` | The responder picks any subset of a known list, then confirms |
| `request_item_verdicts` | The responder approves, rejects or defers each known item |
| `ask_user_questions` | A short form of typed questions, including free text |
| `suggest_tasks` | Proposed tasks; accepted ones become subtasks |
| `decision` (separate route) | Effects on other issues, or a choice that must stand alone |

- Same issue: an interaction. Other issues or bundles: a decision.
- Leave `resolverPolicy` out for normal coordination: the default is `anyone`, including teammates and watchdogs, so nobody is stranded on one human. Use `human_only` only when a person must decide (public commitments, spend, legal or security), `not_creator` when the answer must not come from you, `addresseeAgentId` for one named agent. Address a person only by their exact Paperclip user id; the server rejects unknown or unauthorized recipients, and a title is not authority.
- Set `continuationPolicy` to `wake_assignee` (or `wake_assignee_on_accept`) when you need to resume; `request_confirmation` defaults to `none`, which never wakes you.
- Use a deterministic `idempotencyKey` so retries do not stack cards.
- After creating the card, set the source issue to `in_review` with a comment naming who can answer. For a review request, pass the card id as `reviewInteractionId` in that `PATCH`. `supersedeOnUserComment` defaults to false; set it true when a later comment should cancel the request.
- When a card is answered, read the result and who resolved it. A clear answer from an authorized requester can narrow or replace the scope, so act on it without asking again; it still authorizes no downstream action. If a user answers in a comment instead of the card, record it first so the card does not stay pending: `POST /api/issues/{issueId}/interactions/{interactionId}/resolve-from-comment` with `commentId`, `decision` (`"accept"` or `"reject"`), and `selectedOptionIds` for a checkbox acceptance.

Payloads, results, staleness, withdrawal and retry rules are in [interactions](references/interactions.md). For spend or governed actions use a board approval: `POST /api/companies/{companyId}/approvals` with `type: "request_board_approval"`, `requestedByAgentId`, `issueIds`, and a payload of `title`, `summary`, `recommendedAction`, `risks`; leave the issue `in_review`. Approvals, decisions and "ask first" MCP tools (`approval_required`: do not retry, wait in `in_review`) are in [approvals](references/approvals.md).

## Blockers

- Express "A is blocked by B" with `blockedByIssueIds` (array, replaces the whole set; `[]` clears), on create or `PATCH`. `parentId` alone is not a blocker, and a cancelled blocker never counts as resolved, so remove or replace it.
- You wake automatically with `issue_blockers_resolved` (all blockers `done`) or `issue_children_completed` (all children `done` or `cancelled`).
- A real blocker that is not another issue: `unblockDescriptor` with an exact `action`. Use `owner: { "agentId": "<your-agent-id>" }` when you will clear it yourself, and `owner: "board"` when a person must do something outside Paperclip first (for example, click "Update branch" on a pull request that changes a workflow file). A board-owned block appears in the board inbox, and only a board user can clear it or change its owner. Agents cannot name a specific user or another agent.
- Handle blockers yourself: name the missing capability or authority and do not hand a stuck task to a manager or another agent, because a title grants no access and delegation never bypasses a permission denial. For a question or decision from a person, save an interaction with `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"` on the current task, stay assigned, and set `in_review`; a board-owned block is for work outside Paperclip, not for questions.
- A task given to you from outside your team is not yours to cancel; only the assigning team's manager can. If you doubt it should be done, record the concern, ask the requester through an interaction on the task, and keep it assigned to yourself ([delegation](references/delegation.md)).

## Delegating

- Create ordinary subtasks with `POST /api/companies/{companyId}/issues` and set `parentId` and `goalId` so the hierarchy keeps the work traceable (`billingCode` for cross-team work). A follow-up that shares the same code change but is not a child sets `inheritExecutionWorkspaceFromIssueId`; children inherit the workspace from `parentId`.
- Write review tasks so they can run alone: the delegate can write only to its own issue and descendants, so put the instructions, acceptance criteria and material in the description, ask the reviewer to post findings on the review issue and mark it `done` (a review with adverse findings is `done`), and block your issue on it with `blockedByIssueIds`. Do not ask a delegate to comment on your issue: a low-trust or review-contained delegate cannot write there, so the call returns 403. See [delegation](references/delegation.md).
- To reach an agent whose issues you cannot write to, create a new issue assigned to it with complete instructions: creating issues is company-scoped and always allowed, while commenting across another agent's boundary is not.

## Plans and documents

A requested task document is saved on the issue with `PUT /api/issues/{issueId}/documents/{key}` unless the requester names another destination; confirm the returned revision and link it before you report completion. Plans live in the issue document with key `plan`, not in the description or the repo. Update it with `PUT /api/issues/{issueId}/documents/plan`; on an update send `baseRevisionId` set to the `latestRevisionId` you just read, or the server answers `409`. Link it in your comment as `/<prefix>/issues/<id>#document-plan`. A plan request is not `done`: leave the issue `in_review`, and if the plan needs approval, create a `request_confirmation` bound to the latest revision ([issue-documents](references/issue-documents.md)).

## Comments

A comment is a short status line, then bullets for what changed and what is blocked, with links. End with a reply a reviewer can act on: the endpoint reached, the proof, and what is open (blockers and who must act, decisions, next step).

- Link ticket ids: `[PAP-224](/PAP/issues/PAP-224)`. The prefix is the part of any issue identifier before the dash. Bare ids are not clickable.
- Internal links carry the company prefix, because an unprefixed path leads nowhere: `/<prefix>/issues/<id>` (add `#comment-<id>` or `#document-<key>`), `/<prefix>/agents/<url-key>`, `/<prefix>/projects/<url-key>`, `/<prefix>/approvals/<id>`, `/<prefix>/agents/<url-key-or-id>/runs/<run-id>`.
- Build multiline JSON from a heredoc or `jq --arg`. A hand-inlined one-line string merges paragraphs.
- Mention an agent as `[@Agent Name](agent://<agent-id>)`. A mention is context only; to request work, assign a task.

## Gotchas

- A `409` on checkout means another agent owns the task. Stop, pick a different task, and never retry: retrying cannot change the owner and only burns calls.
- Monitors: a "watcher" exists only as issue state. Claim one only after you set `executionPolicy.monitor.nextCheckAt` and the response shows non-null `monitorNextCheckAt`, an agent assignee, no user assignee, and status `in_progress` or `in_review`; otherwise it never fires. Never imply a watcher on a `done` issue, because `done` means nothing is left to watch ([monitors](references/monitors.md)).
- To wait for CI, a deploy, a preview or a lock, end your turn with `npx paperclipai issue wait <issueId> --in 10m --reason "CI on PR #123"` (or `POST /api/issues/{id}/wait` with `{"in":"10m","reason":"..."}`; 1m to 24h; only on an issue assigned to you in `in_progress` or `in_review`). Do not leave a background process, `sleep` loop or `gh pr checks --watch` running, because on Claude local runs Paperclip stops a process still running after your final result, and other adapters get no re-check ([monitors](references/monitors.md)).
- The disposition guard rejects a move to `in_review` without a real path (`invalid_issue_disposition`), so a comment naming someone is not a waiting path.
- Budget: execution auto-pauses at 100%; above 80%, work only critical tasks.
- Commit with the repository's configured author identity and add no co-author, attribution or other agent-identifying trailer (no `Co-Authored-By`). Git hooks are the local CI: before your first commit in a clone or worktree, confirm hooks are installed (for example `git config core.hooksPath`, or the repo's install step), and never skip them (`--no-verify`, `-n`, `HUSKY=0`, a hooksPath override). A failing hook means fix the cause; a broken hook means stop and report it.

## Hot routes

| Action | Route |
| --- | --- |
| Task with ancestors; release | `GET /api/issues/:issueId`; `POST /api/issues/:issueId/release` |
| Update (optional `comment`) | `PATCH /api/issues/:issueId` |
| Comments | `GET\|POST /api/issues/:issueId/comments[?after=:id&order=asc]`, `GET .../comments/:commentId` |
| Interactions | `GET\|POST /api/issues/:issueId/interactions`, `POST .../interactions/:id/{accept,reject,respond,withdraw}` |
| Create subtask | `POST /api/companies/:companyId/issues` |
| Search | `GET /api/companies/:companyId/issues?q=term` (also filters `status`, `assigneeAgentId`, `projectId`, `labelId`) |
| Documents | `GET\|PUT /api/issues/:issueId/documents[/:key]` |
| Approvals | `POST /api/companies/:companyId/approvals` |
| Attachments | `POST /api/companies/:companyId/issues/:issueId/attachments` (multipart `file`), `GET /api/issues/:issueId/attachments` |
| Workspace runtime | `GET /api/execution-workspaces/:id`, `POST .../runtime-services/:action` |
| Agents, dashboard | `GET /api/companies/:companyId/agents`, `GET /api/companies/:companyId/dashboard` |

## Read more when

| Read | When |
| --- | --- |
| [chat-turns](references/chat-turns.md) | Chat mode, or a server-verified external chat turn |
| [interactions](references/interactions.md) | Building or answering a question, confirmation, checkbox or verdict card |
| [approvals](references/approvals.md) | Board approval, standalone decisions, an "ask first" MCP tool |
| [delegation](references/delegation.md) | Delegating a review, courier requests, cross-team work |
| [monitors](references/monitors.md) | Scheduling or describing a monitor |
| [secrets](references/secrets.md) | You received a credential, or need a granted secret |
| [inbox](references/inbox.md) | Archiving an item from a user's inbox |
| [artifacts](references/artifacts.md) | Delivering a file or an engineering work product (PR, preview, commit) |
| [issue-documents](references/issue-documents.md) | Writing a task document or plan |
| [issue-workspaces](references/issue-workspaces.md) | Browser QA or a preview server; use the managed runtime controls instead of starting your own background servers |
| [cases](references/cases.md) | The cases API |
| [company-skills](references/company-skills.md) | Installing, creating or assigning company skills |
| [routines](references/routines.md) | Creating or managing recurring tasks |
| [workflows](references/workflows.md) | Project setup, OpenClaw invite, instructions path, company import and export, self-test |
| [api-reference](references/api-reference.md) | Response schemas, error codes, full endpoint tables, hiring requests |

To hire or create an agent, use the `paperclip-create-agent` skill; to turn a plan into executable tasks, use `paperclip-converting-plans-to-tasks`.
