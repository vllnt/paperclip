# Company evals: reusable Jev decisions that agents call as tools, with stats

Date: 2026-10-10
Status: Plan only (PR 1). No code ships in this pull request. The code ships in the slices in section 15.
Branch: `docs/company-evals-plan`

## 1. Goal

A company defines a decision once. Any of its agents can then call that decision as a
tool and get a structured answer. Paperclip records every call and shows stats.

Example. An agent opens a pull request that has a preview deployment. The agent must
decide whether a person or a QA agent should test the preview. The company defines an
eval `pr-preview-needs-qa`:

- Input: the changed file paths, diff stats, the title and the labels of the pull request.
- Output: `needs_qa` yes or no with a probability, and `qa_depth` one of
  `none` / `smoke` / `full_qa` with a confidence.

The agent calls the eval, reads the answer, and acts on it. The board sees how often the
eval is called, what it answers, how often it fails or abstains, how fast it is, what it
costs, and how often it is right.

Constraints, all binding:

- **Company-agnostic.** The feature contains no company-specific logic. Each company
  writes its own evals. Paperclip ships starter templates that a company can copy.
- **Jev does the judging, through the one existing client.** The service calls
  `server/src/services/judge-client.ts` (`JudgeClient.ask`). There is no second judge path.
- **Company isolation** on every table, query, route, page and tool.
- **Web, API, CLI and agent tool parity** (the standing user rule).
- **A failure is a failed result, never a guessed answer.**
- **Stats stay in the instance database.** This is not Telemetry (section 14.1).

## 2. What exists today

### 2.1 The Jev judge client (shipped in #40)

`server/src/services/judge-client.ts`:

- Three question types, `JudgeQuestion` = `predicate` (P(true), optional `abstainBand`),
  `choice` (named options, optional `minConfidence`) and `score` (ordered levels,
  optional `minConfidence`).
- `ask({ companyId, rubricVersion, state, questions })` checks, in this order: the
  company's own gateway key, the in-memory answer cache, the per-company daily call cap,
  then one gateway request under a hard timeout. It never throws.
- Result: `{ ok: true, answers, modelId, inputHash, cached }` or
  `{ ok: false, reason, inputHash }`, with `reason` in
  `JUDGE_FAILURE_REASONS = ["no_key", "cap_exceeded", "timeout", "error"]`.
  A model refusal comes back as `ok: true` with every answer abstained.
- `inputHash` is SHA-256 over model id, `rubricVersion`, questions and state. The cache
  key is `companyId:inputHash`, so a new `rubricVersion` never reuses a cached answer.
- The cache is per process: 5,000 entries, 6 h TTL.
- The key is the company secret `AI_GATEWAY_API_KEY`, read through the secret service by
  `createCompanySecretKeyResolver(db, consumerId)` in
  `server/src/services/duplicate-detection-factory.ts`. Each read is audited with that
  `consumerId`. There is no process-wide key.
- The daily cap is the `judge_usage_daily` table (`company_id`, `day`, `calls`), one
  atomic upsert per model call. Cached answers do not count.
- Settings: `PAPERCLIP_JUDGE_TIMEOUT_MS` (default 4,000), `PAPERCLIP_JUDGE_DAILY_CALL_CAP`
  (default 5,000 per company per UTC day), `PAPERCLIP_JUDGE_ZERO_DATA_RETENTION`
  (keep `false`; `true` returned HTTP 500 from the gateway on 2026-10-09).
- **Gap:** the client does not return token usage or cost. The AI SDK `experimental_decide`
  result (`ai@7.0.136`) has `usage: { inputTokens, outputTokens, totalTokens }`. Whether the
  gateway also reports a cost in `providerMetadata` is not verified.

### 2.2 Concepts that are near but different

