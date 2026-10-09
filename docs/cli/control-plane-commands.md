---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
npx paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
npx paperclipai issue get <issue-id-or-identifier>

# Create issue
npx paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
npx paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
npx paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
npx paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
npx paperclipai issue release <issue-id>
```

### Issue Tree

```sh
npx paperclipai issue tree <issue-id> [-C <company-id>] [--json]
```

Prints the issue and its sub-issues as an indented tree, one line per issue:
`identifier [status] assignee=<agent name | user:<id> | -> lastRun=<status(errorCode) age | ->  title`.
Agent names are looked up with the company ID (`-C`, context, or
`PAPERCLIP_COMPANY_ID`); without one, agent IDs are shown. Nodes you cannot read
are omitted and counted in a footer line. `--json` prints the raw
`GET /api/issues/{issueId}/diagnostics/subtree` response.

### Issue Recovery Actions

```sh
# Open recovery actions across a company, newest first
npx paperclipai issue recovery-actions:list [-C <company-id>] [--status active,escalated] [--limit 50] [--json]

# The open recovery action of one issue
npx paperclipai issue recovery-actions <issue-id>

# Resolve a recovery action
npx paperclipai issue recovery:resolve <issue-id> --outcome restored --source-issue-status todo \
  [--action-id <id>] [--resolution-note "..."]

# Resolve an execution recovery with a reconciliation (board only)
npx paperclipai issue recovery:resolve <issue-id> --outcome restored --source-issue-status todo \
  --reconciliation-run-id <run-id> --provider-stopped --action-outcome completed \
  --outcome-evidence "..." [--workspace-repair-evidence "..."]
```

`recovery-actions:list` statuses are `active`, `escalated`, `resolved`, and
`cancelled`; the default is the open ones (`active,escalated`). The limit is
1-200 (default 50). The list is read-only and does not re-check stale actions.
For `recovery:resolve`, any reconciliation flag sends an `executionReconciliation`
object; `--provider-stopped` is required in that case, and evidence texts need
20-12000 characters.

## Company Commands

```sh
npx paperclipai company list
npx paperclipai company get <company-id>
npx paperclipai company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
npx paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
npx paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
npx paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

`company import` is unavailable against cloud-managed instances — the
server answers `403` with `code: "cloud_managed"`. Export remains available
there.

With agent authentication, use `company list` or `company current` to resolve
the scoped company. `company list` first tries the board-wide list; if that is
forbidden, it falls back to `--company-id`, `PAPERCLIP_COMPANY_ID`, context, or
`/api/agents/me` and returns only that scoped company. `company create` requires
board/instance-admin authentication because it is an instance-wide setup
command.

## Agent Commands

```sh
npx paperclipai agent list
npx paperclipai agent get <agent-id>

# Config history
npx paperclipai agent config-revisions <agent-id>
npx paperclipai agent config-revision:get <agent-id> <revision-id>
npx paperclipai agent config-revision:diff <agent-id> <revision-id> [--json]
npx paperclipai agent config-revision:rollback <agent-id> <revision-id>
```

`config-revision:diff` prints one line per changed leaf as
`path: before -> after` (`(unset)` marks an added or removed key). Arrays are
compared as whole values. Secret values are redacted by the server, so a key the
server recorded as changed with no visible difference prints as
`<key>: changed (values redacted)`. `--json` prints
`{ changedKeys, changes: [{ path, kind, before, after }], redactedOnlyKeys }`.

## Skills Commands

```sh
# Browse app-shipped catalog skills without changing company state
npx paperclipai skills browse [--kind bundled|optional] [--category software-development] [--query github]
npx paperclipai skills search "pull request" [--json]

# Inspect catalog metadata and file inventory before install
npx paperclipai skills inspect github-pr-workflow

# Install a catalog skill into the company skill library
# This does not attach the skill to any agent.
npx paperclipai skills install github-pr-workflow --company-id <company-id>
npx paperclipai skills install github-pr-workflow --as pr-flow --force --company-id <company-id>

# External sources still use import instead of catalog install
npx paperclipai skills import ./skills/my-skill --company-id <company-id>
npx paperclipai skills import owner/repo/path/to/skill --company-id <company-id>

# Attach desired company skills to an agent after install/import
npx paperclipai skills agent sync <agent-id> --skill github-pr-workflow --mode add --company-id <company-id>
```

### Company Skill Versions

```sh
# List saved versions of a company skill, newest revision first
npx paperclipai skill versions <skill-id> [-C <company-id>]

# Get one version, including the content of every file
npx paperclipai skill version:get <skill-id> <version-id> [-C <company-id>]

# Unified line diff of the files between two versions
npx paperclipai skill version:diff <skill-id> <from-version-id> <to-version-id> [-C <company-id>] [--json]
```

`version:diff` fetches both versions and diffs their files client-side: one
`--- a/<path>` / `+++ b/<path>` block with `@@` hunks (3 lines of context) per
added, removed, or modified file. Base64 (binary) files print
`Binary file <path> differs`; an executable-bit change prints
`executable: false -> true`. `--json` prints
`{ fromVersionId, toVersionId, fromRevisionNumber, toRevisionNumber, files: [{ path, change, binary, diff }] }`.

## Approval Commands

```sh
# List approvals
npx paperclipai approval list [--status pending]

# Get approval
npx paperclipai approval get <approval-id>

# Create approval
npx paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
npx paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
npx paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
npx paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
npx paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
npx paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
npx paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
npx paperclipai dashboard get
```

## Instance Settings

```sh
npx paperclipai instance settings:general
npx paperclipai instance settings:general:update --payload-json '{...}'
npx paperclipai instance settings:experimental
npx paperclipai instance settings:experimental:update --payload-json '{...}'
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

## Heartbeat

```sh
npx paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
