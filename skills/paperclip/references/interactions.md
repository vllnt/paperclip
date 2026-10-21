# Issue-thread interactions

> Loaded on demand from `SKILL.md`. Read it when you create, answer or withdraw an issue-thread interaction card (`request_confirmation`, `request_checkbox_confirmation`, `request_item_verdicts`, `ask_user_questions`, `suggest_tasks`).

## Issue-thread interactions

Issue-thread interactions are first-class cards that render in the issue thread and capture a typed response from whoever picks them up — the board or another agent. Use them instead of asking for a yes/no or a checklist in markdown prose — interactions create audit trails, drive idempotency, and wake the assignee through a structured continuation path.

A card is a coordination record, not a grant of authority. Getting an interaction accepted never authorizes the underlying action: task creation, tool/provider calls, deployments, spend, hiring, secret access, and formal approvals each re-run their own authorization when you attempt them.

Five issue-thread interaction kinds are supported. Pick the smallest kind that fits the decision shape:

| Kind                            | When to use                                                                                  | When **not** to use                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `request_confirmation`          | Single yes/no decision bound to a target (e.g. accept a plan revision, approve a launch).    | Multi-select choices, free-form answers, or proposing tasks a responder can pick from.             |
| `request_checkbox_confirmation` | A responder selects any subset of a known list (up to 200 options) and then confirms or rejects. | Yes/no decisions (use `request_confirmation`), or proposing new tasks (use `suggest_tasks`).        |
| `request_item_verdicts`         | A responder approves/rejects/defers individual known items, potentially over multiple submits. | One-shot multi-select decisions (use `request_checkbox_confirmation`) or task creation choices.    |
| `ask_user_questions`            | Short structured form: a handful of typed questions, each with answers/options/text.         | Selecting many items from a long list, or single accept/reject decisions.                          |
| `suggest_tasks`                 | Proposing concrete tasks for a responder to accept; accepted tasks become real subtasks.     | Confirming a plan or an arbitrary selection. Tasks are the unit; not arbitrary ids.                |
| `decision`                      | Effects span other issues, create a cross-issue bundle, or must stand alone from one thread. | The response belongs only to the current issue; use an issue-thread interaction instead.           |

Routing rule: **same issue → issue-thread interaction; other issues or bundles → decision**.

Key shared semantics:

- **Resolver audience.** Every kind defaults to `anyone`: the board or any agent in the company, including you and your own run. **Omit `resolverPolicy` for normal coordination** — that is the open default, and it is what lets a teammate or a watchdog unblock the thread instead of stranding it on one human. Ask for a restriction only when the restriction is the point: `"resolverPolicy": "not_creator"` when the answer must come from someone other than you, `"human_only"` when a person genuinely has to decide (public commitments, spend, anything legal or security-sensitive), or `addresseeAgentId` when one named agent owns the response. Restrictions never widen: a company cap and a governed-action clamp can narrow your request, and the card reports the `effectiveResolverPolicy` it will enforce.
- **Continuation policy.** `request_checkbox_confirmation` and `request_item_verdicts` default to `wake_assignee`, which wakes you after the card is resolved or newly resolved item verdicts are submitted. `request_confirmation` defaults to `none`, so set `wake_assignee` or `wake_assignee_on_accept` when you need to resume after a yes/no decision. `none` never wakes you — only use it when you truly do not need to resume.
- **Target binding and staleness.** `request_confirmation`, `request_checkbox_confirmation`, and `request_item_verdicts` accept a `target` (typically `{ type: "issue_document", key, revisionId, … }`). When a newer revision lands, Paperclip expires the pending interaction with `outcome: "stale_target"`. Rebuild against the latest revision and create a fresh interaction.
- **Supersede on user comment.** `supersedeOnUserComment` defaults to `false`. Set it to `true` when a later board/user comment should cancel the pending request with `outcome: "superseded_by_comment"`. On that wake, address the comment and create a new interaction if approval is still required.
- **Withdraw and terminal expiry.** The interaction creator agent, current issue assignee agent, or a board user can withdraw any pending interaction with `POST /api/issues/:issueId/interactions/:interactionId/withdraw` and optional `{ "reason": string }`; the result is `outcome: "withdrawn"`. Closing an issue as `done` or `cancelled` expires all remaining pending interactions with `outcome: "issue_closed"` and never wakes the closed issue.
- **Idempotency.** Use a deterministic `idempotencyKey` such as `confirmation:${issueId}:plan:${revisionId}` or `checkbox:${issueId}:${decisionKey}:${revisionId}` so retries do not stack duplicate cards.
- **Source issue posture.** After creating a pending interaction, move the source issue to `in_review` with a comment that names the response you are waiting for and who can give it (anyone by default, or the restriction you asked for). When a `request_confirmation` or `request_checkbox_confirmation` is the issue review request, include its returned id as `reviewInteractionId` in that PATCH. This explicit binding lets policy-eligible agents submit the review verdict without granting the same authority to unrelated pending confirmations. The pending interaction is the explicit waiting path.

## Checkbox confirmations

Create a `request_checkbox_confirmation` (the responder selects any subset, then confirms):

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

When it is accepted, your wake delivers `result.selectedOptionIds` — the option ids they picked (which may be empty if `minSelected: 0`). Rejection delivers `result.reason` and a `commentId`.

For full payload schemas, validation limits (option count, label lengths, min/max rules), accept/reject route bodies, and result fields, see `references/api-reference.md` -> **Checkbox confirmations**.

## Item verdicts

Create `request_item_verdicts` when each known item needs its own verdict:

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_item_verdicts",
  "idempotencyKey": "verdicts:{issueId}:generated-artifacts:{planRevisionId}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Review each generated artifact.",
    "items": [
      { "id": "api", "label": "API route", "description": "Partial submit endpoint." },
      { "id": "docs", "label": "Docs update" }
    ],
    "verdicts": ["approve", "reject", "defer"],
    "requireReasonOn": ["reject"],
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

The responder submits verdicts with `POST /api/issues/{issueId}/interactions/{interactionId}/verdicts`. Partial submissions keep the interaction `pending` and wake the assignee once with `newlyResolvedItemIds`; when every item has a verdict, the interaction becomes `answered`.
