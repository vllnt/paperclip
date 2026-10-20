---
name: paperclip-designing-lanes
description: >
  Design recurring Paperclip workflows ("lanes") so agents run them
  efficiently and reliably. Use when setting up, reviewing, or repairing a
  standing process such as code review and merge, docs upkeep, process
  changes, watchers, or intake: issue shape, ownership, waiting, routines,
  and the checks that prove a lane works.
---

# Paperclip — Designing Lanes

A companion to `paperclip-converting-plans-to-tasks`. That skill turns a one-off plan into an issue graph. This skill designs a **lane**: a recurring workflow that agents run many times, such as "review and merge pull requests for `web-app`" or "keep `docs-site` accurate". A good lane wakes the right agent once per real event, resumes context instead of starting cold, and always shows who owns the next step.

For the API mechanics (checkout, status, comments, blockers, monitors, routines), follow the `paperclip` skill. This skill uses only what Paperclip does today. Each rule names its source: `[paperclip § Section]` is a section of the `paperclip` skill; other sources are repository paths, with the function or section to read.

## How sessions work

The lane shape follows from one fact. Paperclip saves an agent's session per issue and resumes it on that agent's next wake on the same issue. The task key of an issue wake is the issue id [`server/src/services/heartbeat.ts` `deriveTaskKey`, `packages/db/src/schema/agent_task_sessions.ts`].

- **These wakes normally resume:** `issue_blockers_resolved`, `issue_children_completed`, `issue_commented`, `issue_reopened_via_comment`, `issue_monitor_due`.
- **These start fresh:** `issue_assigned` (every new assignment, every routine fire, every reassignment), `execution_approval_requested`, a wake with `forceFreshSession`, an issue-less timer wake, and some recovery wakes [`server/src/services/heartbeat.ts` `shouldResetTaskSessionForWake`]. A change of the agent's config or model and a session compaction also start fresh (session config freshness and session compaction in the same file). An accepted plan continues in a fresh session on the same issue [`doc/execution-semantics.md` § 7].

So: a new issue always costs one cold start. Reuse the issue for every later step of the same unit, keep its assignee, and wake it with blockers, comments, or reopen.

## The model

```
Lane parent     "Lane: web-app code changes"   owner: lane lead   standing, one per lane
└─ Work item    "PR #412: add rate limiter"    owner: lane lead   one per unit of work
   ├─ implement                                owner: implementer
   ├─ review: security                         owner: one reviewer
   ├─ verify                                   owner: verifier
   └─ merge                                    owner: merger
```

- **One standing lane parent per lane, owned by one lane lead.** Lane decisions, intake triage, and lane notes (issue documents) live here, so the lead's lane session stays warm.
  - Between rounds, park it in `backlog`. That is parked state: it starts no run on its own [`doc/execution-semantics.md` § 3, § 8 Agent-assigned `backlog`]. A comment from a person or another agent still wakes the lead there [`server/src/services/issue-comment-wakeup.ts`].
  - That wake checks the lane parent out to `in_progress` [`server/src/services/heartbeat.ts` `shouldAutoCheckoutIssueForWake`]. End each lane-parent run by setting it back to `backlog`.
  - Do not park it in `todo`. That is dispatch state: the recovery pass dispatches an assigned `todo` issue that has never run as a new assignment, which is a fresh session [`doc/execution-semantics.md` § 8 Agent-assigned `todo`, `server/src/services/recovery/service.ts` `reconcileStrandedAssignedIssues`].
  - Do not point an event trigger's `issueMode.appendToIssueId` at a parked lane parent. The alert is posted as a comment, but a `backlog` issue gets no wake from it [`server/src/services/issue-assignment-wakeup.ts`].
- **One work-item parent per unit of work:** one PR, one external issue, one doc page, one process change. The lane lead owns it and decides each next stage. Its first wake is cold; every later stage resumes on the same issue.
- **One child per role, and only when the owner differs.** Implementer, each review lens, verifier, merger: one issue each, one assignee each. If the implementer also verifies, verification stays a step of the implement child [`skills/paperclip-converting-plans-to-tasks/SKILL.md`, "Split only for a qualifying boundary"]. Paperclip rejects an issue with both an agent and a user assignee, and a checkout of another agent's issue returns `409` [`doc/execution-semantics.md` § 2, paperclip § Step 5]. Keep the same assignee for a child's whole life: reassignment resets its session.
- **Set `parentId`, `goalId`, and `projectId` on every issue.**
  - Role children: use `POST /api/issues/{id}/children` (CLI `issue child:create`). It copies the parent's goal and project. It refuses a new child when the parent already has 25 children, from any route [`server/src/services/issues.ts` `MAX_CHILD_ISSUES_CREATED_BY_HELPER`].
  - Work items under a long-lived lane parent: use `POST /api/companies/{companyId}/issues` [paperclip § Step 9]. That route copies the parent's project but not its goal. Without `goalId`, it uses the project's goal or the company default [`server/src/services/issue-goal-fallback.ts`]. Send `goalId` explicitly.
