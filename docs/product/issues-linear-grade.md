# Linear-grade issues for Paperclip (agents first)

Status: Phase 1 research and design, 2026-10-09. Slice 1 is built from this doc.
Scope: Paperclip tasks ("issues") become a tracker people and agents want to use
instead of GitHub Issues. This doc is generic: nothing here is specific to one company.

## 1. Summary

Three asks: a branch name to copy per task, PRs that link themselves to tasks, and
auto-assignment per project. The code reading says:

- The pieces exist but are not joined. Tasks have stable ids (`PAP-123`), agents already
  get branches named `PAP-123-<slug>`, PRs can be stored as work products, and the UI
  renders PR cards. Nothing connects a PR to a native task, and no code changes a task's
  status when a PR opens or merges.
- The GitHub plugin only links PRs to tasks that were mirrored from a GitHub issue, and
  only through GitHub's own `closedByPullRequestsReferences`.
- On a Tailnet-only deployment (anthm) GitHub webhooks are off and the plugin's one-minute
  sync lists issues, not PRs. A webhook-only design would never fire there.
- Project leads are stored but never used. No project default assignee exists.

Recommendation: build one company-fenced core service that turns "a PR exists with these
facts" into links and status changes, and feed it from three adapters (explicit link, Cloud
relay events, plugin poll). Ship status automation dark and enable it deliberately.

```
 human / agent / CLI ──► POST /issues/:id/git/pull-requests ─┐
 Cloud relay events  ──► github-connection-events.ts ────────┼─► issue-git-links service
 plugin one-minute poll ─► host call (new, narrow) ──────────┘     │
                                                                    ├─ match (company-scoped)
                                                                    ├─ store (issue_work_products)
                                                                    └─ status automation (guarded)
```

## 2. Method and trust

- Paperclip column: read from this repo at `a91d77cc4` (file:line evidence in section 4).
- Competitor columns: official docs, fetched 2026-10-09 by research subagents. Cells are
  marked `?` where no official page was found. Cells marked `†` come from general product
  knowledge and were not re-verified in this pass. Source URLs are in the appendix.
- `doc/TASKS.md` and `doc/TASKS-mcp.md` describe a target model (teams, estimates, due
  dates, milestones). None of it exists in code, so it is not counted as "today".

## 3. Feature matrix

Legend: `●` yes · `◐` partial, paid tier or limited · `○` no · `?` not found · `†` unverified.
Columns: Linear · GitHub Issues + Projects v2 · Jira · Shortcut · Plane · GitLab · Paperclip today.

