# Context budget: a bounded thread window on wake

Status: design, 2026-10-20. Three pull requests: (A) the window, (B) replay limits per issue, agent, company and instance, (C) a warning when the replay nears the model context.

## Problem

On a fresh session, the wake of an issue's assignee carries the whole issue thread. `buildExecutionContinuation` (`server/src/services/execution-continuation.ts`) reads every comment of the issue. It puts each full body into `executionContinuation.messages`, and the adapters render that list as JSON in the prompt. Nothing caps it.

- A thread grows with each comment, so a long-lived issue eventually makes a prompt that is larger than the model context. On one busy instance, every wake of such an issue now fails with "Prompt is too long (~1.04M tokens, limit 1M)".
- The prompt stays in the context for every model call of the run, so its cost repeats on each call. On that instance, the median run uses 1.68M tokens over 18 calls, and the thread replay is about 36% of the tokens.
- The run's `context_snapshot` stores the same full list in the database for each run.

The existing run-context policy (company, agent, routine, wake type) caps only the new comments of one wake. It does not cap the history.

## Measured baseline (read-only, one production company, runs from 2026-10-17 to 2026-10-20)

Method: 87 successful `claude_local` runs (every third run with usage, from 257). For each run we used the run log (Claude stream JSON), the `adapter.invoke` prompt metrics, and the comment sizes of the issue. Tokens per character are fitted from the first model call's context against the prompt characters over the 86 fresh runs: 0.46 tokens per character (2.17 characters per token; the prompt is mostly JSON). A thread read stays in the context for every later call. So its replay cost is its size times the number of calls after it.

| Measure | Value |
|---|---|
| Tokens per run (input + cache read + output), median / p90 | 2.55M / 13.3M (291 runs with usage) |
| Model calls per run, median | 22 |
| Fresh sessions with the full history in the prompt | 86 of 87 |
| Thread tokens in a fresh prompt, median / p90 / max | 2.7K / 16K / 135K |
| Thread replay from the prompt (server side), share of all context tokens | 11.4% |
| Thread replay from agent reads (comments, documents, heartbeat context), share | 9.1% |
| Total replay share: whole sample / median run / p90 run | 20.5% / 5.9% / 34% |
| Runs on threads with 100 or more comments | replay is 37% to 45% of the run |

Example: a 134-comment thread makes a 296,000-character wake prompt. The first model call is 187K tokens, where the median is 48K.

## Design

### (A) The bounded window

All of the change is in `buildExecutionContinuation` and the shared renderer. It does not touch `server/src/services/heartbeat.ts`.

- **Pinned messages.** The window always holds the comments that woke the run (`originCommentIds`) and the latest human request (the objective). Each is cut at 16,000 characters.
- **Newest comments.** Then come the newest other comments, up to 20, each cut at 4,000 characters, until all message bodies reach 48,000 characters. A cut body ends with `[truncated: N more characters; read comment <id>]`.
- **Older comments.** Each older comment gets an entry in `olderMessages`: id, author type, author id, created time, length and a 120-character one-line preview. At most 50 entries are kept (the newest of the older comments). After that, the window holds only a count.
- **Documents.** `documents` is an index of the issue documents: key, title, revision, updated time and length. The plan body in the task brief is cut at 32,000 characters, with a pointer to its revision in `GET /api/issues/{id}/documents/plan/revisions` (the brief can carry an approved revision that is not the latest).
- **Objective and summary.** The objective and `completedWork` are cut at 16,000 characters each.
- **Coverage.** `coverage.kind` is `bounded_task_history` when something was left out, with the counts and `oldestIncludedCommentId`. A thread that fits stays `full_task_history`, so it is unchanged.
- **Final guard.** If the serialized envelope is still above 160,000 characters (about 74K tokens), the guard removes content until it fits:
  1. index entries
  2. the oldest unpinned messages
  3. the oldest completed actions and interaction outcomes (the outcome of the triggering interaction stays; human responses are never removed)
  4. as a last step, it cuts the summary, the pinned messages and the objective to 2,000 characters

  So the history part of a wake cannot overflow a 200K context.
- **Resumed sessions.** A resumed session gets `resumeDelta`: the messages of the window that the previous run did not deliver. So a resumed wake stays a delta, as it is today.
- **Prompt text.** The renderer replaces "History is complete" with a bounded-window note. The note tells the agent how to read older comments only when it needs them:
  - one comment: `GET /api/issues/{id}/comments/{commentId}`, or `paperclipai issue comment:get`
  - older pages: `GET /api/issues/{id}/comments?order=desc&after={oldestIncludedCommentId}&limit=20`, or `paperclipai issue comments --order desc --after-comment-id … --limit 20`
