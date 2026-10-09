# Company session warehouse: archive every agent session to the company's own bucket, and export it

Date: 2026-10-09
Status: plan (W0), revised after independent review round 1 (section 18). W1 is implemented on this branch.
Branch: `feat/session-warehouse`
Source baseline: `origin/main` at `be8194f90`. Every `file:line` below was read at that commit.

## 1. Goal and non-goals

**Goal.** Keep a durable, company-owned history of every agent session, so the
company can improve its agents and Paperclip itself from real history:

1. **Archive.** A company board turns on an archive and picks its own
   S3-compatible destination (AWS S3, Cloudflare R2, MinIO, OVH, ...). From then
   on, every finished run is written there as a self-describing, versioned,
   redacted bundle: run row, run events, transcript, cost events and activity.
   Optional backfill writes the existing history too.
2. **Export.** A board user can stream all of the same data out of the instance
   at any time as company-scoped NDJSON, resumable with a cursor, through the
   API and the CLI. No destination is needed for this.

**Non-goals (v1).** Restore into Paperclip (section 10 only sketches it), a
query engine, cross-company or instance-wide archives (instance recovery is
S3-06/S3-07 of the S3 plan), deletion of remote objects by Paperclip, and any
change to what the existing read endpoints show.

## 2. What exists today

| Area | Today | Source |
|---|---|---|
| Run rows | `heartbeat_runs`: status, timings, `usage_json`, `result_json`, `context_snapshot`, log pointers (`log_store`, `log_ref`, `log_bytes`, `log_sha256`, `log_compressed`). No index on `finished_at`. | `packages/db/src/schema/heartbeat_runs.ts:28-164` |
| Run events | `heartbeat_run_events`: per-run `seq`, `event_type`, `message`, NUL-safe JSONB `payload`. Strings are cut at 16K chars on the main write path. Unique `(run_id, seq)`; index `(company_id, run_id)`. | `heartbeat_run_events.ts:21-48`, `heartbeat.ts:676-701` |
| Transcripts | NDJSON files `<companyId>/<agentId>/<runId>.ndjson` under the instance data dir, one line `{ts, attemptId?, stream, chunk, seq?}`. Uncompressed, no size cap. Retries append to the same file. | `run-log-store.ts:294-346` |
| Instance S3 mirror | `RUN_LOG_S3_*` env copies each finished log to one instance bucket with ambient AWS credentials. Not per company. | `run-log-store.ts:470-498` |
| Storage abstraction | `local_disk` / `s3` providers, one per instance. S3 config has no credentials field (ambient chain) and no server-side encryption. Multipart above 16 MiB. | `server/src/storage/s3-provider.ts:13-98`, `s3-multipart.ts` |
| Costs, activity | `cost_events` (one row per finalized run with usage, `heartbeat_run_id`), `activity_log` (`run_id` indexed). | `cost_events.ts:9-49`, `activity_log.ts:6-35` |
| Retention | None for runs, events, logs, costs, activity. | |
| Per-run reads | `GET /heartbeat-runs/:runId`, `/events?afterSeq` (max 1000 per page), `/log?offset` (max 1 MiB). Board or same-company agent with `company_scope:read`. | `server/src/routes/agents.ts:7025-7040, 7499-7533` |
| Company export | `POST /companies/:id/export` excludes runs, transcripts, costs and activity; runs are not even counted in the fidelity report. | `routes/companies.ts:526-532`, `packages/shared/src/portability-fidelity.ts:11-38` |
| CLI | `run events` (one page), `run log` (one page). The HTTP client reads whole bodies; no streaming. | `cli/src/commands/client/run.ts:129-182`, `cli/src/client/http.ts:118-178` |
| Streaming precedent | `POST /companies/:id/skill-sources/discover` writes NDJSON per line with `no-transform` (so compression does not buffer), drain handling and client-abort stop. | `routes/company-skills.ts:330-372`, `middleware/api-compression.ts:62-84` |
| Destination model | **Planned, not built.** The 2026-10-04 S3 plan (S3-01) defines `storage_destinations`, the `storage_destination` secret-binding target and `/api/companies/:id/storage`. No code exists on `main` or on `feat/company-s3-storage-recovery`; no thread is building it. | `doc/plans/2026-10-04-company-s3-artifacts-dev-handoff.md` (untracked in the main checkout) |

### 2.1 Read-time redaction (what "redacted exactly like the read endpoints" means)

Stored rows are **not** guaranteed redacted: the main `appendRunEvent` path redacts
(`heartbeat.ts:13954-13991`), but five other writers do not (run dispatch, the
active-run watchdog, the native coordinator store, the native control-plane port,
native local process stop). So the archive and export must apply the full
read-time chain themselves:

| Record | Read-time chain today | Source |
|---|---|---|
| Run | `redactCurrentUserValue(run)` then `runRedactions.redactForRun` (registered secret values replaced; the `paperclipSecretRedactions` registry key is stripped). `result_json` comes from the bounded safe projection. | `agents.ts:7025-7040`, `heartbeat.ts:3618-3629,10807-10823`, `run-secret-redaction.ts:44-57` |
| Event | `redactEventPayload(payload)` (secret-named keys, JWTs, bearer/auth headers, command secrets), then `redactCurrentUserValue(event)` (home paths, usernames; only when the instance flag `censorUsernameInLogs` is on), then `redactForRun`. `message` gets no pattern scan at read time. | `agents.ts:7508-7515`, `redaction.ts:941-961`, `log-redaction.ts:107-148` |
| Log | Chunks were redacted when written (`onLog`: current-user text, base64 image strip, `redactSensitiveText`, 64 KiB per chunk). Read time adds only `redactForRun`. | `heartbeat.ts:23492-23514,30699-30734`, `agents.ts:7532` |

**Decision:** W1 extracts this chain into one module,
`server/src/services/run-read-redaction.ts`, and switches the three routes to it,
so the API, the export and the archive cannot drift. The secret-value registry
gets a "prepare once, apply many" method so a 50,000-line transcript costs one
decrypt pass, not one per line.

