# Duplicate detection

Agents file the same work twice. Core only catches an exact normalized title under the same parent, so
reworded duplicates slip through and two agents spend budget on one outcome. This feature checks a new
issue against the company's open work, **before** it is created (agents call an API) and **after** (a
background check), using a free text-similarity pass and one cheap classification call per candidate.

It only **suggests**. It never cancels, merges, reassigns or edits an issue.

## How a check works

```
 draft or new issue
        │
        ▼
 tier 0  identical text (case and spacing aside, 5+ words, nothing cut) ─► "exact", no model call
        │
        ▼
 tier 1  Postgres pg_trgm, this company only, top 5 candidates (free)
        │   excludes: cancelled, hidden, done > 90 days, same routine,
        │   and (after create) issues created later than the new one
        │   down-weights: parent, children, siblings (kept eligible)
        ▼
 tier 2  Jev "same_outcome" predicate, one request per pair
        │   P >= 0.9  → likely duplicate
        │   P <= 0.3  → distinct
        │   between   → abstain ("uncertain")
        ▼
 result  candidates with scores + a recommendation
```

Tier 2 runs only when the company opted in. Any problem with tier 2 (no key, timeout, error, daily
cap) falls back to tier 1 for that pair and is reported as `degradedReason`. **Nothing here can block
or fail issue creation.**

## Turning it on

Per company, board only (`PATCH /api/companies/:companyId`, field `duplicateDetectionMode`):

| Mode | `similar` API | After-create check | Issue text leaves the instance |
|---|---|---|---|
| `off` (default) | tier 0 + 1 only | does not run | no |
| `suggest` | adds Jev scoring | scores and records the ledger | yes |
| `comment` | same as `suggest` | also posts one comment on the newer issue | yes |

Roll out in this order: `suggest` → label real pairs → run the calibration script → `comment` only if
precision at 0.9 is at least 0.9.

## API and CLI

```
POST /api/companies/:companyId/issues/similar          {title, description?, parentId?}
GET  /api/issues/:idOrIdentifier/duplicate-pairs
POST /api/companies/:companyId/issue-duplicate-pairs/:pairId/label   {label: "duplicate" | "keep_both"}
```

```sh
paperclipai issue similar -C <company-id> --title "..." [--description "..."] [--parent-id <id>]
paperclipai issue duplicate-pairs <issue-id-or-identifier>
paperclipai issue duplicate-label -C <company-id> <pair-id> duplicate|keep_both
```

Board and agent keys both work, always scoped to their company. `similar` response:

```json
{
  "mode": "suggest",
  "modelUsed": true,
  "degradedReason": null,
  "recommendation": "likely_duplicate",
  "candidates": [
    { "issueId": "…", "identifier": "ANT-1226", "title": "…", "status": "todo",
      "lexicalScore": 0.91, "sameOutcomeProbability": 0.96, "verdict": "likely_duplicate" }
  ]
}
```

`recommendation` is `create`, `review_candidates` or `likely_duplicate`. Agents should read the
candidates and comment on or link an existing issue instead of creating another when it is
`likely_duplicate`. Verdicts: `exact`, `likely_duplicate`, `uncertain`, `distinct`, `lexical_only`
(the model was not consulted).

## After-create check and the ledger

When `POST /api/companies/:companyId/issues` creates an issue, the response is sent first and the
check runs afterwards. It records every scored pair in `issue_duplicate_pairs`: both issue ids, the
lexical score, the Jev probability, the verdict, the model id Jev reported, a SHA-256 of the exact
input sent, and any later label. It stores **no issue text and no provider response**.

In `comment` mode, pairs that are `exact` or `likely_duplicate` and whose candidate is **older** get one
system comment on the new issue, listing the candidates and their ids for labelling. The comment is
claimed under a lock on the issue, and an issue gets at most one such comment ever, even if the check re-runs or the candidate changes in between. An `issue.duplicate_suspected`
activity entry is written with it. Labelling writes `issue.duplicate_labeled`.

## Calibration

Thresholds are hypotheses until measured. Export labelled pairs and run:

```sh
pnpm --filter @paperclipai/server calibrate:duplicates pairs.json [--tier1-only] [--out report.json]
```