- **Skill.** `skills/paperclip/SKILL.md` says the same. It also says: never fetch the full thread without `limit`.

The shipped `applyContinuationWindow` over the 86 fresh runs of the sample:

- Each envelope is rebuilt from the comment metadata of its issue: real ids, authors and body lengths, with each run's wake comments pinned.
- The thread share of the prompt falls from 11.1% to 4.7% of all context tokens. That saves 6.4% of the tokens of the whole sample.
- Of the 86 runs, 28 get a smaller history.
- The largest envelope falls from 128K to 32K tokens (−75%). On the busy instance, the ~1.04M-token prompt is bounded by the 160,000-character guard, about 74K tokens.
- Other defaults tried in an earlier simulation:

| Window | Thread share after | Largest window |
|---|---|---|
| last 10, 24K characters | 3.2% | 17K tokens |
| last 30, 64K characters | 5.6% | 40K tokens |
| last 50, 120K characters | 7.9% | 64K tokens |

The agent-side reads (9.1%) fall only if agents stop reading the full thread. The prompt note and the skill change ask them to stop.

### (B) Replay limits (issue, then agent, then company, then the instance default)

- Extend the existing run-context policy (`packages/shared/src/run-context.ts`) with a `threadWindow` group: `maxComments`, `maxCommentChars`, `maxTotalChars`, `maxIndexEntries`. The schema bounds each value. The final 160,000-character guard stays fixed.
- **Levels**, from least to most specific: instance default (`instance_settings.general.runContext`), company (`companies.run_context_policy`), agent (`runtimeConfig.runContext`), routine (existing), issue (new nullable `issues.run_context_policy` jsonb; one migration). The most specific set field wins. The brief's order (issue, agent, company, instance) holds, and the routine level keeps its place below the issue.
- **Surfaces:**
  - REST: `PATCH /api/issues/:id` takes `runContextPolicy`, and the instance general settings take `runContext`. Both are in OpenAPI.
  - CLI: `paperclipai issue update --run-context-policy <json|->`, and the existing `paperclipai instance settings:general:update` for the instance. The company and agent commands already take the policy.
  - Web: the existing `RunContextPolicyEditor` on the issue properties and on the instance settings page.
- Setting it needs the same access as editing the issue, the agent or the company. An instance setting needs an instance admin. Each change writes an activity log entry.

### (C) Warning near the model context

- `GET /api/issues/:id/replay-budget` (also `paperclipai issue replay-budget`) estimates two sizes: the full thread, and the bounded replay that a fresh wake of the assignee would get. It uses 0.46 tokens per character, and it says that the numbers are estimates. It also returns the resolved limits and the model context limit.
- The model context limit is the setting `contextLimitTokens` in the same policy. The default is 200,000, because the repo has no table of model context windows. The ratio `warnAtRatio` defaults to 0.8.
- The issue page shows a warning when the replay estimate reaches the ratio. It shows a note when the full thread alone is larger than the limit.
- At run start, when the replay reaches the ratio, the run log gets a `lifecycle` event at level `warn`, written through `appendHeartbeatRunEvent`. A `lifecycle` event does not count as agent activity.
- The `paperclip dispatch` session owns detecting a context overflow after a failure and never retrying it. (C) is a check before the run. It does not parse errors and does not change retries.

## Before and after

- **Before:** the numbers above.
- **After, local and repeatable:** a test builds the wake prompt for a 300-comment `[qa-test]` style thread and checks the prompt size and the window counts. A test also covers the guard.
- **After, production:** a `[qa-test]` issue in the platform company with a long thread (about 150 comments of 2,000 characters). It gets one woken run before the deploy and one after, in a short resume window that the admin session grants. We compare the prompt characters, the first-call tokens, the tokens per run and the replay share. We record the numbers on the Work issue, then clean up the test data.

## Risks

- An agent that needs an old comment must read it. The index and the read commands make this cheap. The pinned messages keep the current request whole up to 16,000 characters.
- A resumed session from before the deploy holds the full history. Its next delta comes from the window, so it does not grow again.
- Native and recovery callers of `buildExecutionContinuation` get the same window. Origin comments and the latest request stay pinned, so the request and authority checks are unchanged. The checks still read all comment rows.
- The token estimate is a fit from one company's prompts. The issue page and the API label it as an estimate.
