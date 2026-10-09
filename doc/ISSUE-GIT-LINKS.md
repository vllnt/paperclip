# Issue git links

A task shows the branch name to copy and the pull requests linked to it. Pull requests link
themselves. A linked pull request can also move the task's status, behind a switch.

Product background and the full plan: [docs/product/issues-linear-grade.md](../docs/product/issues-linear-grade.md).

## The branch name

`GET /api/issues/{id}/git` returns `branch.name`. It is the name an agent workspace creates for
the same task, so a person and an agent who work on one task use one branch name:

```
PAP-123-fix-login-redirect        template: {{issue.identifier}}-{{slug}}
```

The name follows the same rules as the workspace runtime: a pinned `existingBranch` first, then
the task's `branchTemplate`, then the project's, then the default above. Changing the task title
changes the proposed name. It never breaks matching, because matching looks for the identifier
and ignores the slug.

CLI: `paperclipai issue git PAP-123 --branch` prints only the name.

## How a pull request links to a task

All matching runs inside one company. The identifier pattern is built from that company's own
prefix, so another company's identifiers cannot match.

| Signal | Links | A merge can complete the task |
|---|---|---|
| A person or agent links it by hand | yes | yes (unless `closes: false`) |
| The head branch is an agent execution workspace's branch | yes | yes |
| The identifier is in the head branch name (`pap-123-...`, any case) | yes | yes |
| A closing word and the identifier in the title or body: fixes, closes, resolves, completes, implements | yes | yes |
| `[PAP-123]` in the title | yes | yes |
| `refs`, `part of`, `related to`, `contributes to`, or a bare identifier | yes | no |
| `skip PAP-123` or `ignore PAP-123` in the title or body | no, for that identifier | n/a |

A later signal with no text (a relay event) never removes what an earlier one found. A pull
request that an agent attached by hand to the same task is adopted, not duplicated.

Each link is a `pull_request` work product, so the existing pull request cards show it.
Unlinking a pull request keeps the row but hides it everywhere, and automatic matching leaves it
unlinked. Linking it again by hand undoes that.

### Fork pull requests

A pull request whose head branch is in another repository is **unverified**, however it was
linked: by branch name, by an agent workspace branch name, by text, or by hand. It links, and the
panel labels it, but status automation ignores it. Anyone can open a fork pull request with any
branch name or text, so none of those prove where it came from.

While the head repository is unknown, Paperclip reads it from GitHub. If it still cannot tell,
the link stays unverified, except a link a person or agent made by hand, which is trusted until
GitHub shows the head is a fork.

## Status automation

Off by default. Turn it on for the instance:

```
PATCH /api/instance/settings/general   { "gitStatusAutomation": true }
```

With the switch on, the verified pull requests that close a task decide its status:

| Linked pull requests | Task status becomes |
|---|---|
| A ready pull request is open | `in_review` (from `backlog`, `todo`, `in_progress`) |
| Only draft pull requests are open | `in_progress` (from `backlog`, `todo`) |
| One merged into the default branch, none still open | `done` |
| All closed without a merge, and automation moved the task | the status it had before |

A pull request merged into another branch (a stacked pull request) never completes the task.

Automation holds back, and records why, when any of these is true:

| Code | Reason |
|---|---|
| `disabled` | The switch is off |
| `unverified` | No linked pull request is verified |
| `refs_only` | No verified pull request closes the task |
| `ineligible` | The task is hidden, done, cancelled, blocked, has no assignee, or does not belong to people and agents (routines, recovery, watchdogs, plugin-mirrored tasks) |
| `gated` | The task has an execution policy or a review policy |
| `active_run` | An agent run holds the task |
| `pending_confirmation` | A confirmation is waiting on a person |
| `manual_change` | Someone changed the status by hand after automation did |

Each move writes an `issue.git_status_automated` activity entry from `system:git-link`. It does
not post a comment, so it does not wake an agent.

## Where pull request facts come from

| Source | How | Works without webhooks |
|---|---|---|
| Linked by hand | `POST /api/issues/{id}/git/pull-requests`, `paperclipai issue git:link`, or an agent through the MCP `paperclipApiRequest` tool | yes |
| Paperclip Cloud relay events | The existing GitHub connection event poll | yes |

A relay event carries the branch, state, and merge flag, but not the title or body. The service
reads the rest from GitHub only when it needs it (head repository, default branch, draft flag).

## Safety

- No schema change. Links are stored in `issue_work_products.metadata.git`.
- Writes for one pull request run under a database advisory lock, so two deliveries at once leave
  one row. A stale event (older than the stored update time) changes nothing.
- A failure while linking never fails the event delivery.
- Agents can link and unlink only on tasks assigned to them. Board users with company access can
  do it on any task. Reads follow normal company access, and another company's task answers `404`.

## Surfaces

| | |
|---|---|
| REST | `GET /api/issues/{id}/git`, `POST /api/issues/{id}/git/pull-requests`, `DELETE /api/issues/{id}/git/pull-requests/{workProductId}` |
| CLI | `paperclipai issue git`, `issue git:link`, `issue git:unlink` |
| Agent tools | Agents call the REST routes with the MCP `paperclipApiRequest` tool, or run the CLI. See below. |
| Web | Git section in the issue Properties panel |

### Agent tools

An agent reads or links through the REST routes. With the MCP server, use `paperclipApiRequest`:

```
paperclipApiRequest { "method": "GET", "path": "/issues/PAP-123/git" }
paperclipApiRequest { "method": "POST", "path": "/issues/PAP-123/git/pull-requests",
                      "jsonBody": "{\"url\":\"https://github.com/acme/app/pull/7\"}" }
```

There are no dedicated MCP tools for this feature yet, on purpose. The runner capability
inventory (`packages/paperclip-runner/spec/capability`) treats the MCP tools as a fixed legacy
set of 42. Every tool has a fold target there, and the generated files need the external eval
corpus (`PAPERCLIP_EVALS_ROOT`). A build that adds a tool fails the production image check.
Dedicated agent tools should be added through that inventory, with the corpus available.

