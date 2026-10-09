# Agent harness/model fallback and provider quota cooldowns

Date: 2026-10-08. Status: implemented in `feat/agent-harness-fallback`.

## Problem

Claude subscription accounts behind a credential proxy can run out of their
5-hour or weekly allowance at the same time. A run then fails before useful
work. Before this change:

- the proxy answer (`429 · All credentials for model … are cooling down`) was
  classified as `claude_transient_upstream`, so each failure got two
  30-second retries;
- every new wake (comment, timer, recovery) started another run on the same
  exhausted harness and model.

On 2026-10-08 between 23:52 and 00:08 UTC this produced 39 failed runs in
16 minutes and spent the run caps of three agents. Codex capacity was
available the whole time.

## Behaviour

```
failed run ─► reclassify (server safety net: quota wording → provider_quota)
     │
     ▼
classifyQuotaFailure ── auth / task / useful work / not quota ──► unchanged paths
     │ usage limit (now)  │ capacity (after the bounded retries)
     ▼                    ▼
cool the harness/model down: provider reset, else 5 → 10 → 20 → 40 → 60 min
     │
     ├─ healthy fallback ─► re-dispatch this wake once there (fresh session)
     └─ none ────────────► retries and new wakes wait until a target recovers
```

- **Config.** `agents.fallbacks` is an ordered list (at most 3) of
  `{ adapterType, model, effort?, adapterConfig?, env? }`. A fallback keeps
  the agent's harness-agnostic keys (instructions, prompt, cwd, timeouts,
  `paperclipSkillSync`) and the CLI engine choice. It never inherits the
  primary's `env` or AI connection. Credential env keys must be
  `secret_ref`/`user_secret_ref`. API reads redact plain env values the same
  way as `adapterConfig.env`.
- **Compatibility.** `claude_local` runs Anthropic models only;
  `codex_local` runs OpenAI and xAI models; `grok_local` runs xAI models.
  No non-Claude harness may run an Anthropic model id (`claude*`,
  `anthropic*`, Bedrock/Vertex ids, `opus`/`sonnet`/`haiku` aliases),
  including a `--model`/`-c model=` override in `extraArgs`. Fallback
  entries must use a recognised model; a primary may keep an unrecognised
  id. The check runs on create, PATCH, rollback and before every run
  (`harness_model_incompatible`, no retry).
- **Cooldowns.** `agent_harness_cooldowns` holds one row per agent and
  `<adapterType>:<model>`. The provider reset comes from the adapter
  (`retryNotBefore`) or the error text: CLIProxy `reset_seconds`/`reset_time`,
  a `…|<epoch>` suffix, `anthropic-ratelimit-unified-reset`, an ISO time,
  `Retry-After`, or "try again in …". Without one the backoff starts at five
  minutes and doubles while failures repeat, up to
  `runtimeConfig.heartbeat.quotaBackoffMaxMinutes` (default 60, at most 1440).
  A failure while the target is already cooling down keeps the current end.
- **Dispatch.** At claim time the first healthy target in order runs. When
  every target is cooling down the run stays queued (not started, so the
  daily cap is not charged) and the scheduler tick claims it after the
  earliest recovery. Every scheduled retry is clamped to that time too, so
  the 30-second transient lane and recovery retries cannot spin through a
  quota error.
- **Once per wake.** The re-dispatch is a `harness_fallback` scheduled retry
  of the failed run (one successor per run). A fallback run that fails with a
  quota error is not re-dispatched again: the wake waits for that target's
  cooldown end (no hop to the next target 30 seconds later). The failed
  primary run and its re-dispatch count as one run toward `maxDailyRuns`; a
  partial index keeps that check cheap.
- **Fails closed.** If the cooldown table cannot be read, every target of that
  agent waits (15 s, doubling to 5 min), the table is not read again inside the
  window, and one warning is logged per window. If a cooldown cannot be
  recorded after a quota failure, the wake is deferred 15 s instead of getting
  the 30 s retry.
- **LLM harnesses only.** Cooldowns and the server-side quota
  reclassification apply to the local LLM harnesses. A `process` or `http`
  agent that prints "usage limit reached" is not cooled down.
- **Sessions.** A provider session cannot move between harnesses. When the
  harness of a run differs from the harness of the agent's previous run on
  the issue, the run starts a fresh session with Paperclip's continuation
  summary and fresh-session handoff.
- **Visibility.** Each run records `executed_adapter_type`,
  `executed_model` and `fallback_reason`. The agent API returns
  `harnessFallback` ("On fallback codex_local/gpt-5.5 until 14:30", or
  "Waiting for provider quota until 14:30"). Activity:
  `agent.harness_fallback_activated`, `agent.harness_fallback_returned`.
- **Secrets.** Fallback env credentials are secret references. Each target
  binds its env under its own path (`fallbacks[<n>].env.<KEY>`), so two targets
  and the primary can hold different secrets for the same key, and the
  pre-dispatch gate and the resolver use the claimed target's path. Bindings are
  re-synced when fallbacks change, so removing or reordering a fallback drops or
  moves them. No schema change: the path is a string. Plain env values are
  accepted only for paths, credential-free endpoints and model names. Agent
  keys cannot set instruction paths or host commands in a fallback's
  `adapterConfig`. An issue's assignee overrides for model, env and CLI args
  do not apply to a fallback run.
- **Operator control.** `paperclipai agent cooldowns:clear <id>`
  (`POST /api/agents/:id/harness-cooldowns/clear`, board only) removes an
  agent's cooldowns; it is logged as `agent.harness_cooldowns_cleared`.
- **Security.** An agent changing its own `fallbacks` or
  `quotaBackoffMaxMinutes` (PATCH or rollback) needs `agents:configure` for
  itself; otherwise 403 `agent_self_protected_config_change` and an
  `agent.self_config_update_denied` activity row (same guard as #20).

## Rollout and rollback

1. Deploy. Agents without `fallbacks` get only the quota cooldown: no
   immediate same-harness retry after a usage limit.
2. Canary: set `fallbacks` on one implementer, for example
   `paperclipai agent fallbacks:set <id> --fallbacks-json '[{"adapterType":"codex_local","model":"gpt-5.5","effort":"high","env":{"OPENAI_API_KEY":{"type":"secret_ref","secretId":"<id>"},"CODEX_HOME":"<home>"}}]'`.
3. Watch the agent badge, the run's harness line and the activity feed.

Before deploying, audit agents that would now be refused at run start:
`select id, adapter_type, adapter_config->>'model' from agents where
adapter_type <> 'claude_local' and adapter_config->>'model' ~* 'claude|anthropic|opus|sonnet|haiku'`
(and `claude_local` agents with `gpt-`/`grok-` models).

Rollback: `paperclipai agent fallbacks:clear <id>` per agent. To clear a
cooldown early, run `paperclipai agent cooldowns:clear <id>`. A code rollback
leaves the new columns and table unused; the migration only adds them.
