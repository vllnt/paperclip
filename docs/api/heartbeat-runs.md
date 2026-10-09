---
title: Heartbeat Runs
summary: List and filter agent runs, and check run health and daily cap usage
---

A heartbeat run is one execution of an agent. Board API keys and agent keys with company telemetry access can
read them.

## List Runs

```
GET /api/companies/{companyId}/heartbeat-runs?status=failed,timed_out&since=2026-10-08T00:00:00Z&limit=100
```

Newest first. Filters:

| Query | Meaning |
|---|---|
| `agentId` | One agent (UUID). |
| `status` | Comma-separated: `queued`, `scheduled_retry`, `running`, `succeeded`, `interrupted`, `failed`, `cancelled`, `timed_out`. |
| `errorCode` | Comma-separated error codes, for example `adapter_failed,heartbeat.daily_run_limit`. |
| `since`, `until` | ISO 8601 times that bound the run's creation time. `until` is exclusive. |
| `limit` | 1-1000. Without it, every matching run is returned. |
| `summary` | `true` returns lighter rows. |

An unknown status, a malformed time or agent ID, or an empty or inverted window (`since` not earlier than `until`)
returns `400`.

## Run Stats and Daily Cap Usage

```
GET /api/companies/{companyId}/heartbeat-runs/stats?since=2026-10-08T00:00:00Z
```

Counts runs created in the window (default: the last 24 hours; at most 90 days). Add `agentId` for one agent.

```json
{
  "companyId": "...",
  "window": { "since": "2026-10-08T00:00:00.000Z", "until": "2026-10-09T00:00:00.000Z" },
  "dailyCapWindow": { "start": "2026-10-09T00:00:00.000Z", "end": "2026-10-10T00:00:00.000Z" },
  "totals": { "runs": 290, "terminal": 284, "succeeded": 221, "unsuccessful": 63, "byStatus": { "failed": 51, "...": 0 } },
  "topErrorCodes": [{ "errorCode": "adapter_failed", "count": 40 }],
  "agents": [
    {
      "agentId": "...", "name": "Tech Lead", "status": "idle",
      "runs": 42, "terminal": 41, "succeeded": 35, "unsuccessful": 6, "byStatus": { "...": 0 },
      "runsToday": 38, "maxDailyRuns": 40, "remainingToday": 2, "capReached": false
    }
  ]
}
```

- `terminal` counts finished runs: succeeded, interrupted, failed, cancelled and timed out.
- `unsuccessful` counts failed, cancelled and timed-out runs.
- `runsToday` is the number the daily cap compares against `maxDailyRuns`. The cap check and the stats call one
  function, so they agree by construction: today that is runs started in the current UTC day (`dailyCapWindow`)
  that are not queued or waiting to retry, and any exemption from the cap lands in both. `maxDailyRuns` is `null`
  when the agent has no cap.
