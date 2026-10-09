# Monitors and watchers

Read this when you want something to re-check later, when you must wait for an external check, or when you are about to tell anyone that something will watch an external system.

A run is a short execution window, and nothing keeps watching after it exits. The only thing that resumes an issue by itself is a persisted **issue monitor**: durable state on the issue (`monitorNextCheckAt`, `monitorScheduledBy`, and an `executionPolicy.monitor` block with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`). A server scheduler (`tickDueIssueMonitors`) polls for eligible issues whose `monitorNextCheckAt` has passed and wakes the assignee with `PAPERCLIP_WAKE_REASON=issue_monitor_due`.

An issue is eligible only when it is assigned to an agent (`assigneeAgentId` set), has no user assignee (`assigneeUserId` null), and is `in_progress` or `in_review`. The on-demand trigger, `POST /api/issues/{id}/monitor/check-now`, enforces the same conditions. A monitor stored on a user-assigned, `backlog`, `blocked` or closed issue never fires, so a timestamp is necessary but not sufficient. A monitor is timer-based polling, not an event subscription: Paperclip is not told the moment CI or an external check finishes; it wakes you on a schedule so you can look again.

## Waiting for CI, a deploy, a preview or a lock

End your turn with `issue wait` and never leave a background process running. Run `npx paperclipai issue wait <issueId> --in 10m --reason "CI on PR #4320 head abc123"`, or `POST /api/issues/{id}/wait` with `{"in":"10m","reason":"..."}`. The wait is 1 minute to 24 hours and works only on an issue assigned to you in `in_progress` or `in_review`. Then finish your turn. The issue keeps its status, and Paperclip wakes you with `PAPERCLIP_WAKE_REASON=issue_monitor_due` and your reason as the wait note.

Do not run `gh pr checks --watch`, `sleep` loops, port waits or any other background wait. On Claude local runs, Paperclip stops a process that is still running after your final result, and then schedules a re-check for you (5, 10, then 20 minutes, at most three times) with the note "re-check after background task stop". Other adapters do not get that re-check, so always end your turn with `issue wait`.

## Rules

- Claim a watcher only after you scheduled one. A description in a comment creates nothing. Set `executionPolicy.monitor.nextCheckAt` (with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`) through `PATCH /api/issues/{id}`, and use the default full response, not `Prefer: return=minimal`, to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and `status` is `in_progress` or `in_review`. A confirming `GET` is unnecessary.
- Describe a monitor in checkable terms: kind, next check time, attempt and timeout bounds. If you cannot name those, you have not scheduled one and should not imply you have.
- Never imply a live watcher on an issue you mark `done`. `done` means nothing is left to do on the issue, which contradicts an ongoing watcher. When real re-checking is still needed, keep the issue `in_progress` or `in_review` with a scheduled monitor.
- The server enforces this by state, not by what you say: the disposition guard rejects an agent move to `in_review` (`invalid_issue_disposition`) unless a real review path exists (an interaction, an approval, a human reviewer, a typed participant, or a scheduled monitor with a real `monitorNextCheckAt`), and the recovery classifier flags `in_review_without_action_path` for anything parked without a live wake path. Keep your comments consistent with that state.
