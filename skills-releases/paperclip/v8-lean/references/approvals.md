# Approvals, decisions and tool gates

Read this when the board must approve an action, when a choice spans other issues, or when an "ask first" MCP tool returns `approval_required`.

## Contents

- Board approval
- Standalone decisions
- Decision bundles
- MCP tool approval gates

## Board approval

Use `request_board_approval` when the board needs to approve or deny a proposed action such as spend or a governed change. Hiring approvals have their own payload in the "Governance and Approvals" section of the API reference (api-reference.md).

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When it is decided, Paperclip wakes the requester with `PAPERCLIP_APPROVAL_ID` and `PAPERCLIP_APPROVAL_STATUS`. Keep the payload short and decision-ready, give your recommendation, and leave the source issue `in_review` until the decision arrives.

## Standalone decisions

A decision is for effects that span other issues, a bundle of related choices, or a question that must stand alone from one thread. Create it from an issue-scoped run with `POST /api/companies/{companyId}/decisions`:

```json
{
  "title": "Reassign the blocked launch issue?",
  "body": "The current owner is unavailable; this moves the existing issue without creating a duplicate.",
  "ruleKey": "routing.reassign_blocked_issue",
  "options": [
    {
      "id": "reassign",
      "label": "Reassign",
      "effects": [
        { "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }
      ]
    },
    { "id": "leave", "label": "Leave unchanged", "effects": [] }
  ],
  "idempotencyKey": "decision:{originIssueId}:routing.reassign_blocked_issue:v1",
  "continuationPolicy": "wake_origin_agent"
}
```

- `options` takes 1-8 options with unique ids; each option takes up to 10 effects.
- Effect types are `comment_on_issue`, `create_issue`, `update_issue_status`, `assign_issue`, `cancel_issue_tree` and `resolve_blocker`.
- `expiresAt` is optional, defaults to seven days, and may be at most 30 days away.
- `idempotencyKey` is optional but worth setting; reuse is safe only with the same payload.
- `continuationPolicy` is `none` or `wake_origin_agent`. Use the second only when resolution or expiry must resume you.
- One origin agent may have at most 50 open decisions by default.

## Decision bundles

Bundle related cross-issue decisions with `POST /api/companies/{companyId}/decision-bundles`. A bundle holds 1-50 decisions, each with the same fields and limits as a single decision, and is created atomically.

```json
{
  "title": "Launch recovery choices",
  "summary": "Independent choices for ownership and blocker cleanup.",
  "decisions": [
    {
      "title": "Clear obsolete blocker?",
      "body": "Remove the resolved dependency from the blocked issue.",
      "ruleKey": "blockers.clear_obsolete",
      "options": [
        { "id": "clear", "label": "Clear blocker", "effects": [{ "type": "resolve_blocker", "targetIssueId": "{issueId}", "staleness": "strict", "removeBlockedByIssueIds": ["{blockerIssueId}"] }] },
        { "id": "keep", "label": "Keep blocker", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:blockers.clear_obsolete:v1"
    }
  ]
}
```

## MCP tool approval gates

Some MCP tools are configured as **ask first**; their `tools/list` description says human approval is required. When you call one:

1. Paperclip posts one approval card on your checked-out task and returns `approval_required` with instructions. Do not retry while the card is pending. Finish other useful work, note that you wait for tool approval, move the task to `in_review`, and end the run.
2. Paperclip wakes the assignee after approval or rejection. The wake carries the decision and, for an approved action, the execution outcome.
3. Approval means approve and run: Paperclip executes the stored, signed call arguments exactly once. If the wake says it executed, use the result and do not call the tool again. If execution failed, change your approach; a fresh call may open a new approval.
4. Rejection means the action did not run. Do not retry the same call; follow the decline reason, then change your approach or the task's disposition.

Approval requests expire after 60 minutes; call the tool again to open a fresh one. Calling again with identical arguments is safe: a pending request is reused, an executed request returns its stored outcome, and an expired request opens one new card. If the gateway returns `approval_path_missing`, the MCP session is not attached to a checked-out task, so there is nowhere to post the card; run the action again from a run that has the task checked out.
