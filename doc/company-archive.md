# Company Archive

The company archive is a company-directed export of the company's own run
history. It is the fourth data path next to Telemetry, Observability and the run
log (see AGENTS.md section 5, item 7): run content leaves the instance, but only
to a board user of that company or, in a later release, to a destination that
the company's board configured.

Plan and later slices: [2026-10-09-company-session-warehouse.md](plans/2026-10-09-company-session-warehouse.md).

## Export API

`GET /api/companies/:companyId/archive/export` streams NDJSON
(`Content-Type: application/x-ndjson`). Only a board user with access to the
company can call it; agents get 403. Each call writes one `company.data_exported`
activity row with the window, the included entities and the page size. The row
holds no content.

| Query | Meaning |
|---|---|
| `cursor` | Continue after this position. Take it from `run.end.data.cursor` or `export.end.data.next`. |
| `since`, `until` | ISO-8601 window on the settle key. `until` is capped at now minus 10 minutes. |
| `include` | Comma list of `run`, `events`, `transcript`, `costs`, `activity`. Default: all. |
| `limit` | Runs per response, 1 to 500, default 50. |
| `follow` | `true`: stream the whole window in one response (see below). |

CLI: `paperclipai archive export --company-id <id> [--out FILE] [--resume]`
follows `next` until the window is exhausted (see [CLI.md](CLI.md)).

## Which runs

A run is exported when its status is terminal (`succeeded`, `failed`,
`cancelled`, `timed_out`, `interrupted`) and its **settle key**
`coalesce(finished_at, created_at)` is at least 10 minutes old. The delay lets
late events, liveness writes and log finalization land first.

Runs are ordered by `(settle key, run id)`. The settle key is compared with
microsecond precision. Index: `heartbeat_runs_company_settled_idx`.

Known gaps of an incremental pull (a full export, without a cursor, always
includes everything):

- Child rows (events, costs, activity) that land more than 10 minutes after a
  run's settle key are not in an export that already passed the run. Compare
  `run.end.data.marks` with a later pull of the same window to detect them.
- A run that becomes terminal without `finished_at` long after it was created
  has a settle key that the cursor may already have passed. No current writer
  does this; old rows can.

A run can appear more than once: a revived or re-stamped run settles again with
a later key. Keep the last occurrence per run id.

## Records

Every line is one JSON object:

```json
{"kind":"run_event","v":1,"companyId":"…","runId":"…","data":{ … }}
```

| `kind` | `data` |
|---|---|
| `export.header` | `format`, `generatedAt`, `include`, `since`, `until`, `cursor`, `limit`, `redaction` (policy name and version) |
| `run` | The run row with the same columns and bounded `resultJson` as `GET /api/heartbeat-runs/:runId`, without that route's presentation fields (`execution`, `identityHistory`, `retryExhaustedReason`, `outputSilence`) |
| `run_event` | One `heartbeat_run_events` row, in `seq` order |
| `transcript` | One line of the run log: `line` (1-based line number), `ts`, `stream`, `chunk`, `seq`, `attemptId`. A line that is not valid JSON (for example a torn last line after a crash) is `{line, raw}`. |
| `cost_event` | One `cost_events` row of the run |
| `activity` | One `activity_log` row of the run |
| `run.omission` | `{reason, include}`. `transcript_unavailable`: the run has a log pointer but the file and its mirror are gone. `transcript_unreadable`: the log could not be opened or the read failed part way; lines read before the failure were exported. `events_unreadable`: an event page failed to decode; events before it were exported. One unreadable run never stops the export. |
| `run.end` | `counts` per entity, `marks` (`eventMaxSeq`, `costCount`, `activityCount`, `logBytes`: what the run had when it was exported), `settleKey`, `cursor` to continue after this run |
| `export.end` | `runs` in this response, `next` (null when the window is exhausted now), `resumeCursor` (last position, for a later incremental pull) |

With `follow=true` the server follows `next` itself and streams the whole
window in one response with one `export.header` and one `export.end` (the web
download uses this). The response carries `Content-Disposition: attachment`.

- `v` is the schema version of the record kind. Added fields do not change it;
  a renamed field or a changed meaning does.
- Ids are raw UUIDs. Timestamps inside `data` are ISO-8601 UTC with
  millisecond precision. Only `run.end.data.settleKey` and cursors carry the
  stored microseconds; use them, not `data` timestamps, to order runs.
- Delivery is at least once. Deduplicate on `(kind, data.id)`; run events on
  `(runId, data.seq)`; transcript lines on `(runId, data.line)`.
- A response that ends without `export.end` was cut off. Continue from the last
  `run.end` cursor.

## Redaction

All records pass `server/src/services/run-read-redaction.ts`, the same module
the run detail, events and log endpoints use:

- run: current-user masking (when the instance setting `censorUsernameInLogs`
  is on), then registered secret values; the secret registry is removed;
- run event: payload pattern redaction (secret-named keys, JWTs, bearer and
  authorization values, command secrets), then the same two steps;
- transcript line, cost event: current-user masking and registered secret
  values, applied to each decoded line (the log endpoint applies registered
  values to raw text pages);
- activity: payload pattern redaction of `details`, then the same two steps
  (the activity list endpoint returns rows unredacted).

The `redaction` field of `export.header` names the policy version. Redaction is
pattern based: a secret in a shape it does not know is not removed.

## Changing the archive

A change that adds an entity or a field to the export, or weakens redaction,
needs a privacy review, an update of this file, and a `v` bump when a meaning
changes.