- **Give each work item its own workspace.** When the instance has isolated workspaces enabled and the parent has a realized workspace, both create routes reuse the parent's workspace for a new child. Without an override, work items can share the lane parent's workspace. Create each work item with `executionWorkspacePreference: "isolated_workspace"`; its role children then reuse the work item's workspace [`server/src/services/issues.ts` workspace inheritance on create, `skills/paperclip/references/issue-workspaces.md`].
- **Attach the PR or URL as a work product** on the work item: `pull_request`, `preview_url`, `branch`, `commit`, `artifact`, or `document` [paperclip § Generated Artifacts and Work Products]. `POST /api/issues/{id}/git/pull-requests` (CLI `issue git:link`) records a `pull_request` work product. An agent can link only on issues assigned to it, so the implementer links the PR on its implement child and the lane lead links it on the work item [`doc/ISSUE-GIT-LINKS.md`].
- **Keep the tree to 3 levels, 4 at most:** lane, work item, role child, and a sub-step only when it has its own owner. Nesting is for traceability; dependencies go through blockers [`doc/execution-semantics.md` § 6].

## Waiting and handoffs

- **Parents wait `blocked` on the current stage.** The lead creates the stage child, then sets the work item to `blocked` with `blockedByIssueIds` on it. When every blocker is `done`, Paperclip wakes the lead with `issue_blockers_resolved`, or with `issue_children_completed` when every child is closed. Both resume the session. Never poll children, runs, or sessions [paperclip § Issue Dependencies, § Step 7].
  - The blocker wake needs an agent assignee and a status other than `backlog`, `done`, or `cancelled` [`server/src/services/issues.ts`, blocker-resolution wake]. A `cancelled` blocker never resolves: remove or replace it [paperclip § Issue Dependencies].
  - Reopen a child before you block on it again. Setting `blocked` on blockers that are all `done` already wakes the assignee at once [`server/src/routes/issues.ts`, blocked-dependency restore].
  - A comment from a person on a `blocked` issue moves it to `todo` [`doc/execution-semantics.md` § 8 Explicit recovery actions, `server/src/routes/issues.ts` `shouldImplicitlyMoveCommentedIssueToTodo`]. After you answer, set the work item `blocked` again.
- **Only the implementer arms an issue monitor, and only for an external check it owns:** CI on its PR head, a deploy, a preview, or a timed soak of live runs. It ends its turn with `issue wait`. Only the assignee agent or a board user can arm a monitor, and low-trust agents cannot [`server/src/routes/issues.ts` `assertCanManageIssueMonitor`]. A monitor fires once, on a timer, on an agent-assigned issue in `in_progress` or `in_review`, whether or not anything changed [paperclip § Monitors and Watchers, `doc/execution-semantics.md` § 8 Issue monitors]. Leads and reviewers wait on blockers.
- **Reviewers post the verdict on their own issue and mark it `done`, even when the verdict is adverse.** The verdict is the deliverable. Make the review issue self-contained, and never ask a reviewer to comment on the parent: a low-trust reviewer gets `403` there [paperclip § Delegating review tasks, `doc/execution-semantics.md` § 6 Review Delegation, `doc/LOW-TRUST-PRESETS.md`].
- **Repairs go back to the implementer.** The lead comments the findings on the implement child with `"reopen": true`. Paperclip moves the child to `todo` and wakes the implementer with `issue_reopened_via_comment`, which resumes its session. A standard-trust lead can reopen another agent's child; a low-trust lead cannot [`server/src/routes/issues.ts`, issue comment route]. Then the lead blocks the work item on that child again. The parent's owner routes fixes; the reviewer does not make them [paperclip § Delegating review tasks].
- **Choose one review tool per lens.** Paperclip has two:
  - An execution-policy `review` or `approval` stage on the implement child. Use it when the decision must gate that issue itself. Paperclip records the decision on that issue and reassigns it to `returnAssignee` when the reviewer requests changes [`skills/paperclip/references/api-reference.md` § Cross-Agent Review Gates]. These handoffs wake with `execution_review_requested`, `execution_approval_requested`, or `execution_changes_requested`, not `issue_assigned`. Of these, only `execution_approval_requested` starts fresh [`server/src/routes/issues.ts` `buildExecutionStageWakeup`].
  - A review child. Use it when the lens needs its own owner, workspace, or trust boundary (for example a low-trust reviewer), or when several lenses run in parallel [paperclip § Delegating review tasks].
  - Do not use both for the same lens.

