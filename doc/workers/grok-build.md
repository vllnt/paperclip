# Grok Build on workers

`grok_local` runs the official Grok Build CLI. Agents that use a Grok model should
run on it instead of on `codex_local`. This page is the worker prerequisite, the
auth options, the switch for existing agents, and a canary plan.

## The pinned CLI

| | |
|---|---|
| Package | `@xai-official/grok` (launcher) plus `@xai-official/grok-<platform>` (native binary) |
| Version | `1.0.49` (`grok 1.0.49 (8e66fdf1fd8e)`) |
| License | Apache-2.0, both packages. Redistribution in an image is allowed. |
| Platforms pinned | `linux-x64`, `linux-arm64`, `darwin-arm64` |
| Dependency | `@iarna/toml@3.0.0` (ISC), pinned too |

sha512 integrity of the tarballs (the same values the npm registry reports):

```
@xai-official/grok@1.0.49              sha512-vvrgCWsAPlDwl5MdkbC8fjwOOPje32wdbvV10tclIByYqHmvR0iPweNcd3/jCJBhi+BftL7N8fBeC2WfpoV8uA==
@xai-official/grok-linux-x64@1.0.49    sha512-49I9NutgxQpME8bSeEWXuLP3cr5A5oCxch4PfQaXV6sO+N9Tc0QtI5aU5Y3zV2m2XMOvmIwW9/D4YgEtPksnqw==
@xai-official/grok-linux-arm64@1.0.49  sha512-HbX2fliGwr5y40Yug/zmOHO8qK0q9QSQqIyINmLzGWuR+UHnILue38ExMJDz5SqHsoDT7ECKMUE5GVUc8vsSiA==
@xai-official/grok-darwin-arm64@1.0.49 sha512-6Ng+mNhbEBHYgK3phrIUT3+Myr9Lu9oEHWNvBb579N2tw9VGxKStPhV8uA0J4CPU1qZ/1ctsAvU7M73Gk1DrKw==
@iarna/toml@3.0.0                      sha512-td6ZUkz2oS3VeleBcN+m//Q6HlCFCPrnI0FZhrt/h4XqLEdOyYp2u21nd8MdsR+WJy5r9PTDaHTDDfhf4H4l6Q==
```

## Install on a worker

Run as a user that may write to the npm global prefix (root, in an image):

```sh
sh scripts/install-grok-build.sh
grok --version        # grok 1.0.49 (8e66fdf1fd8e)
```

The script fetches the tarballs with `npm pack`, checks each against the pinned
hash, and only then installs them with `--offline`, so npm cannot pull a package
the script did not verify. A wrong hash aborts before anything is installed.

- `GROK_INSTALL_PREFIX` sets the npm prefix (default `/usr/local`).
- `GROK_INSTALL_HOME` sets where the native binary is unpacked (default
  `$GROK_INSTALL_PREFIX/lib/grok`). Keep it out of any user's home. Each agent
  runs with its own `GROK_HOME`, and the launcher would otherwise unpack its own
  ~150 MB copy into every one of them.
- npm must run package scripts: the script fails if the postinstall did not place
  `grok-1.0.49` in `GROK_INSTALL_HOME`.

The Dockerfile runs the script when `INSTALL_LOCAL_CLIS=true` (the default). The
production build sets it to `false`, so the control plane image does not carry
the CLI and workers must.

To upgrade, change the version and every hash in `scripts/install-grok-build.sh`
together (`npm view @xai-official/grok@<version> dist.integrity`, then the same
for each platform package) and update this page.

If the binary is missing, the agent's environment test fails with
`grok_command_unresolvable` and a hint that names this script. A run fails with a
plain "command not found" error.

## Authentication

Pick one per agent. A run with none fails with `grok_auth_required` (the CLI says
"Not signed in"), which is never treated as a quota failure.

1. **`XAI_API_KEY` as a company secret** bound to the agent's env as a
   `secret_ref`. Best for workers.
2. **Device login** into the company Grok home: `grok login --device-auth`
   (alias `--device-code`). Subscription (SuperGrok) billing, no per-run cost.
3. **A gateway.** Set `GROK_XAI_API_BASE_URL` (for example the CLIProxy URL used
   for Codex, ending in `/v1`) together with `XAI_API_KEY`. Confirmed: the CLI
   sends `GET /v1/models`, `GET /v1/api-key`, `POST /v1/responses` and
   `POST /v1/chat/completions` to that URL with `Authorization: Bearer`. The
   gateway must serve xAI models on `/v1/chat/completions`.

