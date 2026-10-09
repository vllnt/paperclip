# Monitors and watchers

Read this when you want something to re-check later, or when you are about to tell anyone that something will watch an external system.

A run is a short execution window, and nothing keeps watching after it exits. The only thing that resumes an issue by itself is a persisted **issue monitor**: durable state on the issue (`monitorNextCheckAt`, `monitorScheduledBy`, and an `executionPolicy.monitor` block with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`). A server scheduler (`tickDueIssueMonitors`) polls for eligible issues whose `monitorNextCheckAt` has passed and wakes the assignee with `PAPERCLIP_WAKE_REASON=issue_monitor_due`.

An issue is eligible only when it is assigned to an agent (`assigneeAgentId` set), has no user assignee (`assigneeUserId` null), and is `in_progress` or `in_review`. The on-demand trigger, `POST /api/issues/{id}/monitor/check-now`, enforces the same conditions. A monitor stored on a user-assigned, `backlog`, `blocked` or closed issue never fires, so a timestamp is necessary but not sufficient. A monitor is timer-based polling, not an event subscription: Paperclip is not told the moment CI or an external check finishes; it wakes you on a schedule so you can look again.

## Rules

- Claim a watcher only after you scheduled one. A description in a comment creates nothing. Set `executionPolicy.monitor.nextCheckAt` (with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`) through `PATCH /api/issues/{id}`, and use the default full response, not `Prefer: return=minimal`, to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and `status` is `in_progress` or `in_review`. A confirming `GET` is unnecessary.
- Describe a monitor in checkable terms: kind, next check time, attempt and timeout bounds. If you cannot name those, you have not scheduled one and should not imply you have.
- Never imply a live watcher on an issue you mark `done`. `done` means nothing is left to do on the issue, which contradicts an ongoing watcher. When real re-checking is still needed, keep the issue `in_progress` or `in_review` with a scheduled monitor.
- The server enforces this by state, not by what you say: the disposition guard rejects an agent move to `in_review` (`invalid_issue_disposition`) unless a real review path exists (an interaction, an approval, a human reviewer, a typed participant, or a scheduled monitor with a real `monitorNextCheckAt`), and the recovery classifier flags `in_review_without_action_path` for anything parked without a live wake path. Keep your comments consistent with that state.
