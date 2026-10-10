# Full observability: usage, cost, waste, bottlenecks and closed feedback loops

Date: 2026-10-09
Status: Phase 1 (data inventory and slice plan) plus Track C (context visibility, section 7.9, slices C1-C5). This pull request is the plan only; the code ships in the slices below.
Branch: `feat/full-observability`

## 1. Goal and constraints

Give operators one place (the Audit hub, API and CLI with identical data) to see
what every run consumed and what it achieved, per run, routine, agent, issue,
project and company, so bottlenecks and waste are found from data and every change
is measured afterwards: **data, finding, decision, change, measured result**.

Why now (operator reports, not independently measured
here): hundreds of runs a day with a large share failing in bursts (server restarts,
worker disk full, restore-lock timeouts, provider quota, external-service quota); a
large always-loaded skill that every run pays for; no view joins agent effort to
outcomes (runs, PRs, CI cycles, review rounds, merges), and no view shows how the
context window fills over a session or what a skill or system prompt costs in it.

Constraints, all binding:

- **Company isolation** on every table, query, panel and export.
- **No secrets or prompt contents in metrics.** Counts, closed enums, ids and
  length-capped identifiers only.
- **Cheap at write time**, heavy work async, indexes planned for millions of runs,
  an explicit retention policy.
- **Fail-open.** An observability failure never fails, delays or retries a run.
- **Migrations safe on a live DB**: additive `CREATE TABLE` only, no `ALTER` of hot tables.
- **API, CLI and UI parity** for every panel.

### Which data path this is (AGENTS.md section 5.7)

This feature is on the **run-log path**: rows in the local instance database,
queried by the local server. It is **not Paperclip Telemetry** (first-party events to
a Paperclip endpoint) and **not OpenTelemetry** (operator OTLP endpoint). This
feature itself sends nothing off the instance, so neither the strict telemetry review
nor the generated telemetry contract applies. The existing `agent.task_run` telemetry
event (`packages/shared/src/telemetry/events.ts:127-154`) and the terminal-run seam that
emits it (`heartbeat.ts:12939`) are not used. A reviewer should reject any slice that
imports from `packages/shared/src/telemetry/`. What a *consumer* of the export (for example a decisions engine) does
with it is the consumer's responsibility; the export carries ids, numbers and enums only.

## 2. How this was measured, and what was not

- **Method:** read the schema and the code that writes it (five parallel read-only
  inventories, spot-checks of every claim that drives the design, then an independent
  adversarial review that checked about 35 `file:line` claims and challenged the
  design; its corrections are applied in this version). Each claim carries a
  `file:line` from `main` at `a91d77cc4`. Items I could not confirm in code are marked
  **UNVERIFIED**.
- **Not measured: any live data.** The only instance available while writing this is a
  development install: its database holds no runs, agents or issues, and its on-disk run
  logs are tiny (none over 4 KB, none with a usage, compaction or skill marker). Nothing
  here was measured on a production company by this document's author. The operator's reports are cited, not reproduced.
  **Update, 2026-10-09:** the operator ran A5, A7 and the count-only checks of Appendix B on a
  production company. Their qualitative results are applied below (rows 2, 29, 31 to 33 of
  section 4, section 5 and section 7.9). Figures and names from that instance stay out of this
  public repository.
  Appendix A is a set of 12 read-only SQL queries for an operator to run on a real company;
  all 12 were executed against a freshly migrated empty schema to prove they parse and
  every column exists (that proves syntax, not results). **A1, A5 and A7 should run
  before any token rollup is trusted** (section 5).
- **Prior art this builds on, not replaces:**
  - `doc/plans/2026-03-14-billing-ledger-and-reporting.md`: `cost_events` stays the
    canonical **spend** ledger; `heartbeat_runs` stays the operational log. The new
    record is a third thing, an **analytics fact** per run, and never feeds billing.
  - `doc/plans/2026-03-13-TOKEN-OPTIMIZATION-PLAN.md`: found cumulative session totals
    stored as per-run usage. `usage_json` now has normalized and raw keys plus
    `usageSource`; section 5 covers what is still unsafe.
  - `doc/run-log-events.md` and `doc/acp-run-lifecycle.md`: the closed-allowlist,
    duration-and-outcome-only, fail-open pattern for run-log events. Reused here.

## 3. What exists today

### 3.1 Per-run storage

| Where | What it holds | Writer | Gaps for observability |
|---|---|---|---|
| `heartbeat_runs` (`packages/db/src/schema/heartbeat_runs.ts`) | status, `error_code` (free text), `created_at`/`started_at`/`finished_at`, retry links (`retry_of_run_id`, `scheduled_retry_*`), `liveness_state`, `usage_json`, `result_json`, `context_snapshot`, `runtime_mode`, `driver_kind`, `driver_version`, log pointers (`log_bytes`) | claim at `heartbeat.ts:17802`, main terminal patch `:25721-25742`; 20+ other writers make a run terminal (reaper, shutdown, cancel, deferral, native reconcilers) | No model, provider, token or cost columns. Run to issue link is jsonb only. `process_loss_retry_count` has no writer (`heartbeat.ts:19510` reads a value that is always 0). No status history. No retention. Index `(company_id, created_at desc)` exists; nothing indexes `finished_at` or `usage_json` keys. |
| `usage_json` (same table) | normalized `inputTokens`/`cachedInputTokens`/`outputTokens`, `raw*` twins, `usageSource` (`session_delta` or `per_run`), session reuse flags, `provider`, `biller`, `model`, `costUsd`, `cacheAdjustedCostUsd`, `costStatus`, `billingType` | single writer `heartbeat.ts:25641-25727`, only on the main adapter-result path; null when there is neither usage nor cost | Untyped (`Record<string, unknown>`); readers tolerate snake_case aliases (`activity.ts:45-85`, `work-timeline.ts:143-157`), so the shape has drifted. Three token classes only. Runs killed by the reaper or shutdown have none. |
| `result_json` (same table) | adapter result plus server keys (`summary`, `executionRecovery`, `configFreshness`, `errorFamily`, `stopReason`, `cancellation`, `workspaceBusy`, ...). For Claude it is the raw CLI result event (`claude-local/execute.ts:1239-1240`) | `heartbeat.ts:25706-25710` | The natural home for a bounded, versioned `observability` object (section 7.2). |
| `cost_events` (`schema/cost_events.ts`) | one row per finalized run with tokens or cost above 0: provider, biller, billing type, `cost_status`, model, input/cached/output (int4), `cost_cents` (int4), `heartbeat_run_id`, issue, project | `updateRuntimeState`, `heartbeat.ts:20120-20190` | No cache-write, reasoning, routine or latency. Sub-cent cost rounds to 0 cents (`heartbeat.ts:5375-5382`). `occurred_at` is finalization time. Each insert also runs two monthly SUMs, two updates and budget evaluation (`costs.ts:56-104`), so it is not a cheap write to copy. |
| `agent_runtime_state` | lifetime counters (`total_input_tokens` ...), `last_run_*` | `heartbeat.ts:20154-20168` | No time dimension; cannot be trended. |
| `heartbeat_run_events` | per-run log: lifecycle rows, `adapter.invoke`, retries, interruptions, `run.phase.timing`, `run.startup.step`, native `run.performance.span` and `usage.reported` | `appendRunEvent`, `heartbeat.ts:13950-14037`; each append locks (`FOR UPDATE`) and rewrites the run row (`heartbeat-run-events.ts:55-76`) | No retention. Native runs persist every protocol event (hundreds to thousands of rows per run, estimate). No `agent_id` index. |
| `tool_call_events` / `tool_invocations` (`schema/tool_access.ts:726-783,818-871`) | run-linked `tool_name`, `outcome`, `latency_ms`, `result_size_bytes`, `error_code`; index `(company_id, run_id)` | tool gateway | Gateway tools only; native and CLI-internal tool calls are not here (UNVERIFIED how complete). |
| NDJSON run log | raw stdout/stderr chunks with server receive time | `onLog`, `heartbeat.ts:23489-23563`; store `run-log-store.ts` | No retention (UNVERIFIED for the S3 mirror). Timestamps are receive time, not provider time. |
| `agent_wakeup_requests` | `requested_at`, `claimed_at`, `finished_at`, `status` (including `skipped`, `coalesced`), `reason`, `coalesced_count` | 20+ sites | `(company, agent, day)` has no exact index. |
| `workspace_operations`, `environment_leases`, `execution_workspace_runtime_leases` | workspace phase timings; lease acquire/release; per-workspace lock | `workspace-operations.ts:524`, `environments.ts:1606-1759`, `workspace-runtime-leases.ts:195` | Lease acquire latency is not stored (`acquired_at` is `defaultNow`). The runtime lease row is deleted on release (`:307`), so lock-contention history is gone. |
| `activity_log` | `issue.updated` with `details.changes.status.{from,to}`, plugin rows, `run_id` | `activity-log.ts:163` | Status key shape differs by writer (`_previous.status`, `previousStatus`, `reopenedFrom`). No index on `action`. |
| `agent_config_revisions`, `company_skill_versions`, `agent_instruction_revisions` | who changed what and when | `agents.ts:838-849` | Raw material for the "changes" view; no link to later metrics. |

### 3.2 Aggregations and surfaces on `main`

- **Audit hub exists:** `ui/src/pages/audit/AuditHub.tsx` with sections `activity`, `runs`, `costs`, `budgets`, `timeline` at `/activity/*` (`App.tsx:405-420`). The routes sit behind `streamlinedUiEnabled`, which `Inbox.tsx:821` hard-codes to `true`. New panels extend this hub.
- **Costs page** (`ui/src/pages/Costs.tsx`) and routes `GET /companies/:id/costs/{summary,by-agent,by-agent-model,by-provider,by-biller,by-project,window-spend}` (`routes/costs.ts`). They group by agent, provider, biller, model, project. **None groups by day** (`costs.ts` and `dashboard.ts` contain no `date_trunc`).
- **Dashboard** (`services/dashboard.ts:30`): 14 UTC days of `{succeeded, failed, recovered, other, failedByErrorCode}` via a retry-chain CTE. No tokens, no cost per day. "Recovered" is computed at read time from retry chains.
- **Recovery report:** `GET /companies/:id/recovery-observability` (weekly recovery rate against a 2% threshold, by cause group). No UI client, no CLI.
- **Run detail** (`AgentDetail.tsx:3381`, `runMetrics()` `:365-389`) reads `usageJson` per run. `AuditRuns.tsx` lists at most 200 runs.
- **CLI:** `cost` (no date flags although the API takes `from`/`to`), `finance`, `budget`, `dashboard get`, `activity list`, `run list/live/get/events/log`, `routine runs`. None for `audit/agent-actions` or `recovery-observability`.
- **Parity enforcement on `main`:** only `server/src/__tests__/openapi-routes.test.ts` (every mounted route literal must be registered in `routes/openapi.ts`). There is **no** CLI-to-API parity test on `main`; PR #22 adds a coverage matrix and is unmerged.
- **PR #28 (open):** `GET .../heartbeat-runs` filters and `GET .../heartbeat-runs/stats` (status counts, top-20 error codes, per-agent cap usage). Query-only, no migration. It does **not** cover tokens, cost, per-day or per-cause series.

### 3.3 Outcomes and lifecycle

