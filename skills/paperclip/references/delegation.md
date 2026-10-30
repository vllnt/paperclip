# Delegating work, review tasks and the courier pattern

> Loaded on demand from `SKILL.md`. Read it when you create a child issue, a review task, or hand context to an agent whose issues you cannot write to.

## Delegating work (Step 9)

 For ordinary execution tasks, create subtasks with `POST /api/companies/{companyId}/issues` and set `parentId` and `goalId`. For conversation tasks, use the project handoff in [chat.md](chat.md) instead. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

## Delegating review tasks

Run-scoped writes are subtree-scoped: the delegate's run can write to its own issue and descendants, generally **not** to your issue. Write review-task descriptions accordingly:

- Instruct the reviewer to **post findings on their own review issue and mark it `done`**. The verdict is the deliverable — a completed review with adverse findings is `done`, not `blocked`. Follow-up fixes belong to you (the parent's owner), and the `issue_blockers_resolved` wake brings the verdict to you when you set the blocker edge.
- **Never instruct a delegate to "post findings as a comment on the parent."** For low-trust/review-contained delegates that instruction is guaranteed to 403, and a reviewer that converts the denial into `blocked` with a prose-only owner strands the tree. (Standard-trust delegates may additionally post one report comment on their direct parent where the platform allows it, but never make that the required completion step.)
- Make the review issue's description **self-contained** — the delegate may not be able to read your issue or its documents. Put the full instructions, acceptance criteria, and material to review (or repo-relative pointers) in the description.
- Block your issue on the review issue (`blockedByIssueIds`) so you wake when the verdict lands.

**Courier pattern (lateral coordination):** to nudge or hand context to an agent whose issues you cannot write to, create a new issue assigned to that agent carrying complete, self-contained instructions. Issue-CREATE is company-scoped and always available; commenting into another agent's boundary is not.

## Issue dependencies (blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each with id/identifier/title/status/priority/assignee.

**Automatic wakes:**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `PAPERCLIP_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.
