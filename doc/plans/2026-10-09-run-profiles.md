# Run profiles: a harness and model per task

Date: 2026-10-09. Status: implemented in `feat/run-profiles` (issues and company tiers).
Routines are the next slice (they need one nullable column).

## Why

An agent runs every task on one harness and model. Simple tasks do not need the
most capable model, and one provider pool (Claude, OpenAI, xAI) caps how many
runs can go at once. A task should be able to pick another harness and model, so
chores run fast and cheap and runs spread across pools.

## Behaviour

```
issue.assigneeAdapterOverrides.runProfile ──► resolve against company tiers
        │ {tier} or {adapterType?, model?, effort?}
        ▼
target chain for the run:  [profile] ─► agent primary ─► agent fallbacks
        │                      │ quota error: cool the target down, re-dispatch the wake once down the chain
        ▼
run records source: issue_profile | fallback | agent_default
```

- **One mechanism.** The profile is the first target of the agent's PR A chain, so
  quota cooldowns, once-per-wake re-dispatch, secret bindings and the harness/model
  matrix are shared with agent fallbacks. A profile target is never retried before
  its cooldown ends.
- **Same harness.** A model or effort alone runs on the agent's own harness with its
  own credentials.
- **Another harness.** The agent's own fallback entry for that harness supplies env
  and secret bindings (`fallbacks[<n>].env.<KEY>`). The agent's primary env and AI
  connection never reach it. Without such an entry the profile cannot apply: setting
  it is 422, and a stored one runs on the agent default and is logged.
- **Company tiers.** `instance_settings.general.companyRunTiers[<companyId>]` holds
  named tiers (`fast`, `standard`, ...) and the allowlist of tiers agents may set.
  `deep` is reserved: the agent's own default. Same storage pattern as
  `companyEnvironmentDefaults`, so no migration. `GET/PUT /api/companies/:id/run-tiers`
  (PUT is board only).
- **Legacy overrides.** The model and effort in `assigneeAdapterOverrides.adapterConfig`
  read as an issue-level profile on the agent's own harness. Tasks that pin a model
  (for example Grok on `codex_local`) keep running, and now share cooldowns and the
  fallback chain.
- **Precedence.** Issue profile over agent default. Routine profiles slot in between in
  the next slice. Child issues inherit nothing.

## Who may set it

The profile changes which model a task burns, so it is a protected field.

| Actor | May set |
|---|---|
| Board user, or agent with `agents:configure` for the assignee | any compatible profile |
| Other agent | a tier on the company allowlist, on an issue it creates or dispatches, over an empty profile or an allowlisted tier |

Clearing a profile counts as the `deep` tier, so an agent cannot lift its own tasks
above its default. Refusals are 403 with `issue.run_profile_denied`; every applied
change is `issue.run_profile_updated` with the profile before and after. The legacy
`adapterConfig.model` and `effort` overrides get the same check. Harness/model
mismatches are 400, an unknown tier is 400.

## Observability

Each run's `runnerProfileJson.adapterDispatch` records `source`, the profile in
effect and the target; the run list returns `targetSource`, and run detail shows it.
`GET /api/companies/:id/run-target-stats?hours=24` returns queued and running runs per
provider pool (anthropic, openai, xai) and finished runs grouped by source, tier,
harness and model with success rate and average duration. Concurrency stays per
agent; the per-pool counts show when raising it is safe.

## Rollout and rollback

1. Deploy. Nothing changes until a company sets tiers or a task sets a profile.
2. Set tiers: `paperclipai company run-tiers:set <company> --tiers-json '{"tiers":{"fast":{"adapterType":"codex_local","model":"grok-4.7","effort":"low"}},"agentAllowlist":["fast"]}'`.
3. Canary one chore: `paperclipai issue update <id> --run-profile fast`.

Rollback: `paperclipai issue update <id> --clear-run-profile`, or empty the tiers with
`run-tiers:set`. A code revert leaves stored profiles unread; there is no migration.