- **Issues:** `createdAt`, `startedAt`, `completedAt`, `cancelledAt` exist; **no `in_review_at`**. First run is `min(heartbeat_runs.started_at)` via the `context_snapshot->>'issueId'` expression index. In-review time is only in `activity_log`.
- **Routines:** `routine_runs` has status (`received|coalesced|skipped|issue_created|completed|failed`), `linkedIssueId`, `coalescedIntoRunId`, `failureReason`. A routine is linked to runs only through `issues.origin_kind='routine_execution'` and `origin_id`; the run path resolves it at `heartbeat.ts:10969-11033` but **never persists it**. No endpoint rolls up per-routine cost or outcome.
- **Human wait:** `issue_thread_interactions.resolved_at - created_at`; indexes are per issue only.
- **Review rounds (internal):** `issue_execution_decisions` (stage `review|approval`, outcome).
- **Work products:** `issue_work_products` (`pull_request` type, statuses `merged|closed|...`) with PR state refreshed on read; **`merged_at` is reduced to a boolean and discarded** (`github-external-object-provider.ts:199`). No open or merge timestamps stored. `metadata.git` does not exist on `main`; PR #45 adds it and hides unlinked rows via `linkedWorkProductCondition()`.
- **GitHub plugin:** the one-minute poll lists issues only and drops PRs (`github.ts:287-290`). PRs arrive only by webhook (`sync.ts:518-563`), which many installs leave off. `check_run` payloads are used to find a PR number and the conclusion is dropped. CI checks and reviews are read live for merge gating and never persisted. Runner minutes: no code at all.
- **Plugin SDK host APIs:** `ctx.metrics.write` (stored as `plugin_logs` rows with `level='metric'`, not query-friendly), `ctx.telemetry.track` (forwards to the external telemetry client; not persisted), `ctx.entities`, `ctx.db`, `ctx.events.emit`. No outcome-reporting API.
- **Plugin company scoping is not enforced by the host.** Plugins are instance-wide and `ensurePluginAvailableForCompany` is a documented no-op (`plugin-host-services.ts:803-808`); `ensureCompanyId` only checks the id is present (`:767-770`).

## 4. What is missing

Verdicts: **Missing** (no source), **Partial** (some source, wrong shape or lossy),
**Derivable** (computable from stored data, nobody does), **Present**.