## Instance prerequisite

The agent route refuses a switch onto an adapter listed in the instance's
disabled adapters (`422 … is not available on this instance`). Enabling needs an
instance admin. Check before moving agents:

```sh
curl -fsS -H "Authorization: Bearer $TOKEN" "$PAPERCLIP_URL/api/adapters" | jq '.[] | select(.type=="grok_local") | {type, disabled}'
# enable if needed
curl -fsS -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"disabled":false}' "$PAPERCLIP_URL/api/adapters/grok_local"
```

## Quota, limits and errors

`grok_local` now reports:

| Situation | `errorCode` | Effect |
|---|---|---|
| Not signed in, invalid or revoked key | `grok_auth_required` | Auth repair path; no cooldown |
| Gateway cooldown ("All credentials for model … are cooling down"), xAI team out of credits or at its spending limit | `provider_quota` | Target cools down; the wake retries once on the next fallback (#31) or profile target (#63) |
| Overloaded, at capacity, 502/503/504, "too many requests" | `grok_transient_upstream` | Bounded retries; capacity cooldown only after they are spent |

Facts from running `grok 1.0.49`:

- The CLI prints one `{"type":"error","message":…}` line, repeats it on stderr and
  exits 1. It drops the response body's `code` and `reset_seconds`, so a reset
  time is known only when the message itself names one; otherwise the cooldown
  backs off 5, 10, 20, 40, 60 minutes.
- A 429 **with** a `Retry-After` header made the CLI print nothing for 90 seconds
  (it waits). Only the adapter's `timeoutSec` bounds that, so keep it set.
- xAI answers an empty team balance with HTTP 403 ("Your team … has either used
  all available credits or reached its monthly spending limit"), not 429.

## Switch an existing agent

A `codex_local` agent that runs a `grok-*` model moves to `grok_local` with the
same model, instructions, working directory and skills:

```sh
paperclipai agent set-adapter <agent-id> grok_local --dry-run   # show the plan
paperclipai agent set-adapter <agent-id> grok_local --xai-base-url https://gateway.example/v1   # apply
```

The agent page shows the same plan with a "Switch to Grok Build" button, and the
API call is `PATCH /api/agents/:id` with the body the plan prints. What it does:

- keeps `model`, `cwd`, `instructionsFilePath`, `promptTemplate`, timeouts and
  the skill sync list;
- `modelReasoningEffort` becomes `reasoningEffort`, lowered to the highest value
  the model takes (`grok-4.5` has no `xhigh`);
- `OPENAI_API_KEY` becomes `XAI_API_KEY` when it is a secret reference. A
  plain-text key cannot move; bind a secret instead. The API returns every
  plain-text env value redacted, so the plan cannot read `OPENAI_BASE_URL`
  either: pass the gateway URL with `--xai-base-url` (or type it on the agent
  page) and it becomes `GROK_XAI_API_BASE_URL`. Other plain values keep their
  key, and the server restores them from the stored config. Other `OPENAI_*`
  and `CODEX_*` env is dropped;
- refuses an agent with a filesystem or network confinement setting, a managed AI
  connection, or a non-Grok model, instead of silently weakening it.

The first run starts a fresh session. Undo by patching the agent back, or roll
back its configuration revision (`paperclipai agent config-revisions <agent-id>`).

## Canary plan

1. Install the pinned CLI on one worker and run `grok models` there.
2. Confirm `grok_local` is enabled on the instance (see above).
3. Bind `XAI_API_KEY` (and `GROK_XAI_API_BASE_URL` if a gateway is used) as company
   secrets. Run the agent's environment test.
4. Switch one anthm agent with `--dry-run`, read the plan, apply.
5. Compare its `grok_local` runs against its earlier `codex_local` runs for a
   working day: success rate, duration and cost in the run log (and, once #63
   lands, `/api/companies/:companyId/run-target-stats`).
6. If equal or better, switch the rest. If not, patch the one agent back.

## Verified and not verified

Verified locally on macOS (`grok 1.0.49`): `--version`, `grok models`, an
unauthenticated `--single` run (exact error captured), an API-key run against a
local mock gateway, the offline checksum-verified install, tamper detection. The
switch was run from the agent page (desktop and 390 px) and from the CLI against
a local server: the stored agent became `grok_local` with its model, effort,
instructions bundle and `XAI_API_KEY` secret reference.

Not verified: execution on Linux (the pins match the registry, but no Linux
container ran here), a real xAI or CLIProxy run with a valid key, and the exact
wording of xAI's rate-limit body.