`pairs.json` is `[{ "id"?, "a": {title, description?}, "b": {…}, "label": "duplicate" | "keep_both" | true | false }]`
(see `server/scripts/fixtures/duplicate-pairs.sample.json`; that file is synthetic and only shows the
format). The report lists precision and recall by threshold for tier 1 alone and for tier 1 + Jev, and
whether precision at the 0.9 comment threshold meets the 0.9 target. It runs the production cascade, so
prompts, truncation and abstain bands match. Use positives from confirmed duplicates and negatives from
random same-project pairs plus near-miss pairs (siblings, recurring issues); negatives that are too easy
inflate precision.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_API_KEY` | unset | Vercel AI Gateway key. Unset means tier 2 is off everywhere (fail open). |
| `PAPERCLIP_JUDGE_DAILY_CALL_CAP` | `5000` | Model calls per company per UTC day. `0` disables model calls. |
| `PAPERCLIP_JUDGE_TIMEOUT_MS` | `4000` | Hard timeout per model request. |
| `PAPERCLIP_JUDGE_ZERO_DATA_RETENTION` | `false` | `true` sends the gateway's `zeroDataRetention` option. Tested 2026-10-09 with the Paperclip gateway key: every request returned a gateway 500, so it was not usable and all checks fell back to tier 1. Leave it `false` unless the gateway team has zero-data-retention enabled for Jev, and re-test with the live smoke test first. |

The model is pinned to `typesafe-ai/jev` in code (`JUDGE_MODEL_ID`). There is no override.

## Cost

Jev costs $0.042 per 1M input tokens and nothing for output. A pair is an estimated 400 to 600 tokens
(two issues, descriptions cut to 1,500 characters) and a check scores at most five pairs, so a new issue
costs at most about $0.0001. A busy company creating 3,500 issues a week stays under a dollar a week.
The gateway logs real usage; check it after the first day. Identical inputs hit an in-memory cache (6 hours,
5,000 entries, keyed by company and input hash), so the pre-create and after-create checks of the same
draft share one answer. The daily cap is stored in `judge_usage_daily` and survives restarts.

## Privacy

This is a fourth data path, separate from telemetry, observability and the run log: **opt-in company
content sent to an external model provider** (Vercel AI Gateway, then TypeSafe).

- Off by default; a company must opt in.
- Per pair the request carries only: the new issue's title and description, and the candidate's title,
  description and status. Descriptions are redacted for secrets and cut to 1,500 characters. No ids,
  identifiers, names, comments, projects or attachments.
- The ledger keeps ids, scores and a hash, never text.
- Jev is stateless here (one request per pair, no prior turns), so there is no context to clear.

## Limits

- The after-create check runs for issues created through `POST /companies/:companyId/issues`. Issues made
  by routines, plugins, chat or imports are not checked, but the `similar` API works for any caller.
- `pg_trgm` treats letters by the database locale. On a UTF-8 locale accented letters count as letters; on a
  `C` locale they split words. Compare `SELECT datctype FROM pg_database WHERE datname = current_database()`
  with your expectations for non-English titles. The offline calibration mirrors UTF-8 behavior.
- Titles under three words in total are never sent to the model, since "Fix bug" is shared by unrelated work. Identical text counts as `exact` only with five or more words and when no description was cut at 1,500 characters; everything else identical still goes to the model.
- The after-create check runs through a small bounded queue (3 at a time, 100 waiting). If a bulk import overflows it, extra checks are skipped, not delayed. Re-run them with the `similar` API if needed.
- Existing issues are redacted and truncated the same way as the new one before they are sent.
- Only `same_outcome` is asked. Subset, superset and overlap relations are a later increment.
- Watchdog follow-ups of the same source are not excluded yet (routine-origin issues are).
- No UI yet: use the API, the CLI or the issue activity feed.

## Reuse

`server/src/services/judge-client.ts` is the shared decisions client: typed `predicate`, `choice` and
`score` questions with abstain, a content-hash cache, a per-company daily cap, a hard timeout and fail-open
results. The queue ranker's classification questions (kind, ready, irreversible, size) can use it without
changes.

## AI SDK call

Jev is an evaluation (decision) model. The client calls it through the AI SDK's `experimental_decide` with
`createGateway({ apiKey }).decisionModel("typesafe-ai/jev")`. `experimental_evaluate` is the deprecated alias of the same
function. See the [Vercel guide](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk) and the
[AI Gateway model docs](https://vercel.com/docs/ai-gateway/models-and-providers).
