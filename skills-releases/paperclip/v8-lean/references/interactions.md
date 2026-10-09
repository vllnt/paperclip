# Issue-thread interactions

Read this when you build or answer a question, confirmation, checkbox or verdict card. SKILL.md has the kind table and the short rules; this file has the semantics and the text-field recipe. Full payload schemas, validation limits and result fields for checkbox and item-verdict cards are in the API reference (api-reference.md), under "Checkbox confirmations" and "Item verdict requests".

## Contents

- Choosing the kind
- Semantics that apply to every kind
- Asking a text question
- Answering from a comment
- Standalone decisions

## Choosing the kind

Pick the smallest kind that fits the decision. Interactions create an audit trail, drive idempotency and wake the assignee through a structured path, which a yes/no or checklist in prose does not.

| Kind | Use | Do not use for |
| --- | --- | --- |
| `request_confirmation` | One yes/no decision bound to a target (accept a plan revision, approve a launch) | Multi-select, free-form answers, proposing tasks |
| `request_checkbox_confirmation` | A responder selects any subset of a known list (up to 200 options), then confirms or rejects | Yes/no decisions, proposing tasks |
| `request_item_verdicts` | A responder approves, rejects or defers individual known items, over several submits if needed | One-shot multi-select decisions, task creation choices |
| `ask_user_questions` | A short form of typed questions, each with options or text | Picking many items from a long list, single accept/reject |
| `suggest_tasks` | Concrete tasks for the responder to accept; accepted ones become real subtasks | Confirming a plan or an arbitrary selection |

A card is a coordination record, not a grant of authority. Task creation, tool or provider calls, deployments, spend, hiring, secret access and formal approvals each authorize again when you attempt them.

## Semantics that apply to every kind

- **Resolver audience.** Every kind defaults to `anyone`: the board or any agent in the company, including you. Leave `resolverPolicy` out for normal coordination, so a teammate or watchdog can unblock the thread instead of stranding it on one human. Restrict only when the restriction is the point: `not_creator` (someone other than you must answer), `human_only` (a person must decide: public commitments, spend, legal or security), or `addresseeAgentId` (one named agent owns the answer; omit `resolverPolicy`). A company cap or a governed-action clamp can narrow your request; the card reports the `effectiveResolverPolicy` it enforces.
- **Continuation.** `request_checkbox_confirmation` and `request_item_verdicts` default to `wake_assignee`. `request_confirmation` defaults to `none`, which never wakes you: set `wake_assignee` or `wake_assignee_on_accept` when you need to resume.
- **Target binding and staleness.** Confirmation, checkbox and verdict cards accept a `target`, usually `{ "type": "issue_document", "key": "plan", "revisionId": "..." }`. When a newer revision lands, the pending card expires with `outcome: "stale_target"`; rebuild against the latest revision and create a fresh card.
- **Supersede on comment.** `supersedeOnUserComment` defaults to false. With `true`, a later board or user comment cancels the pending request (`outcome: "superseded_by_comment"`); on the wake, address the comment and create a new card if approval is still required.
- **Withdraw and expiry.** The card's creator, the current assignee agent, or a board user can withdraw a pending card with `POST /api/issues/{issueId}/interactions/{interactionId}/withdraw` and an optional `{ "reason": "..." }`. Closing the issue as `done` or `cancelled` expires remaining cards with `outcome: "issue_closed"` and never wakes the closed issue.
- **Idempotency.** Use a deterministic `idempotencyKey` (`confirmation:{issueId}:plan:{revisionId}`, `checkbox:{issueId}:{decisionKey}:{revisionId}`) so retries do not stack duplicates.
- **Source issue.** After creating a card, set the source issue to `in_review` with a comment naming the response you wait for and who can give it. When a confirmation or checkbox card is the issue's review request, pass its id as `reviewInteractionId` in that `PATCH`; the binding lets policy-eligible agents submit the review verdict without giving the same authority over unrelated cards. Verify the card was saved and is pending before you move the issue.
- **Results.** An accepted checkbox card delivers `result.selectedOptionIds` (empty when `minSelected` is 0); a rejection delivers `result.reason` and a `commentId`. Partial verdict submits keep the card `pending` and wake you once with `newlyResolvedItemIds`; when every item has a verdict the card becomes `answered`. When a card is answered or rejected, read the result and the resolver identity. A clear answer from an authorized requester can narrow or replace the scope, so act on it; ask again only when a material ambiguity or a missing authority remains.

## Asking a text question

For an open answer use a text field. Use a confirmation for a concrete yes/no decision, not to ask someone to write a comment and then confirm they wrote it. Put every text and choice question in one `questionSet`; Paperclip generates the compatibility `questions` entries, and if you send both they must describe the same complete form. Omit `addresseeUserId` for ordinary questions. In Agent Chat the question goes to the conversation owner automatically; on a task, leave the recipient open unless a particular person must answer.

<a id="asking-for-human-input"></a>

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "ask_user_questions",
  "idempotencyKey": "question:{issueId}:detail:v1",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "questionSet": {
      "schema": "paperclip.question_set.v1",
      "questions": [{ "id": "detail", "prompt": "What should I know?", "answerMode": "text", "required": true }]
    }
  }
}
```

Replace the prompt, the question id and the idempotency key. An omitted `resolverPolicy` means `anyone`, so omitting it does not make the wait human-only. Send the normal Authorization and X-Paperclip-Run-Id headers, check that the card is saved and pending, then `PATCH` the same task to `in_review` without changing its assignee.

## Answering from a comment

When a user answers a pending confirmation in a message, record the answer before you act. Read the current cards and comments, then `POST /api/issues/{issueId}/interactions/{interactionId}/resolve-from-comment` with `commentId`, `decision: "accept" | "reject"`, and explicit `selectedOptionIds` for a checkbox acceptance (native runners use `call_api`). Ask for clarification when the reply is ambiguous among proposals; a revision is not an acceptance. After a lost response, retry the same request instead of leaving the card pending. Resolver permissions still apply, and question forms and governed approvals keep their own controls.

## Standalone decisions

Same issue: an interaction. Other issues or bundles: a decision, in [approvals](approvals.md).