### A. Model

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Sub-issues | ● | ● 8 levels, 100 each | ● | ● | ● | ● | ● `parentId`; no depth cap |
| Blocks / blocked-by | ● | ● | ● | ● | ● † | ◐ Premium | ● `blockedByIssueIds`, cycle checks |
| Duplicate / related | ● † | ◐ "duplicate of" comment | ● | ○ | ◐ | ◐ relates | ○ (create-time dedup; #40 open) |
| Per-team or project workflows | ● per team, 5 categories + Triage | ◐ Projects Status field | ● | ● | ● | ◐ scoped labels | ○ fixed 7 statuses |
| Priority | ● † | ◐ org issue field (preview) | ● | ? | ● | ◐ | ● 4 levels |
| Estimates | ● † | ◐ Effort field | ● | ? | ● | ● | ○ |
| Labels | ● groups | ● | ● | ● | ● | ● scoped | ◐ company-level, no edit |
| Due dates | ● † | ◐ Target date field | ● | ? | ● | ● | ○ |
| Custom fields | ○ † | ● typed, searchable | ● | ? | ● | ◐ | ○ |

### B. Planning

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Projects | ● | ● | ● | ● | ● | ● | ● (`leadAgentId` stored, unused) |
| Cycles / sprints | ● | ◐ iteration field | ● | ● | ● | ● | ○ |
| Milestones | ● per project | ● per repo | ● versions | ◐ | ◐ modules | ● | ○ |
| Roadmap / initiatives | ● | ◐ roadmap layout, no initiatives | ● | ● | ● | ● | ◐ goals hierarchy |

### C. Intake and automation

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Triage inbox | ● accept, decline, duplicate, snooze | ○ | ◐ JSM intake | ○ | ● separate Triage state | ◐ Service Desk | ○ |
| Templates / forms | ● | ● issue forms (preview) | ● | ? | ● | ● | ○ |
| Recurring issues | ● | ○ | ● scheduled rule | ? | ● | ○ | ● routines |
| SLAs | ◐ † | ○ | ● JSM | ○ | ○ | ◐ † | ○ |
| Rules engine | ◐ triage rules | ◐ Projects workflows | ● | ◐ | ● | ◐ triage bot | ◐ plugin sync rules |

### D. Views and daily use

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Saved, shared views | ● | ● | ● | ● | ● | ● | ◐ per-user client filters |
| Query language | ◐ filters | ● qualifiers | ● JQL | ● operators | ● | ● | ◐ lexical search, exact id |
| Keyboard-first UI | ● | ◐ | ◐ | ● | ◐ | ◐ | ◐ inbox keys, `c`, `/` |
| Notifications / inbox | ● | ● | ● | ● | ● | ● | ◐ inbox, no email/push |
| Subscribers / watchers | ● | ● | ● | ● | ● | ● | ○ |

### E. Git integration (what slice 1 targets)

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Copy branch name | ● shortcut, format setting; optional assign-me + start | ● `gh issue develop`, sidebar | ● dev panel | ● `sc-<id>` | ? | ● `%{id}-%{title}`, editable | ◐ agent workspaces only |
| Auto-link by branch name | ● | ◐ only branches made from the issue | ● key in branch | ● | ? | ● `123-` prefix | ○ |
| Auto-link by PR title/body | ● | ◐ keywords only | ● title | ● title, body, comments | ● `[KEY]` | ● MR description | ○ |
| Magic words | ● fixes, closes, resolves, completes, implements; refs, part of | ● close/fix/resolve + forms | ◐ smart commits `#done` | ◐ | ◐ brackets | ● close, fix, resolve, implement | ○ |
| Status on PR open / merge / close | ● per team, per target branch (regex) | ◐ close on merge to default; Projects workflows | ● Automation rules | ● event handlers | ● incl. closed-without-merge | ◐ close on merge to default only | ○ |
| Several PRs per issue | ● moves after the last | ● lists all | ● OPEN > MERGED > DECLINED, with count | ● other open PR holds | ? | ? | ○ |
| Opt-out token | ● `skip`, `ignore` | ○ | ○ | ● `skip-sc` | ○ | ○ | ○ |
| Fork and permission rules | ? | ● default branch only | ? | ? | ? | ● default branch, merger rights | ○ |

### F. Assignment and agents

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Project or component default assignee | ○ (templates, triage owner) | ○ | ● lead / component lead | ○ | ● default + intake owner | ○ | ◐ lead stored, unused |
| Round-robin, load-balanced rules | ◐ triage responsibility + rules; no round-robin documented | ○ | ● | ○ | ◐ | ◐ triage bot | ◐ plugin rules, GitHub-origin only |
| Capacity or model aware | ○ | ○ | ◐ JSM, humans | ○ | ○ | ○ | ◐ `maxConcurrentRuns` unused for routing |
| Agent as assignee | ● delegate | ● Copilot | ● Rovo | ◐ | ● | ● Duo | ● native (checkout, runs, policy) |
| Human stays accountable | ● assignee + delegate | ◐ | ◐ | ? | ? | ? | ◐ `responsibleUserId` |

### G. Insight and integration

| Capability | Linear | GitHub | Jira | Shortcut | Plane | GitLab | Paperclip today |
|---|---|---|---|---|---|---|---|
| Analytics | ● | ◐ Projects charts | ● | ● cycle/lead time | ● | ◐ | ○ for issues (cost and run stats only) |
| Public API | ● GraphQL | ● REST + GraphQL | ● REST | ● REST v3 | ● | ● | ● REST + runtime OpenAPI |
| Webhooks | ● signed | ● signed | ◐ API ones expire in 30 days | ● † | ● signed | ● † | ◐ plugin events, routine triggers |
| Official MCP | ● | ● | ● remote | ● hosted | ● MIT | ● GA 19.5 | ◐ no work-product/label/relation tools |
| CLI | ○ (importer only) | ● `gh` | ● `acli` | ? | ? | ● `glab` † | ◐ no relations or label assignment |
| GitHub Issues sync | ● one- or two-way, new issues | n/a | ○ | ○ | ● two-way | ◐ † | ◐ title/body/state, polled |

### What Paperclip has that none of these do

Keep these; do not flatten them to match a competitor: atomic checkout with run ownership,
execution and review policy with approval gates, issue documents with revisions, thread
interactions (confirmations that resolve on PR merge), work products, tree holds, routines
as recurring agent work, and per-run audit.

## 4. Paperclip today: what the code does

| Area | Finding | Evidence |
|---|---|---|
| Identifiers | `PAP-123`: company `issuePrefix` + counter, unique across the instance | `packages/db/src/schema/issues.ts:136`, `companies.ts:13`, `server/src/services/issues.ts:10152-10161` |
| Statuses | Fixed: backlog, todo, in_progress, in_review, done, blocked, cancelled. `in_progress` needs an assignee | `packages/shared/src/constants.ts:189`, `server/src/services/issues.ts:9830` |
| Agent branch name | Default `{{issue.identifier}}-{{slug}}`, 120 chars, per-project template | `server/src/services/workspace-runtime.ts:3268`, `ui/src/components/ProjectProperties.tsx:871` |
| Branch to issue | `execution_workspaces.sourceIssueId` + `branchName`, indexed on `(companyId, branchName)` | `packages/db/src/schema/execution_workspaces.ts:22,30,63` |
| PR storage | `issue_work_products` type `pull_request`, metadata `repo`, `number`, `headRef`, `baseRef`, `state`; PR card UI | `server/src/services/work-products.ts:87-130`, `ui/src/components/artifacts/IssueArtifactCard.tsx:228` |
| PR creation of that row | Manual only (API `POST /issues/:id/work-products`) | `server/src/routes/issues.ts:10810` |
| Core PR events | Cloud-relay `pull_request` events update `external_objects` and sweep merge confirmations. Payload has repo, number, state, merged, headRef, baseRef; no title, body, or head repo | `server/src/services/github-connection-events.ts:95-120,238-270` |
| Company fence in that path | Event → installation binding → `companyId`; per-company delivery receipts | `github-connection-events.ts:339-370,492-505` |
| Plugin PR links | Only for tasks mirrored from a GitHub issue (`closedByPullRequestsReferences`) | `packages/plugins/plugin-github/src/task-links.ts:20,60-85` |
| Plugin sync | Issues only (`row.pull_request` filtered out). PR handling is webhook-only or on demand | `plugin-github/src/github.ts:290`, `sync.ts:524-560` |
| Deployment | anthm is Tailnet-only: webhooks off, scheduled sync is the event path | `plugin-github/README.md:35,314` |
| Status ownership | Mirrored GitHub tasks: sync maps open→todo, closed→done. `execution policy` and approval stages are row-locked and re-authorised | `plugin-github/src/sync.ts:30-32`, `server/src/services/issue-execution-policy.ts:1217` |
| Merge-aware workflow | A pending `request_confirmation` that names a PR auto-accepts on merge and wakes the assignee | `server/src/services/issue-thread-interactions.ts:2840` |
| Auto-assignment | None. `leadAgentId` is only exported/patched. Routines use a fixed assignee. Plugin rules cover GitHub-origin tasks | `packages/db/src/schema/projects.ts:15`, `plugin-github/src/sync.ts:46-95` |
| Surfaces | REST (~90 issue routes), runtime OpenAPI, CLI `issue` group, MCP (create/update/checkout/documents) | `server/src/routes/openapi.ts:4100`, `cli/src/commands/client/issue.ts`, `packages/mcp-server/src/tools.ts` |
| "Project 34" | Not in code. It is data: a GitHub Projects v2 board the plugin browses and edits; Project fields are not mirrored into tasks | `plugin-github/src/management-projects.ts`, README "Boundaries" |

Invariants any design here must keep: single assignee, atomic checkout, company scoping on
every row and route, activity logging on mutations, `statusVersion` bumps, review/approval
gates (never bypass with a plain status write), and the partial unique indexes that allow
one open issue per origin kind.

## 5. Gap analysis

| Gap | Hurts | Slice |
|---|---|---|
| No human-facing branch name | Humans guess names; agent and human branches differ | 1 |
| PR never links to a native task by itself | Cannot leave GitHub Issues | 1 |
| No status change on PR events | Tasks drift from reality | 1 |
| Poll-only deployments get no PR events | anthm gets nothing from a webhook design | 1 |
| Lead and capacity data unused | Every new task needs a hand-off | 3 |
| No triage, templates, SLAs | Outside issues land in `todo` untouched | 4 |
| GitHub Issues mirror is the only intake | GitHub stays the source of truth | 5 |
| No estimates, due dates, cycles | Cannot plan | 6 |
| No shared views, subscriptions | Weak for humans | 7 |

## 6. Design

### 6.1 Principles

1. Agents first, humans well served: every capability exists as REST + OpenAPI, CLI, MCP tool,
   and web UI. The web UI is the thinnest of the four.
2. Reuse what exists: work products for storage, the workspace renderer for branch names,
   `issueService.update` and the execution-policy transition for status.
3. One core service, many adapters. Adapters only normalise facts; they never decide.
4. Ship dark: linking is on; status automation is off until an operator enables it.
5. No schema change in slice 1 (the live database stays untouched; #40 already owns
   migration 0296).

### 6.2 Branch names

`branchName(issue, template?) = sanitize(render(template ?? "{{issue.identifier}}-{{slug}}"))`

- Same function as the agent workspace renderer, so a human and an agent get the same name for
  the same task: `PAP-123-fix-login-redirect`. It honours the project's `branchTemplate`.
  The renderer moves to `packages/shared`; `workspace-runtime.ts` imports it. No behaviour change.
- Case is kept (`PAP-123-…`) because that is what existing agent branches use; matching is
  case-insensitive. Renaming the title changes the proposal, never the matching.
- Shown in the issue header with a copy button and the command `git switch -c <name>`.
- Read model: `GET /api/issues/{id}/git` returns `branch.name`, `branch.command`, `branch.template`.

### 6.3 PR linking

A signal is the normalised fact set, whatever its source:

```
PullRequestSignal {
  provider: "github", repository: "owner/name" (lowercase), number, url,
  title?, body?, headRef, baseRef, headRepository?, defaultBranch?,
  state: open|closed, draft?, merged, updatedAt, deliveryId?,
  source: manual | agent | cloud_event | plugin_poll
}
```

Matching runs inside one `companyId`. Candidates, strongest first:

| # | Signal | Result |
|---|---|---|
| 1 | Manual link by a person or agent | link, closes (sticky) |
| 2 | `execution_workspaces.branchName = headRef` (+ repo) | link, closes |
| 3 | Company identifier in `headRef` (`PAP-123`, case-insensitive, not inside a longer token) | link, closes |
| 4 | Closing word + id in title/body: fixes, closes, resolves, completes, implements; or `[PAP-123]` in title | link, closes |
| 5 | `refs`, `part of`, `related to`, `contributes to`, or a bare id in title/body | link only |
| – | `skip PAP-123` or `ignore PAP-123` in title/body | no link for that id, overrides 2-5 |

Rules:
- The id pattern is built from the company's own prefix, so another company's ids cannot
  match. Lookups always filter on `companyId`. This is the isolation guarantee.
- Re-evaluated on every signal (opened, edited, synchronize, reopened, poll), so a late
  fix to the title or body links the PR on the next pass.
- Max 10 issues per PR and 25 PRs per issue. Body and title are cut at 24k characters
  before matching; patterns are linear-time.
- A fork PR (`headRepository ≠ repository`) is stored as `verified: false`: visible, labelled,
  and excluded from automation. A person can confirm it (manual link). When the head
  repo is unknown (Cloud payload), the link is unverified unless rule 2 matched.
- Only a merge into the repo default branch counts as "merged for closing". A PR into
  another PR's branch (a stack) stays linked and never completes the task.
- Storage: one `issue_work_products` row per (issue, PR). `externalId = owner/repo#pull/N`,
  `provider = github`, `type = pull_request`, `metadata.git = { linkedBy, closes, verified,
  suppressed, remoteUpdatedAt, automation }`. Existing PR cards render it unchanged. A PR
  work product that an agent already attached by hand (same URL, or same repo and number)
  is adopted and annotated, never duplicated.
- Idempotency: writes run under `pg_advisory_xact_lock(hash(companyId, externalId))` with
  select-then-upsert; stale events are dropped by comparing `remoteUpdatedAt`; webhook
  redelivery is absorbed by the existing `connection_event_deliveries` receipt. No unique
  index is added in slice 1 (existing duplicates would fail it on a live table).
- Unlink sets `suppressed` so automatic matching does not re-add it; a manual link clears it.

### 6.4 Status automation

For each issue, derive state from its verified, closing PRs, then apply one move.

```
open PR (ready) ........ status in {backlog, todo, in_progress}  ──► in_review
draft PR only .......... status in {backlog, todo}               ──► in_progress
all closing PRs closed,
  none merged .......... status = what automation set            ──► previous status
merged into default,
  no PR still open ..... status in {todo, in_progress, in_review} ──► done
```

Guards, in order. Any failing guard leaves status alone and records why in
`metadata.git.automation.deferred`:

1. Instance switch off (default) → link only.
2. Issue is hidden, done, cancelled, or blocked → link only.
3. Origin is not `manual` or `chat_channel` (routine, recovery, watchdog, plugin-mirrored
   GitHub tasks stay with their owner) → link only. Mirrored GitHub tasks move to slice 5.
4. A run holds the issue (`executionRunId` or `checkoutRunId`) → defer. The agent sets
   its own status; the next signal re-checks.
5. A pending merge confirmation names this PR (`request_confirmation`) → defer to the
   existing sweep and the woken assignee.
6. Execution policy has review/approval stages → go through
   `applyIssueExecutionPolicyTransition`; if it does not allow `done`, move to `in_review`
   instead. Gates are never skipped.
7. Compare-and-set on `statusVersion`. If a person or agent changed the status after the
   automation's last move, automation stops touching that issue (`suspended: manual_change`).

Each move writes activity `issue.git_status_automated` with `_previous.status`, actor
`system:git-link`, and the PR. No comment is posted (comments wake agents).

### 6.5 Auto-assignment per project (slice 3)

- Project settings (new table, company-scoped): `mode: off | lead | rules`, `defaultAssignee`
  (agent or user), ordered `rules`, `pool`.
- Rule: `when` label, origin, priority, title pattern → `assign` agent, user, or pool.
- Pool strategies: `least_loaded` (open assigned work), `round_robin`.
- Agent eligibility: passes `getAgentWorkEligibility`; under `maxConcurrentRuns` and an
  open-work cap; adapter or model matches the rule's requirement.
- Human override always wins: assigns only when no assignee is set; a person assigning or
  clearing an assignee records `autoAssignSuppressed`; automatic assignment never
  reassigns. Every automatic assignment logs the rule that fired.
- Triggers: issue created without assignee, label added, leaving triage.
- Respects the single-assignee invariant and `responsibleUserId` (the human who stays
  accountable when an agent does the work).

### 6.6 Bypassing GitHub Issues (slice 5)

- Paperclip is the source of truth. GitHub Issues becomes an optional, one-way publish for
  people who live on GitHub; the existing two-way mirror stays available per project.
- Migration of existing mirrors: an `adopt` action per project turns mirrored tasks into
  native ones (keeps ids, history, links), posts a pointer comment on each GitHub issue, and
  optionally closes it as not planned. Reversible until the GitHub issue is closed.
- Inbound GitHub issues from outsiders land in triage (slice 4), not `todo`.
- `Fixes PAP-123` works from day one; `Fixes #45` keeps working for mirrored tasks via the plugin.

### 6.7 Four surfaces, slice 1

| Capability | Web | REST + OpenAPI | CLI | Agent tool (MCP) |
|---|---|---|---|---|
| Branch name | header chip, copy, `git switch -c` | `GET /api/issues/{id}/git` | `issue git <id>` | `paperclipGetIssueGit` |
| Linked PRs | "Pull requests" section, provenance, verify, unlink | same read; `POST /api/issues/{id}/git/pull-requests`; `DELETE …/{workProductId}` | `issue git:link <id> <url>`, `issue git:unlink` | `paperclipLinkPullRequest` |
| Automation switch | Instance settings toggle | `PATCH /api/instance/settings/general` (`gitStatusAutomation`) | existing settings command | n/a |

Agent docs go in a new reference file, not `skills/paperclip/SKILL.md` (heading line
numbers are anchored by the production image build).

## 7. Slice plan (stacked PRs, each shippable)

| # | Slice | Contents | Unlocks |
|---|---|---|---|
| 1 | Git links | Branch name; PR auto-link (explicit, Cloud relay, plugin poll); guarded status automation, dark by default; API, OpenAPI, CLI, MCP, web | Leave GitHub Issues for PR tracking |
| 2 | Git depth | Per-project automation config, target branches with regex and a "no action" override (Linear), draft handling; commit and trailer linking; checks and review state in the panel; "ready for merge" state; re-check when a run ends; optional "copy branch also assigns me and starts the task" (Linear's personal toggle); unique index on a new link table | Trust to turn automation on everywhere |
| 3 | Auto-assignment | Project assignment settings; lead default; rules; capacity and model aware pools; override semantics | No manual hand-off |
| 4 | Intake and triage | Triage queue, templates and forms, due dates and SLAs, duplicate detection (#40), GitHub issues into triage | Real intake |
| 5 | GitHub Issues bypass | Adopt and migrate mirrors, one-way publish, Projects field mapping | Retire GitHub Issues |
| 6 | Planning | Estimates, due dates, cycles, milestones, related/duplicate relations, typed searchable fields (GitHub issue fields), status categories per project | Plan work |
| 7 | Views and daily use | Shared views, query syntax, command palette, subscriptions, email and push | Human comfort |
| 8 | Insights | Cycle time, throughput, burn-up, agent and human load | Measure |

Slice 1 is deliberately free of schema changes and of edits to the busiest files
(`routes/issues.ts`, `cli/.../issue.ts`, `shared/src/index.ts` keep one-line registrations).

## 8. Slice 1 proof plan

RED first, then GREEN:

- Unit: branch renderer parity with the workspace runtime; id extraction and precedence;
  skip tokens; closing vs refs words; adversarial inputs (long body, lookalike ids).
- Service (embedded Postgres): link by workspace branch, branch id, keyword; company A's PR
  never links company B's task even with identical numbers and a shared repo; fork PR is
  unverified; stacked PR never completes; redelivery and out-of-order events change nothing
  twice; every status guard in 6.4.
- Routes: board and agent authorisation, company access, idempotent POST, unlink suppression.
- Plugin: poll adapter reports only repos linked to the company's projects.
- CLI and MCP: payload shapes. UI: component tests plus a real browser pass at desktop
  and mobile widths with zero console errors.
- Live-DB safety: no migration. Enabling status automation is an explicit settings change.

## 9. Risks and open questions

- Status automation default stays off in slice 1. After a soak on one project, flip it in
  slice 2 with per-project control.
- On merge, should agent-owned tasks go straight to `done`, or wake the assignee for
  post-merge checks? Slice 1 keeps `done` guarded by 6.4 rules 4-6; revisit with data.
- Plugin poll needs a new narrow host call in the plugin SDK. If it grows, it ships as a
  stacked part 1b so the core PR is not blocked.
- Branch case: kept as the agent default. A lowercase option can come with templates.

Coordination: #22 (API coverage matrix: add rows when it lands), #33-#38 (CLI/API parity:
slice 1 adds its own CLI file), #40 (migration 0296: slice 1 adds none), #29 and #27
(status and wait semantics: automation defers while a run or monitor holds the issue).

## Appendix: sources (fetched 2026-10-09)

- Linear: https://linear.app/docs/github · https://linear.app/docs/code-and-reviews · https://linear.app/docs/triage · https://linear.app/docs/assigning-issues · https://linear.app/developers/agents · https://linear.app/developers/webhooks
- GitHub: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue · https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-a-branch-for-an-issue · https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
- Jira: https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/ · https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/
- Shortcut: https://www.shortcut.com/help/integrations/github/
- Plane: https://docs.plane.so/integrations/github · https://docs.plane.so/core-concepts/intake
- GitLab: https://docs.gitlab.com/user/project/issues/managing_issues/ · https://docs.gitlab.com/user/project/repository/branches/
