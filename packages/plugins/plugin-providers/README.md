# Providers

Providers is bundled by default in the VLLNT Paperclip fork. It adds **Org → Providers**
for API gateways and existing subscription connections. Each agent keeps its own
harness and selects a provider and model in its runtime settings.

The package retains the ID `vllnt.paperclip-plugin-cliproxyapi` so existing installs
and links continue to work. Source lives here; the former external development copy
is no longer the source of truth.

## Setup

Build the fork (`pnpm build`) and start it. Providers installs automatically when
its bundle is present. Plugin Manager can disable or uninstall it; startup respects
that choice. No connection is created automatically.

Before entering a proxy key, the instance operator must approve its origin, for example:

```sh
PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS=http://127.0.0.1:8317
```

Use a URL reachable from both Paperclip and the agent's execution environment.
For remote agents, loopback points at the remote environment. Never include a key
in the URL. Enter it only in the password field on the Providers page.

**Test connection** lists the complete catalog without saving. Select a model and
**Test model** to send a short prompt. **Save provider** verifies the selected API
format and stores the key in Paperclip's vault. **Disconnect** revokes access;
**Reconnect** rotates the key at the same endpoint and preserves existing grants.

Codex needs OpenAI Responses (`/v1/responses`); Claude needs Anthropic Messages
(`/v1/messages`). Chat Completions alone is insufficient. Both use `/v1/models`
for discovery. Account/subscription management uses Paperclip's existing sign-in
flow. Subscription model choices use the harness catalog, not an entitlement check.

The plugin's UI is trusted same-origin host code. Credentials and authorization
remain owned by the host AI Connections API, not plugin state.

## Development and verification

From the repository root:

```sh
pnpm --filter @vllnt/paperclip-plugin-cliproxyapi typecheck
pnpm --filter @vllnt/paperclip-plugin-cliproxyapi test
pnpm --filter @vllnt/paperclip-plugin-cliproxyapi build
pnpm test:e2e:providers
```

The end-to-end suite boots a disposable Paperclip home and a mock gateway. It
checks default installation, both wire formats, standalone tests, model discovery,
secret rejection, saved-key testing, disconnect/reconnect, company isolation,
agent provider/model persistence, failure recovery, subscription rendering, and
mobile layout. Subscription rendering is a browser fixture: no OAuth or host CLI
credentials are read. Use `PAPERCLIP_E2E_PORT` (default 3199) and
`PAPERCLIP_E2E_GATEWAY_PORT` (default 18318) when those ports are busy.

Detailed runtime boundaries and protocol references are in
[AI Connections](../../../doc/connections/AI-CONNECTIONS.md).