| # | Candidate | Verdict | Evidence | Proposed source | Slice |
|---|---|---|---|---|---|
| 1 | Token classes per run: input, cache-read, cache-write, output, reasoning | **Partial** | `UsageSummary` has input/cached/output only (`adapter-utils/src/types.ts:33-37`). Claude folds cache-write into input (`claude-local/parse.ts:49`); its fallback path drops it (`:111-115`). ACPX folds it too (`acpx-engine/execute.ts:3278-3285`); the split survives only in `result_json.usage` as `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens` (`:3287-3298`, `:5097`). OpenCode folds reasoning into output (`opencode-local/parse.ts:53-62`). Native normalizer drops reasoning (`native-session-executor.ts:9322-9346`). Claude's raw result event, already in `result_json`, probably holds `cache_creation_input_tokens` (UNVERIFIED, see A6). | Disjoint classes in the record; adapter fields in `result_json.observability`; backfill from `result_json` | 1b-1d |
| 2 | Token-class semantics comparable across providers | **Missing** | Claude `inputTokens` is `input + cacheCreation` with cache-read separate. **Measured on a production company (2026-10-09):** OpenAI-family and xAI (grok) streams report the cached count *inside* the input count; Anthropic streams report it *on top*. The adapter label does not predict the shape: a `codex_local` run on an Anthropic model emits Claude stream-json. The mapping therefore keys on stream shape and provider, not on `adapter_type`. Cache hit rate computed as `cached/input` is wrong for the providers that count cached tokens inside input. | Per-provider mapping into disjoint classes. Slice 1a applies it for the providers `openai` and `xai`; those two labels are an assumption until a count-only check lists the distinct provider and model pairs. Fixtures from the real CLIs follow in 1b-1c | 1a / 1b-1c |
| 3 | Per provider and model per run | **Partial** | One model per `cost_events` row. Claude's per-model `modelUsage` is summed away (`parse.ts:39-55`). Provider hard-coded `anthropic` whatever the base URL (`claude-local/execute.ts:1265`); managed connection attribution sits only in `context_snapshot.aiConnection` (`heartbeat.ts:21889`). | `model` (primary) and `model_count` in 1a; per-model child rows in the Claude PR; provider/biller from the connection | 1a / 1b |
| 4 | Always-loaded footprint per run, by skill | **Partial** | Character counts only, in the `adapter.invoke` event payload (`heartbeat.ts:23651-23663`). Claude's instruction file (`--append-system-prompt-file`, `execute.ts:873-875`), skills manifest (`:526-533`) and mounted skills (`:549`) are **not measured**. No tokenizer anywhere. | Launch-time manifest (kind, `skillKey@versionId`, chars) plus measured first-turn prompt tokens (needs per-message usage; the Claude parser ignores it, `parse.ts:76-89`) | 1b |
| 5 | Queue wait vs run time | **Derivable** | `started_at - created_at`; native `heartbeat.queue` span row exists. Nothing stores or aggregates it. | Derived once into the record | 1a |
| 6 | Lock and lease wait (restore lock, workspace busy) | **Partial** | Restore lock: only the timeout code, no wait duration on success (`workspace-restore-merge.ts:204,274`; PR #21 raises the wait to 10 min). Workspace busy: a chain of cancelled runs linked by `retry_of_run_id` (`heartbeat.ts:16474-16553`). Lease acquire latency not stored. | Workspace-busy chain derivable in 1a. A `lock_wait_ms` column is added in the PR that adds a source (after #21) | 1a / later |
| 7 | Retries and their cause | **Partial** | `retry_of_run_id`, `scheduled_retry_reason` (about 9 values), `scheduled_retry_attempt`. In-run provider retries and 429s not counted (pi's `auto_retry_end` used only on final failure). | `retry_depth`, `retry_reason` in 1a; in-run provider error counts with the adapter PRs | 1a / 1b-1d |
| 8 | Provider latency, 429s, capacity errors | **Partial** | No legacy time-to-first-token. Native persists `provider.time_to_first_agent_event` span rows (`native-run-trace.ts:281-311`), which nothing reads. Runtime classification into `errorFamily` exists only for claude, codex, hermes gateway and ACPX (`hermes/.../execute.ts:773`, `acpx-engine/execute.ts:5043-5069`). Gemini, kimi and openclaw return named setup/gateway codes (`gemini-local/.../execute.ts:217`, `kimi-local/.../execute.ts:197`, `openclaw-gateway/.../execute.ts:1056-1403`) but nothing for runtime quota or rate limit; grok, cursor, opencode, pi fall to `adapter_failed` (`heartbeat.ts:25600-25602`). | Native span rows; shared classifier over the stderr excerpt | 1a / 1d |
| 9 | Worker CPU, memory, disk per run | **Missing** | No `rss`/`memoryUsage`/`du` stored anywhere. Disk-full has **no error code**; ENOSPC appears only in a diagnostics errno list (`workspace-restore-diagnostics.ts:6`). Low free space throws `workspace_git_scan_failed` (`workspace-manifest.ts:18-26`). A `statfsSync` free-space check already runs there: a free sampling point. | Cause classifier now (stderr/errno); sampling of free bytes at that point as a separate PR | 1a (classifier) / 7 |
| 10 | Run-workspace bytes | **Missing** | `execution_workspaces` has no size. PR #44 records `bytesFreed` in `activity_log` when it reaps. | Read #44's activity rows | 7 |
| 11 | Per-routine cost and outcome | **Derivable** | routine to issue (`origin_id`) to runs and `cost_events.issue_id`. No endpoint. | Persist `routine_id` on the record, resolved with the existing resolver logic | 1a / 2 |
| 12 | Issue lifecycle timings (created, first run, in review, done) | **Partial** | See 3.3. In-review needs `activity_log` parsing; `status_decisions` is native-runtime only. | One normalizing reader over `activity_log` (see section 9; no history table exists and none is planned elsewhere). Known shapes: `details.status` with `details._previous.status`, `details.changes.status.{from,to}` (both read by `issue-review-policy.ts`), plus `issue.git_status_automated` rows after #45. Other writers (`issue.stalled_review_decided`, plugin updates) are **not audited**; verify with A12 on real rows | 2 |
| 13 | External outcomes: PR opened/merged, CI cycles, runner minutes, review rounds | **Missing** | See 3.3. | PR lifecycle timestamps first (3a), then `outcome_events` through a shared plugin host call (3b) | 3 |
| 14 | Deploy-platform outcomes (Convex first) | **Missing** | No Convex plugin on `main` (PR #42 open). | Same host call, after #42 | 3 |
| 15 | Interruptions by cause (deploy, backup, crash) | **Partial** | `server_shutdown_interrupted` (graceful signal, `heartbeat.ts:15348-15431`) versus `process_lost` (`:19524`), `restartKind hot\|hard\|graceful` in the native recovery event. No boot or shutdown record, so deploy vs restart vs crash vs backup cannot be told apart. | `server_boot_events` (instance-level, section 7.6) plus the classifier | 1a / 6 |
| 16 | Failure cause taxonomy | **Partial** | `error_code` is free text with about 150 distinct literals (reviewer count 153; `heartbeat_runs.ts:68`) and no enum. Liveness is a closed set of 7 (`constants.ts:931-939`). `recovery-observability.ts` has its own cause groups. Convex quota has no code. | Shared closed `RUN_FAILURE_CAUSES` plus a pure classifier (error code, error family, status, signal, stderr excerpt patterns); unmapped codes surfaced | 1a |
| 17 | Turn count, tool calls, tool errors per run | **Partial** | Native: `tool.execution.*` with duration and exit code in the run log. Gateway tools: `tool_call_events` (row above). Legacy CLI tools: only in UI parsers (`claude-local/ui/parse-stdout.ts:74-117`); pi's server parser discards them. `num_turns` appears nowhere in code; Claude's raw result event, already stored in `result_json`, is expected to carry it (UNVERIFIED, A6). | Count in the adapter parsers; fixture-verify the Claude result keys | 1b-1d |
| 18 | Tokens per tool call | **Not directly observable** | CLIs report usage per assistant message, not per tool. `tool_call_events.result_size_bytes` gives a size proxy for gateway tools only. | Approximate tool-result size as context growth between consecutive turns; deferred, analysis-oriented | later |
| 19 | Dollar cost for non-billed usage | **Partial** | Server never prices (`heartbeat.ts:5375-5397`): Codex `costUsd` is always null, so those runs are `unpriced` with 0 cents. Claude subscription runs keep an API-equivalent `costUsd` in `usage_json` while `cost_cents` is forced to 0. The only price table is eval-only (`evals/model-pricing.ts`). | Tokens are the primary metric. Optional versioned price catalog for an "API-equivalent" estimate, flagged `estimated`. **Decision D3** | 2 |
| 20 | Per-day series of tokens, cost, failures | **Missing** | Section 3.2. | Query service over the record | 2 |
| 21 | Always-loaded context in tokens | **Missing** | No tokenizer (`rg tiktoken\|countTokens` finds nothing). | Measured first-turn tokens where the adapter exposes per-message usage; otherwise `chars/4` flagged `estimated` | 1b |
| 22 | Waste: failed and interrupted runs | **Derivable** | status, error code, cause. | Query layer | 5 |
| 23 | Waste: duplicate runs | **Partial** | Admission-time controls exist: wake coalescing (`status=coalesced`), `issue-rewake-throttle.ts` (its header documents a 25-session, 2.4x cost case), `SELF_REBLOCK_WAKE_LIMIT`. Nothing detects duplicates among runs that actually executed. | Window query over the record by (agent, issue, wake reason) | 5 |
| 24 | Waste: runs on closed issues | **Partial** | Only queued runs are cancelled for a terminal issue (`QueuedRunStalenessErrorCode`). A run already started on one is not flagged. | Issue status at run start and end, derived from the status timeline | 5 |
| 25 | Waste: runs on stale heads, work on merged PRs | **Missing** | No detector. | Needs PR head sha and merge time from outcome events plus the sha a run worked on | 3 / 5 |
| 26 | Waste: unproductive runs | **Present** | `liveness_state` (`plan_only`, `empty_response`, `blocked`, ...), `last_useful_action_at`. | Copy to the record | 1a |
| 27 | Retention | **Missing** | No prune job on any table in scope except DB backup pruning (`backup-lib.ts:123`). | Retention for the new tables from day one; separate follow-up for run events and NDJSON | 1e |
| 28 | Interventions (changes tied to measured impact) | **Missing** | No concept. `agent_config_revisions`, `company_skill_versions`, `agent_instruction_revisions` exist as raw material. | Derived "changes" view plus impact on read | 6 |
| 29 | Privacy | **Gap to avoid** | `adapter.invoke` stores the full `prompt` and `context` in the run log (`claude-local/execute.ts:955-962`); no key rule matches `prompt`. The operator's check confirmed that production rows hold the prompt and the process environment. Not copied into the new record. Reported, not fixed here (F2). A separate PR extends `redactEnvForLogs` with more env names and value rules (URL user info, PEM blocks). | Allowlist-only builder | all |
| 30 | Provider-side retry and no-work runs | **Partial** | Deferral cancellations (`workspace_busy`, `ai_connection_busy`, `heartbeat.ts:16423,16474`) are terminal runs that never started provider work; counting them as "failed runs" overstates failure. | `provider_work_started` flag on the record | 1a |
| 31 | Context fill per turn (how a session's context grows) | **Missing** | The server parser keeps only the final usage (`claude-local/parse.ts:76-89` ignores per-assistant-message `usage`); the UI parser reads result-level usage only (`ui/parse-stdout.ts:125-128`). ACP `usage_update` (`used`, `size`) is shown live (`TaskChatUsageReadout.tsx:11-13`); no `usage_update` event appeared in the sampled production logs, so treat it as not persisted until a fixture shows otherwise. Native and Codex events carry cumulative and run-delta spend, not fill (`runnerd-codex-transport.ts:1706-1709`). | Per-adapter pure `parseContextSamples` over the stored NDJSON, on read (7.9) | C1 |
| 32 | Compaction and truncation events | **Partial** | The runner emits `context.compacted` v1 (`reason`, `sameSession`, `compactionId`) for Codex `thread/compacted` and compaction items, but **`preTokens` and `postTokens` are always `null`** (`provider-events.ts:761-768`, `:1062-1069`), so a native compaction is a marker with no size. Claude's documented `system` / `compact_boundary` (`compact_metadata.trigger`, `pre_tokens`) has no handler anywhere in the repo, and no `compact_boundary` event appeared in the sampled production logs: the parser follows the documented shape and is tested on a hand-written fixture until a real one exists. | Parse both into the record and timeline: Claude carries `pre_tokens`; native shows the marker only until a protocol change fills the sizes (C5) | C1 |
| 33 | Model context window | **Partial** | Only ACP `size` is seen in code. Claude `modelUsage[].contextWindow` is usually present in the result event of production runs (operator check, 2026-10-09); a run without it reads `unknown`. | Store when reported, else `unknown`; never guess a window | C1 |
| 34 | Context composition at invoke time | **Partial** | Claude records `promptMetrics` chars (bootstrap, wake, handoff, task context, heartbeat prompt) in `adapter.invoke` (`claude-local/execute.ts:923-961`, `adapter-utils/types.ts:159`). Instructions and skill-listing sizes are not recorded. Instructions are injected only on a fresh Claude session (`execute.ts:931`). | One `contextComposition` key on the existing `adapter.invoke` payload, estimated tokens (7.9) | C1 |
| 35 | Skill impact on context | **Missing** | Footprint (row 21) lists skills but no token size and no load counts. UI knows a `Skill` tool name (`tool-taxonomy.test.ts:97`); the server does not count it. | Token sizes from the #51 counter; loads counted by the worker | C3 |
| 36 | System-prompt impact per agent | **Missing** | `agent_instruction_revisions` holds the content; nothing measures it against context or cost. | Baseline budget and share of first-turn context | C2 |
| 37 | Token delta on instruction, skill and model changes | **Missing** | Audit actions exist (`agent.instructions_*`, `agent.skills_synced`, `agent.updated`, `agent.config_rolled_back`, `company.skill_version_created\|updated\|file_updated`) with no size information. | Delta computed on read from revision rows | C4 |

## 5. Data-quality findings to settle before any rollup is trusted

1. **Codex usage basis is an unmeasured assertion.** The `codex_local` CLI parser
   declares `usageBasis: "per_run"` and overwrites rather than sums repeated
   `turn.completed` events (`codex-local/parse.ts:74-93`). The declaration came from
   commit `efcce9cc8` (PR #9505), whose text asserts the semantics without data. In
   contrast the repo's own runner treats Codex app-server totals as **monotonic session
   totals** and subtracts a baseline captured at resume to get a run delta
   (`paperclip-runner/src/drivers/codex/codex-usage-baseline.ts:1-45`). The token plan
   observed one reused session's counter growing across 3,607 runs. If the CLI is
   cumulative on resume, **Codex token totals are overcounted** for every resumed
   session, on any install that resumes Codex sessions. Appendix A7 answers this directly (about 100% non-decreasing
   pairs per session means cumulative; about 50% means per-run).
   **Resolved by A7 on a production company (2026-10-09): `codex_local` counts are per
   run.** The declaration holds, so no parser fix is needed (decision D8 is dropped). The
   record marks `codex_local` rows `measured`. Codex rows from the runner's app-server path
   and from any other Codex adapter stay `declared`, because only the CLI path was checked.
   One gap remains: the check could not cover a resume that reuses the same session id. Slice
   1c adds one guard test for it, and a violation would turn the rows `derived` or `declared`
   again.
2. **Claude is `per_run` on its normal path** (final result event, `parse.ts:127`; the
   `modelUsage` fallback, `execute.ts:1113-1117`). On the rare path where neither the
   stream usage nor `modelUsage` parses and it falls back to the top-level `usage`, the
   basis is null and the server's session-delta heuristic applies.
3. **The session-delta heuristic can undercount.** For adapters without `per_run`, the
   server subtracts the previous run's raw totals whenever the session id repeats
   (`heartbeat.ts:12189-12205`, `:5595-5620`). That repairs a cumulative counter and
   corrupts a per-invocation one. Affected: cursor, gemini, opencode, pi, kimi, hermes,
   openclaw, and the Claude fallback above. The record stores `usage_basis` and
   `usage_quality` so affected rows are visible, not hidden.
4. **Token classes mean different things per provider** (row 2). The record uses
   disjoint classes: `input` (fresh, uncached), `cache_read`, `cache_write`, `output`;
   `reasoning` is a subset of `output`. Cache hit rate is
   `cache_read / (input + cache_read + cache_write)`. The deriver applies the rule by
   provider: for `openai` and `xai` the stored `input` is the reported input minus the cached
   part. If the cached count is larger than the input, the counts stay as reported and the row
   is `declared`. Claude `input` still includes cache creation until slice 1b splits it.
5. **`cost_events` is not a safe base for analytics:** int4 cents (sub-cent rounds to 0),
   finalization-time `occurred_at`, no unique run constraint, heavy per-insert side effects.
   The record carries cost in micro-USD and is reconciled against the ledger, not derived from it.
6. **`process_loss_retry_count` never increments**, so the one-retry guard at `heartbeat.ts:19510` is dead. Reported, out of scope.
7. **Unbounded growth.** `heartbeat_run_events` (native: every protocol event) and the NDJSON logs have no retention. Reported as follow-up F1, not part of this feature.

## 6. What traces and transcripts already hold that an analysis consumer can use

Persisted today, no new collection needed to mine:

- **Native runs:** `emittedAt`-timed tool and turn events, `tool.execution.*` (name, status, duration, exit code), `usage.reported` with `runDelta` (the only token source for native runs finalized by the reconciler), and `run.performance.span` rows (queue, environment acquire, workspace realize, provider time-to-first-event, settle). Nothing reads the span rows today.
- **Legacy and ACP runs:** `run.phase.timing` over 12 closed phases and `run.startup.step` (`startup-timing.ts:649-862`). The `sandbox.exec` and `restore.*` details are **OTel-only** and lost without an endpoint (`doc/run-log-events.md:149-158`).
- **Gateway tools:** `tool_call_events` with latency, outcome, result size and error code per call.
- **Claude result event:** stored whole in `result_json` (`execute.ts:1239-1240`), so keys the parser ignores (per-model costs, possibly `num_turns` and `duration_api_ms`) are already on disk for backfill.
- **NDJSON log:** raw stream-json from which tool-call sequences, identical repeated calls (name plus input), `isError` results and idle gaps can be derived with the adapter parsers. Needs the UI-side parsers moved or duplicated server-side; gaps use receive time.
- **Control-plane signals:** wake skip reasons (`issue_rewake_throttled`, `heartbeat.timer.no_actionable_work`, ...), `coalesced_count`, liveness state and reason, watchdog decisions, `routine_runs` coalesced and skipped with reasons.

Not persisted (cannot be mined without new collection): legacy turn count and per-message usage, provider latency on legacy adapters, restore-lock wait on success, resource usage.

Boundary rule for the loop: metrics and exports carry **ids, numbers and enums only**. The consumer
dereferences a run id through the existing authorized run and log APIs, which is where
content access is already controlled. Content never travels through the observability store.

## 7. Design

### 7.1 One new fact table: `run_usage_records`

One row per terminal heartbeat run, **derived from the run's own row** by an async
worker (7.2), not written from the run path. Why a table, stated honestly: the existing
`(company_id, created_at desc)` index already supports time-window scans, and
`heartbeat_runs` is never pruned, so neither indexing nor retention alone justifies a
table. What does: (a) the record joins data that does not live on the run row (issue
status timeline, routine origin, wake reason, cause classification), which should be
computed once, not on every panel query; (b) it is a typed, versioned shape while
`usage_json` is untyped and has drifted; (c) it can be re-derived when the taxonomy
improves (`schema_version`) without touching the operational row; (d) it keeps analytics
indexes off the hottest table, where every run event already rewrites the row.

Columns (about 40). Every text column is either a closed enum (values outside the set map
to `other`) or an identifier restricted to `[a-z0-9_.:@/+-]`, at most 80 characters. No
free text, no hashes.

- **Keys:** `run_id` (PK), `company_id` (FK, leads every index), `agent_id`, `issue_id`, `project_id`, `routine_id`. No FKs to agents or runs: this is an analytics fact and must survive agent deletion.
- **Dimensions:** `adapter_type`, `runtime_mode`, `driver_kind` (native agents have `adapter_type = paperclip_runner`, which hides the real engine, `heartbeat.ts:25685`), `provider`, `biller`, `billing_type`, `model` (primary), `model_count`, `invocation_source`, `wake_reason` (mapped to the known set, else `other`), `is_retry`, `retry_depth`, `retry_reason`, `session_reused`.
- **Outcome:** `status`, `error_code`, `cause_family` (closed enum, 7.3), `liveness_state`, `provider_work_started`, `useful_action`, `issue_status_at_start`, `issue_status_at_end`.
- **Tokens (bigint):** `input_tokens`, `cache_read_tokens`, `cache_write_tokens` (null = adapter does not report), `output_tokens`, `reasoning_tokens` (null likewise), `usage_basis`, `usage_quality` (`measured|declared|derived|missing`).
- **Cost (micro-USD):** `cost_micros`, `api_equivalent_micros` (nullable), `cost_status`.
- **Time:** `run_created_at`, `started_at`, `finished_at` (**`coalesce(run.finished_at, run.created_at)`, never null**: `heartbeat_runs.finished_at` is nullable and not every terminal writer is proven to set it; `updated_at` is not used because event appends and the post-terminal liveness write keep bumping it), `day` (UTC date of `finished_at`), `queue_wait_ms`, `duration_ms`, `startup_ms`, `first_event_ms` (the last two nullable).
- **Activity (nullable):** `turns`, `tool_calls`, `tool_errors`.
- **Footprint (nullable):** `first_turn_prompt_tokens` (measured), `footprint_chars`, `footprint_sources` (jsonb, at most 32 entries of `{kind, ref, chars}`; `kind` is a closed set `instructions|skill|bootstrap|wake|task_context|session_handoff|prompt|mcp`; `ref` is `skillKey@versionId` for skills, so the same skill at two versions is two footprints, or an instruction revision id).
- **Meta:** `schema_version`, `source` (`derived|backfill`), `derived_at`.

Deliberately left out until a source exists: `lock_wait_ms`, `provider_active_ms`, in-run provider error counts, per-model split (arrives as a child table `run_usage_models` with the Claude adapter PR), content hashes.

Indexes (4, btree): `(company_id, finished_at, run_id)` (the trailing `run_id` makes it a keyset index for the warehouse export, section 9); `(company_id, agent_id, finished_at)`; partial `(company_id, issue_id)` where issue not null; partial `(company_id, routine_id, finished_at)` where routine not null. The `finished_at`-leading shape also serves range-delete retention.

### 7.2 Collection: derive from the row, change the run path as little as possible

The run path gets **one small addition**: a pure function `buildRunObservability(...)`
called while assembling the existing terminal `result_json` (`heartbeat.ts:25706-25710`),
so it rides the terminal UPDATE that already happens (no new query, no new write). It
takes typed inputs only (the adapter result and the invocation metadata), never reads
`prompt`, `context`, stdout or stderr, returns a bounded versioned object
`result_json.observability`, and is wrapped so any throw yields `undefined` and the
terminal write proceeds unchanged. It carries only what the row does not already hold:
`cacheWriteTokens`, `reasoningTokens`, `turns`, `toolCalls`, `toolErrors`,
`firstTurnPromptTokens`, `modelUsage[]` (at most 8), `footprint.sources[]` (at most 32).

Everything else is **derived asynchronously** by a worker from rows that already exist:

- Every 60 seconds (configurable), under a Postgres advisory lock so only one instance works at a time, for each company: select terminal runs created within a 48-hour lookback and finished more than 10 minutes ago (so `liveness_state`, written after the terminal write at `heartbeat.ts:18508`, and late metadata have settled) that have no record. The scan uses the existing `(company_id, created_at desc)` index. Batches of 200. **The 48-hour window is on `created_at`, so it misses a run that was created earlier and turns terminal later** (queued behind a paused agent, waiting on a scheduled retry, then cancelled). A daily reconcile sweep runs the same anti-join over a 30-day `created_at` window in small batches; runs it finds are counted as `late` in the health response, so the gap is visible instead of silent. Runs older than 30 days that turn terminal are reported by health as unreconciled, not guessed at. (The session-warehouse track found the same hole in its cursor, which is how this surfaced.)
- Build each record from the run row, `agents` (adapter type), the issue (project, routine origin), the wake request (reason), the status timeline (issue status at start and end) and `result_json.observability`. Upsert by `run_id`, replacing only when the new `schema_version` is higher.
- **Backfill is the same code** with a larger `--since` and `source='backfill'`; re-derivation after a taxonomy change is the same code with `--rederive`.
- Runs whose terminal write carried no adapter result (reaper, shutdown, cancel, deferral) have no `usage_json`: they are recorded with `usage_quality='missing'`, which is true, and still carry cause, timings and issue. Their wasted tokens are unknown rather than guessed.

Why this and not a hook beside finalization: a review of the code found 20+ writers that
make a run terminal (the main adapter-result path, the reaper, graceful shutdown,
deferral cancellations, native reconcilers, queue and wake-queue cancels, recovery
service), only one of which has an adapter result, and about 20 awaited steps between
the terminal write and `updateRuntimeState` where a throw would skip a hook placed there.
Deriving from the row covers every path by construction, cannot affect a run, heals
itself after a crash or a lagging worker, and needs no shutdown drain. The shared
terminal seam (`emitTerminalAgentTaskRun`, `heartbeat.ts:12939`) is the Telemetry and
Sentry path and is deliberately not used.

Failure behavior: the worker logs once per interval and exposes `derived / terminal` for
the last 24 hours at `GET /observability/health`. A lagging or failed worker delays
panels; it never touches a run.

### 7.3 Failure cause taxonomy

Closed `RUN_FAILURE_CAUSES` in `packages/shared`, one pure classifier, table-tested
against every known error code (about 150, including the 12 listed per area in the inventory):

`interrupted_graceful` (deploy or restart), `interrupted_crash` (process lost, detached, duplex lost), `disk_or_workspace` (restore failed, git scan failed, ENOSPC pattern), `workspace_lock` (busy, restore lock timeout), `provider_quota`, `provider_transient`, `external_service_quota` (Convex `DeploymentQuotaReached`-style patterns), `timeout`, `auth_or_config`, `budget_or_cap`, `control_plane_cancel`, `operator_cancel`, `adapter_failure`, `unknown`.

The classifier may make one bounded pattern pass over `stderrExcerpt` to choose a cause;
the matched text is discarded and never stored. Unmapped codes land in `unknown` and are
listed by an "unmapped codes" view, so the taxonomy grows from data instead of guesses.
Deploy vs restart vs crash vs backup needs an outside marker: 7.6.

### 7.4 Query service first, rollups only when evidence demands them

At 1,000 runs a day a company produces about 365,000 rows a year, and the stated
scale target is millions. Hourly and daily views are `date_trunc` queries over the record
behind the same API contract. Plan: slice 2 ships the query service with the index plan
and records `EXPLAIN (ANALYZE)` for every panel query against a synthetic 5-million-row
table in a throwaway embedded database. **Materialized rollups are built only if a panel
query misses its latency budget there, or when long-range history must outlive record
retention (decision D6).** If built, the requirements are fixed now so they are not
rediscovered:

- Grain `(bucket_kind, bucket_start, company_id, agent_id, routine_id, project_id, adapter_type, model, cause_family)` with **non-null surrogate keys** (nil UUID or `'none'` instead of null; a primary key cannot contain null) and counts and sums only.
- **Dirty-bucket rows** written in the same transaction as the record upsert, and a per-bucket `pg_advisory_xact_lock` while recomputing, so commit-order races (`derived_at` is not a safe watermark) and two instances cannot write a stale bucket.
- A bucket is **frozen once its records are pruned**; never recompute a bucket whose facts have been partly deleted.
- Per-model attribution comes from `run_usage_models`, not a "largest model" guess.
- "Recovered" stays a read-time computation from retry links; it is not stored.
- Percentiles come from the record inside its retention window; sums and trends from rollups.

### 7.5 Outcomes and the join to effort

`outcome_events` (append-only, company-scoped): `kind` (closed set: `pull_request.opened|merged|closed|head_updated`, `ci.run.completed`, `review.submitted`, `deployment.completed`), `issue_id`, `run_id` (nullable), `occurred_at`, `subject_ref` (for example `owner/repo#123`; shown in the panel, never exported), `attrs` (bounded: conclusion, duration_ms, runner_ms, head sha), `source` (plugin id), `source_event_id` (idempotency key, unique per company and source).

Phased: **3a** persists PR lifecycle timestamps on the work product through the existing refresh path (small; merges per hour needs only this); **3b** adds `outcome_events`, the SDK methods, and CI and review ingestion.

- **One SDK edit, two host methods (agreed with the Linear-grade session, 2026-10-09).**
  - `ctx.git.reportPullRequest(snapshot)` under a new capability `git.report`. The snapshot is a typed object carrying repository, number, url, state, draft, merged, headRef, baseRef, headSha, `createdAt`, `mergedAt`, `closedAt`, `updatedAt` (plus the title/body fields their link service needs). One host handler fans out to their link service and to the outcome collector. They pass fields through; I derive events and own the keys.
  - `ctx.outcomes.report(event)` for `ci.run.completed`, `review.submitted`, `deployment.completed`, in the same SDK change.
  - PR events use **per-kind idempotency keys** (`repo#number:opened`, `:merged`, `:closed`, `:head:<sha12>`), not one key per snapshot, so a repeated or later snapshot of the same PR is a no-op.
- **Company scoping is not enforced by the plugin host** (3.3). The `companyId` in a plugin payload is plugin-supplied and unchecked. The outcome handler must (1) require the capability, (2) verify the company exists, (3) verify every `issue_id` and `run_id` in the event belongs to that company (the host has an `inCompany` pattern at `:827`) and reject on mismatch, and (4) bound every field. Panels stay company-filtered regardless. Residual risk, stated plainly: a trusted instance-level plugin can still inject false events for an issue it names correctly; every event carries its `source` plugin id so the panel can show provenance. The Linear-grade link handler applies the same checks (agreed).
- **GitHub without webhooks:** the PR listing does not exist on `main` (`github.ts:287-290` drops PRs). The Linear-grade session owns writing it (ETag per repo and page, cached in plugin state) in the `github-sync` job and messages before the first edit to `sync.ts`. I add check-run fetching on top, only for PRs whose head moved. If the outcome work lands first, they reuse mine. CI cycles = distinct completed workflow runs per PR; runner minutes from the run timing endpoint where the repo uses hosted runners (**UNVERIFIED** for self-hosted runners).
- **Merge-time fix** (`github-external-object-provider.ts:199` discards `merged_at`): PR #45 edits the same `pullRequestSnapshot` data and `PullRequestMergeDetails`, so 3a waits and rebases on #45.
- **Work-product reads** (linked PRs per issue) count only rows where `linkedWorkProductCondition()` holds (added by #45, which hides unlinked rows).
- **Efficiency metrics** attribute to a merged PR the runs on its issue up to `merged_at`: tokens per merged PR, runs per merged PR, CI cycles per PR, review rounds per PR, merges per hour. Sub-issue trees reuse the existing tree recursion in a later pass.

### 7.6 The changes view, impact on read, and the analysis loop

No intervention table in the first cut (decision D7). Changes are **derived from tables
that already record them**, which is "recording every change" without double-writing:

| Change | Existing source |
|---|---|
| Agent config, cap or model change | `agent_config_revisions` (`changed_keys`, actor, `created_at`) |
| Skill release or pin | `company_skill_versions`; keyed on `skillKey@versionId` (pins apply only with `experimental.enableBetaSkills`) |
| Instruction change | `agent_instruction_revisions` |
| Routine change or pause | `routine_revisions`, routine status in `activity_log` |
| Budget policy | `budget_policies` writes in `activity_log` |
| Deploy, restart, crash | `server_boot_events` |

`server_boot_events(id, booted_at, version, previous_shutdown)` is the one new small
table: written at boot, and `previous_shutdown` records whether the prior process
recorded a graceful shutdown (and the signal) or ended uncleanly. It is **instance-level
metadata with no company or user data**, so it follows the same documented exception as
the announcement publication-ID registry in AGENTS.md section 5.1; that PR updates
AGENTS.md accordingly. Panels join it by time, which is what separates a deploy cluster
of `server_shutdown_interrupted` from a crash cluster of `process_lost`.

- **Impact is computed on read:** the same metric over an equal window before and after on the same scope, with a minimum-sample guard and the overlapping changes listed as confounders. It is not frozen; if a frozen result or a manual entry is needed later, an `observability_interventions` table is added then (D7).
- **Findings are ordinary issues** labeled for the audit, not a new table. A decision is the issue; the change is the revision row it caused. The loop closes with existing primitives.
- **Analysis export:** `GET .../observability/export` (NDJSON; every line has `kind` and integer `v`; resumable through an opaque base64url cursor and a trailing `{"kind":"cursor","next":...}` line, the same envelope as the session-warehouse export, section 9): usage aggregates, deterministic anomaly flags computed on read (spikes against a trailing 14-day baseline per agent, model and cause; unknown-cause share; tokens-per-run drift), the derived change list (kind, ids, timestamps only, no free text), and at most N sample run ids per flag. It excludes intervention summaries, `subject_ref` and any per-issue rows. Access: board, or an agent holding an explicit audit permission (decided in PR 6).

### 7.7 Retention

Instance setting with defaults: records 400 days, `server_boot_events` kept. A daily job deletes in batches of 5,000 by `finished_at`, off the run path. If rollups are built (D6): hourly 90 days, daily 3 years. No partitioning until a measured table exceeds about 20M rows.

### 7.8 Isolation, authorization and privacy (tests, not intent)

- Every query filters `company_id`; `agentId`, `issueId`, `routineId` and `runId` filters are verified to belong to the company before use.
- **Authorization.** `assertCompanyCostReadAllowed` is a closure inside the cost router (`routes/costs.ts:75`), not importable; PR 2 extracts it to a shared guard used by the cost and observability routes. It denies low-trust agents, so the rule is "board and same-company agents allowed by `company_scope:read`", not "all same-company agents". Company-level endpoints return **no per-issue or per-run rows**; per-issue queries (`issueId=`) require `issue:read`, as `/issues/:id/cost-summary` does (`routes/costs.ts:86-100`).
- A two-company integration test covers every endpoint, the export, the worker and the boot-event join (which must expose no company data).
- A canary test puts unique strings in the prompt, context, stdout, stderr, instruction text and skill content, runs the builder and the worker, and asserts none appears in any new table or in `result_json.observability`.
- A column-contract test fails if any new text column lacks a closed enum or the identifier charset and length cap.

### 7.9 Track C: context visibility (sessions, composition, skills, system prompts)

Requirement (operator, 2026-10-09): see how each session's context changes over turns,
what a skill adds to context, and what an agent's system prompt costs in tokens and
context, in the web UI, through the API and through the CLI.

**Three quantities, never mixed.**

- *Spend*: tokens billed for a run. Already in the usage record.
- *Context fill*: tokens in the model's window at one API turn, that turn's `input + cache_read + cache_write`. Per turn; it peaks, and compaction lowers it.
- *Composition*: what the always-loaded part of the context is made of at invoke time (instructions, skill listing, wake and task prompt, session handoff). Measured by estimate.

**One counter, named and flagged.** The only counter is `estimateTokens`: UTF-8 bytes
divided by 4, rounded. **Ownership: it is defined once in `packages/shared`** (PR #62, which
every Track C slice depends on); the lean-skills PR #51 currently holds a draft copy in
`packages/skills-catalog/src/skill-quality-text.ts` and has agreed to delete it and import
the shared one before it merges (decision D12). It is an **estimate, not a tokenizer**.
Every number from it is stored and returned with `basis: "estimated"` and
`tokenizer: "bytes_div_4"`; every number a provider reported is `basis: "reported"`. The two
are never summed into one field. Both copies pin the same behavior in a test (`"abcd"` is 1,
four `"é"` are 2, `""` is 0); the skill check's
`metrics.estimatedTokens` counts the whole SKILL.md including frontmatter, so
description-only and per-file counts call `estimateTokens` directly. Where the function
lives is decision D12. **The estimate is biased low for some models.** On the same v8-lean
SKILL.md the estimate is about 5.6k tokens against 7.8k measured with a Sonnet 5 tokenizer
(about 30% under) and 5.7k with a Haiku 4.5 tokenizer (close), a figure from that session.
So no panel presents an estimated share as exact. The reader sees the error: `calibration =
median(reported first-turn context / estimated composition)` per adapter and model,
computed on read from two stored fields. The `countTokens` option of the quality check and
the `tokenizer` field leave room for a real tokenizer later (D9).

**Sources by adapter.** Only what the repo or the vendor documents is claimed; the rest is
marked, and the first step of C1 is to capture real fixtures that settle it.

| Adapter lane | Context fill per turn | Compaction | Window | Status |
|---|---|---|---|---|
| `claude_local` | `assistant` events carry `message.usage` (documented `BetaMessage`). One API turn can emit several assistant events that share `message.id`, so dedupe by id. | `system` / `compact_boundary` with `compact_metadata {trigger: manual\|auto, pre_tokens}` (documented) | `modelUsage[].contextWindow` (usually present on production runs) | Window confirmed. Per-message usage and `compact_boundary` are documented but **not yet seen** in sampled production logs; the parser ignores per-message usage today, so C1 starts from a captured fixture |
| ACPX and ACP lanes | `usage_update` status events: `used`, `size` | none seen | `size` | live in the UI; no `usage_update` appeared in sampled production logs, so treat it as not persisted |
| `paperclip_runner` (native) | spend deltas only (`usage.reported`: `cumulative`, `runDelta`) | `context.compacted` v1: marker with `reason` and `sameSession`; `preTokens` and `postTokens` are always `null` today | not carried | spend and compaction markers available; fill and compaction size are not |
| `codex_local` CLI | `turn.completed` totals only (per run, A7). A run on an Anthropic model streams Claude stream-json and is read by the Claude lane | none parsed | none | spend only |
| gemini, cursor, opencode, pi, kimi, hermes, openclaw | none per turn | none | none | `none` |

The API returns `availability` (`full` fill and window, `partial` fill without window or
compaction, `spend_only`, `none`) and a closed-enum `reason`. An unsupported adapter reads
"not available for this adapter", never an empty chart that looks like zero.

**Storage.**

- **Timeline: not stored.** Derived on read from the run's NDJSON through an optional pure per-adapter `parseContextSamples(lines)` (numbers and enums only), capped at 2,000 points and downsampled. If the log was pruned (section 9) the response says `log_pruned`.
- **Summary: sibling table `run_context_records`**, one row per run: `company_id`, unique `run_id`, `agent_id`, `finished_at` (as in 7.1), its own `schema_version`, `adapter_type`, `model`, `availability`, `window_tokens`, `turns`, `first_turn_context_tokens`, `peak_context_tokens`, `final_context_tokens`, `compactions_auto`, `compactions_manual`, `session_resumed`, `composition` (jsonb, at most 40 parts: kind enum, tokens, count, `ref` = `skillKey@versionId` or revision id) and `skill_loads` (jsonb, at most 50). The **same worker pass** as 7.2 writes it (same lock, lookback, settle delay, backfill and `--rederive`). It is a separate table with its own `schema_version` so adding context fields never bumps the usage record's version, which would move the prune-guard constant in section 9. Retention follows 7.7. The privacy canary and column-contract tests of 7.8 cover it.
- **Composition is captured at invoke time** as one extra key, `contextComposition`, on the payload of the **existing** `adapter.invoke` event that `onAdapterMeta` already appends (`heartbeat.ts:23651-23663`). **No new append, no new row lock, no new await.** (An independent review pointed out that this existing call awaits `appendRunEvent`, which takes a `FOR UPDATE` lock on the run row and throws on a binding or database error, `heartbeat-run-events.ts:67-80`; a second row would double that exposure. That behavior is already there, is not changed, and is reported rather than fixed here.) The value comes from a pure `buildContextComposition(...)` wrapped in try/catch that returns `undefined` on any error, so the payload is then byte-identical to today's. It cannot be derived afterwards because the instructions bundle and skill set may change before the worker runs. Parts: `instructions` (bytes of the resolved bundle files, revision id), one `skill_listing` part per skill (`skillKey@versionId`, description tokens, always loaded), and the adapter's existing numeric `promptMetrics` (bootstrap, wake, handoff, task context, heartbeat prompt; flagged as character-based). The worker reads an allowlist of numeric keys from that payload only; the full prompt that `adapter.invoke` also carries (F2) is never read. The key is documented in `doc/run-log-events.md`; there is no new event type.
- **Fresh versus resumed sessions.** Claude injects the instructions file only on a fresh session (`execute.ts:931`), and later turns read it back from cache. `session_resumed` is stored, so the system-prompt cost view counts the write on fresh sessions and the cheaper read on resumed ones, instead of charging every run the same.
- Runs from before this ships have no composition event. Their `availability` shows what can still be derived (`spend_only`); nothing is invented.

**Skill impact** (C3), per `skillKey@versionId`, from records and the revision tables, never from content:

- *Always-on tokens*: the description in the listing (estimate).
- *On-demand tokens*: the body plus the reference files that were loaded (estimate over the version's files).
- *Loads*: `Skill` tool calls counted by the worker from the NDJSON through the adapter parser (the tool name exists in the UI taxonomy). In sampled production logs a `Skill` tool call appears only inside the escaped JSON of a log line's `chunk` field, so the counter decodes each line's JSON and then the event inside it. The input key is **UNVERIFIED** until a fixture exists.
- *Runs exposed* and *share*: `share = min(1, always-on tokens / reported first-turn context)`, shown only when the reported value is above zero. When the estimate exceeds the reported value the share is clamped to 1 and the row is flagged `estimate_exceeds_reported`; the panel shows how many runs were flagged, so an over-estimating counter is visible.
- *Version-change delta*: estimator over consecutive `company_skill_versions`, plus the read-time before/after comparison of 7.6 (equal windows, minimum sample, overlapping changes listed as confounders). It never claims causality.

**System-prompt impact** (C2), per agent: instruction tokens (estimate, from the revision each run used), the **baseline budget** (instructions, skill listing and fixed wake preamble; mean of recent composition events), its share of reported first-turn context (bounded to 0..1 as above), and **carried tokens per run** = system-prompt tokens × turns, with `shareOfRunInput = min(1, carried / reported run input)` (input = fresh + cache read + cache write). The **cost allocation** is `allocatedCostMicros = round(shareOfRunInput × inputShareOfRunTokens × cost_micros)` with `inputShareOfRunTokens = reportedInput / (reportedInput + output)`. It assumes one price per token across classes, so it is labeled `basis: "allocated"`, never exceeds the run's cost by construction, is omitted when the run's cost status is not measured, and is replaced by an exact figure only if the price catalog (D3) gives per-class prices. Trend by day.

**Audit token deltas** (C4): for the existing actions `agent.instructions_bundle_updated`, `agent.instructions_file_updated`, `agent.instructions_file_deleted`, `agent.instructions_path_updated`, `agent.skills_synced`, `agent.updated` (model or adapter keys), `agent.config_rolled_back` (`routes/agents.ts`) and `company.skill_version_created`, `company.skill_updated`, `company.skill_file_updated` (`routes/company-skills.ts`), return `contextDelta {beforeTokens, afterTokens, delta, basis}` computed **on read** from `agent_instruction_revisions`, `agent_config_revisions` and the skill version rows. A model or adapter change shows the old and new window where known. No stored delta, so nothing goes stale.

The activity-row-to-revision mapping, checked against the writers (no guessing by time):

| Action | Key linking the row to its change today | C4 |
|---|---|---|
| `agent.config_rolled_back` | `details.revisionId` (an `agent_config_revisions` id, `routes/agents.ts:4422`) | none needed |
| `company.skill_version_created` | `entityId` is the version id (`routes/company-skills.ts:894-896`) | none needed |
| `agent.instructions_bundle_updated`, `agent.instructions_file_updated`, `agent.instructions_file_deleted`, `agent.instructions_path_updated` | none (`details` hold mode, path, size; `routes/agents.ts:5182-5187`, `:5294-5298`) | add `details.revisionId` at these four call sites; additive JSON key, existing readers ignore it |
| `agent.updated`, `agent.skills_synced` | none (`summarizeAgentUpdateDetails`; desired-skill lists) | add `details.configRevisionId` at the two call sites |
| `company.skill_file_updated` | `details.versionId`, the new version id (`routes/company-skills.ts:1263-1267`); the before value is that skill's previous version | none needed |
| `company.skill_updated` | none, and none needed: `details` hold only slug, categories and sharing scope (`:1217-1221`), which change no content or description | no delta; the entry answers `contextDelta.unavailable = "not_applicable"` |

Rows written before C4 carry no reference, so their activity entry answers
`contextDelta.unavailable = "no_revision_ref"`. They are never matched by timestamp. The
change rows of slice 6, which are derived straight from the revision tables, show the delta
for the whole history regardless. The instruction delta needs no content read:
`agent_instruction_revisions.byte_length` already holds the byte count, so
`round(byte_length / 4)` equals the shared estimate (a test pins this against a fixture).
A test asserts every `revisionId` written by C4 points at a row of the same company and agent.

**Surfaces and permissions** (parity in section 8). Each Track C route reuses, unchanged, the guard of the resource's own `GET`; no new permission is invented:

| Route | Guard it reuses | Agent key |
|---|---|---|
| `GET /heartbeat-runs/:runId/context` | `getAccessibleResource` plus `assertRunTelemetryReadAllowed` as in `GET /heartbeat-runs/:runId` (`routes/agents.ts:7025-7029`) | exactly what that route allows |
| `GET /agents/:agentId/context-budget` | `assertCanReadAgent` (`routes/agents.ts:2146`): board needs config-read; an agent key must be of the same company | same-company only; another company's id answers 404 |
| `GET /companies/:companyId/skills/:skillId/impact` | the read guard of `GET /companies/:companyId/skills/:skillId` | same as that route |
| `contextDelta` on activity and `GET /changes` | the existing activity-list guard | same as that route |

A table-driven test sends the same request as board, same-company agent, other-company
agent and unauthenticated to the base route and to the Track C route and asserts the
status codes are identical. Every response carries counts, enums and ids only.

**Deliberately not in v1.**

- Claude's exact `/context` report (`SDKContextUsage`: categories, per-skill tokens, memory files, MCP tools). Anthropic computes it with token-counting requests that do not appear in the message stream, and it exists only when `/context` is issued. An opt-in, sampled probe is D10.
- Codex per-turn fill: the normalized usage event has no last-turn usage or window (`runnerd-codex-transport.ts:1706-1709`). Adding them is a runner protocol change with Rust-side schema and validators, so it is the linked follow-up C5 (D11).
- Splitting growth into tool results, comments and history: providers do not report it. Growth between consecutive turns minus that turn's output approximates tool results and new messages (row 18), as a later pass.

## 8. Slice plan (stacked PRs)

Stack order is the dependency order. Each PR is independently reviewable, carries its
own tests and docs, and ships API, CLI and OpenAPI together. Estimated size is rough.
Because collection is derived from rows, **1a delivers value with no adapter change and
no run-path change**.

| PR | Scope | Depends on | Size |
|---|---|---|---|
| **0** | This plan (`docs(observability): ...`) | none | doc |
| **1a** | **Record + derivation worker:** `run_usage_records` (migration), shared types, cause taxonomy and classifier, async worker with advisory lock, row-derived fields only (tokens and cost from `usage_json`, timings, cause, issue/project/routine, runtime_mode, driver_kind, retry, liveness, `provider_work_started`), backfill and `--rederive` commands, health endpoint with CLI `health`, the keyset read `listUsageRecordsAfter` and the exported `RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION` constant that the session-warehouse prune guard needs (section 9). Tests: classifier table, worker idempotency and version replace, lookback and settle delay, single-worker lock, two-company isolation, canary. | none | L |
| **1b** | **Run-path builder + Claude** (CLI and ACP lanes): `buildRunObservability`, cache-write, `modelUsage` child rows, turns and tool counts, first-turn prompt tokens, footprint from `listRuntimeSkillEntries` (`heartbeat.ts:21910`) and `promptMetrics`; Claude result-key fixtures (settles A6). | 1a | M |
| **1c** | **Codex + Grok** (CLI and ACP lanes): disjoint-class mapping from captured real fixtures; the Codex usage basis is per run (A7), so there is no parser fix (D8 dropped); one guard test for a resume that reuses a session id | 1a, A7 | M |
| **1d** | **Native (`paperclip_runner`) + ACPX engine, then the remaining adapters** (gemini, cursor, opencode, pi, kimi, hermes, openclaw): `usage.reported` and span rows, per-adapter fixtures, usage-basis audit | 1a | M |
| **1e** | Retention job for the new tables | 1a | S |
| **2** | **Query service + API + CLI + parity:** `GET usage`, `failures`, `footprint`; shared authorization guard; OpenAPI; the table-driven parity test (every OpenAPI path under the prefix needs a CLI command and a UI client method; assigned here because `main` has none, and written to coexist with PR #22's matrix); issue-lifecycle reader over `activity_log`; `EXPLAIN` evidence at 5M rows and the rollup decision (D6); price catalog if D3 accepted | 1a | L |
| **3a** | PR lifecycle timestamps persisted on work products; `GET efficiency` (merges per hour, tokens and runs per merged PR) | 2, #45 | M |
| **3b** | `outcome_events`, SDK methods and capability, GitHub PR and check polling on top of the Linear-grade listing; `GET bottlenecks` (CI cycles, review rounds, queue and status time) | 3a, Linear-grade 1b | L |
| **4** | **UI:** Usage (tokens, cost, model, skill footprint) and Failures panels in the Audit hub; desktop and mobile browser verification, token-gate check | 2 | L |
| **5** | **Waste:** failed and interrupted, duplicates, runs on closed issues, unproductive runs; `GET waste` + CLI + panel (stale-head later, needs 3b head shas) | 2 | M |
| **3c / 5b** | Bottlenecks, Efficiency panels, each in the PR that adds its API | 3a / 3b | M each |
| **6** | **Changes view + impact on read + analysis export + anomaly flags;** `server_boot_events` and the AGENTS.md exception | 2 (3a/3b for outcome metrics) | L |
| **7 (dropped)** | Worker free-bytes sampling and workspace bytes. The resource-capacity track owns host sampling (D5). The tokens-per-tool-result approximation is not planned. | none | none |
| **C1** | **Run context (Track C, 7.9):** first step is to capture real fixtures (Appendix B) and settle the UNVERIFIED rows; `run_context_records` (migration), the `contextComposition` key on the existing `adapter.invoke` payload (no new row), the worker pass, `parseContextSamples` for Claude, ACP/ACPX and runner events, `GET /heartbeat-runs/:runId/context`, `paperclipai run context <runId>`, and the Context section on run detail (timeline chart, compactions, peak against window, composition). All three surfaces in this PR. | 1a, 2 (guard, parity test), #62 (shared estimate) | L |
| **C2** | **Agent context budget:** `GET /agents/:agentId/context-budget`, `paperclipai agent context-budget <agentId>`, an AgentDetail card (baseline budget, share of first-turn context, cost allocation, estimator calibration, trend). | C1, #62 | M |
| **C3** | **Skill impact:** `GET /companies/:companyId/skills/:skillId/impact`, `paperclipai skill impact <skillId>`, a skill-page panel (always-on, on-demand, loads, version-change delta). | C1, #62 (shared estimate, D12) | M |
| **C4** | **Audit token deltas:** `contextDelta` on activity entries and on `GET /changes` rows for instruction, skill-version, skill-sync and model or adapter changes, with the deterministic row-to-revision mapping of 7.9 (adds `revisionId` to the `details` of six writers; additive); Audit hub badge; the CLI prints it. The before/after impact join stays in 6. | C2, C3 (shared estimator helper), #62 | M |
| **C5 (linked follow-up)** | Codex per-turn context fill (last-turn usage and window in the runner's usage event, schema and validators); Claude `/context` probe if D10 is accepted. | C1, D10, D11 | M |

**Unverified log shapes.** The operator's A7 and Appendix B results arrived on 2026-10-09 (qualitative only; section 7.9 and rows 2, 29 and 31 to 33 of section 4 carry them). Settled: Codex CLI usage is per run, cached tokens sit inside input for OpenAI-family and xAI streams, `contextWindow` is usually present, and the `Skill` call shape. Still unverified: per-message `usage` and `compact_boundary` in Claude streams, the `Skill` input key, ACP `usage_update` persistence, resumes that reuse one Codex session id, and the exact provider and model labels. Slices 1c and C1 do not rely on any of those. They build behind the stated assumptions, with tests on fixtures, and each assumption is replaced by the measured shape when it is checked.

Parity contract per panel (API is the source; CLI and UI are thin):

| Panel | API (under `/companies/:companyId/observability`) | CLI (`paperclipai observability ...`) | Slice |
|---|---|---|---|
| Tokens and cost by agent, routine, project, model, adapter, day, hour | `GET /usage` | `usage --group-by --since --until --agent-id ...` | 2 |
| Footprint by skill and source | `GET /footprint` | `footprint` | 2 |
| Failure causes over time | `GET /failures` | `failures` | 2 |
| Collector health | `GET /health` | `health` | 1a |
| Waste | `GET /waste` | `waste` | 5 |
| Efficiency trend | `GET /efficiency` | `efficiency` | 3a |
| Bottlenecks (queue, lock, status time, CI, review) | `GET /bottlenecks` | `bottlenecks` | 3b |
| Changes and impact | `GET /changes`, `GET /changes/:id/impact` | `changes`, `impact` | 6 |
| Analysis export | `GET /export` | `export` | 6 |
| Run context (timeline, compactions, composition); UI: run detail, Context section | `GET /heartbeat-runs/:runId/context` | `run context <runId>`, next to `run events` and `run log` (`cli/src/commands/client/run.ts`) | C1 |
| Agent context budget; UI: AgentDetail card | `GET /agents/:agentId/context-budget` | `agent context-budget <agentId>` | C2 |
| Skill impact; UI: skill page panel | `GET /companies/:companyId/skills/:skillId/impact` | `skill impact <skillId>` | C3 |
| Token delta on audit entries; UI: Audit hub badge | `contextDelta` field on the activity list and `GET /changes` | `changes` and `activity` print it | C4 |

The Track C routes (full paths, not under the `/companies/:companyId/observability` prefix in the header) sit next to the resource they describe (run, agent, skill), not under `/observability`, because that is where a reader already is and where permissions already apply. The OpenAPI route test and the parity test of PR 2 cover them. The CLI already has an unrelated top-level `context` command (`cli/src/commands/client/context.ts`, the client profile); the new subcommands do not collide with it.

Every CLI command accepts `--json` and date filters (the existing `cost` CLI lacks them, a known gap not repeated here). The health status appears as a chip in the Usage panel so it has a UI client.

## 9. Coordination

| Item | Overlap | Plan |
|---|---|---|
| **PR #28** run stats | `heartbeat-runs/stats` (status counts, top-20 error codes, daily cap) | Do not touch. `failures` adds per-day and per-cause series on top. Expect a trivial conflict in `packages/shared/src/index.ts` exports and `routes/openapi.ts`; rebase after it lands. |
| **PR #31** harness fallbacks | adds `executed_adapter_type`, `executed_model`, `fallback_reason` to `heartbeat_runs` and a migration | Record the agent's `adapter_type` at first; add the executed values after #31 merges. |
| **PR #12** provider capacity retry | writes `resultJson.providerQuotaBeforeUsefulAction` | Read that jsonb key when present (no compile dependency); counts as not-wasteful in the waste view. |
| **PR #21** restore queue | longer lock wait | Add `lock_wait_ms` after it lands; ask for a wait duration on the success path. |
| **PR #44** SSH workspace reaping | `bytesFreed` in activity rows | Source for workspace bytes. This plan no longer uses it (PR 7 is dropped, D5). |
| **PR #45 / Linear-grade session** (agreed 2026-10-09) | `metadata.git` on work products, `pullRequestSnapshot` edits in `github-external-object-provider.ts`, planned PR listing in the `github-sync` job (slice 1b, not started), planned SDK call | One SDK edit with two host methods (section 7.5). They write the PR listing; I add check-run fetching on top. Neither of us edits the SDK or `sync.ts` until the shape is settled in writing; they message before touching `sync.ts`. No status-history table: I read `activity_log` (they have not audited every status writer; A12 checks real rows). My `merged_at` change rebases on #45. Count only `linkedWorkProductCondition()` rows. Both handlers validate issue-company ownership because the plugin host does not (3.3). |
| **Session-warehouse track** (`feat/session-warehouse`, agreed 2026-10-09 with amendments) | Per-company opt-in archive of finished runs to the company's own S3-compatible bucket, plus `GET /companies/:id/archive/export` and `paperclipai archive export` | **Boundary: I measure, they archive and export.** I create no bucket writes and export no raw content; they create no `run_usage_records`, `server_boot_events`, `outcome_events`, cause taxonomy or `/observability/*` route. **Prune guard** (replaces "record exists"): they may delete `heartbeat_run_events` rows and run-log files (and their S3 mirror) only for runs that finished at least their minimum age ago (default off, at least 30 days), whose archive upload is verified, AND that have a `run_usage_records` row with `schema_version >= RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION` (a constant exported from `packages/shared`; 1a defines it as the first version, 1b and 1d raise it when they start reading events). They never prune `heartbeat_runs`, `cost_events`, `activity_log` or revision tables: the worker, `--rederive` and the issue-lifecycle reader read them. Before a company enables pruning, run my backfill first, or its event-derived fields are lost for good. **Formats:** NDJSON, `kind` closed set plus integer `v` on every line, raw UUIDs, ISO-8601 UTC, opaque base64url cursor over `{v, t, id}` keyset `(finished_at, run_id)` ascending with a trailing `{"kind":"cursor","next":...}` line. Their cursor is adopted. Two amendments: the keyset time is `coalesce(finished_at, created_at)` (immutable, non-null), and only runs finished more than 10 minutes ago are exported (the same settle delay as my worker), because `finished_at` is assigned in the app and a slower commit could land behind a cursor that already passed it; consumers dedupe on `(kind, id)`. **Archiving my data:** one entity file `usage_records.ndjson` with `kind: "observability.usage_record"` and `v = schema_version`, read through my service (`listUsageRecordsAfter({companyId, cursor, limit})`, shipped in 1a), never re-derived. Records are replaced when `schema_version` rises, so archive objects are keyed by `(run_id, schema_version)` and are not immutable. My export stays separate (aggregates, flags, change list; ids, numbers and enums only) and uses a different route and permission from their raw-content export. |
| **PR #42** Convex plugin | Convex deployments and quota | Outcome events from it after merge. |
| **Lean-default-skills session** | skill footprint | They cut it, this measures it. Their PR 1 carries release `v8-lean` and a skill-quality check; they send me the PR number, and the change appears in the changes view keyed on `skillKey@versionId`. Their files (`skills-releases/paperclip/`, `evals/promptfoo/`, `packages/skills-catalog/src/`, `doc/plans/2026-10-09-lean-default-skills.md`) do not overlap mine. I do not edit `skills/paperclip/SKILL.md` (line anchors, see `capability-contract`). |
| **Decisions-engine track** | judgement on top of this data | Export contract in 7.6; ids, numbers and enums only. |
| **Migrations** | `0296` is claimed twice (#40 `0296_clear_lord_tyger`, #31 `0296_tricky_unicorn`) | Mine take the next free number at rebase and are regenerated then; the SQL is additive and uses `IF NOT EXISTS`, so reordering is safe. |
| **Adding MCP tools** | fails the production image check (capability contract needs the external corpus) | No MCP tools; agents use the REST API and CLI. |
| **Lean-default-skills, PR #51 (Track C)** | the token counter: `estimateTokens` (UTF-8 bytes / 4, rounded) is defined once in `packages/shared` (PR #62). Their draft #51 (head `ea7067aed`, **draft**, held behind #27, #29 and #58 and an eval-credit block, so no merge date) holds a copy in `packages/skills-catalog/src/skill-quality-text.ts` | One counter, one owner, available on `main` as soon as #62 merges: see decision D12. They agreed to delete their copy and import the shared function before #51 merges, and to keep the semantics from changing silently; a real tokenizer would be a new function or the `countTokens` option. I edit none of their files. |
| **Session-warehouse track (Track C)** | the prune guard in the row above | Track C also consumes run events and NDJSON (the `adapter.invoke` composition key, per-turn usage, `context.compacted`). Add a second constant `RUN_CONTEXT_RECORD_EVENTS_CONSUMED_VERSION` (exported with the first). **Confirmed 2026-10-09 by the session-warehouse track.** Its final rule: a run's events and logs may be pruned only when the run settled at least 30 days ago, its archive is deeply verified, its usage record is at `RUN_USAGE_RECORD_EVENTS_CONSUMED_VERSION` or higher, and its context record is at `RUN_CONTEXT_RECORD_EVENTS_CONSUMED_VERSION` or higher. The session-warehouse pruner refuses to prune when the database has a `run_context_records` table that its build has no guard for. Whichever of that pruner and C1 lands second wires the context condition. A run finished after C1 ships may be pruned only when its `run_context_records` row exists at that version; **there is no exception for runs without a composition event**, because those can still hold per-turn usage. The worker writes a record for every terminal run (availability `none` when nothing is derivable), and `--backfill` creates records for older runs from their logs, so an operator runs it before enabling pruning. After pruning, the per-turn **timeline** answers `log_pruned` by design while the per-run summary (peak, compactions, composition) survives; the timeline can be rebuilt from the archived NDJSON in the company's own bucket. `run_context_records` can join the archive as a second entity file (`kind: "observability.context_record"`) through `listContextRecordsAfter`, shipped in C1; their choice. |
| **Runner protocol (`packages/paperclip-runner`)** | the normalized usage event lacks last-turn usage and window | Only C5 touches it, with the schema, validators and Rust side together. Not in C1-C4. |

## 10. Verification per slice

- **Unit:** classifier against every known error code; per-adapter usage mapping from real captured fixtures with the disjoint-class invariant (`total = input + cache_read + cache_write + output`); `buildRunObservability` never throws, is bounded, and returns `undefined` on bad input.
- **Run path:** with the builder forced to throw, the terminal UPDATE still writes the same row as before (regression test on the unchanged columns).
- **Integration (embedded Postgres):** worker derives a record for each terminal status and for runs with no `usage_json`; idempotent re-run; version-bump replace; settle delay and lookback; single-worker advisory lock; backfill resumes after interruption; two-company isolation on every endpoint and the export; retention batches; canary strings never persisted.
- **Contract:** OpenAPI route test, the new CLI/UI parity test, CLI mocked-fetch tests for URLs and flags.
- **Reconciliation:** over a backfilled window, `sum(cost_micros) / 10000` matches `sum(cost_cents)` of `cost_events` within rounding, and token sums match `usage_json` normalized totals; differences are reported by the backfill, not hidden.
- **UI:** real browser at desktop and mobile widths, zero console errors, `pnpm check:token-gates`, `DESIGN.md` token-only rule.
- **Scale:** `EXPLAIN (ANALYZE)` on each panel query against a synthetic 5M-row record table in a throwaway embedded database.
- **Track C:**
  - Per-adapter `parseContextSamples` from captured real fixtures: dedupe by `message.id`, compaction rows, window, and the `availability` degrade path when per-message usage is absent.
  - `contextComposition` is bounded, numeric, fail-open and passes the canary (a prompt-only string never reaches the payload key or either table). With `buildContextComposition` forced to throw, the `adapter.invoke` payload equals today's byte for byte, and the number of appends per run is unchanged (asserted).
  - The worker pass writes `run_context_records` idempotently; version replace and `--rederive` behave as for the usage record.
  - Estimator identity: the server imports `estimateTokens` from `@paperclipai/shared` and a test asserts one implementation (no `/ 4` byte counter elsewhere).
  - Each of the four Track C routes: two-company isolation, agent-within-permission read, and CLI mocked-fetch tests for URL and flags.
  - Audit deltas: for each listed action, before and after tokens match a hand-computed fixture, including a delete and a model change.
  - UI: desktop and mobile, zero console errors, `pnpm check:token-gates`, empty, unavailable (`none`, `log_pruned`) and loading states each have a visible message.
- Local gaps on this host (no `cargo`, so no full build; known pre-existing failures) are recorded in `local-test-setup` and will be reported, not hidden.

## 11. Decisions for the operator

| ID | Question | Recommendation |
|---|---|---|
| D1 | Retention default: records 400 days | Accept. Cheap, and covers a year-over-year view without rollups. |
| D2 | Shared host call with the Linear-grade track | **Settled** with that session (7.5). |
| D3 | Add a versioned price catalog for an "API-equivalent" dollar estimate (Codex cost is always null today)? | Yes, small and flagged `estimated`; tokens stay the primary metric. Without it, Codex cost panels are blank. **Decided by the orchestrator on 2026-10-09 (the user may override):** yes. Every dollar figure from the catalog is labeled `estimated (API-equivalent)` and is never added to reported cost. The catalog carries a source and an as-of date. |
| D4 | GitHub polling load (PR list plus check-runs, conditional requests) | Accept with a per-repo budget and a visible "last synced" in the panel. |
| D5 | Worker disk sampling (PR 7): wanted now? | After PR 2. The classifier already names disk failures; sampling adds the early warning at a point (`workspace-manifest.ts:15-26`) that already checks free space. **Decided by the orchestrator on 2026-10-09 (the user may override): dropped.** The resource-capacity track owns host sampling, so PR 7 is removed from this plan. The failure causes stay in this plan. |
| D6 | Build materialized rollups now (as originally asked) or gate them on `EXPLAIN` evidence at 5M rows? | Gate on evidence. About 365k rows a year per busy company does not need them, and the design requirements are written down (7.4) for when it does. Say so if you want them built regardless. **Decided by the orchestrator on 2026-10-09 (the user may override):** no rollups until evidence. Slice 2 records the query timings and plans at 5M rows in `doc/run-usage-records.md`. |
| D7 | Interventions as a table now, or derived from existing revision tables? | Derived first (7.6); add the table only for manual entries or frozen results. **Decided by the orchestrator on 2026-10-09 (the user may override):** derived, not stored. |
| D8 | Codex usage basis: run A7 on a production company first. If cumulative, fix the parser basis as its own bug-fix PR before showing Codex rollups without a caveat. | Run A7 this week; it decides whether Codex token totals are inflated. **Decided by the orchestrator on 2026-10-09 (the user may override): dropped.** Production data shows that Codex usage is per run (A7). Slice 1c records `codex_local` as `per_run` and adds one guard test for resumes that reuse a session id. Token semantics depend on the stream shape and the provider, not on `adapter_type`: OpenAI-family streams (including Grok) count cached tokens inside input, Anthropic streams count them on top, and `codex_local` with an Anthropic model emits Claude stream-json. |
| D9 | Token counter for Track C: keep the shared bytes / 4 estimate (flagged `estimated`, with a calibration metric against provider-reported tokens), or add a real tokenizer dependency? | Keep the estimate. No new dependency, and the calibration metric shows its error from real data. Revisit only if calibration is poor. **Decided by the orchestrator on 2026-10-09 (the user may override):** keep the estimate, and C1 adds a per-model calibration band: for each run, C1 compares the estimated composition total with the provider-reported input tokens, and shows the ratio for each model (an error band) next to the estimates, so a share cannot mislead. This does not block 1a. |
| D10 | Claude exact `/context` probe (per-category and per-skill tokens from the provider): add an opt-in, sampled probe per agent? | Defer. It adds a step to sampled runs and exists only on request; ship the estimate and calibration first (C5 if wanted). **Decided by the orchestrator on 2026-10-09 (the user may override): deferred.** |
| D11 | Codex per-turn context fill needs last-turn usage and window in the runner's usage event (a protocol change across Rust and TypeScript). | Separate follow-up (C5) after C1 shows the gap on real data; do not widen C1. **Decided by the orchestrator on 2026-10-09 (the user may override):** a separate follow-up PR after C1. Production data confirms that Codex does not persist per-turn context fill. |
| D12 | Where does the single token estimate live? Today only in `skills-catalog`, on lean-skills draft PR #51, which has no merge date. C1, C2 and C4 need it on `main`. | Put `estimateTokens` (same behavior, same test) in `packages/shared` in its own small first PR; `skills-catalog` already depends on `@paperclipai/shared`, so #51 replaces its body with an import on rebase. One counter, owned by the package everyone already depends on, no wait on a draft. If lean-skills prefers, the alternative is to stack C-track PRs on #51 and wait for it. **Settled 2026-10-09:** lean-skills accepted and will import the shared function on #51; PR #62 is open. Not a user decision. |
| F1 | Follow-up (not in this feature): retention for `heartbeat_run_events` and NDJSON logs, which grow without bound | **Handed to the session-warehouse track** as an opt-in "prune after verified archive" step, with the guard in section 9. Not pruning on the strength of "a record exists": 1b and 1d read `adapter.invoke`, `usage.reported` and `run.performance.span` events, so only a record at the event-consuming schema version makes them safe to delete. |
| F2 | Follow-up: `adapter.invoke` persists prompt and context in the run log | Separate privacy issue; this feature does not depend on it. |

## Appendix A. Read-only measurement queries for a production company

Run on the production database with a read-only role. All are `SELECT` only and
return counts and distributions, never content. Use the results to confirm
the assumptions in sections 4 and 5 before slice 1 is merged. **A1, A5 and A7 first.**
All 12 were executed against a freshly migrated empty schema (parse and column check only).

```sql
-- A1. Usage coverage by adapter (last 7 days): how many runs have usage at all
select a.adapter_type, count(*) runs,
       count(r.usage_json) with_usage,
       count(*) filter (where r.usage_json ? 'rawInputTokens') with_raw,
       count(*) filter (where r.usage_json ->> 'usageSource' = 'session_delta') session_delta,
       count(*) filter (where r.usage_json ->> 'usageSource' = 'per_run') per_run
from heartbeat_runs r join agents a on a.id = r.agent_id
where r.created_at > now() - interval '7 days'
group by 1 order by 2 desc;

-- A2. Daily run volume and failure share (checks the reported volume and failure rate)
select date_trunc('day', created_at) d, count(*) runs,
       count(*) filter (where status in ('failed','timed_out')) failed,
       count(*) filter (where status = 'interrupted') interrupted,
       count(*) filter (where status = 'cancelled') cancelled,
       count(*) filter (where status = 'scheduled_retry') scheduled_retry
from heartbeat_runs where created_at > now() - interval '14 days' group by 1 order by 1;

-- A3. Failure mix by error code (checks the cause taxonomy and the unmapped share)
select coalesce(error_code, '(null)') error_code, count(*) n
from heartbeat_runs
where created_at > now() - interval '14 days'
  and status not in ('succeeded','queued','running','scheduled_retry')
group by 1 order by 2 desc limit 60;

-- A4. Cost status by billing shape (how much is unpriced or subscription)
select provider, biller, billing_type, cost_status, count(*) rows,
       sum(input_tokens)::bigint inp, sum(cached_input_tokens)::bigint cached,
       sum(output_tokens)::bigint outp, sum(cost_cents)::bigint cents
from cost_events where occurred_at > now() - interval '7 days'
group by 1,2,3,4 order by rows desc;

-- A5. Token-class semantics: is cached a subset of input? (ratio near 1 means subset;
--     compare codex_local with claude_local)
select a.adapter_type,
       sum((r.usage_json ->> 'cachedInputTokens')::numeric) / nullif(sum((r.usage_json ->> 'inputTokens')::numeric), 0) cached_over_input,
       count(*) runs
from heartbeat_runs r join agents a on a.id = r.agent_id
where r.created_at > now() - interval '7 days' and r.usage_json is not null
group by 1 order by 3 desc;

-- A6. What Claude and ACPX already keep in result_json (backfill sources and unverified CLI keys)
select count(*) runs,
       count(*) filter (where result_json ? 'modelUsage') with_model_usage,
       count(*) filter (where result_json ? 'num_turns') with_num_turns,
       count(*) filter (where result_json ? 'duration_api_ms') with_duration_api_ms,
       count(*) filter (where (result_json -> 'usage') ? 'cache_creation_input_tokens') claude_cache_creation,
       count(*) filter (where (result_json -> 'usage') ? 'cachedWriteTokens') acpx_with_cache_write,
       count(*) filter (where (result_json -> 'usage') ? 'thoughtTokens') acpx_with_thought_tokens
from heartbeat_runs where created_at > now() - interval '7 days';

-- A7. Cumulative vs per-run counters: within one session, does raw input only ever grow?
--     About 100% non-decreasing pairs = cumulative counter; about 50% = per-run counter.
--     Decides whether codex_local token totals are overcounted (section 5, item 1).
with pairs as (
  select a.adapter_type,
         (r.usage_json ->> 'rawInputTokens')::numeric as cur,
         lag((r.usage_json ->> 'rawInputTokens')::numeric)
           over (partition by r.agent_id, r.session_id_after order by r.created_at) as prev
  from heartbeat_runs r join agents a on a.id = r.agent_id
  where r.created_at > now() - interval '7 days'
    and r.session_id_after is not null
    and r.usage_json ? 'rawInputTokens'
)
select adapter_type, count(*) pairs,
       round(100.0 * count(*) filter (where cur >= prev) / count(*), 1) pct_non_decreasing
from pairs where prev is not null
group by 1 order by 2 desc;

-- A8. Queue wait distribution by agent (seconds)
select agent_id, count(*) n,
       percentile_cont(0.5) within group (order by extract(epoch from started_at - created_at)) p50,
       percentile_cont(0.95) within group (order by extract(epoch from started_at - created_at)) p95
from heartbeat_runs where created_at > now() - interval '7 days' and started_at is not null
group by 1 order by p95 desc limit 25;

-- A9. Linkage: share of runs that resolve to an issue
select count(*) runs, count(*) filter (where context_snapshot ->> 'issueId' is not null) with_issue
from heartbeat_runs where created_at > now() - interval '7 days';

-- A10. Run-log growth (is retention urgent?)
select relname, pg_size_pretty(pg_total_relation_size(c.oid)) size,
       (select reltuples::bigint) approx_rows
from pg_class c where relname in ('heartbeat_runs','heartbeat_run_events','activity_log','cost_events','agent_wakeup_requests');

-- A11. Footprint signal available today: adapter.invoke events carrying char metrics
select count(*) events,
       count(*) filter (where payload -> 'promptMetrics' is not null) with_prompt_metrics
from heartbeat_run_events where event_type = 'adapter.invoke' and created_at > now() - interval '1 day';

-- A12. Status-change shapes in activity_log (the issue lifecycle reader must handle each one found)
select action,
       (details ? 'status') has_status,
       ((details -> '_previous') ? 'status') has_prev_status,
       ((details -> 'changes') ? 'status') has_changes_status,
       count(*) n
from activity_log
where entity_type = 'issue' and created_at > now() - interval '14 days'
  and ((details ? 'status') or ((details -> 'changes') ? 'status') or ((details -> '_previous') ? 'status'))
group by 1, 2, 3, 4 order by n desc;
```

## Appendix B. Read-only shape checks on the run-log directory (Track C)

These settle the rows marked UNVERIFIED in 7.9 before C1 writes a parser. They print
**counts of files only**, never content. Run them on a production company's run-log
directory (`RUN_LOG_BASE_PATH`, default `<instance>/data/run-logs`). `-uu` is needed because
ignore files can hide the logs.

```sh
cd "$RUN_LOG_BASE_PATH"
for p in 'cache_read_input_tokens' 'cache_creation_input_tokens' 'compact_boundary' \
         'contextWindow' 'usage_update' 'context.compacted' 'token_count'; do
  printf '%s: ' "$p"; rg -uu -l -F "$p" . | wc -l
done
printf 'Skill tool_use: '; rg -uu -l -F 'name\":\"Skill\"' . | wc -l
```

What each count decides:

| Marker | Decides |
|---|---|
| `cache_read_input_tokens` or `cache_creation_input_tokens` in files that also hold `"type":"assistant"` events | Claude per-message usage is in the stored stream, so the context timeline is derivable for `claude_local` |
| `compact_boundary` | Claude compaction rows exist in practice |
| `contextWindow` | the window is available from the result event |
| `usage_update` | ACP context fill is persisted, not only live |
| `context.compacted` | runner compaction events are persisted |
| `token_count` | any Codex per-turn signal is stored |
| `Skill` tool_use | skill loads are countable, and the input key is then read from one fixture |

A zero for a marker means that signal is `spend_only` or `none` for that adapter until an
adapter change adds it; the API reports that through `availability`, not as an empty chart.
On the development machine that wrote this plan every marker returned 0, but its logs are
tiny (no file over 4 KB), so that result proves nothing about production.
