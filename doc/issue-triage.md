# Issue triage

An unassigned `todo` issue waits for a person to notice it. Triage scores every new issue with the
Jev decision model and records a **suggested priority**, a **category** and a **suggested owner**. In
`apply` mode the router also fills the empty assignee, so the issue no longer waits.

It is built in, works the same for every company, and reuses the judge client of
[duplicate detection](duplicate-detection.md): the same company key, the same daily call cap and
timeout, the same answer cache.

## What it does and does not do

| It does | It never does |
|---|---|
| Record a suggested priority, a category and a suggested owner for each new issue, with the probabilities behind them | Change a priority (a suggestion in this version) |
| In `apply` mode, set the assignee of an **unassigned `todo`** issue when the top owner is confident | Reassign an issue, or touch one that has an assignee (an agent or a person) |
| Skip routine-made issues, hidden issues and issues that are already closed | Block, delay or fail the create of an issue |
| Pick owners only from the company's own agents that are not paused, not terminated and not awaiting approval | Read or send anything about another company |

## How a triage runs

```
 new issue (any create path)
        │  after the create returns, through a small bounded queue
        ▼
 rules   company mode off ............................... nothing happens
 first   routine-made, hidden or closed issue ........... no record, values kept
         title under three words ........................ record "skipped", no model call
         no company key ................................. record "degraded" (no_key)
        │
        ▼
 ask     category                       (always)
         priority                       (only when it is still the default "medium")
         owner                          (only when the issue has no assignee)
         one choice question each; owner options are the company's agents,
         grouped by role and title, ten per call, plus a "none" option
        │   at most 6 model calls for one issue
        ▼
 record  one row in issue_triages + one "issue.triage_recorded" activity entry
        │
        ▼ (apply mode, status todo, nobody assigned, top owner confident)
 assign  the assignee is set under the issue lock, the agent is woken,
         "issue.triage_assigned" is logged
```

- **An explicit value is kept.** An issue with an assignee is never asked about its owner. A priority
  other than `medium` counts as explicit and is not asked about; `medium` is the default and cannot be
  told from a chosen `medium`, so it still gets a suggestion. The suggestion never changes the issue.
- **Agents with the same role and title are one option.** The model sees only role and title, so it
  could not tell them apart. The group resolves to its least busy agent (fewest open issues), then the
  lowest id.
- **Large companies.** Options are ranked by how many words of the issue appear in the role and title
  and sent ten per call. More than 60 groups are cut after ranking. This keeps the calls at six or
  fewer.
- **Failures degrade, never fail.** A missing key, a spent daily cap, a timeout or an error records
  `degraded` with the reason and changes nothing on the issue.

## Thresholds

The router assigns only when **all** hold:

| Check | Value |
|---|---|
| The issue is an unassigned `todo` (read again under the issue lock) | required |
| Top owner probability | at least **0.8** |
| Lead over the next option (another agent, or "none" on the same page) | at least **0.2** |
| The top owner beats the "none" option | required |
| The agent can still take work (not paused, terminated or awaiting approval) | required |

If the issue has more than ten owner groups, the options of each call sum to about one within that
call only. The best group over all calls is the top, and the next option is the best other group of
any call or the "none" option of the top's own call. A weak or split answer is recorded and not applied.

These values are hypotheses until measured. Every record keeps the model id, the probabilities and the
outcome (`applyOutcome`), so a later calibration can tune them from real data:

| `applyOutcome` | Meaning |
|---|---|
| `applied` | The router set the assignee |
| `suggest_mode` | The owner was confident, but the company is in `suggest` mode |
| `below_threshold`, `narrow_margin` | Near misses: the top was under 0.8, or led the next by under 0.2 |
| `none_preferred` | The model preferred "no listed role fits" |
| `no_suggestion`, `no_probabilities` | No candidate agents, or the model gave no probabilities |
| `not_unassigned_todo` | The issue was not an unassigned `todo` when the router looked (for example `backlog`) |
| `owner_unavailable` | The agent was paused or removed in the meantime |
| `not_requested` | The issue already had an assignee, so owner was not asked |

When the company evals feature lands, the triage questions move onto a company eval. There is no
second ledger before then.

## Turning it on

Per company, board only: `PATCH /api/companies/:companyId`, field `issueTriageMode`.

| Mode | Issue text leaves the instance | Effect |
|---|---|---|
| `off` (default) | no | Nothing runs. |
| `suggest` | yes | Each new issue gets a recorded triage. Nothing on the issue changes. |
| `apply` | yes | As `suggest`, plus the router fills the empty assignee of an unassigned `todo`. |

```sh
paperclipai company update <company-id> --issue-triage-mode suggest
```

