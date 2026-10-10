---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

This route does not accept query filters. Unsupported query parameters return `400`.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

By default `adapterConfig` merges at the top level (a partial `env` replaces the whole `env`) and
`runtimeConfig` is replaced. Set `"replaceAdapterConfig": true` to replace `adapterConfig`.

### Change one config value (merge patch)

Set `"mergeConfig": true` to send only the keys you want to change. `adapterConfig` and `runtimeConfig`
are applied as JSON merge patches ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)) over the stored
config:

- Keys you name change. Keys you don't name keep their stored values, including secrets, so you never
  resend a secret to change something else.
- `null` removes a key.
- Arrays and scalars replace the stored value.
- Each `adapterConfig.env` entry is replaced whole (an env binding is never mixed with another), and so is
  `adapterConfig.workspaceStrategy`.
- An `adapterConfig.env` value read back from `GET` as `{"type":"plain","value":"***REDACTED***"}` restores the
  stored value. Other redacted values are not restored, so don't send them back.
- `runtimeConfig.aiConnection` can't be removed this way (`422`); change the agent's AI connection instead.
- A key named `__proto__`, `constructor` or `prototype` anywhere in the patch, arrays included, is refused with
  `400`, and `details[].path` names where. So is a patch nested deeper than 32 levels or holding more than 10,000
  values. Nothing is stored and no activity is logged.
- An agent key gets `403` when the merged `adapterConfig` would add, change or remove a host-executed
  `workspaceStrategy` command (`provisionCommand`, `runtimeProvisionCommand` or `teardownCommand`). That includes
  a `workspaceStrategy` that leaves a stored command out, because the strategy is replaced whole, and
  `workspaceStrategy: null`. A strategy that keeps its commands as they are is allowed. A board user with
  `agents:configure` may change them.

```
PATCH /api/agents/{agentId}
{
  "mergeConfig": true,
  "runtimeConfig": { "heartbeat": { "maxDailyRuns": 64 } },
  "adapterConfig": { "model": "gpt-5", "env": { "DEBUG": null } }
}
```

The merged configs are validated like a full update and recorded as a config revision. If the stored
config changes while your patch is applied, the request fails with `409`; read it again and retry.
`mergeConfig` can't be combined with `replaceAdapterConfig` or an `adapterType` change (`422`). Authorization is
unchanged: board users need `agents:configure` on the agent, and agents keep their existing limits on
changing themselves.

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Clear Agent Error

```
POST /api/agents/{agentId}/clear-error
```

Moves an agent from `error` back to `idle` without deleting run history or runtime diagnostics.
Only agents currently in `error` can be cleared.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