**Export pass (defense in depth).** The read chain is the floor, not the
ceiling. Because direct writers skip write-time redaction (for example the
scheduled-retry cancel event, `heartbeat.ts:28403-28424`), a log file can be
written outside `onLog`, and cost and activity rows are returned raw by their
list endpoints (`services/activity.ts:340-375`), **every exported or archived
record also gets one pattern pass** (`sanitizeRecord`, `redaction.ts:881`):
secret-named keys, bearer and authorization text, JWT-shaped values and
command secrets, on every key and string leaf. Event payloads keep the
`redactEventPayload` result (a second generic pass would mask native span
names). The routes keep their current output exactly; only exported records
get the extra pass. The pass also applies the write path's own env rule
(`redactEnvForLogs`, key names containing key, token, secret, password,
passwd, authorization or cookie) to every `env` object again, because
`adapter.invoke` events store the adapter `env` and the `prompt` in every
event and not every writer redacts at write time. It also redacts PEM blocks
and URL userinfo (`scheme://user:pass@host`) in every string. When the
observability track widens the write-side rules, it does so in that shared
function, so the export follows automatically. Transcript lines are redacted per decoded record, never per
raw text page. Tests insert canaries through direct writers (event message,
transcript line, cost row, activity details) and assert none survive. The
archive records the redaction policy version, so a later strengthening can
re-archive.

## 3. Scope: what is archived and exported

| Entity | v1 | Per run or company stream | Redaction |
|---|---|---|---|
| Run row | yes | per run | run chain + export pass |
| Run events | yes, all `seq` | per run | event chain + export pass on non-payload fields |
| Transcript (NDJSON log) | **yes, included** | per run | current user + registered secrets + export pass, per decoded line |
| Cost events with `heartbeat_run_id` | yes | per run | current user + registered secrets + export pass (`billing_code` is free text) |
| Activity rows with `run_id` | yes | per run | current user + registered secrets + export pass (details can quote text) |
| Activity and cost rows without a run | W7 | company stream, daily partition | same |
| Issue comments, documents, tool calls, `run_usage_records` (observability) | W7 | company stream | per entity, decided in W7 |
| Provider traces | no | | kept 24 h by design, out of scope |
| Secrets, secret registry material, agent API keys | **never** | | stripped |

Runs are **terminal and settled** before they are archived or exported:
status in `succeeded | failed | cancelled | timed_out | interrupted` (the server's
`HEARTBEAT_RUN_TERMINAL_STATUSES`, `heartbeat.ts:830-836`; W1 moves one shared
constant to `packages/shared`) and the settle key is at least 10 minutes old
(late events, liveness writes and log finalize have landed; same delay as the
observability worker).

## 4. Record format v1 (shared by export and archive)

Defined once in `packages/shared/src/company-archive.ts` (types, closed `kind`
list, cursor codec, query validator). Every NDJSON line is one JSON object:

```json
{"kind":"run_event","v":1,"companyId":"…","runId":"…","data":{ …redacted event… }}
```

- `kind` is a closed set: `export.header`, `run`, `run_event`, `transcript`,
  `cost_event`, `activity`, `run.omission`, `run.end`, `export.end`.
  `observability.usage_record` is reserved for W7 (its `v` is the record's
  `schema_version`, owned by the observability track).
- `v` is the integer schema version of that `kind`. Additive fields do not bump
  it; a rename or a meaning change does.
- Ids are raw UUIDs. Timestamps inside `data` are ISO-8601 UTC with millisecond
  precision (JSON `Date`). Only the settle key in `run.end` and the cursor carry
  the stored microseconds, and ordering uses only them.
- `run.omission` says what is missing and why (`transcript_unavailable`,
  `transcript_unreadable`), so a gap is explicit, never silent.
- `run.end` carries per-kind record counts, high-water marks (`eventMaxSeq`,
  `costCount`, `activityCount`, `logBytes`) and the resume cursor for "after this
  run". The marks let a
  consumer (and the archive drift sweep, section 7.4) detect child rows that
  arrived after the run was exported.
- Consumers dedupe on `(kind, data.id)` (events on `(runId, data.seq)`;
  transcript lines on `(runId, data.line)`, the 1-based line number in the
  append-only log), because delivery is at least once.

**Cursor.** Opaque base64url of `{"v":1,"t":"<settle key>","id":"<run id>"}`.
The settle key is `coalesce(finished_at, created_at)`: non-null, and
`finished_at` is set once. It is never `updated_at`, which event appends keep
bumping. The key is read from Postgres as text with microseconds and compared
as `timestamptz`, because a JavaScript `Date` truncates to milliseconds and a
keyset on truncated values skips or repeats rows. Order: `(settle key, id)`
ascending. W1 adds one index for it:
`heartbeat_runs (company_id, (coalesce(finished_at, created_at)), id)`.
Agreed with the observability track (same envelope and cursor in its
`/observability/export`).

**Completeness guarantees (stated, not hidden).**

- *Late child rows.* "Settled" does not freeze a run's children. Events, cost
  and activity rows that land more than 10 minutes after the settle key are not
  in an incremental export that already passed the run; a full export or a
  re-pull of that window includes them, and `run.end` marks show the
  difference. The archive closes the gap with the drift sweep (section 7.4).
- *Late-terminal runs.* The incremental guarantee is: every run whose move into
  a terminal status sets or advances `finished_at` appears after any cursor
  taken before that move. Section 19 shows every current writer meets it except
  one pre-existing reaper race (`heartbeat.ts:19484`, `setRunStatus` matches on
  id only), which can flip a just-finished run back to running and let a later
  `run.finishedAt ?? now` write keep the old key. The fix is its own bug-fix PR
  **F3** (#65: the existing `setRunStatusIfRunning` compare-and-set, with a
  regression test), and W1 merges after it. The archive's reconcile sweep
  (section 7.4) stays as a second line of defense.

## 5. Archive layout

Hive-style partitions so DuckDB, Athena, Spark or `aws s3 sync` work without
Paperclip. The partition date is the run's `created_at` (immutable), so every
archive of the same run lands under the same run prefix.

```
<destination prefix>/paperclip-archive/v1/companies/<companyId>/
  _format.json                                  # format id + version + redaction policy, written at enable
  runs/dt=YYYY-MM-DD/run=<runId>/
    manifest-<attemptId>.json                   # written LAST; immutable; the greatest name is current
    a=<attemptId>/                              # immutable: one attempt never overwrites another
      run.json.gz                               # 1 line: kind "run"
      events.ndjson.gz                          # kind "run_event", seq order
      transcript.ndjson.gz                      # kind "transcript", file order
      costs.ndjson.gz                           # kind "cost_event"
      activity.ndjson.gz                        # kind "activity"
```

