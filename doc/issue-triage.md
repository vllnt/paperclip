# Issue triage

A new issue that nobody sorts waits. An unassigned `todo` issue is never picked up, and every issue needs
a priority and an owner that someone has to choose. This feature scores each new issue with the Jev
decision model: it suggests a **priority**, a short **category** and an **owner**, and records the
probabilities behind each. In `apply` mode the router also fills the empty assignee of an unassigned
`todo` issue, so that issue no longer waits for a person.

It reuses the judge client that duplicate detection uses (see [duplicate-detection.md](duplicate-detection.md)):
the same company secret `AI_GATEWAY_API_KEY`, the same daily call cap (`PAPERCLIP_JUDGE_DAILY_CALL_CAP`),
the same timeout (`PAPERCLIP_JUDGE_TIMEOUT_MS`) and the same kind of answer cache (its own in-memory
instance, keyed by the exact input). It adds no table. Nothing here
can block or fail issue creation.

## What it does

```
 new issue (any create path)
        │
        ▼
 company mode: off ─► stop
        │
        ▼
 rules, no model call
   routine-created issue ........ recorded as "skipped"
   title under three words ...... recorded as "skipped"
   explicit assignee ............ owner is not asked
   non-default priority ......... priority is not asked
        │
        ▼
 one Jev request, three choice questions
   category   bug | feature | chore | docs | research | ops | question
   priority   critical | high | medium | low
   owner      one of this company's agents, or "none"
        │
        ▼
 record one "issue.triaged" activity entry
        │
        ▼ (apply mode only)
 unassigned todo, top owner >= 0.8, beats the next by >= 0.2
        └─► set the assignee, wake that agent
```

Priority is a **suggestion in v1**. The router never changes it.

## Modes

Per company, board only (`PATCH /api/companies/:companyId`, field `issueTriageMode`):

| Mode | Model call | Records the triage | Changes the issue | Issue text leaves the instance |
|---|---|---|---|---|
| `off` (default) | no | no | no | no |
| `suggest` | yes | yes | no | yes |
| `apply` | yes | yes | fills an empty assignee of a `todo` issue | yes |

A company also needs its own gateway key: a company secret named `AI_GATEWAY_API_KEY`. Without it, or
when the daily cap is spent, the check records one `degraded` triage per issue (reason `no_key` or
`cap_exceeded`) and changes nothing. A timeout or gateway error records `degraded` with reason `timeout`
or `error`.

## Rules that run first

These need no model call and always win over the model:

- An issue created by a routine run keeps its values (`skipped`, reason `routine_origin`).
- A title under three words is not sent (`skipped`, reason `short_title`).
- An issue with an agent or user assignee is not asked for an owner, and `apply` never reassigns it.
- An issue with a priority other than the default (`medium`) is not asked for a priority.
- Candidate owners come only from the issue's own company, and only agents that can be woken: not
  paused, not terminated, not pending approval, with a valid reporting chain.
- At most 12 candidates are offered per issue. A company with more agents gets the 12 whose name, role,
  title and capabilities share the most words with the issue; the choice is deterministic.

## Model calls

One request carries every question, so a normal triage is **one model call**. A hard ceiling of **6
model calls per issue** is enforced in code, so a future question cannot make the cost grow without
bound. Each request counts once against the company's daily call cap. An answer that is already cached
counts as no call (`modelCalls: 0` in the record).

## When `apply` assigns

All of these must hold, checked in this order. The first one that fails is recorded as the decision:

1. The company is in `apply` mode (`mode_suggest` otherwise).
2. The model named an agent, not `none` (`no_owner_suggested`).
3. The issue status is `todo` (`not_todo`).
4. The model returned probabilities (`no_probabilities`).
5. The top probability is at least **0.8** (`below_probability`).
6. It beats the next probability, `none` included, by at least **0.2** (`below_margin`).
7. The write wins: it is one conditional update that sets the assignee only while the issue is still an
   unassigned `todo` (`assignee_changed` if a person or agent got there first), and the agent is still
   assignable (`not_assignable`).

On success the router bumps the issue's status version, writes an `issue.updated` activity entry
(`source: "issue_triage"`) and wakes the new assignee with the normal assignment wake. It never reassigns
an issue and never touches priority, status, labels or comments.

## What is recorded

One `issue.triaged` activity entry per issue (a second check on the same issue is a no-op). Its details
hold the full record, so a later calibration can tune the thresholds:

| Field | Meaning |
|---|---|
| `outcome` | `suggested`, `applied`, `skipped` or `degraded` |
| `reason` | why it was skipped or degraded, else `null` |
| `mode` | the company mode when it ran |
| `modelId`, `modelCalls`, `inputHashes` | the model Jev reported, how many calls were made, a SHA-256 of each input sent |
| `thresholds` | the owner thresholds in force (0.8 and 0.2) |
| `priority` | `current`, `suggested` and the probability of each level |
| `category` | `suggested` and the probability of each category |
| `owner` | `suggestedAgentId`, `suggestedAgentName`, the probability of each candidate agent id and of `none`, `topProbability`, `margin`, `decision`, `appliedAgentId`, `candidateCount` |

The record holds **no issue text and no provider response**. Agent names are stored so the record stays
readable after an agent is renamed.

## API and CLI

```
GET /api/issues/:idOrIdentifier/triage?limit=20&cursor=<opaque>
PATCH /api/companies/:companyId        {"issueTriageMode": "off" | "suggest" | "apply"}
```

```sh
paperclipai issue triage <issue-id-or-identifier> [--limit 20] [--cursor <cursor>] [--json]
paperclipai company update <company-id> --issue-triage-mode suggest
```

The read route returns `{ "items": [...], "nextCursor": "..." | null }`, newest first. The cursor is
opaque; pass `nextCursor` back as `cursor`. Board and agent keys both work, always scoped to their
company; another company's issue answers 404 exactly like a missing one.

**Agents:** read the triage before you re-route an issue. If a triage shows `applied`, the router chose
you with the probabilities recorded; if the issue is not yours to do, comment with the reason and hand
it back rather than silently reassigning.

## Data path and privacy

`suggest` and `apply` send each new issue's title and description to Vercel AI Gateway and on to the Jev
provider, together with the name, role, title and capabilities of up to 12 candidate agents. The same
preparation as duplicate detection applies: secret-like text (tokens, keys, credentials) is redacted and
the description is cut to 1,500 characters. **Names, email addresses, customer details and other personal
data in issue text are sent as written.** Get an informed opt-in from the company's owner and confirm the
provider's retention settings before turning a company on (see the same section in
[duplicate-detection.md](duplicate-detection.md)).

## Rollout

1. Informed opt-in, retention confirmed, and the `AI_GATEWAY_API_KEY` company secret in place.
2. Set `issueTriageMode` to `suggest` on one company.
3. Create a few real issues and read `paperclipai issue triage`. Compare each suggested owner with who
   actually did the work; the recorded probabilities show where the thresholds sit.
4. Only then set `apply`. Keep watching `owner.decision` for `assignee_changed` and `below_margin`.

To stop, set the mode back to `off`; issues already assigned stay assigned.

## Later

When company evals land, the triage questions move onto a company eval so thresholds can be tuned against
labelled outcomes. Until then the activity entries are the only record; there is no second ledger.
