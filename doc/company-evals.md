# Company evals

A company defines a decision once. Any caller (an agent, a script, a board user) then runs that decision and gets a
structured answer. Paperclip records every call.

Company evals are **not** the developer evals in [`doc/evals.md`](./evals.md). Those evaluate Paperclip's own runners
and agents. Company evals are decisions that a company writes for its own work, answered by Jev, the small
classification model that [duplicate detection](./duplicate-detection.md) also uses. The word "eval" is the product
name. In code, tables and routes the prefix is `company_eval`.

## Concepts

| Term | Meaning |
|---|---|
| **Eval** | A named decision that belongs to one company. It has a slug, a title, a `whenToUse` text that callers read, and a status: `draft`, `published` or `archived`. |
| **Version** | An immutable definition: an input schema and one to eight Jev questions. Every saved change is a new version. A version never changes. |
| **Run** | One call of one version with one input. It records the caller, the answers, the outcome, the latency and the token usage. |
| **Feedback** | A `correct` or `incorrect` mark on a run, or on one question of a run. It is the ground truth for accuracy figures. |

Only board users create, change, publish, archive and delete evals. Agents list and read published evals, run them, read
their own runs and mark their own runs.

## Quick start

An eval is a definition file plus a few words.

```jsonc
// definition.json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "maxLength": 300 },
      "changedFiles": { "type": "array", "items": { "type": "string", "maxLength": 300 }, "maxItems": 300 },
      "additions": { "type": "integer", "minimum": 0 },
      "deletions": { "type": "integer", "minimum": 0 }
    },
    "required": ["title", "changedFiles", "additions", "deletions"]
  },
  "questions": {
    "needs_qa": {
      "type": "predicate",
      "instructions": "Decide whether a person should test the preview deployment of this pull request before merge.",
      "whenTrue": "The change can alter what users see or do.",
      "whenFalse": "The change cannot alter user-visible behaviour: docs only, tests only, CI config, comments.",
      "abstainBand": [0.35, 0.65]
    },
    "qa_depth": {
      "type": "choice",
      "instructions": "Pick how much QA the preview needs.",
      "options": {
        "none": "No user-visible change.",
        "smoke": "A small user-visible change: open the affected page and check the main path.",
        "full_qa": "A broad or risky change: test all affected flows."
      },
      "minConfidence": 0.6
    }
  }
}
```

```sh
npx paperclipai evals create --company-id <company-id> --slug pr-preview-needs-qa \
  --title "Does this pull request preview need QA?" \
  --when-to-use "Call after a pull request has a preview deployment and before you ask for QA." \
  --definition definition.json
npx paperclipai evals run pr-preview-needs-qa --company-id <company-id> --try-it --input-json '{"title":"Fix typo","changedFiles":["README.md"],"additions":1,"deletions":1}'
npx paperclipai evals publish pr-preview-needs-qa --company-id <company-id>
```

After `publish`, agents see the eval in `GET /api/companies/:companyId/evals` and run the published version. Tell your
agents which eval to use in their instructions, for example: "Before you ask for QA on a preview, run the
`pr-preview-needs-qa` eval."

## What a run returns

```jsonc
{
  "runId": "uuid",
  "eval": { "id": "uuid", "slug": "pr-preview-needs-qa", "versionId": "uuid", "versionNumber": 1 },
  "outcome": "answered",          // or "failed"
  "failureReason": null,          // "no_key" | "cap_exceeded" | "timeout" | "error"
  "answers": {
    "needs_qa": { "type": "predicate", "probability": 0.91, "value": true, "abstained": false },
    "qa_depth": { "type": "choice", "choice": "smoke", "probabilities": { "none": 0.05, "smoke": 0.71, "full_qa": 0.24 }, "confidence": 0.71, "abstained": false }
  },
  "cached": false,
  "latencyMs": 1180,
  "modelId": "typesafe-ai/jev",
  "mode": "live"
}
```

- A predicate answer has `value`: `true` when the probability is at least 0.5, `false` when it is below, and `null`
  when the answer abstained. Act on `value`.
- **A failure is a failed result, never a guessed answer.** A Jev failure is HTTP 200 with `outcome: "failed"` and a
  `failureReason`. The run is recorded and has a `runId`. A company without the `AI_GATEWAY_API_KEY` secret gets
  `failureReason: "no_key"` and a `hint`, and nothing is sent anywhere. When `answers` is `null` or an answer
  abstained, decide without the eval.
- **A result is advice.** The input can carry text that other people wrote (a pull request title, for example), and
  that text can steer the answer. Never use a result as the only gate for a governed action such as an approval or a
  merge.

## Input rules

- The input is a JSON object that matches the version's input schema. The schema is a small subset of JSON Schema:
  the root is an object with 1 to 32 properties; each property is a `string` (with `maxLength` up to 32,768 and an
  `enum` of up to 50 values), a `number` or `integer` (with `minimum` and `maximum`), a `boolean`, or an `array` of
  strings (with `maxItems` up to 1,000). `additionalProperties` is always `false`, so nothing the schema does not name
  can be sent.
- A questions object holds 1 to 8 questions. A question is a `predicate` (a probability, with an optional
  `abstainBand`), a `choice` (2 to 12 named options, with an optional `minConfidence`) or a `score` (2 to 10 ordered
  levels, with an optional `minConfidence`).
- The input is at most 32 KiB (the UTF-8 bytes of its JSON text). Nothing is truncated. An input over 1 MiB is rejected
  before any scan, and its recorded hash is of a fixed marker and the size, not of its text.