## Templates

| Lane | Stages |
| --- | --- |
| Code | plan (optional) → implement → review per routed lens at head H → verify → merge. A verdict counts only at the head it reviewed, or after a proven clean rebase. |
| Docs | change check → draft → accuracy review → publish |
| Process or skill change | draft → review → apply → verify live |
| Watch | check before the LLM runs; create no issue when nothing changed; a finding becomes a work item in the owning lane |
| Intake and planning | create deduplicated work items with a goal and a project |
| Clean (optional, post-merge) | merge the whole change behind a flag → review and refactor on main → release gate |

Read [references/lane-templates.md](references/lane-templates.md) for the rules of each template and a worked example.

## Anti-patterns

| Anti-pattern | Symptom | Do instead |
| --- | --- | --- |
| One issue per routine tick | Each fire creates an issue and wakes it with `issue_assigned`, a fresh session; cold starts dominate cost | Skip unchanged ticks before an issue exists (gate script, activity gate, no-op skip) and send findings to a standing lane [`packages/shared/src/routine-gate.ts`, `references/routines.md` of the `paperclip` skill, `docs/agents-runtime.md` § 3.2] |
| Many PRs or items bundled in one issue | No single owner; one status for several states; a verdict cannot name one head | One work item per unit of work |
| Several reviewers on one issue | Only the assignee can check it out (`409`) and set its status, so one status stands for several verdicts; low-trust reviewers cannot write there at all | One review child per lens, or one execution-policy stage per lens |
| A parent kept `in_review` with a no-op monitor | Each re-arm brings one timer wake with nothing new; the lead pays for a run per check | Parent `blocked` on its children; only the implementer waits on an external check |
| Assigned `todo` mirrors | An issue that only mirrors outside state is dispatched as an assignment and runs with nothing to do | Record the outside state as a work product or comment on the owning issue, or park the mirror in `backlog` |
| Deep trees | Context and diagnostics spread over many levels; owners are unclear | Keep to 3 levels, 4 at most |
| Per-agent run caps hit by liveness redispatch | The recovery pass dispatches every assigned `todo` issue that never ran. The runs queue behind `maxConcurrentRuns` and count against `maxDailyRuns`; at the daily cap, new wakes are skipped and real lane work waits [`server/src/services/recovery/service.ts` `reconcileStrandedAssignedIssues`, `server/src/services/heartbeat.ts` `getHeartbeatDailyCapBlock`, `doc/SPEC-implementation.md` § 11.6] | Keep few assigned `todo` issues per agent; park future work in `backlog`; watch `capReached` in `paperclipai run stats` |

## Checklist

- [ ] One standing lane parent, one lane lead, goal and project set; set back to `backlog` at the end of each lead run.
- [ ] One work item per unit of work, with its own workspace and the PR or URL as a work product.
- [ ] One child per role and owner, one assignee for its whole life; review children are self-contained.
- [ ] Parents wait `blocked` with `blockedByIssueIds`; no parent waits on a monitor.
- [ ] Only implementers use `issue wait`, each for a named external check.
- [ ] Repairs reopen the implement child; verdicts name the head or revision they checked.
- [ ] Scheduled checks skip before the LLM runs when nothing changed, and create no issue then.
- [ ] Intake deduplicates with an `idempotencyKey` and a similar-issue check.
- [ ] No assigned `todo` issue exists without work to do.
- [ ] The tree is at most 4 levels deep.
- [ ] The lane metrics below were read before and after the change.

## Verify a lane

Read these numbers before you change a lane and again after a day of real runs. [references/lane-metrics.md](references/lane-metrics.md) says where to read each one in the UI, the REST API, and the CLI, and how to derive the ones with no direct surface.

| Metric | Healthy sign |
| --- | --- |
| Fresh vs resumed sessions per day | Most runs on lane parents and work items resume a session |
| Issues created by no-op ticks | Near zero: unchanged ticks are skipped before an issue exists |
| Wakes skipped or merged vs wakes that ran | Duplicate wakes merge; no agent reaches its daily cap with lane work waiting |
| Child issues per shipped item | Close to the number of stages, plus one per real repair |
| Time from open to merged or done | Stable or falling; a long gap between stages points to a handoff with no owner |

## What a lane does not depend on

A lane design does not depend on session reuse across routine ticks, a no-change check before a monitor wake, cap-aware liveness dispatch, or priority ordering of queued runs. If an instance has them, a good lane gets cheaper; its shape stays the same.
