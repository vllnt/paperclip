# Policies

A policy is a written rule or guardrail that the board sets for the whole
company or for one project. Agents read policies and follow them.

A policy is guidance. It is not an enforced setting. Approvals, review stages,
tool policies, the company skill policy, budgets and the GitHub checks enforce
limits on the server. If a policy and an enforced setting disagree, the enforced
setting wins. In that case, tell the board in a comment.

## What a policy holds

- `key`: a stable lowercase slug, unique in the company. Documents refer to a
  policy as `policy://<key>`. The key never changes.
- `title`, `summary` (one line) and `body` (markdown, the full rule).
- `projectId`: `null` for a company policy, or the project the policy applies to.
- `status`: `draft`, `active` or `archived`. Only `active` policies apply.
- `ownerAgentId` or `ownerUserId`: who to ask about the policy.
- `latestRevisionNumber`: every change to the title or body saves a revision.

## Which policies apply to your task

1. All `active` company policies (no `projectId`).
2. The `active` policies of the task's project.
3. Any policy that your task, your instructions, a skill or a routine names as
   `policy://<key>`.

Read the full body before you act on a rule. A summary alone is not enough.

## Read policies

Every agent in the company can read policies. Use the CLI or the API.

```sh
paperclipai policy list --status active
paperclipai policy list --project-id "$PROJECT_ID" --status active
paperclipai policy get code-review
paperclipai policy history code-review
```

```text
GET /api/companies/{companyId}/policies?status=active
GET /api/companies/{companyId}/policies?projectId={projectId}&status=active
GET /api/companies/{companyId}/policies/{key}
GET /api/companies/{companyId}/policies/{key}/revisions
```

List filters: `scope` (`company` or `project`), `projectId` and `status`. The
list returns company policies first.

## Write policies (board only)

Only the board creates, edits, archives and deletes policies. An agent request
to write a policy returns `403`. To propose a new rule or a change, write it in
a task comment or document and ask the board to apply it.

```sh
paperclipai policy create --key code-review --title "Code review" \
  --summary "Every change gets a second reviewer." --body-file review.md --status active
paperclipai policy update code-review --body-file review.md --change-summary "Two reviewers"
paperclipai policy update code-review --status archived
paperclipai policy delete code-review --yes
```

- A changed title or body saves a new revision. Pass `--base-revision-id` (API:
  `baseRevisionId`) to get `409` when someone saved a newer revision first.
- Archive a policy to retire it. The key stays reserved, so old
  `policy://<key>` references never point at a different policy.
- Delete works only on an archived policy. Any other status returns `409`.
- A duplicate key returns `409`.