The company also needs its own gateway key: the company secret `AI_GATEWAY_API_KEY`, the same one
duplicate detection uses. There is no server-wide key. A company in `suggest` or `apply` mode without
the secret gets a `degraded` record with reason `no_key` for each issue, and nothing is sent. Deleting
or replacing the secret takes effect within about 30 seconds.

**Before turning a company on, get an informed opt-in.** `suggest` and `apply` send each new issue's
title and description (and the role and title of the company's agents) to the AI Gateway and on to the
Jev model provider. Secret-like text is redacted and descriptions are cut to 1,500 characters;
**names, email addresses, customer details and other personal data in issue text are sent as
written.** The company's owner should agree to that knowingly, and the operator should confirm the
provider's retention settings first (see [duplicate detection](duplicate-detection.md#privacy)).

Roll out in this order:

1. Informed opt-in and retention confirmed.
2. `suggest`. Read the records on real issues for a few days (`paperclipai issue triage`).
3. Label a handful of issues: did the suggested owner match who really did the work?
4. `apply`, only when the near misses and the confident picks look right.

## API and CLI

```
GET  /api/issues/:idOrIdentifier/triage
PATCH /api/companies/:companyId        {"issueTriageMode": "off" | "suggest" | "apply"}
```

```sh
paperclipai issue triage <issue-id-or-identifier>
paperclipai company update <company-id> --issue-triage-mode off|suggest|apply
```

Board and agent keys both work, always scoped to their company. The read returns 404 when no triage
was recorded (mode off, a routine-made issue, or the check has not run yet). Response:

```json
{
  "issueId": "…",
  "status": "scored",
  "reason": null,
  "mode": "suggest",
  "suggestedPriority": "high",
  "category": "bug",
  "suggestedAssigneeAgentId": "…",
  "probabilities": {
    "priority": { "critical": 0.05, "high": 0.7, "medium": 0.2, "low": 0.05 },
    "category": { "bug": 0.9, "feature": 0.02 },
    "owner": [
      { "agentId": "…", "role": "engineer", "title": "Backend Engineer", "probability": 0.86, "groupSize": 2 },
      { "agentId": null, "role": "none", "title": null, "probability": 0.04, "groupSize": 0 }
    ]
  },
  "applyOutcome": "suggest_mode",
  "appliedAt": null,
  "modelId": "…",
  "inputHashes": ["…"],
  "modelCalls": 1
}
```

Agents: read the triage before you re-route an issue (the `paperclip` skill says so). An owner or
priority that was not applied is a hint, not an instruction.

## Data path

This is the same fourth data path as duplicate detection (opt-in company content sent to an external
model provider), separate from telemetry, observability and the run log.

- Per call the request carries the issue's title and description (redacted, cut to 1,500 characters)
  and the role and title of the candidate agents. No ids, identifiers, agent names, comments, projects
  or attachments.
- `issue_triages` keeps ids, the suggested values, the probabilities, the agents' roles and titles as
  sent, the model id and a SHA-256 per call. It never stores issue text or a provider response.
- Jev is stateless here: one request per call, no prior turns.

## Settings

Shared with duplicate detection:

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_JUDGE_DAILY_CALL_CAP` | `5000` | Model calls per company per UTC day, counted across triage and duplicate detection. `0` disables model calls. |
| `PAPERCLIP_JUDGE_TIMEOUT_MS` | `4000` | Hard timeout per model request. |
| `PAPERCLIP_JUDGE_ZERO_DATA_RETENTION` | `false` | See duplicate detection. |

The model is pinned to `typesafe-ai/jev` in code. There is no override.

## Cost

Jev costs $0.042 per 1M input tokens and nothing for output. A call is an estimated 600 to 1,200 tokens,
and most issues need one call. A busy company creating 3,500 issues a week stays under a dollar a week.
Identical inputs hit the shared in-memory cache (6 hours, 5,000 entries). Each call counts against the
daily cap.

## Limits

- The check runs after the create returns, through a bounded queue (3 at a time, 100 waiting). If a bulk
  import overflows it, extra checks are skipped, not delayed.
- An issue created inside a transaction that is still open is retried at 1, 5 and 20 seconds until it is
  visible, then dropped.
- Triage runs once per issue. An edit, a status change or a later assignment does not trigger it again.
- Paths that write issues without the issue service (company import, history merge, case conversations)
  are not triaged, as with duplicate detection.
- Priority is a suggestion only in this version.

## Code map

- `server/src/modules/issue-triage/`: `domain/` (rules, candidate grouping, questions, thresholds),
  `application/` (the use case and its ports), `adapters/` (Postgres, the judge client, the guarded
  assignment), `index.ts`.
- `server/src/services/issue-triage-factory.ts`: wires the module to the shared judge path and the
  bounded queue.
- `server/src/routes/issue-triage.ts`: `GET /issues/:id/triage`.
- `packages/db/src/schema/issue_triages.ts`: the record; one row per issue, `company_id` on every row,
  no triggers or sequences.
