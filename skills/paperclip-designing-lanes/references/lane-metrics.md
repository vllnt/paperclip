# Lane Metrics

Five numbers tell you whether a lane runs efficiently and reliably. Read them before you change a lane, and again after a day of real runs. This file names where each number lives in Paperclip today. Where no page or command shows a number directly, it says how to derive it from existing endpoints.

All REST paths are under `/api` and need the normal authentication. CLI commands are `paperclipai` subcommands; add `--json` for machine-readable output. UI paths start with the company prefix, for example `/EX/...`.

## 1. Fresh vs resumed sessions per day

A resumed session reuses the context the agent already built on that issue. A lane where most lead runs are fresh is paying to rebuild context.

| Surface | Where |
| --- | --- |
| REST | `GET /api/companies/{companyId}/heartbeat-runs?since=...&until=...&agentId=...&limit=1000`. Do not pass `summary=true`: it drops the session fields. |
| CLI | `paperclipai run list -C <companyId> --since 1d --limit 1000 --json` (`--agent-id` to narrow) |
| One run | `GET /api/heartbeat-runs/{runId}`, `paperclipai run get <runId>`, or the run page `/<prefix>/agents/<agent>/runs/<runId>` (session IDs before and after) |
| Saved sessions (board only) | `GET /api/agents/{agentId}/task-sessions`, `paperclipai agent task-sessions <agentId>`: one row per saved task session, with its `taskKey` |

**Derive it.** For each run, read `usageJson.freshSession` and `usageJson.sessionReused` (`usageJson.sessionRotated` marks a planned rotation). Group by the day of `createdAt`. Keep only lane runs by matching `contextSnapshot.issueId` to the lane parent and its work items. When `usageJson` is null (the adapter reported no usage), count a run as resumed when `sessionIdBefore` is set.

**Token proxy.** `paperclipai observability usage -C <companyId> --group-by day` (REST `GET /api/companies/{companyId}/observability/usage?groupBy=day`) splits uncached input tokens from cache reads. Add `--issue-id <issueUuid>` to look at one lane issue; this filter takes the issue UUID, not an identifier such as `EX-210`. Many cold starts show as a high share of uncached input.

## 2. Issues created by no-op ticks

A tick that creates an issue and then finds nothing to do is pure overhead.

| Surface | Where |
| --- | --- |
| REST | `GET /api/routines/{routineId}/runs?limit=200` |
| CLI | `paperclipai routine runs <routineId> --limit 200` |
| Routine-execution issues | `GET /api/companies/{companyId}/issues?originKind=routine_execution&originId={routineId}&status=done,cancelled` |
| UI | the routine's runs tab `/<prefix>/routines/<routineId>/runs` |
| Cost of the ticks | `paperclipai observability usage -C <companyId> --routine-id <routineId> --group-by day`: runs, tokens, and cost per day |

**Derive it.** In the routine runs, a run with `status` `skipped`, `coalesced`, `grouped`, or `recovered` created no new issue. On a skipped run, `failureReason` usually says why, for example `gate_skip`, `gate_unchanged`, or `gate_unavailable` (gate script), `unchanged_since_last_run` (no-op skip), `no_external_activity` (activity gate), or `paused`. A `skip_if_active` skip has no `failureReason`. For the other runs, `linkedIssueId` names the run issue when one was created. Count a run issue as a no-op tick when it closed with no work product (`GET /api/issues/{id}/work-products` or `paperclipai issue work-products <id>` is empty) and no work item or comment beyond the closing one (`GET /api/issues/{id}/activity` or `paperclipai activity issue <id>`). The healthy number is near zero.

## 3. Wakes skipped or merged vs wakes that ran

A healthy lane merges duplicate wakes and runs once per real event.

| Surface | Where |
| --- | --- |
| Runs per agent and day cap | `GET /api/companies/{companyId}/heartbeat-runs/stats?since=...` or `paperclipai run stats -C <companyId> --since 24h`: totals by status and, per agent, `runsToday`, `maxDailyRuns`, `remainingToday`, `capReached` |
| Parked wakes | `GET /api/companies/{companyId}/deferred-wakes` (no CLI): per agent `deferredCount`, `oldestDeferredAgeSeconds`, `promotedLast24h`, plus why wakes are parked and the sweep's skip counters [`doc/execution-semantics.md` § 5] |
| One issue | `GET /api/issues/{issueId}/diagnostics/wakes` (no CLI): each wake's `reason`, `status`, and `coalescedCount`, for 14 days, at most 50 rows |
| One subtree | `GET /api/issues/{issueId}/diagnostics/subtree` or `paperclipai issue tree <issueId> --json`: a few recent wakes per node |
| Daily runs | `GET /api/companies/{companyId}/dashboard`, `paperclipai dashboard get`, or the Dashboard page: `runActivity` per day |

**Derive it.** No endpoint lists all wake requests of a company. For a lane, read the wake diagnostics of the lane parent and of each open work item. Add up `status` values: `completed` ran; `coalesced` and `skipped` did not start a new run. Then read runs that did start (metric 1 list) and count those whose wake reason (`contextSnapshot.wakeReason`) was a timer or monitor and that changed nothing. An agent with `capReached: true` while lane work waits is the anti-pattern "per-agent run caps hit by liveness redispatch".

## 4. Child issues per shipped item

Close to the number of stages, plus one per real repair, is healthy. Many more means the lane splits work that one owner could finish, or loops.

| Surface | Where |
| --- | --- |
| Direct children | `GET /api/companies/{companyId}/issues?parentId={workItemId}` |
| Whole subtree | `GET /api/companies/{companyId}/issues?descendantOf={workItemId}` or `paperclipai issue tree <workItemId>` |
| Shipped items | `GET /api/companies/{companyId}/issues?parentId={laneParentId}&status=done` |
| UI | the work item's page `/<prefix>/issues/<identifier>`: its sub-issues list |

**Derive it.** List the lane's `done` work items, then count each one's descendants. `paperclipai issue list` has no parent filter; use the REST call or `issue tree`.

## 5. Time from open to merged or done

| Surface | Where |
| --- | --- |
| Issue timestamps | `GET /api/issues/{issueId}` or `paperclipai issue get <issueId>`: `createdAt`, `completedAt` |
| PR state | `GET /api/issues/{issueId}/work-products?refreshPullRequests=true`, `paperclipai issue work-products <issueId>`, or `paperclipai issue git <issueId>`: a `pull_request` work product with `status: "merged"` |
| Status history | `GET /api/issues/{issueId}/activity` or `paperclipai activity issue <issueId>` |
| UI | the issue page `/<prefix>/issues/<identifier>`: its activity and work products |

**Derive it.** No endpoint reports cycle time. Compute `completedAt - createdAt` for each `done` work item. A work product has no merge timestamp; use the merge child's `completedAt` as the merge time. `completedAt` is cleared when an issue is reopened, so read the activity history for an item that was reopened. A long gap between one child's `completedAt` and the next child's `createdAt` points to a handoff with no owner.