| Existing | What it is | Why evals are separate |
|---|---|---|
| Skill Studio: `company_skill_test_inputs`, `company_skill_test_runs` (`packages/db/src/schema/company_skills.ts`) | Runs a whole agent on a skill against a saved input, through a harness issue. Minutes per run. | An eval is one cheap, synchronous Jev decision (seconds). No agent, no issue. |
| `feedback_votes` | Thumbs on issue output. Requires an `issue_id` and a user author. Has a "share with labs" flow that sends data off the instance. | Eval feedback comes from agents too, a run may have no issue, and feedback must never leave the instance. |
| Runner evals: `evals/` (promptfoo), `packages/paperclip-eval-kernel`, `packages/paperclip-runner/src/evals`, `doc/evals.md` | Developer tooling that evaluates Paperclip's own agents. | Same word, different thing. See decision D1. |
| `issue_duplicate_pairs` (#40) | A ledger of Jev answers for one built-in decision. | Evals generalise this: any company-defined decision, same client. |

### 2.3 How agents reach Paperclip today

- `packages/mcp-server` is a standalone published package (`npx -y @paperclipai/mcp-server`).
  No adapter in this repo starts it. External harnesses use it.
- Built-in agents learn the API from the Paperclip skill (`skills/paperclip/SKILL.md` and
  `references/*.md`) and call the REST API or the `paperclipai` CLI.
- So "agents call evals as tools" needs both: MCP tools for external harnesses, and a skill
  reference for built-in agents (section 9).

## 3. Concepts

| Term | Meaning |
|---|---|
| **Eval** | A named decision that belongs to one company. It has a slug, a title, a "when to use" text that agents read, and a status. |
| **Version** | An immutable definition of an eval: an input schema and a set of named Jev questions. Every saved change makes a new version. |
| **Run** | One call of one version with one input. It is recorded with its caller, answers, outcome, latency and cost. |
| **Feedback** | A correct or incorrect mark on a run (or on one question of a run), from the caller or a board user. It is the ground truth for accuracy stats. |
| **Template** | A starter eval that Paperclip ships. A company copies it into its own evals. |

```
agent / CLI / web "try it"
        |  POST /api/companies/:companyId/evals/:slug/runs  { input }
        v
 +------------------- evals service -------------------+
 | 1. company access + actor rules (agent: published)  |
 | 2. verify run id and issue (same company, agent)    |
 | 3. input <= 32 KiB       else 422, rejected row     |
 | 4. input matches schema  else 422, rejected row     |
 | 5. JudgeClient.ask({ companyId,                     |
 |      rubricVersion: version.id,                     |
 |      state: input, questions: version.questions })  |
 | 6. insert company_eval_runs row (answered | failed) |
 +-----------------------------------------------------+
        |  200 { runId, outcome, answers | failureReason, cached, latencyMs, ... }
        v
 caller acts on the answer, later: PUT .../runs/:runId/feedback
```

## 4. Decisions

The manager's defaults are written here as decisions. The user can change any of them at
plan review. Each decision names the alternatives that were rejected and why.

**D1. Name.** The product name is "Evals" (the user's word). Code and tables use the
prefix `company_eval` (`company_evals`, `company_eval_versions`, `company_eval_runs`,
`company_eval_feedback`). This follows `company_skills`, and a search for `company_eval`
never hits the runner evals. Routes are `/api/companies/:companyId/evals`. The CLI group is
`paperclipai evals`. The user doc is `doc/company-evals.md`, and it states the difference
from the runner evals in `doc/evals.md`.
Rejected: bare `evals` / `eval_runs` tables (they collide in search with the runner evals);
another product name such as "decisions" (it collides with the existing decision queues).

**D2. Model.** An eval has immutable versions. Every save of the definition creates a new
version with the next `version_number`. A save with a byte-identical definition (same
`definition_hash`) returns the latest version and creates nothing. The eval row points at
one `published_version_id`. Status is `draft` (never published), `published`, or
`archived`. The version id is the Jev `rubricVersion`.
Rejected: a mutable draft plus immutable published versions (two code paths, and "try it"
results would refer to a definition that no longer exists).

**D3. Input schema.** A small JSON Schema subset (section 6.2): the root is an object;
properties are string, number, integer, boolean, or an array of strings;
`additionalProperties` is always `false`, so nothing that the schema does not name is sent
to the gateway. The subset itself is checked by a zod schema in `packages/shared`. Inputs
are checked with Ajv, which the server already uses (`server/src/services/plugin-config-validator.ts`).
Rejected: full JSON Schema (nested objects and `$ref` make the "what is sent" review hard);
`z.fromJSONSchema` (exported by zod 4.4.3 but unused in the repo).

**D4. Authoring authority.** Only board actors (board sessions and board API keys) create,
edit, publish, archive and delete evals. Viewers cannot (the existing non-GET rule in
`assertCompanyAccess`). Agents can list and read published evals, run them, read their own
runs, and give feedback on their own runs. Agent-proposed drafts behind an approval gate
come later.
Rejected for now: a new permission key `evals:manage` in `PERMISSION_KEYS`. It adds a
grant to manage for no current need. It is easy to add later.

**D5. Running.** Input over 32 KiB (UTF-8 bytes of the JSON text) gets 422
`eval_input_too_large`. Nothing is truncated. An input that does not match the schema gets
422 `eval_input_invalid`, with paths and messages but no input values. Both are recorded as
`outcome: "rejected"` runs without the input, so the board sees agents that send bad input.
A Jev failure is HTTP 200 with `outcome: "failed"` and `failureReason`. It is a valid,
recorded result, and the caller gets a `runId`. A 422 body also carries the rejected run's
`runId` and `code`. The HTTP logger writes the request body of every response with status
400 or more (`server/src/middleware/logger.ts`), so the run and feedback routes are added to
the body-redacted route checks in `server/src/middleware/http-log-policy.ts`, like
`isRuntimeGitHubHttpRequest`. Otherwise a rejected input would reach the server logs with no
retention limit.
Rejected: HTTP 503 for Jev failures (callers would need two parsers, and the failure would
have no run id for stats).

**D6. Store the input?** Yes, for 30 days by default, so a new version can be compared on
real inputs. After that only the hash and the size stay. The setting is
`PAPERCLIP_EVAL_INPUT_RETENTION_DAYS` (0 = never store). It is a data-retention choice,
so the user confirms it at plan review.
Rejected: never store (re-scoring needs the caller to send inputs again); keep forever
(unbounded storage of agent-supplied text).

**D7. Feedback.** One mark per author per run per question (`question_id` is optional;
empty means the whole run). A later mark from the same author replaces the earlier one.
Agents can only mark their own runs, so they grade themselves. Stats therefore show two
accuracy figures: "board" (board marks only) and "all" (the board mark when there is one,
else the agent mark). The counting rules are in section 11.1.
Rejected: reuse `feedback_votes` (section 2.2); an `expected` answer field (no stat uses it
yet; add it when re-scoring ships).

**D7a. One rule for a predicate's yes or no.** Each predicate answer in a result also has
`value`: `true` when P >= 0.5, `false` when P < 0.5, and `null` when the answer abstained.
Agents act on `value`, and the stats use the same rule. So accuracy measures the decision
the agent acted on. A per-question threshold can come later.

**D8. Records and activity log.** Every run writes one `company_eval_runs` row with the
actor, run, issue and project. That row is the audit record for the call. Runs are not
copied into `activity_log`. Every configuration change and every feedback mark writes an
activity log entry.
Rejected: one activity entry per run (it doubles every write and floods the company
activity feed). This is a deliberate reading of "activity log for every mutation". The
reviewer can overturn it.

**D9. Budget.** Eval calls share the per-company daily cap in `judge_usage_daily` with
duplicate detection. One company key gives one budget. A `cap_exceeded` failure shows in
the stats.
Rejected: a separate cap per feature (needs a new key column and a primary-key change in
`judge_usage_daily`, with no evidence of need yet).

**D10. Cost and usage.** S1 extends the success branch of `JudgeOutcome` with an optional
`usage` (token counts from `result.usage`), and `costUsd` only if the gateway reports a
cost. Duplicate detection ignores the new fields. This extends the one client. It is not
a second path. It also changes `RawDecision` and the gateway transport, which must pass
`usage` through. A cached answer records 0 tokens. A refusal uses one cap slot and has no
usage data, so it records null tokens.
Rejected: estimate cost from a price table (it goes stale, and the price is not known here).

**D11. Timeout.** Evals use the same `PAPERCLIP_JUDGE_TIMEOUT_MS` (4 s). #40 only measured
one-question calls. S1 measures 2-question latency with the live smoke test. If p95 is over
3 s, a later change gives evals their own timeout setting. Note: the key lookup, the cap
reservation and the gateway call each have their own timeout, so one call can wait up to
three times the setting.

**D12. Consent to send input to the gateway.** Two acts send input to Jev, and both are
deliberate: an agent or board user runs a published eval, or a board user runs "try it" on
any version. Every run is a call that someone made on purpose with input they chose. A
company without the `AI_GATEWAY_API_KEY` secret gets `no_key` and sends nothing. There is
no extra company switch. "Try it" runs carry `mode: "try_it"`, and stats leave them out by
default.
Rejected: a company-level `evalsMode` like `duplicateDetectionMode`. That switch exists
because duplicate detection reads issue text automatically. Evals only send what a caller
passes on purpose.

**D13. Deletion.** `DELETE` works only for an eval that was never published (else 409
`eval_has_history`). Such an eval can only have "try it" runs (6.1), and they are deleted
with it. Otherwise the board archives it. Archived evals keep
their runs and stats, and agents cannot see them. Publishing an archived eval restores it.

**D14. Slices.** Only S1 carries a migration, with all four tables. Later slices add no
migration, so the just-in-time renumbering happens once. Agent tools move into their own
slice, S1b, because the runner capability gate changes about ten generated files
(section 9.2). This keeps the S1 review on data, authorization and running.

## 5. Data model and migration

All `id` columns are `uuid` with `defaultRandom()`. All timestamps are `timestamptz`.
Enums are `text` columns typed from `as const` arrays in `packages/shared`.

### 5.1 `company_evals`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid | primary key |
| `company_id` | uuid not null | FK `companies.id` ON DELETE CASCADE |
| `slug` | text not null | `^[a-z0-9][a-z0-9-]{1,62}$`; unique `(company_id, slug)`; never changes |
| `title` | text not null | 1-120 chars |
| `when_to_use` | text not null | 1-1,000 chars; agents read it to pick an eval |
| `status` | text not null default `draft` | `draft` / `published` / `archived` |
| `published_version_id` | uuid null | FK `company_eval_versions.id` ON DELETE SET NULL |
| `template_key`, `template_version` | text null | set when copied from a template (S4) |
| `created_by_user_id`, `updated_by_user_id` | text null | board user ids |
| `created_at`, `updated_at` | timestamptz not null | default now |
| `published_at`, `archived_at` | timestamptz null | |

Index: unique `company_evals_company_slug_uq (company_id, slug)`.
`published_version_id` and `company_eval_versions.eval_id` reference each other. Drizzle
emits the second foreign key as `ALTER TABLE ... ADD CONSTRAINT` after both tables exist.

### 5.2 `company_eval_versions` (insert only)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid | primary key; used as Jev `rubricVersion` |
| `company_id` | uuid not null | FK `companies.id` ON DELETE CASCADE |
| `eval_id` | uuid not null | FK `company_evals.id` ON DELETE CASCADE |
| `version_number` | integer not null | unique `(eval_id, version_number)` |
| `input_schema` | jsonb not null | the subset in 6.2 |
| `questions` | jsonb not null | `Record<questionId, JudgeQuestion>` (6.3) |
| `definition_hash` | text not null | SHA-256 of the canonical `{input_schema, questions}` |
| `change_note` | text null | up to 500 chars |
| `created_by_user_id` | text null | |
| `created_at` | timestamptz not null | |

The service has no update path for this table. A test asserts that.

### 5.3 `company_eval_runs`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid | primary key; the `runId` callers get |
| `company_id` | uuid not null | FK `companies.id` ON DELETE CASCADE |
| `eval_id` | uuid not null | FK `company_evals.id` ON DELETE CASCADE |
| `version_id` | uuid not null | FK `company_eval_versions.id` ON DELETE CASCADE |
| `caller_type` | text not null | `agent` / `user` |
| `caller_agent_id` | uuid null | FK `agents.id` ON DELETE SET NULL |
| `caller_user_id` | text null | |
| `heartbeat_run_id` | uuid null | FK `heartbeat_runs.id` ON DELETE SET NULL |
| `issue_id` | uuid null | FK `issues.id` ON DELETE SET NULL |
| `project_id` | uuid null | FK `projects.id` ON DELETE SET NULL |
| `input_hash` | text not null | SHA-256 of the canonical input alone, so equal inputs match across versions |
| `input_bytes` | integer not null | |
| `input` | jsonb null | kept until `input_expires_at` (D6) |
| `input_expires_at` | timestamptz null | null when the input is not stored |
| `mode` | text not null default `live` | `live` / `try_it` (D12); agents always `live` |
| `outcome` | text not null | `answered` / `failed` / `rejected` |
| `failure_reason` | text null | `JUDGE_FAILURE_REASONS` when failed; `input_too_large` / `input_invalid` when rejected |
| `answers` | jsonb null | `Record<questionId, JudgeAnswer>` when answered |
| `any_abstained` | boolean not null default false | |
| `cached` | boolean not null default false | |
| `latency_ms` | integer not null | wall time around `JudgeClient.ask`; 0 for a rejected run |
| `model_id` | text null | |
| `input_tokens`, `output_tokens` | integer null | D10 |
| `cost_usd` | numeric(12,6) null | only when the gateway reports it |
| `created_at` | timestamptz not null | |

Where the caller fields come from:

- `caller_type`, `caller_agent_id`, `caller_user_id`: `getActorInfo(req)`
  (`server/src/routes/authz.ts`).
- `heartbeat_run_id`: the run id from `getActorInfo(req)` is **not trusted as is**. Only
  agent JWTs carry a signed run id. Agent API keys and board callers send the
  `X-Paperclip-Run-Id` header, and the auth middleware takes it unchecked
  (`server/src/middleware/auth.ts`). The MCP client sends it on every write. So the service
  looks the run up by `id`, `company_id` and, for agents, `agent_id` (the pattern in
  `resolveAgentSelfTrustPreset`, `server/src/routes/agents.ts`). A header that is not a UUID,
  or a run that does not match, stores null and does not fail the call. This stops a
  spoofed run id from another company from filling in this company's issue and project.
- `issue_id`: an optional `issueId` in the request body, checked to be an issue of the same
  company. If it is absent and the run was verified, it comes from the run's
  `context_snapshot ->> 'issueId'`, accepted only when it is a UUID of an issue in the same
  company. `readRunIssueId` exists three times as a private function, and the copies differ
  (`server/src/services/attention.ts` falls back to `taskId` and has no UUID check). S1 adds
  one exported helper with the strict behaviour (UUID check, no `taskId` fallback) and uses
  it. Moving the three copies to it is a follow-up.
- `project_id`: from the verified issue.

Indexes. A cascade or ON DELETE SET NULL from a parent needs an index that starts with the
foreign-key column, or deleting that parent scans this table. Eval, version, agent and
project ids are unique across companies, so these indexes also serve the stats queries,
which always filter on `company_id` too:

- `company_eval_runs_eval_created_idx (eval_id, created_at)`
- `company_eval_runs_version_created_idx (version_id, created_at)`
- `company_eval_runs_company_created_idx (company_id, created_at)` (list summary stats)
- `company_eval_runs_agent_created_idx (caller_agent_id, created_at)`
- `company_eval_runs_project_created_idx (project_id, created_at)`
- `company_eval_runs_heartbeat_run_idx (heartbeat_run_id) WHERE heartbeat_run_id IS NOT NULL`
- `company_eval_runs_issue_idx (issue_id) WHERE issue_id IS NOT NULL`
- `company_eval_runs_input_expiry_idx (input_expires_at) WHERE input IS NOT NULL`

### 5.4 `company_eval_feedback`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid | primary key |
| `company_id` | uuid not null | FK `companies.id` ON DELETE CASCADE |
| `run_id` | uuid not null | FK `company_eval_runs.id` ON DELETE CASCADE |
| `question_key` | text not null default `''` | a question id, or `''` for the whole run |
| `verdict` | text not null | `correct` / `incorrect` |
| `note` | text null | up to 2,000 chars |
| `author_type` | text not null | `agent` / `user` |
| `author_key` | text not null | `agent:<id>` or `user:<id>`; unique `(run_id, question_key, author_key)` |
| `author_agent_id` | uuid null | FK `agents.id` ON DELETE SET NULL |
| `author_user_id` | text null | |
| `created_at`, `updated_at` | timestamptz not null | |

Indexes: the unique index above (it starts with `run_id`, so it serves the cascade from
runs and the label lookup for runs in a stats window),
`company_eval_feedback_company_created_idx (company_id, created_at)`, and
`company_eval_feedback_author_agent_idx (author_agent_id) WHERE author_agent_id IS NOT NULL`.

Index rule exemptions: `company_evals.company_id` is served by the unique
`(company_id, slug)` index. `company_eval_versions.company_id` and
`company_evals.published_version_id` have no index of their own. Both tables grow only by
board authoring (tens to hundreds of rows per company), so a scan on company removal or
version delete is cheap.

### 5.5 Company removal

- Every `company_id` is NOT NULL with ON DELETE CASCADE.
- Every agent, run, issue and project reference is nullable with ON DELETE SET NULL.
- Child tables cascade from their NOT NULL parents.

This meets the rules of the company-delete foreign-key check in open PR #83
(`company-removal-coverage.test.ts`): SET NULL references are ignored, and NOT NULL
cascades count as deleted with their parent. No `tx.delete` is needed in
`companyService.remove()`. If #83 merges first, its check covers the new tables
automatically. If not, S1 adds a test that removes a company with eval rows and asserts
that none remain.

### 5.6 Migration

- One migration in S1. It only runs `CREATE TABLE`, `CREATE INDEX` on the new empty tables,
  and `ADD CONSTRAINT` between them. It does not change any existing table.
- The number is taken just in time, when the landing captain names S1 as next. This plan
  claims no number.
- Workflow: AGENTS.md section 6, then `pnpm --filter @paperclipai/db check:migrations`.
- Rollback: the tables are new and nothing else reads them, so an older image ignores them.

## 6. Running an eval

### 6.1 Steps

1. Resolve the eval by `(company_id, slug)`. Another company's eval and a missing eval both
   give 404, through `getAccessibleResource` (no 403 vs 404 leak).
2. Actor rules: an agent may only run a `published` eval, at its published version. A draft
   or archived eval is 404 for an agent. A board actor may pass `versionNumber` to run any
   version ("try it"). Agent keys with the `skill_test` scope get 403, like
   `issue-duplicates.ts`.
   The run's `mode` is `live` only when it runs the published version of a published eval
   and the board did not ask for `mode: "try_it"`. Every other run is `try_it`. So a board
   run of a draft version never counts in the default stats and never blocks deletion.
3. Verify the caller's run id and issue (5.3).
4. Size check on `JSON.stringify(input)` in UTF-8 bytes: over 32,768 gives 422 and a
   `rejected` run row without the input.
5. Schema check with the version's compiled Ajv validator: a mismatch gives 422 and a
   `rejected` run row without the input. Validators are cached by version id, because
   versions never change.
6. `judge.ask({ companyId, rubricVersion: version.id, state: input, questions: version.questions })`.
   The evals service has its own `JudgeClient` with the key resolver consumer id `evals`,
   so secret reads are audited as evals. `createCompanySecretKeyResolver` moves from
   `duplicate-detection-factory.ts` to a module next to `judge-client.ts`, so the evals
   service does not import the duplicate-detection factory. It shares the
   `judge_usage_daily` cap (D9).
7. Insert the run row (5.3), then return.

### 6.2 Input schema subset

```jsonc
{
  "type": "object",                       // required at the root
  "properties": {                          // 1-32 properties
    "<name>": {                            // ^[A-Za-z][A-Za-z0-9_]{0,63}$
      "type": "string",  "description": "...", "maxLength": 32768, "enum": ["..."]   // enum: up to 50
      // or "type": "number" | "integer", "minimum", "maximum"
      // or "type": "boolean"
      // or "type": "array", "items": { "type": "string", "maxLength": n }, "maxItems": 1000
    }
  },
  "required": ["<name>", "..."]
  // "additionalProperties" is always false; the service sets it
}
```

### 6.3 Questions

- 1 to 8 questions per version. Question ids match `^[a-z][a-z0-9_]{0,39}$`.
- Each question is a `JudgeQuestion` from `judge-client.ts`, stored as is.
- Limits: `instructions` 1-2,000 chars; `choice` 2-12 options, each up to 500 chars;
  `score` 2-10 levels; `abstainBand` inside [0, 1] with low < high; `minConfidence` in [0, 1].
- Not verified: whether Jev has its own limit on questions per call. S1's live smoke test
  checks 2 questions. The limit of 8 is a guess.

### 6.4 Result

```jsonc
{
  "runId": "uuid",
  "eval": { "id": "uuid", "slug": "pr-preview-needs-qa", "versionId": "uuid", "versionNumber": 3 },
  "outcome": "answered",                   // or "failed"
  "failureReason": null,                   // "no_key" | "cap_exceeded" | "timeout" | "error"
  "answers": {                             // null when failed
    "needs_qa": { "type": "predicate", "probability": 0.91, "value": true, "abstained": false },  // value: D7a
    "qa_depth": { "type": "choice", "choice": "smoke", "probabilities": { "none": 0.05, "smoke": 0.71, "full_qa": 0.24 },
                  "confidence": 0.71, "abstained": false }
  },
  "cached": false,
  "latencyMs": 1180,
  "modelId": "typesafe-ai/jev"
}
```

A `no_key` result also carries `hint`: "Add the company secret AI_GATEWAY_API_KEY".

An eval result is advice. The input can carry text that outsiders wrote (a pull request
title, for example), and that text can steer the answer. A result must never be the only
gate for a governed action such as an approval or a merge. `doc/company-evals.md` and the
skill reference say so.

## 7. API

All routes are in a new `server/src/routes/company-evals.ts`. Each one is registered in
`server/src/routes/openapi.ts`, and the file is added to `apiPrefixes` in
`server/src/__tests__/openapi-routes.test.ts`. Board-only routes are added to
`BOARD_ONLY_OPERATIONS`, and 201 routes to `CREATED_OPERATIONS`. (The decision-training
routes show the trap: they enforce board-only in code but the spec does not say so.)

Base: `/api/companies/:companyId/evals`

| Method and path | Who | Result |
|---|---|---|
| `GET /` | board, agent | List. Board: all except archived by default, `?status=`. Agent: published only, with `whenToUse` and the published input schema. Each row has 7-day summary stats (S3). |
| `POST /` | board | Create with the first version: `{ slug, title, whenToUse, inputSchema, questions, changeNote? }`. 201. 409 on a duplicate slug. |
| `GET /:slug` | board, agent | Detail with the published and the latest version. Agent: published only. |
| `PATCH /:slug` | board | `{ title?, whenToUse? }`. |
| `DELETE /:slug` | board | 204, or 409 `eval_has_history` (D13). |
| `GET /:slug/versions` | board | List of versions. |
| `POST /:slug/versions` | board | New version `{ inputSchema, questions, changeNote? }`. 201, or 200 with the existing latest version when the definition is identical. Both responses are declared in OpenAPI, and the route is not put in `CREATED_OPERATIONS` (that list rewrites 200 to 201, so the 200 case would vanish). |
| `GET /:slug/versions/:versionNumber` | board | One version. |
| `POST /:slug/publish` | board | `{ versionNumber? }`; default is the latest. Sets `published`. |
| `POST /:slug/archive` | board | Sets `archived`. |
| `POST /:slug/runs` | board, agent | Run (section 6). `{ input, issueId?, versionNumber? (board only), mode? (board only: "try_it") }`. 200. |
| `GET /:slug/runs` | board, agent | `?from&to&versionNumber&agentId&projectId&outcome&mode&limit&cursor`. Agent: own runs only. Input is included while retained. |
| `GET /:slug/runs/:runId` | board, agent | One run with its feedback. Agent: own runs only. |
| `PUT /:slug/runs/:runId/feedback` | board, agent (own runs) | `{ questionId?, verdict, note? }`. Upsert by author (D7). |
| `GET /:slug/stats` | board, agent | Section 11. `?from&to&versionNumber&agentId&projectId&mode` (default `live`). Agents may read company-wide stats: they hold counts and rates, never inputs. |

Templates (S4): `GET /api/eval-templates`, `GET /api/eval-templates/:key`, and
`POST /api/companies/:companyId/evals/from-template` `{ templateKey, slug? }` (board, 201,
creates a draft).

Errors: 400 for any body or query that fails its zod validator, including an invalid input
schema or invalid questions on create (the existing `validate()` middleware convention);
401; 403 (agent authoring, viewer write, `skill_test` key, cancelled run); 404 (missing,
another company's, or hidden from agents); 409 (slug taken, delete with history); 422 only
for an eval input that is too large or does not match the version's schema
(`eval_input_too_large`, `eval_input_invalid`).

Logging: `POST /:slug/runs` and `PUT /:slug/runs/:runId/feedback` are added to the
body-redacted route checks in `server/src/middleware/http-log-policy.ts` (D5), with a test
that a 422 or a 5xx on these routes writes no input to the log.

Activity log actions (entity `eval` or `eval_run`; details carry slug and version number,
never input values): `eval.created`, `eval.updated`, `eval.version_created`,
`eval.published`, `eval.archived`, `eval.deleted`, `eval.created_from_template`,
`eval.feedback_recorded`.

## 8. CLI

A new `cli/src/commands/client/evals.ts`, registered in `cli/src/index.ts`, built with
`addCommonClientOptions`, `resolveCommandContext`, `apiPath` and `printOutput` from
`cli/src/commands/client/common.ts`. Every command supports `--json`.

| Command | Calls |
|---|---|
| `paperclipai evals list [--status <s>]` | `GET /evals` |
| `paperclipai evals show <slug>` | `GET /evals/:slug` |
| `paperclipai evals create --slug <s> --title <t> --when-to-use <text> --definition <file.json>` | `POST /evals` |
| `paperclipai evals edit <slug> [--title] [--when-to-use] [--definition <file.json>] [--note]` | `PATCH`, and `POST /versions` when `--definition` is given |
| `paperclipai evals versions <slug>` | `GET /versions` |
| `paperclipai evals publish <slug> [--version <n>]` | `POST /publish` |
| `paperclipai evals archive <slug>` | `POST /archive` |
| `paperclipai evals run <slug> (--input <file or -> \| --input-json <json>) [--issue-id <id>] [--version <n>] [--try-it]` | `POST /runs` (`--version` and `--try-it` are board only) |
| `paperclipai evals runs <slug> [filters]` | `GET /runs` |
| `paperclipai evals feedback <slug> <runId> (--correct \| --incorrect) [--question <id>] [--note <text>]` | `PUT /feedback` |
| `paperclipai evals stats <slug> [--from] [--to] [--version] [--agent-id] [--project-id] [--mode <live\|try_it\|any>]` | `GET /stats` (S3) |
| `paperclipai evals templates` / `paperclipai evals copy-template <key> [--slug]` | S4 |

A definition file holds `{ "inputSchema": {...}, "questions": {...} }`. The existing
top-level `feedback` command does not clash, because this one is nested under `evals`.
Docs: `doc/CLI.md` and `docs/cli/control-plane-commands.md`.

## 9. Agent tools

### 9.1 MCP tools (`packages/mcp-server/src/tools.ts`)

| Tool | Input | Calls |
|---|---|---|
| `paperclipListEvals` | `{ companyId? }` | `GET /evals` (published only, with `whenToUse` and input schema) |
| `paperclipRunEval` | `{ companyId?, slug, input, issueId? }` | `POST /evals/:slug/runs` |
| `paperclipEvalFeedback` | `{ companyId?, slug, runId, verdict, questionId?, note? }` | `PUT .../feedback` |

Each tool uses `makeTool` with a string-literal description that contains no `"`
character. The capability inventory regex (`"([^"]+)"`) only reads string literals without
that character.

### 9.2 Runner capability gate

The server build runs `check:capability-contract` and `check:capability-inventory` in
`packages/paperclip-runner`. Both parse `tools.ts`. Adding three tools means:

1. Three `toolMappings` entries in `spec/capability/source-contract.json`.
2. The tool count 42 becomes 45 in `scripts/generate-capability-contract.mjs` (the check and
   its prose), in `scripts/lib/capability-inventory.mjs` (`expectedCounts.legacyMcpAliases`),
   in `scripts/check-capability-inventory.test.mjs`, and in `test/capability-contract.test.mjs`.
3. Three `legacyMcpFoldTargets` entries that point at existing `eval:` rows. No eval row
   covers this feature yet, so S1b picks the nearest rows and says why in the PR.
4. Regenerate `generated/capability/*` with
   `pnpm --dir packages/paperclip-runner generate:capability-contract` (works offline).
5. Update `spec/capability/mcp-tool-map.yaml`, `spec/capability/eval-traceability.yaml`,
   `src/generated/capability-contract.ts` and `docs/capability-contract.md`.
   `generate:capability-inventory` needs an external corpus (`PAPERCLIP_EVALS_ROOT`) that is
   not available here. So these files are written with a small script that calls the lib
   exports (`buildMcpInventory`, `encodeInventory`, `renderContractModule`,
   `renderDocumentation`), and the script is part of the PR.
6. Tool rows carry line anchors in `tools.ts`. Append the new tools after the last
   `paperclip*` tool, so the fewest anchors move.
7. Proof for S1b: the full runner `build` passes (it also runs `check:protocol-coverage`,
   which reads `eval-traceability.yaml`, and `check:semantic-contracts`), and
   `pnpm --dir packages/paperclip-runner test:scenarios` passes. The two capability checks
   alone are not enough.

### 9.3 Skill reference for built-in agents

- A new `skills/paperclip/references/evals.md` explains when and how to call evals through
  the API and the CLI. It also says how to read `whenToUse`, how to treat an abstained or
  failed result (decide without it, never invent an answer), that a result is advice and
  never the only gate for a governed action, and how to give feedback.
- `SKILL.md` headings are anchored by line number in the capability checks. The pointer to
  the new reference extends the existing pointer line under "Full Reference" (it names
  `references/api-reference.md` today). It adds no line above any heading.
- The new reference is not added to `skillSources` in S1b. Adding it changes the pinned
  capability counts, which is a separate decision for the runner owners.
- A company tells its agents which eval to use in the agent instructions, for example:
  "Before you ask for QA on a preview, run the `pr-preview-needs-qa` eval."

## 10. Web (S2)

- A route `evals` and `evals/:slug/:section` in `boardRoutes()` (`ui/src/App.tsx`). Add
  `"evals"` to `BOARD_ROUTE_ROOTS` (`ui/src/lib/company-routes.ts`) and to the unprefixed
  redirect list. Add a sidebar entry in both `Sidebar.tsx` and `Sidebar.production.tsx`, and
  register the page in both UI surfaces that `App.tsx` builds (streamlined and production).
  If #68 (lazy routes) has merged, follow its pattern.
- `ui/src/api/companyEvals.ts` and keys in `ui/src/lib/queryKeys.ts`, TanStack Query inline,
  as in Routines.
- **List page:** title, slug, status, published version, and the 7-day calls, failure rate,
  abstain rate and accuracy (from S3; empty cells until then).
- **Eval page** with sections:
  - Definition: title and "when to use", input schema and questions as JSON text areas (the
    `JsonObjectField` pattern in `ui/src/components/JsonSchemaForm.tsx`: keep invalid text,
    `aria-invalid`, `role="alert"`). Save creates a version. Publish picks a version.
  - Versions: a list with a line diff (`ui/src/lib/line-diff.ts`, as in `RoutineHistoryTab`).
  - Try it: paste an input, pick a version, run, see the answers and the raw result.
  - Runs: a history with filters, and correct/incorrect plus a note per run. The layout
    follows `OutputFeedbackButtons.tsx`, but the data-sharing consent dialog is not used.
- Tokens only (`DESIGN.md`); run `pnpm check:token-gates`. Check desktop and mobile widths in
  a real browser with zero console errors.

## 11. Stats (S3)

### 11.1 Definitions (per eval; filter by version, agent, project, mode and time)

Stats count `live` runs by default (`mode=try_it` or `mode=any` to change it).

| Stat | Definition |
|---|---|
| calls | runs in the window that reached the judge (`answered` + `failed`) |
| rejected | `rejected` runs, split by `input_too_large` / `input_invalid`; shown apart from calls |
| failure rate by reason | failed runs / calls, split by `failure_reason` |
| abstain rate | answered runs with `any_abstained` / answered runs; also per question |
| answer distribution | per question: predicate `value` `true` / `false` / `abstain` (D7a); choice per option plus `abstain`; score per level plus `abstain` |
| latency p50 / p95 | over answered, not cached runs (a cache hit takes about 0 ms and would hide model latency), shown next to the count of `timeout` failures, which are the slowest calls and are not in the percentiles |
| cache-hit rate | cached runs / answered runs |
| tokens, cost | sums of `input_tokens`, `output_tokens`, `cost_usd`; cost shows "not reported" when every value is null |
| accuracy | per question: labelled correct / labelled, in two figures: "board" and "all" (D7) |
| precision, recall | predicates: precision = correct / labelled answers with `value` true; recall = (answered true and correct) / (answered true and correct + answered false and incorrect). Choice: precision per option. |
| daily series | the same counts per UTC day |

Label counting rules:

- For each run and question, the label is the first that exists of: a board question mark;
  a board whole-run `correct`; an agent question mark; an agent whole-run `correct`. The
  "board" figure stops after the first two. So a board mark always beats an agent mark.
- A whole-run mark (`question_key = ''`) does not say which answer was wrong when it is
  `incorrect`, so a whole-run `incorrect` is not a label for any question. Stats show the
  count of whole-run `incorrect` marks so they are not lost. When a board user marked the
  whole run `incorrect`, the agent's marks on that run are ignored, so an agent mark never
  beats a board mark.
- A labelled answer that abstained is not in accuracy, precision or recall. It is counted
  as "labelled abstentions".

### 11.2 Query sketches

Summary (one statement per request):

```sql
SELECT count(*) FILTER (WHERE outcome <> 'rejected')               AS calls,
       count(*) FILTER (WHERE outcome = 'rejected')                AS rejected,
       count(*) FILTER (WHERE outcome = 'failed')                  AS failed,
       count(*) FILTER (WHERE failure_reason = 'timeout')          AS timeouts,
       count(*) FILTER (WHERE outcome = 'answered' AND any_abstained) AS abstained,
       count(*) FILTER (WHERE cached)                              AS cached,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)
         FILTER (WHERE outcome = 'answered' AND NOT cached)        AS latency_p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
         FILTER (WHERE outcome = 'answered' AND NOT cached)        AS latency_p95,
       sum(input_tokens), sum(output_tokens), sum(cost_usd)
FROM company_eval_runs
WHERE company_id = $1 AND eval_id = $2 AND mode = 'live'
  AND created_at >= $from AND created_at < $to
  -- optional: AND version_id = $v AND caller_agent_id = $a AND project_id = $p
```

Failure reasons: the same filter, `GROUP BY failure_reason`.

Answer distribution:

```sql
SELECT a.key AS question_id,
       CASE
         WHEN (a.value ->> 'abstained')::boolean THEN 'abstain'
         WHEN a.value ->> 'type' = 'predicate'
           THEN CASE WHEN (a.value ->> 'probability')::float8 >= 0.5 THEN 'true' ELSE 'false' END
         WHEN a.value ->> 'type' = 'choice' THEN a.value ->> 'choice'
         ELSE a.value ->> 'score'
       END AS bucket,
       count(*)
FROM company_eval_runs r
CROSS JOIN LATERAL jsonb_each(r.answers) AS a
WHERE r.company_id = $1 AND r.eval_id = $2 AND r.mode = 'live' AND r.outcome = 'answered'
  AND r.created_at >= $from AND r.created_at < $to
GROUP BY 1, 2
```

Marks for the runs in the window, read through the unique index that starts with `run_id`:

```sql
WITH runs AS (
  SELECT id, answers FROM company_eval_runs
  WHERE company_id = $1 AND eval_id = $2 AND mode = 'live' AND outcome = 'answered'
    AND created_at >= $from AND created_at < $to
)
SELECT r.id AS run_id, r.answers, f.question_key, f.verdict, f.author_type
FROM runs r
JOIN company_eval_feedback f ON f.run_id = r.id AND f.company_id = $1
```

The service then picks one label per run and question with the precedence in 11.1, for
the "board" and the "all" figures, and counts them against the answers bucketed as above.
Labelled runs are a small share of all runs, so this stays cheap. If it does not, the same
precedence can move into SQL with `DISTINCT ON`.
Daily series: `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')` with `GROUP BY`. Empty
days are filled in code, as in `server/src/services/dashboard.ts`.

`percentile_cont` is new in this repo (today the only percentile is in JavaScript in
`services/tool-access.ts`). S3 tests run these queries on the embedded Postgres.

### 11.3 Scale and indexes

- Every query filters on `company_id`, plus `eval_id` or `version_id` and a time range.
  The `(eval_id, created_at)` and `(version_id, created_at)` indexes in 5.3 serve them; the
  ids are unique across companies, and `company_id` stays in every query as the isolation
  check. Agent and project filters use the indexes that start with those columns. The list
  page's 7-day summary uses `(company_id, created_at)`.
- Size estimate: 2,000 runs a day for one company is about 730,000 rows a year. The rows
  without input are under 2 KB each, so about 1.5 GB a year. Stored input is bounded by
  runs a day × retention days × input size. A typical pull request input is 2-5 KiB; the
  worst case is 32 KiB.
- Plan: compute at query time. Add a daily rollup table only when a measured stats query
  is slow. This is the same rule as `doc/plans/2026-10-09-full-observability.md`.

## 12. Input retention job (ships in S1)

- Setting: `PAPERCLIP_EVAL_INPUT_RETENTION_DAYS` in `server/src/config.ts`, default 30,
  0 = do not store the input. The precedent is `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS`.
- At insert: `input_expires_at = now() + days`. A changed setting affects new runs only,
  which is predictable. (Rejected: compute expiry at sweep time, which would make a lowered
  setting delete old input at once.)
- Sweep: on the heartbeat scheduler tick in `server/src/index.ts`, at most every 10 minutes
  (the SSH run-directory sweep pattern), inside `trackHeartbeatSchedulerWork`, and once at
  startup. Each tick runs batches of:

  ```sql
  UPDATE company_eval_runs SET input = NULL
  WHERE id IN (SELECT id FROM company_eval_runs
               WHERE input IS NOT NULL AND input_expires_at <= now()
               ORDER BY input_expires_at LIMIT 1000)
  ```

  up to 20 batches a tick. Do not copy `plugin-log-retention.ts`: its delete has no limit,
  and its start function is never called.
- If `HEARTBEAT_SCHEDULER_ENABLED=false`, only the startup sweep runs. `doc/company-evals.md`
  says so.

## 13. Starter template (S4)

- Templates are a typed module in `packages/shared` (`company-eval-templates.ts`). A unit test
  checks each template with the same validators as user input. There is no catalog package
  until there are more than a few templates (the skills and teams catalog packages are the
  model if that happens).
- Copying creates a new **draft** in the company with `template_key` and `template_version`.
  Nothing installs by itself.
- `pr-preview-needs-qa`, version 1:

```jsonc
{
  "slug": "pr-preview-needs-qa",
  "title": "Does this pull request preview need QA?",
  "whenToUse": "Call after a pull request has a preview deployment and before you ask a person or a QA agent to test it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title":        { "type": "string", "maxLength": 300 },
      "labels":       { "type": "array", "items": { "type": "string", "maxLength": 100 }, "maxItems": 50 },
      "changedFiles": { "type": "array", "items": { "type": "string", "maxLength": 300 }, "maxItems": 300,
                        "description": "Changed file paths, repository-relative" },
      "additions":    { "type": "integer", "minimum": 0 },
      "deletions":    { "type": "integer", "minimum": 0 },
      "hasUiChanges": { "type": "boolean", "description": "True when the author knows the change is visible in the UI" }
    },
    "required": ["title", "changedFiles", "additions", "deletions"]
  },
  "questions": {
    "needs_qa": {
      "type": "predicate",
      "instructions": "Decide whether a person should test the preview deployment of this pull request before merge.",
      "whenTrue": "The change can alter what users see or do: UI files, styles, routes, user-facing copy, forms, auth flows, or client-side data handling.",
      "whenFalse": "The change cannot alter user-visible behaviour: docs only, tests only, CI config, comments, or internal refactors with no UI or API contract change.",
      "abstainBand": [0.35, 0.65]
    },
    "qa_depth": {
      "type": "choice",
      "instructions": "Pick how much QA the preview needs.",
      "options": {
        "none": "No user-visible change.",
        "smoke": "A small user-visible change: open the affected page and check the main path.",
        "full_qa": "A broad or risky change: several pages, flows, auth, payments, or data entry. Test all affected flows."
      },
      "minConfidence": 0.6
    }
  }
}
```

The template sends file paths, counts, the title and labels, not diff contents. A company
can widen it in its own copy.

## 14. Security, privacy and data paths

### 14.1 Which data path this is (AGENTS.md section 5.7)

Runs, feedback and stats are rows in the local instance database, read by the local
server. This is like the **run-log path**. It is **not Paperclip Telemetry**: no event goes
to the first-party telemetry endpoint, and `packages/shared/src/telemetry/` does not change.
It is **not Observability**: no span attributes change. A reviewer should reject a slice
that adds a telemetry event for evals.

### 14.2 What leaves the instance

- The eval input and the questions go to the Vercel AI Gateway and the `typesafe-ai/jev`
  model, with the company's own key. This is the same data flow as #40 duplicate detection.
  Zero data retention stays off (see 2.1).
- Nothing goes out for a company without the `AI_GATEWAY_API_KEY` secret.

### 14.3 Risks and controls

| Risk | Control |
|---|---|
| Cross-company read | `company_id` in every query; 404 for another company's rows; isolation tests in every slice. |
| An agent changes an eval's behaviour | Agents cannot author (D4); versions are immutable; changes are in the activity log. |
| Secrets in agent-supplied input are sent and stored | The schema limits what can be sent (`additionalProperties: false`, `maxLength`); the template sends paths and counts, not diffs; input is purged after 30 days; `doc/company-evals.md` warns. Automatic redaction is open question Q5. |
| Rejected input lands in the server logs | The run and feedback routes are body-redacted in the HTTP logger (D5), with a test. |
| A spoofed run id links a run to another company's issue | The run id is verified by company and agent before use; no match stores null (5.3). |
| Prompt injection in the input | The questions come from the board. The model returns probabilities and choices only, never text that runs. Outsider text in the input can still steer the answer, so a result is advice and never the only gate for a governed action (6.4). Feedback and stats show wrong answers. |
| Runaway cost | The per-company daily cap (D9); cached answers are free; `cap_exceeded` is visible in stats. |
| One agent reads another agent's inputs | Agents see only their own runs; board users see all runs. Agents can read company-wide stats, which hold counts and rates only. |

## 15. Slices

Each slice is its own pull request with an independent review. Each one fills the PR
template, including the web, API and CLI parity statement.

| Slice | Contents | Migration |
|---|---|---|
| **S1** data and running | 4 tables; shared types and validators; evals service; all routes in section 7 except stats and templates; OpenAPI; CLI except `stats` and templates; activity log; run-id verification and the strict `readRunIssueId` helper (5.3); body redaction for the run and feedback routes; the input retention job; `JudgeOutcome.usage` (D10); the key resolver moved next to the judge client; `doc/company-evals.md`; CLI docs | yes, number taken just in time |
| **S1b** agent tools | 3 MCP tools; the runner capability gate (9.2); `skills/paperclip/references/evals.md` and the `SKILL.md` pointer | no |
| **S2** web | list, eval page (definition, versions, try it, runs with feedback) | no |
| **S3** stats | `GET /stats`, list summary stats, `paperclipai evals stats`, web stats panels | no |
| **S4** templates | template module with `pr-preview-needs-qa`; template routes; CLI `templates` and `copy-template`; web "Start from template" | no |

Order: S1, then S1b and S2 in parallel, then S3, then S4. Code PRs start only after this
plan is approved.

Not in v1, each a later follow-up: company export and import of evals (the portable
company package does not include them); re-scoring stored inputs against a new version;
agent-proposed drafts behind an approval gate; a per-question predicate threshold; a
daily rollup table (only if a stats query is measured slow).

### 15.1 Tests per slice

- **S1:** another company's eval and run give 404 (read, run, feedback); agent create,
  edit or publish gives 403; agents see only published evals (draft gives 404); input schema
  subset accepted and rejected cases; input over 32 KiB gives 422 with nothing sent to the
  judge; schema mismatch gives 422 without values; `no_key` gives a recorded failed run;
  `cap_exceeded` and `timeout` give recorded failed runs; cache by version (same input, new
  version: no cache hit; same version: hit, `cached: true`); versions cannot be updated; an
  identical definition creates no version; delete of a published eval gives 409; feedback
  upsert per author, and an agent cannot mark another agent's run; one activity log entry
  per mutation and none with input values; rejected calls are recorded without input, with
  `latency_ms` 0, and the 422 body carries their `runId`; a 422 or 5xx on the run route
  writes no input to the HTTP log; a board run of a non-published version, or with
  `mode: "try_it"`, is stored as `try_it`; a run id header that is not a UUID, or that names
  another company's or another agent's run, stores null run, issue and project and the
  call still succeeds; an agent cannot send `versionNumber` or `mode`; predicate answers
  carry `value` by the D7a rule; the retention sweep clears expired input in batches and
  keeps the hash; company removal leaves no eval rows; `openapi-routes` covers every route;
  CLI request shapes.
- **S1b:** MCP tool request shapes (`packages/mcp-server/src/tools.test.ts`); the full
  runner `build` and `test:scenarios` pass (9.2, step 7); the skill-doc tests
  (`paperclip-skill-utils`) pass.
- **S2:** UI component tests for the editor and try-it states; a real-browser check at
  desktop and mobile widths with zero console errors; token gates.
- **S3:** each stat on a fixed data set, including the "board" and "all" accuracy figures,
  the label precedence (board question, board whole-run `correct`, agent question, agent
  whole-run `correct`), whole-run `incorrect` counted but not used as a label, a board
  whole-run `incorrect` that removes the agent's marks on that run, labelled
  abstentions left out, cached runs left out of
  latency, timeouts counted next to it, rejected runs apart from calls, try-it runs left
  out by default, and null cost shown as not reported; the filters; the CLI.
- **S4:** every template passes the validators; copy creates a draft with provenance; a
  slug conflict gives 409.

### 15.2 Which tests gate CI

CI runs only the fixed `vitest run` list in `Dockerfile` (line 145) inside "Build production
image". Each slice appends its non-database test files to that list: the shared validator
tests, the input-schema and size-cap unit tests, the CLI tests (the CLI is a root vitest
project), and the template test. Database-backed server tests run locally and in review,
like today. `packages/mcp-server` is not a root vitest project, so its tests do not gate CI.
S1b says so in its risks and does not change the CI layout.

## 16. Open questions for the user

1. **Q1 Input retention (D6).** Store eval inputs for 30 days by default, then keep only
   the hash. Is 30 right, or should the default be 0 (never store)?
2. **Q2 Name (D1).** "Evals" collides with the runner's developer evals in docs and search.
   Keep "Evals" with the `company_eval` prefix in code?
3. **Q3 Activity log (D8).** Runs are recorded in their own table, not in the activity log.
   Agree, or log every run too?
4. **Q4 Budget (D9).** Evals share the company's daily Jev cap with duplicate detection.
   Agree, or a separate cap?
5. **Q5 Redaction.** Should the server run the existing secret redaction over string inputs
   before it sends and stores them? It costs CPU per call and can damage legitimate input
   (for example a file path that looks like a token).
6. **Q6 Slices (D14).** Agent tools move from S1 into their own slice S1b. Agree?
