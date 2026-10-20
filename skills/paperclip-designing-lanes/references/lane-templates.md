# Lane Templates

Each template gives the stages of one work item, who owns each child, and a short worked example. The shape is always the same: a standing lane parent, one work-item parent per unit of work, one child per role. The lane lead owns the work item, creates the child for the next stage, and waits `blocked` on it. Names, identifiers, and commit SHAs below are examples.

Sources use the same notation as `SKILL.md`: `[paperclip § Section]` is a section of the `paperclip` skill; other sources are repository paths.

## Contents

- [Code lane](#code-lane)
- [Docs lane](#docs-lane)
- [Process or skill change lane](#process-or-skill-change-lane)
- [Watch lane](#watch-lane)
- [Intake and planning lane](#intake-and-planning-lane)
- [Optional post-merge Clean lane](#optional-post-merge-clean-lane)

## Code lane

Stages: plan (optional) → implement → review per routed lens at head H → verify → merge.

| Stage | Child assignee | Created when | Done means |
| --- | --- | --- | --- |
| implement (plan first, if needed) | implementer | work item starts | PR open and linked on this child as a `pull_request` work product, CI green, closing comment names head H |
| review: one per lens | one reviewer per lens | implement is `done` | verdict comment that names head H; `done` even when adverse |
| verify | verifier | every review is clean at H | evidence attached (test output, preview, screenshots) |
| merge | the agent or person allowed to merge | verify is `done` | PR merged at H |

- **Plan on the implement child.** For a large or risky change, the implementer saves a `plan` document on the implement child and, when approval is required, waits `in_review` on a confirmation [paperclip § Planning]. An accepted plan continues on the same issue [`doc/execution-semantics.md` § 7]. A separate plan child adds a cold start and splits one owner's work.
- **Route lenses by what changed.** Example lenses: security (auth, secrets, permissions), data (migrations), UI (pages, components), API contract (routes, CLI). A change that touches nothing risky can need one general review. Use one review child per lens, or one execution-policy stage per lens on the implement child; see "Choose one review tool per lens" in `SKILL.md`.
- **A verdict counts only at the head it reviewed.** If the PR head moves after a review, that verdict is stale. The one exception is a proven clean rebase: the same patch on a new base, with evidence such as `git range-diff` output showing no change, posted on the work item. Paperclip uses the same rule for confirmations: a newer document revision expires a pending confirmation as `stale_target` [paperclip § Issue-Thread Interactions].
- **The implementer waits for CI, nobody else.** It ends its turn with `issue wait`, naming the PR and head. The lead waits on blockers [paperclip § Monitors and Watchers].
- **Repairs reopen the implement child.** The lead comments the findings with `"reopen": true`. The implementer resumes its session on that issue. Reopen the review child for the new head the same way.
- **Merge belongs to the merge child.** If the instance turned on git status automation (off by default), a merged PR can also close a linked task. It ignores stacked merges and holds back on gated issues [`doc/ISSUE-GIT-LINKS.md`]. A lane does not depend on it.

**Worked example (`web-app`).**

1. Intake creates EX-210 "PR #412: add rate limiter" under lane parent EX-200, with the PR URL in the description. Lead: Lane Lead. Goal and project set.
2. Lane Lead links PR #412 on EX-210 as a `pull_request` work product. It creates EX-211 "Implement #412" for Coder, then blocks EX-210 on EX-211.
3. Coder links PR #412 on EX-211, pushes, and ends its turn with `npx paperclipai issue wait EX-211 --in 10m --reason "CI on PR #412 head 3f9c2e1"`. CI passes. Coder comments "Ready at 3f9c2e1" and marks EX-211 `done`.
4. The blocker wake brings Lane Lead back to EX-210, in the session it already has for that issue. The diff touches login code. Security Reviewer runs at low trust, so the lens gets its own child: EX-212 "Security review of PR #412 at 3f9c2e1". Lane Lead blocks EX-210 on it.
5. Security Reviewer finds a missing permission check, posts the verdict on EX-212, and marks it `done`.
6. Lane Lead reopens EX-211 with the finding. Coder fixes it at head 8a01b77 and marks it `done`. Lane Lead reopens EX-212 with "Re-review at 8a01b77". The verdict is clean.
7. Lane Lead creates EX-213 "Verify #412" for QA, then EX-214 "Merge #412 at 8a01b77" for Merger, one after the other. After the merge, Lane Lead marks EX-210 `done`.

## Docs lane

Stages: change check → draft → accuracy review → publish.

| Stage | Child assignee | Done means |
| --- | --- | --- |
| change check | no child: the watch or intake step | the source changed since the page was last verified; otherwise no work item exists |
| draft | writer | page edited; branch, PR, or `preview_url` work product attached |
| accuracy review | reviewer | each claim checked against the source at the draft revision; verdict on its own issue |
| publish | publisher | page live; final URL attached as a work product |

- One work item per page or per tightly linked page set. Ten pages in one issue have no clear status.
- The reviewer checks the draft revision it was given. A new draft revision needs a new verdict, as in the code lane.
- Put the source revision that the page now matches in the publish comment. The next change check compares against it.

**Worked example (`docs-site`).** A watch run finds that the `web-app` CLI added a `--dry-run` flag. It creates EX-240 "CLI reference: document --dry-run" under the docs lane parent EX-201. Docs Lead creates EX-241 for Writer (draft, preview attached), then EX-242 for Docs Reviewer ("check against `web-app` at 5d2b7a0"), then EX-243 for Publisher. Each child is created after the previous one is `done`. Docs Lead marks EX-240 `done` with the published URL.

## Process or skill change lane

Stages: draft → review → apply → verify live.

| Stage | Child assignee | Done means |
| --- | --- | --- |
| draft | author | proposal as a `plan` document, or a PR against the skill or instructions |
| review | reviewer | verdict on its own issue |
| apply | the owner allowed to make the change | change applied; this child is the implementer |
| verify live | verifier | the change works in real runs, with numbers |

- **Apply needs the right authority.** Agents create and manage only routines assigned to themselves [`references/routines.md` of the `paperclip` skill]. Only board users change a routine gate script [`server/src/services/routines.ts` `assertCanChangeGate`]. Company skill installs follow `references/company-skills.md` of the `paperclip` skill. When the change needs board consent, use `request_board_approval` [paperclip § Requesting Board Approval].
- **Live evidence needs real runs.** The apply child is the implementer, so it may end its turn with `issue wait` (for example `--in 24h --reason "first day of runs after the change"`). On the wake, it records before and after numbers from the [lane metrics](lane-metrics.md) and closes. The verifier then reads the same data independently.
- Name the metric that must move, and its current value, in the draft. A process change without a number to check cannot be verified live.

**Worked example.** Two database migrations were merged last week without a data review. EX-260 "Add a data lens to the code lane" is created under the process lane parent EX-202. Author drafts the change to the lane lead's review-routing instructions (EX-261). Reviewer approves it (EX-262). The apply child EX-263 belongs to the agent allowed to change those instructions. That agent applies the change, waits 24 h with `issue wait`, and records "work items with a migration and no data review: 2 last week, 0 since the change". Verifier confirms the count from the code lane's issue tree (EX-264).

## Watch lane

A watch lane looks at something outside Paperclip on a schedule. Its job is to find changes, not to fix them.

- **Check before the LLM runs.** Use the cheapest check that Paperclip supports:
  - A routine gate script [`packages/shared/src/routine-gate.ts`, `server/src/services/routines.ts`]:
    - It runs on a worker with no LLM before the routine wakes its agent.
    - Exit 1 skips the run at zero tokens. Exit 0 wakes the agent with the script output attached as untrusted context. Other exit codes, a timeout, or too much output fail open: the agent wakes with a failure note [`server/src/services/routine-gates/outcome.ts` `decideGateOutcome`].
    - By default, output that matches the last issue-creating run on the same trigger is also skipped (`routineNoopSkipSettings.skipUnchangedGateResult`, on unless set to `false`) [`packages/shared/src/routine-noop-skip.ts`]. Empty output is never treated as unchanged, so print what you found.
    - Only board users set or change a gate [`server/src/services/routines.ts` `assertCanChangeGate`]. The script is pinned at a commit in a repository on the instance allowlist.
    - The board or the routine's own agent can run it once with `POST /api/routines/{id}/gate/test`, which creates no run, issue, or wake [`server/src/routes/routines.ts`].
  - `activityGatePolicy: "require_external_activity"` when the watched thing is Paperclip activity [`references/routines.md` § Activity-Gated Scheduled Runs].
  - `routineNoopSkipSettings.skipUnchanged` skips a run whose inputs match the last run that changed nothing. It cannot see outside sources, so do not use it for a routine that polls an outside system [`docs/agents-runtime.md` § 3.2].
  - Without a gate, the first step of the run is the check. When nothing changed, close the run issue `done` with a one-line comment such as "No change since 5d2b7a0". A routine fire wakes with `issue_assigned`, and a run on that wake that ends with no issue comment can queue one follow-up wake to ask for it [`server/src/services/heartbeat.ts` `shouldRequireIssueCommentForWake`].
- **Create no issue when nothing changed.** A skipped routine run creates no issue and wakes no agent. Use `concurrencyPolicy: "skip_if_active"` or `"coalesce_if_active"` so that ticks do not stack [`references/routines.md` § Concurrency Policies].
- **A finding becomes a work item in the owning lane.** Create it under that lane's parent, assigned to that lane's lead, with `goalId`, `projectId`, and an `idempotencyKey` built from the finding's identity. Then close the run issue `done` with a comment that names the new work item. The watch run does not fix the finding.
- **Run a cross-lane watcher at standard trust.** A standard-trust agent can create an issue for another agent [paperclip § Delegating review tasks, courier pattern] and write to any issue it can see [`doc/SPEC-implementation.md` § 9.3.1]. A low-trust run can assign new issues only to itself or to agents inside its boundary [`doc/LOW-TRUST-PRESETS.md`], so it cannot hand a finding to another lane's lead.
- For alerts from an event source, repeats and recoveries arrive as comments on the same issue, not as new issues [`references/routines.md` § Event Triggers].

**Worked example.** A routine "Dependency advisories for `web-app`" runs every hour. Its gate script lists open advisories and exits 1 when there are none. One hour, it prints `GHSA-xxxx-yyyy in parser@2.1.0`. The routine creates a run issue and wakes Watcher. Watcher creates EX-270 "Upgrade parser for GHSA-xxxx-yyyy" under the code lane parent EX-200 with `idempotencyKey: "advisory:web-app:GHSA-xxxx-yyyy"`, then closes the run issue with "Filed EX-270". The next hour prints the same line, so the gate skips the run.

## Intake and planning lane

Intake turns requests into work items. It does not do the work.

- **Deduplicate before you create.**
  - Send an `idempotencyKey` built from the external identity (for example `pr:web-app:412`). A repeat create returns the first issue. Keys are kept for 7 days [`server/src/services/issues.ts` `ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS`].
  - Without `allowDuplicate`, an open issue with the same normalized title under the same parent, created in the last 48 h, is returned instead of a new one [`packages/shared/src/validators/issue.ts` `allowDuplicate`, `server/src/services/issues.ts` recent-open-title check].
  - For older items, check `POST /api/companies/{companyId}/issues/similar` (CLI `paperclipai issue similar`) [`server/src/routes/issue-duplicates.ts`], or search with `GET /api/companies/{companyId}/issues?q=...` [paperclip § Searching Issues].
- **Every work item gets** `parentId` (the lane parent), `goalId`, `projectId`, one assignee (the lane lead), and a self-contained description with acceptance criteria. Send `goalId` explicitly: `POST /api/companies/{companyId}/issues` copies the parent's project but not its goal, and without `goalId` it uses the project's goal or the company default [`server/src/services/issue-goal-fallback.ts`]. When the instance has isolated workspaces enabled, also send `executionWorkspacePreference: "isolated_workspace"`.
- **Start or park on purpose.** A work item that is assigned and `todo` starts automatically. Create work that must not start yet as `backlog`. Create it `blocked` with `blockedByIssueIds` when it waits for another issue [paperclip § Status Quick Guide, `doc/execution-semantics.md` § 8 Agent-assigned `todo` and Agent-assigned `backlog`].
- One-off plans go through `paperclip-converting-plans-to-tasks`. Intake handles the recurring stream.

**Worked example.** Three bug reports arrive from the support inbox. Two describe the same crash. Intake creates EX-280 "Crash on empty cart" with `idempotencyKey: "support:ticket-5521"`. For the second report, `issues/similar` finds EX-280, so Intake comments the extra report there instead. It creates EX-281 for the third report. Both work items go under the code lane parent EX-200 with the "Checkout reliability" goal and the `web-app` project.

## Optional post-merge Clean lane

Use this when review time blocks flow and a feature flag makes an early merge safe. The flag is a practice in the product code, not a Paperclip feature. Paperclip supplies the issues and the gate.

Stages: merge the whole change behind a flag → review and refactor on main → release gate.

| Stage | Child assignee | Done means |
| --- | --- | --- |
| merge behind flag | implementer | the whole change is merged with the flag off; one PR linked |
| clean review | reviewer | review of the merged code on main; verdict on its own issue |
| clean fix (only if the review finds problems) | implementer | follow-up PRs merged and linked on this child |
| release | the agent that turns the flag on | approval recorded; the flag is on |

- Record the release gate as `request_board_approval` linked to the release child [paperclip § Requesting Board Approval], or as an execution-policy `approval` stage on the release child [`references/api-reference.md` § Cross-Agent Review Gates of the `paperclip` skill].
- Create the release child only after the clean children are `done`. Code that is merged but not cleaned must not turn on.
- The cost: `main` carries unreviewed code behind a flag. Do not use this lane for security or data-migration changes.

**Worked example.** Work item EX-290 "New search page". Coder merges it dark in PR #430 on EX-291 (flag `search_v2` off). Reviewer's clean review EX-292 finds two problems. Coder fixes them in PR #433 on EX-293. Release Agent's EX-294 "Release search_v2" requests board approval. When it is approved, Release Agent turns the flag on and Lane Lead closes EX-290.
