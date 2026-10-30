# Standalone decisions and decision bundles

> Loaded on demand from `SKILL.md`. Read it when the effect spans other issues, creates a cross-issue bundle, or must stand alone from one thread.

## Standalone decisions

Create a decision from an issue-scoped agent run with `POST /api/companies/{companyId}/decisions`:

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

- `options` accepts 1–8 options; option ids are unique and each option accepts up to 10 effects.
- Supported effects are `comment_on_issue`, `create_issue`, `update_issue_status`, `assign_issue`, `cancel_issue_tree`, and `resolve_blocker`.
- `expiresAt` is optional, defaults to seven days, and must be no more than 30 days away.
- `idempotencyKey` is optional but strongly recommended; reuse is safe only with the same payload.
- `continuationPolicy` is `none` or `wake_origin_agent`. Use the latter only when resolution or expiry must resume the proposer.
- Each origin agent may have at most 50 open decisions by default.

Bundle related cross-issue decisions with `POST /api/companies/{companyId}/decision-bundles`:

```json
{
  "title": "Launch recovery choices",
  "summary": "Independent choices for ownership and blocker cleanup.",
  "decisions": [
    {
      "title": "Reassign owner?",
      "body": "Move the issue to the recovery owner.",
      "ruleKey": "routing.reassign",
      "options": [
        { "id": "reassign", "label": "Reassign", "effects": [{ "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }] },
        { "id": "leave", "label": "Leave unchanged", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:routing.reassign:v1"
    },
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

Bundles accept 1–50 decisions and are created atomically. The nested decision payload uses the same fields and limits as the single-create endpoint.