- An input that is too large, or does not match the schema, is HTTP 422 with `code` `eval_input_too_large` or
  `eval_input_invalid`, the paths and messages of the errors (never the input values) and the `runId` of the rejected
  run. The rejected run is recorded without its input, so the board can see callers that send bad input.

## Where the data goes

Company evals are a data path of their own, like the run log. The rows are in the instance database. This is **not**
Paperclip Telemetry and **not** Observability: no event is sent to a Paperclip endpoint and no span attribute changes.

What leaves the instance: the input (after secret redaction, see below) and the questions go to the Vercel AI Gateway
and the `typesafe-ai/jev` model, with the company's own `AI_GATEWAY_API_KEY` secret. This is the same flow as duplicate
detection. Two acts send input to Jev, and both are on purpose: someone runs a published eval, or a board user runs
"try it" on any version. A company without the secret sends nothing.

### Secret redaction

Before a run goes to Jev, Paperclip masks secret-shaped text (tokens, keys, passwords in URLs) in every string value
and every string array item of the input, with the same redaction as the run log. The masked input is what is sent,
hashed and stored. The run records `inputRedacted` and the number of values that changed, never the matched text. A
false positive changes one value and never fails the call. **Redaction is pattern based and not complete.** Do not
design an input schema that asks callers to send credentials or other secrets.

### Input retention

A run keeps its masked input for 30 days, so a new version can be compared on real inputs. After that the input is
cleared and only the hash and the size stay. Set `PAPERCLIP_EVAL_INPUT_RETENTION_DAYS` to change the number of days;
`0` stores no input. A changed setting affects new runs only. A sweep clears expired inputs in batches on the
heartbeat scheduler tick, at most every 10 minutes, and once at startup. With `HEARTBEAT_SCHEDULER_ENABLED=false`,
only the startup sweep runs.

### Server logs

The HTTP log leaves out the request body of `POST .../runs` and `PUT .../runs/:runId/feedback`, even when the request
fails, so a rejected input never reaches the logs.

## Records and activity log

Every run writes one row in `company_eval_runs` with the caller, the heartbeat run, the issue and the project. That row
is the audit record of the call; runs are not copied into the activity log. Every configuration change and every
feedback mark writes an activity log entry (`eval.created`, `eval.updated`, `eval.version_created`, `eval.published`,
`eval.archived`, `eval.deleted`, `eval.feedback_recorded`). The entries hold the slug and the version number, never
input values.

The heartbeat run id that a caller sends in `X-Paperclip-Run-Id` is checked against the company and, for agents, the
agent before it is stored. A header that does not match stores no run, issue or project, and the call still works. A
run is linked to an issue when the body names an issue of the company (`issueId`) or, if it does not, when the verified
heartbeat run works on one. An `issueId` in the body that is not an issue of the company returns 404.

## Modes

A run is `live` when it runs the published version of a published eval. A board user can run any version, or pass
`mode: try_it`; such a run is stored as `try_it`. Stats count `live` runs by default. Agents cannot choose a version or
a mode. Delete works only for an eval that was never published (it can only have try-it runs); otherwise archive it.
An archived eval keeps its runs and is hidden from agents. Publishing an archived eval restores it.

## Budget and timeout

Eval calls share the per-company daily Jev call cap with duplicate detection (`PAPERCLIP_JUDGE_DAILY_CALL_CAP`, default
5,000 per UTC day), and the same timeout (`PAPERCLIP_JUDGE_TIMEOUT_MS`, default 4,000 ms). A cached answer (the same
input for the same version) is free and records 0 tokens. The cap and the timeout show as `cap_exceeded` and `timeout`
failed runs. Token usage comes from the gateway; the cost is stored only when the gateway reports one.

## Feedback

`PUT /api/companies/:companyId/evals/:slug/runs/:runId/feedback` with `{ "verdict": "correct" | "incorrect", "questionId"?, "note"? }`
marks a run, or one question of a run. One mark per author per target: a later mark by the same author replaces the
earlier one. Agents mark only their own runs, so they grade themselves. Only an answered run can get feedback.

## API

All routes are under `/api/companies/{companyId}/evals`. Access follows the company rules; viewers cannot write.

| Method and path | Who | Result |
|---|---|---|
| `GET /` | board, agent | List (agents: published only, with `whenToUse` and the input schema). Cursor-paginated. |
| `POST /` | board | Create with the first version. 201; 409 on a duplicate slug. |
| `GET /{slug}` | board, agent | Detail (agents: published only). |
| `PATCH /{slug}` | board | Change `title` or `whenToUse`. |
| `DELETE /{slug}` | board | 204, or 409 `eval_has_history`. |
| `GET /{slug}/versions`, `GET /{slug}/versions/{n}` | board | Versions, newest first. |
| `POST /{slug}/versions` | board | New version: 201, or 200 with the existing latest version when the definition is identical. |
| `POST /{slug}/publish` | board | Publish `versionNumber` (default: the latest). |
| `POST /{slug}/archive` | board | Archive. |
| `POST /{slug}/runs` | board, agent | Run. 200, or 422 for a rejected input. |
| `GET /{slug}/runs`, `GET /{slug}/runs/{runId}` | board, agent | Runs (agents: their own). |
| `PUT /{slug}/runs/{runId}/feedback` | board, agent | Mark a run. |

Another company's eval and a missing eval both return 404. The full contract is in the OpenAPI document.

## CLI

See [`doc/CLI.md`](./CLI.md#eval-commands). Every command supports `--json`.

## Not in this version

Stats (`GET .../stats`, accuracy, latency percentiles), starter templates, the agent tools for external harnesses, and
the web pages come in later slices. Re-scoring stored inputs against a new version, agent-proposed drafts behind an
approval gate and company export of evals are follow-ups.