**Attempts, not overwrites: nothing in a bundle is mutable.** The attempt id is
`g<leaseGeneration, 10 digits>-a<per-run attempt number, 4 digits>`, for example
`g0000000042-a0003`, so attempt ids sort in the order they were made. Each
attempt writes its data files under `a=<attemptId>/` and then its own
`manifest-<attemptId>.json`, written last and never rewritten. Readers take the
manifest with the greatest name; a run prefix without a manifest is in progress.
A stale lease holder has a lower generation than its successor, so its late
manifest sorts below the successor's and cannot replace it; within one lease the
holder is the only writer and its attempt number only grows (the ledger keeps
it). No conditional-write support is needed from the provider. A re-archive
(drift, policy bump, retry) is a new attempt. Superseded attempts stay in the
bucket in v1 (Paperclip deletes nothing remote); W5 adds an opt-in cleanup of
attempts older than the current one, after verification.

Example query: `select data->>'eventType', count(*) from read_ndjson('s3://bucket/prefix/paperclip-archive/v1/companies/*/runs/*/*/a=*/events.ndjson.gz') group by 1`
(join on the greatest `manifest-*.json` per run to read only current attempts).

`manifest.json` (uncompressed, small):

```json
{
  "format": "paperclip.company-archive.run-bundle", "v": 1,
  "companyId": "…", "runId": "…", "agentId": "…",
  "run": {"status": "succeeded", "createdAt": "…", "finishedAt": "…", "settleKey": "…"},
  "attemptId": "…", "archivedAt": "…", "producer": {"app": "paperclip", "version": "…"},
  "redaction": {"policy": "paperclip.read-redaction", "v": 1, "censorUsername": false},
  "source": {"eventMaxSeq": 412, "logBytes": 1834221, "logSha256": "…"},
  "files": [
    {"name": "a=…/events.ndjson.gz", "kind": "run_event", "records": 412, "bytes": 51234,
     "sha256": "…", "contentType": "application/x-ndjson", "contentEncoding": "gzip"}
  ],
  "omissions": []
}
```

- `sha256` and `bytes` are of the stored (gzipped) object, so anyone can verify
  a download with `sha256sum`. `source.logSha256` is the instance's own hash of
  the raw log (`heartbeat_runs.log_sha256`), recorded for provenance.
- A reader treats a run prefix without a manifest, or an attempt whose files do
  not match its manifest checksums, as incomplete (an upload in progress).
- Objects are written with `Content-Type`, `Content-Encoding: gzip` metadata and
  the destination's server-side encryption mode (section 6.2).
- Gzip, not zstd: it is in Node core and every reader handles it.

## 6. Destination model (reuse S3-01, build only the subset the archive needs)

### 6.1 Reuse

The S3 plan's S3-01 contract is the model; nothing here is a second destination
or credential system. Because S3-01 is not implemented, **W2 implements the
S3-01 subset** exactly as specified there, so the later asset work (S3-02/S3-03)
extends these tables instead of replacing them:

- `storage_destinations` with the S3-01 columns: `id, companyId, provider, origin,
  label, locationJson, revision, credentialRevision, retiredAt, lastProbeJson,
  createdAt, updatedAt`; unique `(companyId, id)` for composite FKs. W2 accepts
  `origin = 'company'` and `provider = 's3'` only. Location is immutable (HTTPS
  endpoint, region, bucket, prefix, addressing style); a change needs a new
  destination.
- `storage_destination` added to the existing secret-binding targets; company
  destinations require explicit company secret references for the access key id
  and secret key, with **no ambient fallback**; missing or revoked secrets fail
  visibly. Concretely: add it to `SECRET_BINDING_TARGET_TYPES`
  (`packages/shared/src/constants.ts:750-760`; `target_type` is plain text, so
  no migration); write refs with `syncSecretRefsForTarget(companyId,
  {targetType: "storage_destination", targetId}, refs, {replaceAll: true})`
  (`services/secrets.ts:4691-4793`); resolve with an explicit binding context
  `{consumerType: "storage_destination", consumerId, configPath, actorType:
  "system"}` so the binding check runs and every read lands in
  `secret_access_events` (`secrets.ts:1132-1209`; without a context both are
  skipped); add a label branch in `buildBindingTargetMap` (`secrets.ts:2736`) and
  `consumerTypeLabel` (`ui/src/lib/secret-delivery.ts:72-81`).
- Routes under S3-01's base `/api/companies/:companyId/storage`:
  `GET /destinations`, `POST /destinations` (client UUID, idempotent),
  `POST /destinations/:id/probe`, `PATCH /destinations/:id/credentials`,
  `POST /destinations/:id/retire`. S3-01's `PUT /default`, inventory and
  migration routes are asset features and stay with S3-02/S3-03.
- Connection rules from S3-01 section 5: private buckets, HTTPS only, no
  credentials in the URL, validated bucket/prefix/region, DNS/IP validation at
  connect time (no redirects; loopback, link-local, metadata and private ranges
  rejected unless the endpoint is on an operator-owned allowlist the company
  cannot edit). Neither setup nor probe creates a bucket, policy, ACL or
  lifecycle rule.
- The archive **uses** a destination; it does not own one. One destination can
  serve both assets (later) and the archive, or the board can use separate ones.

### 6.2 Additions the archive needs (small, in the owning modules)

- `createS3StorageProvider` gains optional `credentials` (resolved from the
  secret binding) and `serverSideEncryption`. Instance callers pass neither and
  keep today's behaviour.
- `PutObjectInput` gains optional `contentEncoding` and `serverSideEncryption`
  (passed through to `PutObject` and `CreateMultipartUpload`).
- Encryption modes on the destination location: `s3_managed` (default; sends
  `x-amz-server-side-encryption: AES256`), `kms` (AWS; `aws:kms` + key id) and
  `bucket_default` (sends no header; for providers that reject the header but
  encrypt at rest, for example R2, or MinIO without KMS). The probe checks the
  mode works and records the `ServerSideEncryption` value HEAD returns.
- Probe = bounded PUT, HEAD, GET + SHA-256, DELETE of a deterministic key under
  `<prefix>/paperclip-archive/.probe/<probeId>`, 30-second timeout, intent
  persisted before network work (S3-01 section 5). It also does one anonymous
  GET of the probe object; if that succeeds the bucket is public and the probe
  **fails** (activation is refused, fail closed).
- `bucket_default` cannot prove encryption from a HEAD that returns no SSE value.
  The probe records `encryption: "unverified"` and activation with it needs an
  explicit board acknowledgment, recorded in the activity row.

### 6.3 Company isolation at the bucket

Paperclip's own writes are isolated by construction (composite FK, company-bound
queries and keys, section 7.2). A shared bucket is a different risk: if two
companies point at the same bucket, each company's credential may read the
other's objects outside Paperclip, and an object-key prefix is not an access
policy (S3-01 section 5). So:

