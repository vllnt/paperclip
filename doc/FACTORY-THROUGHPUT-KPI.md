# Factory throughput KPI

`scripts/factory-throughput-kpi.mjs` measures how many pull requests an agent factory merges per hour, and checks that the speed did not cost quality. It reads GitHub (through `gh`) and, if you ask, the Paperclip dashboard. The only thing it ever writes is the state of its own gate (a local file or one Paperclip issue document), and only in gate mode.

The script needs Node 20 or later. It has no dependencies.

> **Status.** The tests use a fake `gh` and a fake Paperclip API. The script has not run against live GitHub yet. Check the first live run against the numbers in the GitHub UI before you rely on it (see [First live run](#first-live-run)).

## What it reports

| Section | Meaning |
| --- | --- |
| `merges` | PRs merged into each repository's default branch in the last 1 h, 6 h and 24 h, and the rolling 6 h minimum (per hour). |
| `sustained` | How many consecutive 24 h days had a rolling 6 h minimum at or above the target (default 6 per hour, 3 days). `DONE yes` needs every day. |
| `shape 24h` | Median and p90 PR size, share of tiny PRs (10 lines or fewer), median open-to-merge time. Use it to spot a rate that rises because PRs get trivial. |
| `guard` | For each merge in the guard window: were all required checks green, and were the required approvals given by someone other than the author, **at the moment of the merge**. |
| `revert+hotfix 7d` | Share of reverts and hotfixes among the merges of the last 7 days, compared with a baseline. |
| `open PRs` | Open PRs by state: `draft`, `conflicts`, `ci_failing`, `ci_pending`, `changes_requested`, `waiting_review`, `ready`. Also the longest wait for a first review. |
| `review 24h` | Time from ready-for-review to the first review by someone else (p50, p90), and the merges that had no such review. |
| `agents` | Idle, running, paused and error agents, and task counts, from the Paperclip dashboard (`--agents`). |

The `open PRs`, `review`, and `agents` sections explain the number. They never change `DONE`.

### Definitions

- A window is half-open: `(end - length, end]`. A PR merged exactly at the start is outside.
- The rolling 6 h minimum is exact. The count in a 6 h window only changes when a merge enters it or leaves it, so the script looks at the first window, the last window, and the instant each merge leaves. It does not sample.
- Day `i` of `sustained` (0 is the newest) meets the target when **every** 6 h window inside the newest `i + 1` days has at least `target * 6` merges. A quiet stretch that crosses midnight counts against both days. `consecutive` is the number of days from the newest that meet it; `DONE yes` needs all `--sustain-days`.
- A repository that cannot be read, or whose history is cut by the page cap, makes the counts lower bounds. A lower bound that already meets the target stays `yes`. A miss becomes `unknown`, not `no`.
- A revert is a title that starts with `Revert "`, `revert:` or `revert(scope):`, a branch named `revert-<number>-…` (what GitHub's Revert button creates) or `revert/…`, or a `revert` label. A hotfix is a title `hotfix:`/`hotfix(scope):`, a branch `hotfix-…` or `hotfix/…`, or a `hotfix` label. A plain `fix:` is not a hotfix, and neither is a branch such as `revert-button`.
- The revert and hotfix share is a regression when it is above both twice the baseline share and the baseline plus 5 points. Below 30 merges or 3 events in the last 7 days the state is `insufficient_data` and the counts are still printed.
- The baseline is `--baseline EVENTS/TOTAL` (for example `2/39`), or it is computed from the 7 days that end at `--baseline-at`. A baseline with fewer than 30 merges, or with more than half of them reverts and hotfixes, cannot detect anything. It is reported as `no_baseline`, and `DONE` is then `unknown`.

### The guard has four answers

`pass`, `fail`, `unenforced`, `unknown`. Only `pass` lets the KPI be done.

- `fail`: a merge had a failing or missing required check, or too few approvals, when it was merged.
- `unenforced`: the base branch has no required checks and no required approvals. The script cannot prove that nobody bypassed anything. It still prints how many merges had a failing check.
- `unknown`: anything the script could not read or model:
  - the rules could not be read, or were read only in part (one source failed, a full page of 100 rules, or a rule type the script does not evaluate: `workflows`, `required_deployments`, `code_scanning`);
  - the repository uses a merge queue;
  - a PR has more checks than the script reads (100), or more reviews (50) when approvals are required;
  - merges are still waiting for a detail fetch (see `--detail-budget`);
  - the list of merged PRs of a repository was cut short, a repository could not be read, or no repository was given.
- `DONE` is `unknown` whenever the collection is incomplete, even if the repositories that were read are clean.

Approvals follow GitHub's rule: each reviewer's **latest** decision counts (`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`), comments change nothing, the author's own approval and an approval after the merge do not count.

If the required checks change between two runs, merges from before that moment that were not judged yet are `unknown` ("required checks changed after this merge"). The script cannot know which rules applied at the time, and it does not hold old merges to rules that did not exist. This lasts until those merges leave the guard window.

The script cannot see an administrator who clicked "merge without waiting". It sees the effect: a merge with a missing or failing required check. Rule-suite evidence needs an administrator token and is not part of this script.

## Usage

```sh
node scripts/factory-throughput-kpi.mjs --repos owner/a,owner/b --baseline 2/39
node scripts/factory-throughput-kpi.mjs --repos owner/a --line       # one line
node scripts/factory-throughput-kpi.mjs --repos owner/a --json       # aggregates only
node scripts/factory-throughput-kpi.mjs --discover-org owner --agents
```

Repositories can also come from `FACTORY_KPI_REPOS`. They are listed once each, whatever the letter case. `--discover-org` adds every unarchived repository of the organization with a push inside the window, up to 1,000 repositories; a longer listing makes the run incomplete.

| Option | Default | Meaning |
| --- | --- | --- |
| `--repos A,B` | `FACTORY_KPI_REPOS` | Repositories as `owner/name`. |
| `--discover-org ORG` | off | Add the active repositories of an organization. |
| `--target N` | 6 | Merges per hour. |
| `--sustain-days N` | 3 | Days that must meet the target. Whole number, at least 1. |
| `--guard-days N` | `--sustain-days` | Window for the guard. Whole number. It is never shorter than `--sustain-days`. |
| `--baseline E/T` | `FACTORY_KPI_BASELINE` | Revert and hotfix baseline. |
| `--baseline-at TIME` | `FACTORY_KPI_BASELINE_AT` | Compute the baseline from the 7 days that end at this time. |
| `--detail-budget N` | 120 | Most merges to fetch checks for in one run, shared equally between repositories, newest first. The rest are shown as "not fetched yet". |
| `--no-guard`, `--no-support` | off | Skip the guard, or the open PR and review sections. |
| `--agents` | off | Read the Paperclip dashboard. Needs `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID`. |
| `--now TIME` | the clock | Evaluate at a fixed time. Not allowed with `--gate`. |
| `--json` | off | Aggregates only, no per-PR rows. |
| `--line` | off | One line. |
| `--help` | | Usage. Needs no repository. |
| `--gate` and its options | off | See [Gate mode](#gate-mode-silent-unless-something-changed). |

`TIME` is an ISO date (`2026-10-18`) or a timestamp with a zone (`2026-10-18T12:00:00Z`, `2026-10-18T14:00:00+02:00`). A timestamp without a zone is refused: it would be read in the local time of the runner.

Environment: `FACTORY_KPI_REPOS`, `FACTORY_KPI_BASELINE`, `FACTORY_KPI_BASELINE_AT`, `FACTORY_KPI_STATE_FILE`, `FACTORY_KPI_STATE_ISSUE`, and `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`. An option wins over its variable.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Report printed. In gate mode: nothing to say. |
| `10` | Gate mode only: there is a line to post. |
| `20` | Report printed, but the collection was incomplete or the guard could not be verified. |
| `2` | Usage error. The reason is on stderr. |
| `1` | Unexpected failure. The reason is on stderr. In gate mode an unexpected failure inside the gate is a printed line and exit `10`, so a broken gate is not mistaken for a quiet one. |

## Gate mode: silent unless something changed

```sh
node scripts/factory-throughput-kpi.mjs --gate --state-issue ISSUE_ID --repos owner/a,owner/b --baseline 2/39
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--gate` | off | Print nothing and exit `0` unless something changed. |
| `--state-file FILE` | `FACTORY_KPI_STATE_FILE` | Keep the state in a local file. |
| `--state-issue ID` | `FACTORY_KPI_STATE_ISSUE` | Keep the state in an issue document (`PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`). |
| `--state-key KEY` | `kpi-state` | Document key. It must start with `kpi-`, so the gate cannot overwrite another document such as `plan`. |
| `--heartbeat-hours N` | 4 | Speak at least this often. |
| `--rate-step N` | 1 | Merges per hour of movement that is worth a line. |

The gate prints nothing and exits `0` when nothing worth a line changed. Otherwise it prints one KPI line, the reasons, and the facts to act on, and exits `10`.

The gate speaks when:

- the verdict (`DONE`), the guard state, or the revert and hotfix state changed;
- there is a new violation;
- the 24 h rate or the rolling 6 h minimum moved by `--rate-step` or more since the last line;
- the number of sustained days changed;
- the collection has been incomplete in two runs in a row (one failed read is a blip), or it is complete again;
- the options changed, so the numbers mean something else (`configuration changed`);
- the saved time is ahead of the clock;
- `--heartbeat-hours` passed since the last line;
- the state is unreadable or could not be saved, or the gate itself failed (`gate failed: …`).

While a read is incomplete the numbers are lower bounds. Only definite facts are compared then (a new violation, a failed guard, a regression), and the last complete numbers stay as the reference.

The gate compares with the last line it printed, not with the last run. A slow drift therefore cannot hide. A gate run does not read open PRs or agents: its line never shows them.

### State

The state holds the last printed numbers, a count of incomplete runs, and the per-PR guard verdicts. Entries that do not look like ones the gate wrote are dropped. A malformed "last printed" record makes the whole state unreadable, and the gate speaks and says why.

- A silent run writes the state only when that saves work next time (merges not judged yet because of the budget) or when the count of incomplete runs changed. It never touches the "last printed" record.
- A silent run that cannot write is not silent: it says `state not saved`. A gate that cannot remember is not healthy.
- `--state-file` writes through a temporary file with a random name and mode `0600`.
- `--state-issue` needs the Paperclip credentials, uses `PUT /api/issues/{id}/documents/{key}` with the revision it read, and does not follow redirects. `PAPERCLIP_API_URL` must be an http(s) address without credentials; a trailing `/api` is ignored.
- Keep the state in an issue document when runs happen in fresh workspaces. Do not put it on an issue that humans edit by hand.

## Routine

Run the gate command every 30 minutes at an off-minute (for example `7,37 * * * *`), with the "skip if active" concurrency policy. Step 0 of the routine is the gate command itself.

| Exit code | What the routine does |
| --- | --- |
| `0` | Silent. Set the issue to done with no comment. |
| `10` | Post the **whole** output as one comment: the first line is the KPI line, the rest is why and what to act on. |
| `1` or `2` | The routine is misconfigured or the script broke. Post stderr as a comment and set the issue to blocked. |

Do not add an "external activity" gate to the routine. Merges on GitHub are not Paperclip activity, so the routine's activity gate policy must be `always`.

Requirements for the runner:

- Node 20 or later, `gh`, and network access to `api.github.com`.
- A read-only GitHub token in `GH_TOKEN` (or `gh auth login`). See [Token permissions](#token-permissions).
- For `--state-issue`: the routine's own `PAPERCLIP_API_URL`/`PAPERCLIP_API_KEY`, which can write documents on the state issue. Use a dedicated issue for the state, for example the routine's own issue.

The script strips `PAPERCLIP_*` and `*_API_KEY` from the environment it gives to `gh`, and `GH_DEBUG`/`DEBUG`. The GitHub token reaches `gh` only through `GH_TOKEN`/`GITHUB_TOKEN` or `gh`'s own login.

## Token permissions

These are the permissions each feature needs. They follow GitHub's documentation and have not been checked against a live token yet.

| Feature | GitHub permission (fine-grained token) |
| --- | --- |
| Merged and open PRs, reviews | Pull requests: read |
| Checks and statuses on the head commit | Checks: read, Commit statuses: read |
| Rulesets that apply to a branch | Metadata: read |
| Classic branch protection | Administration: read |
| `--discover-org` | Metadata: read on the organization's repositories |

Reports from users (not verified against a live token) say that a fine-grained personal access token cannot read check runs through GraphQL, so every merge would stay `unknown`. If that happens, use the installation token of a GitHub App with the permissions above (read-only) instead of a personal token. Do not use a token that can write.

Without a permission the script does not guess. A repository whose classic protection cannot be read (HTTP 403) and that has no readable ruleset is `unknown`. A repository with readable rulesets but unreadable classic protection is judged `unknown` too, with the reason "enforcement only partly readable": the protection might require checks the script cannot see. A violation it did see stays a violation.

## First live run

1. Run `--repos owner/a` without `--gate`. Compare `merges 1h / 6h / 24h` with the merged-PR list in the GitHub UI.
2. Pick one merge and confirm that the guard line agrees with its checks on the PR page.
3. Look at the `guard` lines for `unknown` and read their reasons. Fix the token permissions, not the script.
4. Run the revert and hotfix section without a baseline, read the counts, and pin `--baseline EVENTS/TOTAL` from them.
5. Start the routine.

## Cost and limits

- Each run costs about one GraphQL request per 100 merged PRs per repository (at most 40 pages, then the repository is marked as cut short), two REST calls per repository for the rules, one GraphQL request per 15 uncached merges (at most `--detail-budget`), and one request for open PRs (at most 10 pages). At most 4 repositories are read at once. Verdicts are cached by `repo#number`, so a merged PR is fetched once.
- The script only sends GET requests and GraphQL queries. It refuses mutations, refuses unknown REST paths, validates organization and repository names, and removes tokens, JWTs, URL credentials and the exact values of credential variables from every message it prints. Text from outside (repository names, API errors) is flattened to one line and capped at 300 characters before it is printed.
- Checks with the same name from different apps are not told apart. Approvals by people without write access are not told apart from approvals that count.
- Open PRs: the decision is GitHub's `reviewDecision` when the branch requires reviews; otherwise the latest decision of each reviewer in the last 30 reviews. `mergeable` is computed lazily by GitHub, so a PR may show as not conflicting before GitHub has looked. The number of such PRs is printed.
- Queued and deferred wakes are not readable with an agent token. The report says so. They move to the dashboard in a separate change.
- CI duration p50 and p95 are not part of this script yet.

## Tests

```sh
pnpm test:factory-throughput-kpi
```

The tests use a fake `gh`, a stub `gh` binary for the child-process path, and a fake Paperclip API. They never touch the network. They are not wired into CI yet.