- **No shared physical location across companies on one instance.** A
  destination cannot be created or activated when another company on the
  instance has a non-retired destination with the same normalized endpoint and
  bucket (any prefix). The error says only that the location is unavailable, not
  which company holds it.
- **Out-of-prefix probe.** When the destination has a prefix, the probe also
  tries a PUT and GET at a sibling key outside that prefix and records whether
  the credential was denied (`isolation: "prefix_scoped" | "bucket_wide"`). The
  status shows it; the docs ask for a dedicated bucket or a prefix-scoped key.
- Residual: one cloud account can hold credentials that reach several buckets.
  That is the company's or operator's credential hygiene; Paperclip states it in
  the setup text and does not claim provider-side isolation it has not tested.

## 7. Delivery

### 7.1 Settings and ledger (W3, two new tables)

| Table | Columns and invariants |
|---|---|
| `company_archive_settings` | One row per company. `companyId` PK (FK to companies, `on delete cascade`), `enabled` (default false), `leaseOwner`, `leaseExpiresAt`, `leaseGeneration` (fencing token, +1 on every claim), `destinationId` (composite FK `(companyId, destinationId)` to `storage_destinations`, so another company's destination cannot be selected), `backfillFrom` (null = all history), `cursorKey` + `cursorRunId` (keyset position), `revision` (optimistic concurrency), `state` (`active`, `backing_off`, `paused_error`), `consecutiveFailures`, `nextAttemptAt`, `lastErrorCode`, `lastErrorMessage` (sanitized), `lastArchivedAt`, timestamps. |
| `company_archive_runs` | Ledger, one row per (destination, run). PK `(destinationId, runId)`, `companyId`, `status` (`archived`, `parked`), `settleKey`, `attemptId`, `manifestSha256`, `bytes`, `marks` (`eventMaxSeq`, `costCount`, `activityCount`, `logBytes` at archive time), `formatVersion`, `redactionPolicyVersion`, `attempts`, `lastErrorCode`, `archivedAt`, `verifiedAt` (deep verify, W5). Index `(companyId, status)`. No FK to `heartbeat_runs` (the ledger outlives a pruned or deleted run, and the prune guard reads it). A destination change starts a new ledger for the new destination; the old rows stay as the record of what the old destination holds. |

Enabling requires a destination whose last successful probe is under 15 minutes
old and matches its current credential revision (the S3-01 activation rule).
Changing the destination resets the cursor to `backfillFrom`; old bundles stay
where they are. Disabling stops new uploads and keeps everything.

### 7.2 Worker

```
every 60 s (PAPERCLIP_COMPANY_ARCHIVE_INTERVAL_MS):
  for each company with enabled = true and nextAttemptAt <= now:
    claim the company lease (compare-and-set on leaseOwner/leaseExpiresAt, 5 min, renewed per run;
                             leaseGeneration += 1 and becomes the fencing token)
    runs = terminal runs where (settleKey, id) > cursor and settleKey <= now - 10 min
           order by settleKey, id limit 25
    for run in runs:
      try   writeBundle(run, token)           -> ledger 'archived'; cursor := run   (one transaction,
                                                 only where leaseGeneration = token)
      catch destination error (auth, network, 5xx, SSE rejected):
              company backoff 1 m, 2 m, ... 6 h; cursor stays; state backing_off; stop this company
      catch run data error (log unreadable, payload decode):
              attempts += 1; after 3: ledger 'parked' + activity row; cursor := run
```

- **One writer per company, fenced.** A lease column with compare-and-set (the
  `skill-sources.ts:175-176` pattern), not a session advisory lock: production
  code holds no session-level advisory locks, and a transaction-scoped lock
  cannot span minutes of network I/O. A lease alone is not a fence: a stale
  holder can still be mid-upload when its lease expires. So every claim bumps
  `leaseGeneration`, the worker carries it as a fencing token, the ledger and
  cursor commit only `where leaseGeneration = token`, and data files go to an
  attempt prefix (section 5), so a stale holder can at worst leave an unused
  attempt and a lower-sorting manifest (section 5). The timer starts in
  `server/src/index.ts` like the external-object refresh (`index.ts:1186-1202`),
  is tracked for graceful shutdown, and runs whether or not the heartbeat
  scheduler is on.
- **At least once, deterministic keys.** A crash after upload and before the
  cursor commit retries the run as a new attempt under the same run prefix,
  with its own manifest written last. Bundle locations depend only on company,
  run and attempt, never on time.
- **Survives restarts.** All progress is in Postgres; nothing lives only in memory.
- **Resumable backfill.** Backfill is the same loop starting from `backfillFrom`;
  it is bounded per tick (25 runs, one company stream at a time), so it never
  starves the live tail for long. A per-tick byte budget
  (`PAPERCLIP_COMPANY_ARCHIVE_MAX_BYTES_PER_TICK`, default 256 MiB) limits egress;
  a single run larger than the budget is archived alone in its own tick.
- **Head-of-line on destination failures, not on bad runs.** A bucket outage
  stops the company's stream and backs off; one corrupt run is parked after
  three tries so it cannot block the stream. Parked runs show in status and can
  be retried (`archive retry`).
- **Isolation by construction.** The worker reads only rows with the company's
  id, resolves only that company's destination through the composite FK, and
  writes only under `companies/<companyId>/` of that destination. A test seeds
  two companies with distinct canary strings and asserts that neither bucket
  contains the other's.
- **Fail-open for runs.** The worker never touches the run path, never blocks a
  run, and an archive failure never changes a run row.
- **Off switch.** `PAPERCLIP_COMPANY_ARCHIVE_DISABLED=true` stops the worker on
  an instance (operator policy, cloud-managed deployments).

### 7.3 Writing one bundle

1. Load the run (safe projection) and prepare the run's redactor once.
2. For each file: stream records from Postgres (events in `seq` pages of 1000)
   or the run-log store (a new byte-stream read, local file then the
   `RUN_LOG_S3_*` mirror), redact per record, serialize, gzip and hash into a
   `0600` temp file in a `0700` staging dir under the instance data dir.
   Memory stays bounded; the staging file is deleted in `finally`, and the
   worker empties the staging dir at startup (a crash can leave redacted
   plaintext there).
3. `PUT` each file under `a=<attemptId>/` with exact length, content metadata
   and the SSE mode (multipart above 16 MiB, as today). `HEAD` it and require the
   size, and the SSE value when the mode is not `bucket_default`.
4. Re-check the lease generation, then `PUT manifest-<attemptId>.json`. Record
   the ledger row (attempt id and marks) and advance the cursor in one fenced
   transaction.

The run-log byte stream is a new optional `RunLogStore.openReadStream` method:
the paged `read()` decodes each page as UTF-8 and can cut a multi-byte character
or a line at a page boundary (`run-log-store.ts:242`), which is acceptable for a
live tail but not for an archive.

### 7.4 Reconcile and drift sweep

Daily, per enabled company, over runs with settle key in
`[max(backfillFrom, now - 30 d), cursor]`:

- **Missing:** terminal runs with no ledger row for the current destination are
  archived through the same `writeBundle` (late-terminal runs, section 4, and
  anything a past bug skipped).
- **Drift:** archived runs whose current marks (max event `seq`, cost and
  activity row counts, `log_bytes`) differ from the ledger marks get a new
  attempt. This closes the "settled is not frozen" gap for 30 days after
  settlement; later changes are rare and are caught by `archive rearchive --since`
  (W5).

Both are bounded by the 30-day window, use indexed aggregates per run
(`heartbeat_run_events (run_id, seq)`, `cost_events` and `activity_log` run
indexes), and share the per-tick byte budget.

## 8. Export API and CLI (W1)

`GET /api/companies/:companyId/archive/export`

| Query | Meaning |
|---|---|
| `cursor` | resume after this position (from `run.end` or `export.end`) |
| `since`, `until` | settle-key window; `until` is capped at now - 10 min |
| `include` | comma list of `run,events,transcript,costs,activity` (default all) |
| `limit` | runs per response, default 50, max 500 |

- **Authorization:** board with company access only (`assertBoard` then
  `assertCompanyAccess`, `routes/authz.ts:32-121`, the
  `managed-agent-profiles.ts:41-76` pattern; listed in `BOARD_ONLY_OPERATIONS`
  in `routes/openapi.ts:1344`). Agents get 403, including agents that can read
  single runs: a bulk raw export is a board decision (decision D3).
- **Response:** `Content-Type: application/x-ndjson`, `Cache-Control: no-cache,
  no-store, no-transform` (bypasses the compression buffer), written line by line
  with drain handling and stop on client abort (the `skill-sources/discover`
  pattern). First line `export.header` (company, window, include, redaction
  policy, settle cutoff). Last line `export.end` with `next` (null when the
  window is exhausted). A response that ends without `export.end` was cut off;
  the client resumes from the last `run.end` cursor.
- **Activity:** one `company.data_exported` row per request (actor, window,
  include, run count when finished; no content). Bulk export is the main way
  data leaves the instance, so it is audited even though it is a read.
- **CLI:** `paperclipai archive export --company-id <id> [--since] [--until]
  [--include ...] [--out FILE] [--resume]`. It follows `next` until the end,
  streams to stdout or a file (pipe to `gzip` to compress), and with `--resume`
  reads the last `run.end` cursor back from the existing output file, cuts any
  torn tail after it, and refuses when the file was exported for another
  company or with other `--include`/`--since` options (omitted options are taken
  from the file's header), so an interrupted export continues instead of
  restarting or mixing data sets. The CLI HTTP client gets a streaming method
  (it reads whole bodies today).
- **OpenAPI:** registered in `routes/openapi.ts` (the route test requires it).

## 9. Retention

| Option | Owner | v1 |
|---|---|---|
| Archive retention | The company, through bucket lifecycle rules or Object Lock on its own bucket. Paperclip never deletes archived objects (only its own probe objects). | documented, no code |
| Instance prune after archive | **W6, opt-in per company, off by default.** Deletes `heartbeat_run_events` rows and run-log files (local and `RUN_LOG_S3_*` mirror) of runs that are (a) settled more than `pruneAfterDays` ago (minimum 30), (b) archived **and** deep-verified (`verifiedAt` set by a full GET + SHA-256 match against the manifest, done right before the delete), (c) have a `run_usage_records` row with `schema_version >= RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION`, and (d) once the observability context slice (C1) has shipped, have a `run_context_records` row with `schema_version >= RUN_CONTEXT_RECORD_EVENTS_CONSUMED_VERSION`, with no exception (its worker writes a record for every terminal run and its `--backfill` covers older runs; operators run that backfill before enabling prune). Both constants come from `packages/shared`. Fail closed: prune refuses to run when the usage table or constant is missing, and also when the database has a `run_context_records` table that the running build has no guard for. Whichever of W6 and C1 lands second wires condition (d) into the prune query, so an older build can never delete events and logs the context track still reads. The prune UI and `archive prune status` show how many eligible runs still lack either record. After a prune the observability run timeline reports `log_pruned` by design. Never prunes `heartbeat_runs`, `cost_events`, `activity_log` or revision tables. Pruned runs keep their row; the events and log endpoints then return 410 with the archive location. | W6 |
| Retention of observability records (observability slice 1e) | Archive-then-prune for their tables too: once W7 archives `run_usage_records` and `run_context_records`, slice 1e deletes a record of a company with the archive on only after W7 has archived that `(runId, schema_version)` (W7 exposes the archived stream cursor per company). Companies without the archive keep 1e's plain retention. Until W7 ships, 1e applies as planned. W6 never relies on a record 1e may delete: W6 prunes at 30+ days, 1e at 400 days. | W7 + 1e |
| Instance-wide retention without an archive | Out of scope (would delete data the company never received). Operators keep DB backups. | no |

## 10. Restore and import (later, not v1)

- **Read-through** (first candidate, after W6): the run page fetches a pruned
  run's transcript and events from the company's bundle (already redacted),
  verifies the manifest checksums, and shows them. No write to the DB.
- **Import into a new company** (later): `paperclipai archive import --from
  <destination> --company <new>` replays bundles into an empty company in a
  quarantined state, with id remapping. It needs the company-only restore
  contract that S3-07 explicitly leaves out, so it is a separate plan.
- The format carries everything a later import needs: format and schema
  versions, ids, ordering keys and checksums. Redacted values are not restorable
  by design.

## 11. Data path classification (AGENTS.md section 5 item 7)

The archive is **none of the three listed paths**: it sends company data off the
instance (unlike the run log), to a destination the company's board chose
(unlike Telemetry, which goes to a Paperclip endpoint by default), and it carries
content, not spans (unlike Observability). It is closest to the existing company
export: a company-directed data export. Proposed additive AGENTS.md entry (W1
adds it):

> - **Company archive** is a company-directed export of the company's own run
>   history: transcripts, run events, runs, costs and activity, redacted with the
>   read-time chain. It is off by default per company. It sends data only to a
>   destination the company's board configured, or to a board user who calls the
>   export API. Its paths are:
>   - `packages/shared/src/company-archive.ts`
>   - `server/src/services/run-read-redaction.ts`
>   - `server/src/services/company-archive*.ts`
>   - `doc/company-archive.md`
>
>   **Company archive change (privacy review).** A change that adds an entity or
>   a field to the archive or export, or weakens redaction, needs a privacy
>   review and a `v` bump where the meaning changes. It does not use the
>   telemetry contract.

## 12. Threat model

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Company A's data lands in company B's bucket | Composite FK on destination; worker queries and object keys bound to one company id; no physical bucket shared across companies on one instance (section 6.3); two-company canary test in W1 (export) and W3 (archive) | One cloud account can hold keys to several buckets (credential hygiene, section 6.3) |
| T2 | Secrets in transcripts leave the instance | Same read-time redaction as the API, per record; registered secret values replaced; secret registry stripped; archive opt-in with an explicit consent text in UI | Pattern redaction misses unknown secret shapes; the archive makes such a miss durable outside the instance. `redaction.v` lets a later re-archive rewrite bundles. |
| T3 | Destination credentials leak | Only secret references stored; values resolved per worker tick, never logged or returned; masked API responses; rotation via `PATCH credentials` | A board user can always read their own company's secrets |
| T4 | SSRF via a custom endpoint | HTTPS only; DNS/IP check at connect time; no redirects; private ranges only through an operator allowlist | |
| T5 | Bucket is public or shared | Probe fails (activation refused) when an anonymous GET succeeds; same bucket refused across companies; out-of-prefix probe records `prefix_scoped` or `bucket_wide` | A prefix is not an access policy (S3-01); `bucket_wide` is shown, not blocked |
| T6 | Data at rest at the provider | SSE (`s3_managed` default, `kms`); `bucket_default` only with a recorded board acknowledgment because a HEAD cannot prove it | Anyone holding the bucket key reads plaintext; client-side encryption is decision D5 |
| T7 | Tampering in the bucket | Per-file SHA-256 in the manifest; deep verify before any prune | The manifest is not signed (HMAC signing is a W5 option) |
| T8 | Insider bulk exfiltration through the export API | Board-only; one activity row per export | A board user already has full read access |
| T9 | Cost or disk exhaustion (big backfill) | Per-tick byte budget, one run at a time per company, staging files removed in `finally`, staging under the instance data dir | Egress cost is the company's |
| T10 | Losing data by pruning too early | Prune off by default, min 30 days, deep verify right before delete, observability guard, never prunes runs/costs/activity | |
| T11 | Company deleted | New tables reference `companies` with `on delete cascade` (company delete removes about 30 tables explicitly and relies on FK cascades for the rest, `services/companies.ts:538-587`); destination secret bindings go with the company's secrets; bundles stay in the company's own bucket | Erasure in the bucket is the company's job |
| T12 | Plaintext left in local staging after a crash | `0700` dir, `0600` files under the instance data dir; deleted in `finally`; staging dir emptied at worker startup | Files are redacted already; no secure erase on SSDs |
| T13 | Stale worker overwrites a newer bundle | Fencing token on ledger and cursor commits; immutable attempt prefixes and immutable per-attempt manifests ordered by fencing generation (sections 5, 7.2) | None known: no bundle object is ever rewritten |

## 13. Size and cost estimate

**Measured** (operator read-only check of the production instance, 2026-10-09):
run logs grow about **142 MB a day** (853 MB in 6 days, 2,218 NDJSON files,
largest 10 MB), all as local files on the instance host; the `RUN_LOG_S3_*`
mirror is not used. That is about 370 logs a day at a mean of about 385 KB.
The operator's earlier figure of about 950 runs a day includes runs that never
wrote a log (cancelled or deferred before start). Items marked **A** are still
assumptions.

| Quantity | Value |
|---|---|
| Raw transcripts per day | 142 MB (measured) |
| Events per day | A: no more than the transcripts (events are mostly short lifecycle and tool rows) |
| Gzip ratio on NDJSON | A: 6x (JSON with repeated keys) |
| Compressed bundles per day | about 25 MB transcripts + up to 25 MB events and small files: **25-50 MB** |
| Per year | **about 9-18 GB** |
| Storage cost after one year | AWS S3 Standard about $0.20-0.40/month; R2 about $0.15-0.30/month; OVH Standard less |
| Requests | 7 PUT/HEAD per run, about 370 runs a day: about 80k a month, about $0.40/month on AWS, free tier on R2 |
| Backfill of the current history | 6 days of logs (853 MB raw) is about 150-300 MB compressed: minutes at the default 256 MiB-per-minute budget |
| Largest single bundle | a 10 MB log compresses to about 2 MB; it stays a single PUT (multipart starts at 16 MiB) |

Measure before enabling backfill on a production instance (read-only SQL):

```sql
select count(*) runs, sum(log_bytes) log_bytes,
       percentile_cont(0.5) within group (order by log_bytes) p50,
       percentile_cont(0.95) within group (order by log_bytes) p95
from heartbeat_runs where created_at > now() - interval '7 days' and log_bytes is not null;
select pg_size_pretty(pg_total_relation_size('heartbeat_run_events'));
select count(*) / 7 events_per_day from heartbeat_run_events where created_at > now() - interval '7 days';
```

## 14. Slices (each one shippable alone, each on web, API and CLI)

Standing rule (2026-10-09): every feature ships on the **web UI, the API
(OpenAPI) and the CLI**, so agents can do what humans do within their
permissions. Each slice below ships all three, or names its linked follow-up PR.

| Slice | Scope | Web | API (OpenAPI) | CLI | Depends on | Size |
|---|---|---|---|---|---|---|
| **W0** | This plan | | | | none | doc |
| **W1** | **Format v1, shared redaction, streaming export.** `packages/shared/src/company-archive.ts` (kinds, envelope, cursor codec) and `HEARTBEAT_RUN_TERMINAL_STATUSES`; `run-read-redaction.ts` used by the three run routes, plus the export pass; `RunLogStore.openReadStream`; export service; index migration; AGENTS.md data-path entry; `doc/company-archive.md`. | Company Settings, "Data export": window and entities, download (`follow=true`) | `GET /companies/:id/archive/export` (board) | `archive export` with `--resume` | none | M |
| **W2** | **Company storage destinations (S3-01 subset).** `storage_destinations`; `storage_destination` secret-binding target; S3 provider credentials, SSE, content encoding; endpoint validation and operator allowlist; probe (fail-closed public read, out-of-prefix check, `bucket_default` acknowledgment); one physical bucket per company per instance; activity rows. | Company Settings, "Storage destinations": create, probe, rotate credentials, retire, masked status | `GET/POST /storage/destinations`, `POST …/probe`, `PATCH …/credentials`, `POST …/retire` | `storage destinations list|create|probe|rotate|retire` | none (S3-01 contract) | L |
| **W3** | **Archive delivery and status.** `company_archive_settings`, `company_archive_runs`; worker (fenced lease, cursor, settle, backoff, parking, byte budget, staging cleanup); bundle writer with attempt prefixes and immutable manifests; reconcile and drift sweep. | Company Settings, "Data archive": enable with consent text and backfill choice, destination pick, status (state, lag, last archived run, last error, parked runs with retry) | `GET/PUT /archive/settings` (board), `GET /archive/status` (board, and agents allowed `company_scope:read`: counts and state only), `POST /archive/runs/:runId/retry` (board) | `archive enable|disable|status|retry` | W1, W2 | L |
| **W5** | **Verify and re-archive.** Full GET + SHA-256 per bundle (`verifiedAt`), re-archive after a policy bump or late drift, opt-in cleanup of superseded attempts, optional HMAC manifest signing. | Status shows verified share; "Verify now" and "Re-archive since" actions | `POST /archive/verify`, `POST /archive/rearchive` | `archive verify`, `archive rearchive --since` | W3 | M |
| **W6** | **Prune after verified archive** (section 9), with the observability guard; 410 responses with the archive location. | "Prune after N days" setting with the guard state shown | `PUT /archive/settings` prune fields; 410 on pruned run reads | `archive prune status` | W5, observability 1a/1b | M |
| **W7** | **Company streams:** activity and costs without a run, issue comments, documents, tool calls, `run_usage_records` (via `listUsageRecordsAfter`) and `run_context_records` (via `listContextRecordsAfter`, kind `observability.context_record`), daily partitions `streams/<entity>/dt=…/part-<n>.ndjson.gz`. | Entity toggles in "Data archive" and "Data export" | export `include` values and archive settings | same flags | W3, observability 1a | M |
| **F3** | Separate bug fix: reaper race at `heartbeat.ts:19484` (section 4) | none (no surface) | none | none | none | S |

**Archive status** (W3) is readable on all three surfaces: state (`off`,
`active`, `backing_off`, `paused_error`), lag (age of the oldest settled run not
yet archived, and the count behind the cursor), last archived run and time,
last error code and sanitized message, parked runs, and the destination's probe
and encryption state. Status holds no run content, so agents with
`company_scope:read` may read it; configuration and retry stay board-only.

Order rationale: W1 has no credentials, no new table and no remote writes, so it
is the lowest-risk first step, it already answers "export all traces and data",
and it fixes the record format and the redaction module that W3 writes with.
W2 is independent of W1 and can be built in parallel.

## 15. Test plan

| Slice | Tests (fail before, pass after) |
|---|---|
| W1 | Cursor codec round trip and rejection of malformed cursors. Keyset over microsecond-close settle keys (no skip, no repeat). Two-company isolation: company B's export never contains company A's canary. Redaction canary: a registered secret value, a secret-named payload key, a bearer token and (with the flag on) a home path never appear in the export; the three routes still return the same bodies (route regression tests). Transcript with a multi-byte character across a 1 MiB boundary survives intact. Missing log yields `run.omission`. Settle cutoff excludes a run finished 1 minute ago. Board-only: agent with `company_scope:read` gets 403. Activity row written. Streaming: client abort stops the query loop. CLI: follows `next`, `--resume` continues after a cut-off file. OpenAPI route test. |
| W2 | Two-company negative cases (foreign destination, foreign secret). Secret missing or revoked fails visibly, no ambient fallback. Endpoint validation: http, credentials in URL, private IPv4/IPv6, DNS rebinding to a private address, redirect. Probe against a local S3-compatible fake: success, wrong key, SSE rejected, timeout with leftover cleanup, public-read warning. Idempotent create with the same UUID; conflicting reuse is 409. Activity rows. |
| W3 | Worker against a fake S3: bundle layout, manifest last, checksums match the stored bytes, SSE header sent. Crash after upload before commit re-uploads the same keys. Destination outage backs off and does not advance the cursor; a corrupt run is parked after three tries and the stream continues. Settle delay. Advisory lock: two workers, one runs. Reconcile sweep picks a late-terminal run. Two-company canary across buckets. Disable stops uploads. |
| Web (every slice) | Playwright spec for the settings section (happy path, error path), browser check at desktop and mobile widths with zero console errors, `pnpm check:token-gates`. |
| W5-W7 | Per slice: verify detects a modified object; re-archive rewrites with the new policy version; prune refuses without the observability table, without verify, under 30 days; prune deletes only events and logs. |

Each PR runs the touched suites, `pnpm --filter @paperclipai/shared build`, server
`tsc --noEmit` filtered to changed files (this host lacks `cargo`, see
DEVELOPING notes), and reports what it could not run.

## 16. Coordination

| Track | Agreement |
|---|---|
| Full observability (`feat/full-observability`) | Agreed 2026-10-09. It **measures** (`run_usage_records`, `/observability/*`, ids, numbers and enums only); this track **archives and exports raw content**. Shared envelope (`kind`, integer `v`), cursor (base64url, settle key `coalesce(finished_at, created_at)`, 10-minute settle) and dedupe rule. Its follow-up F1 (retention of run events and logs) moves here as W6 with its guard. W7 archives its records via `listUsageRecordsAfter`, keyed by `(runId, schema_version)`. Amended 2026-10-09 for its context track (C1): a second prune condition, a `run_context_records` row at `RUN_CONTEXT_RECORD_EVENTS_CONSUMED_VERSION` for every run once C1 ships, no exception, wired by whichever of W6 and C1 lands second (section 9), and W7 may archive `context_records.ndjson` (kind `observability.context_record`, `v` = its `schema_version`) through `listContextRecordsAfter`, with the same cursor and settle rules. |
| S3 artifacts plan (S3-01..S3-08) | W2 implements the S3-01 subset (destinations, secret binding, probe) to that contract. S3-02/S3-03 later add `company_storage_settings`, asset columns and `PUT /default` on top. No second destination or credential model. |
| Migrations | `0296` is claimed by open PRs #31 and #40; W1-W3 take the next free number when they rebase. |

## 17. Decisions for the user

| ID | Question | Recommendation |
|---|---|---|
| D1 | Slice order: export (W1) first, archive delivery in W2-W3? | Yes: smallest, no credentials, fixes the format first. |
| D2 | When a board enables the archive, default backfill: all history or from now? | All history (the goal is every session over time), shown with the size estimate before confirming. |
| D3 | Who may call the bulk export: board only, or also agents with an explicit permission? | Board only in v1. |
| D4 | Default SSE mode `s3_managed` (AES256) with `bucket_default` allowed for providers that reject the header? | Yes. |
| D5 | Client-side encryption (company key, for example age or libsodium) on top of SSE? | Not in v1; revisit if a company needs protection from its own bucket provider. |
| D6 | Prune after archive: off by default, minimum 30 days, never runs/costs/activity? | Yes. |

## 18. Independent review log

**Round 1** (2026-10-09, Codex `gpt-6-astra`, read-only, verdict REJECT). Every
finding was accepted; resolutions:

| # | Finding | Resolution |
|---|---|---|
| B1 | Read chain leaves event `message` (direct writers), cost rows, activity rows and transcript text without pattern redaction | Export pass on every exported record (section 2.1); direct-writer canary tests for event message, transcript line, cost `billing_code` and activity details; mutation check shows the test fails without the pass |
| B2 | Late-terminal runs can be skipped; record timestamps are milliseconds, not microseconds | Gap stated in sections 4 and 19 and in `doc/company-archive.md`; archive reconcile sweep (7.4). Contract fixed: only the settle key and cursor carry microseconds |
| B3 | Lease expiry is not a fence; ledger keyed by run only | `leaseGeneration` fencing token on every commit; immutable `a=<attemptId>/` prefixes with the manifest naming one complete attempt; ledger PK `(destinationId, runId)` (sections 5, 7.1, 7.2) |
| B4 | "Settled" does not freeze child rows | High-water marks in `run.end` (implemented) and in the manifest and ledger; drift sweep re-archives changed runs for 30 days; `rearchive --since` after that (7.4, W5) |
| B5 | Isolation not proved when a bucket is shared | One physical bucket per company on an instance; public-read probe fails closed; out-of-prefix probe recorded (6.3, T1, T5) |
| N1 | `.gz` CLI output promised, not built | Dropped; pipe to `gzip` |
| N2 | `--resume` does not check options | Header fingerprint: company, `--include`, `--since` must match; omitted ones come from the file (tested) |
| N3 | One run can exceed the per-tick byte budget | Such a run is archived alone in its own tick (7.2) |
| N4 | Staging leftovers after a crash | Startup cleanup and threat T12 |
| N5 | `bucket_default` cannot prove encryption | Recorded as `unverified`; activation needs a board acknowledgment (6.2, T6) |

**Round 2** (Codex `gpt-6-astra`, verdict REJECT). B1 and B5 resolved. Remaining
items and resolutions:

| # | Finding | Resolution |
|---|---|---|
| B2 | Incremental guarantee still has a gap | Guarantee stated exactly (section 4); the only current violator is the reaper race; separate fix F3 proposed; reconcile sweep covers it meanwhile |
| B3 | The shared mutable manifest is not fenced | Removed: per-attempt immutable manifests named by fencing generation; readers take the greatest (section 5) |
| B4 | Marks cannot reveal late cost or activity rows | `run.end` marks now carry `costCount` and `activityCount` (implemented and tested) |
| New | A page of deleted runs ends the export early | Cursor advances before the skip (implemented); test deletes a run mid-stream |

**Round 3** (Codex `gpt-6-astra`, verdict REJECT). B3, B4 and the pagination
item resolved. Remaining:

| # | Finding | Resolution |
|---|---|---|
| B2 | The reaper race still breaks the incremental guarantee for W1 export consumers; the W3 sweep does not help them. Satisfied by landing F3 or an export-side reconciliation | F3 built as its own PR (#65): `setRunStatusIfRunning` compare-and-set, regression test red before and green after. W1 (#61) merges after #65 |
| New | CLI `--resume` neither keeps nor validates `--until` | `export.header` records `requestedUntil`; resume reuses it when omitted and refuses a different one (tested) |

**Round 4** (Codex `gpt-6-astra`, narrow closure check, verdict **APPROVE**).
B2 resolved by F3 (#65): the reaper's detached-process write and its process-loss
path are both compare-and-set, so no reaper write reopens a terminal run by id.
`--until` resume resolved.

A separate code review (Claude code-reviewer, round 1 of W1 code) found 11
defects, all fixed with tests: unreadable run logs and event pages no longer
stop the export (`run.omission`); the first page is queried before the 200 is
sent; calendar-invalid cursors are rejected; the event mark is the last
exported `seq`; the abort listener is attached before the audit write; CLI
output errors, server resets, empty `--resume` files and NUL-extending
truncation are handled.

## 19. Settle-key evidence: who writes `finished_at`

Read-only audit of every `heartbeat_runs` status write in `server/src` at
`be8194f90` (packages have none; no raw SQL updates outside tests):

- **Every write that moves a run into a terminal status sets `finished_at`**
  (directly, through the `setRunStatus` patch, or as `run.finishedAt ?? now`).
  The five writes without it keep a status the run already had
  (`heartbeat.ts:13403, 19023, 11849`, `recovery/service.ts:1942, 4677`), so the
  old value stays.
- **Re-stamps move the key forward.** Five paths overwrite `finished_at` on a run
  that is already terminal (`heartbeat.ts:30180` failed to cancelled,
  `native-restart-recovery.ts:827`, `native-finalization-reconciler.ts:455`,
  `native-session-executor.ts:8930`, any `setRunStatus` landing on a terminal
  run). The run then appears again later in the stream. Consumers keep the last
  occurrence per run id.
- **Revives clear it.** The four reachable terminal-to-running paths (all
  native: `native-restart-recovery.ts:967`, `native-finalization-reconciler.ts:514`,
  `native-workspace-export-recovery.ts:91`, `native-workspace-export-retry.ts:137`)
  set `finished_at` to null; the run settles again with a new key and is
  exported again. Two paths that keep it are unreachable in production
  (`status-decision-committer.ts:953`, `native-session-executor.ts:7021`).
- **Remaining gap:** historical rows that are terminal with a null
  `finished_at` (settle key = `created_at`), and a race in `setRunStatus`
  (`heartbeat.ts:19484`, write matches on id only) that can flip a just-finished
  run back to running with its old `finished_at`. Both are covered by the full
  export and by the archive reconcile sweep; neither needs a new column.
