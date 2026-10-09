# Convex plugin

Design and slice plan for `vllnt.paperclip-convex` (`packages/plugins/plugin-convex`, bundled key `convex`).
It lets agents of any company manage Convex deployments, with access decided per
**environment class** and per **agent**, enforced on the server.

Status: slice 1 is implemented in this PR (the "1" rows below). Slices 2 and 3 are specified here and ship as stacked PRs.

Why it exists: a Convex team has a deployment quota (300). A team that leaks preview deployments hits
`DeploymentQuotaReached`, and every backend CI job then fails. Agents need to see, trim and
eventually operate deployments without holding a credential that can touch production.

## 1. Sources and how each endpoint was verified

| Source | Base URL and auth | Stability |
| --- | --- | --- |
| Management API (`https://api.convex.dev/v1/openapi.json`, v1) | `https://api.convex.dev/v1`, `Authorization: Bearer <Team Token, OAuth Team/Project Token, PAT, or Preview Deploy Key>` | Documented, versioned |
| Deployment API (`@convex-dev/platform` 0.1.11 generated types, `docs.convex.dev/deployment-api/*`) | `<deploymentUrl>/api/v1` where `deploymentUrl` comes from the Management API; `Authorization: Convex <deploy key, team token or OAuth token>` | Documented. `get_current_usage` is marked **Beta** |
| Public HTTP API (`/api/query`, `/api/mutation`, `/api/action`, `/api/run/{fn}`) | `<deploymentUrl>`; optional user bearer token; deploy key for admin use | Documented. Functions only, no system functions |
| Streaming export (`/api/v1/data/sync`, `list_active_syncs`) | Deployment API auth | Documented, needs deploy key |
| CLI internals (`convex` 1.46.0 source: `/api/stream_function_logs`, `/api/shapes2`, `/api/run_test_function`, `/api/export/request/zip`, `/api/export/zip/{ts}`, `/api/import/*`, `/api/perform_import`, `/api/deploy2/*`, system functions `_system/cli/tables`, `_system/cli/tableData`, `_system/cli/modules:apiSpec`) | Deployment URL, `Authorization: Convex <deploy key>` | **UNSTABLE**: not in any OpenAPI or docs page |
| Dashboard internals (Health page metrics; `convex insights` reads `dashboard/teams/{id}/usage/query` on the dashboard backend with a user session token) | Dashboard session | **UNSTABLE** and not callable with a management token |
| Backups (create, list, download, restore) | Dashboard only. `npx convex export` is the only CLI route (ZIP) | **UNSTABLE** / no public API found |
| Convex MCP server (12 tools: `status`, `tables`, `data`, `runOneoffQuery`, `functionSpec`, `run`, `logs`, `insights`, `envList`, `envGet`, `envSet`, `envRemove`) | Local process, deploy key | Reference for the production gating model only |

Facts that shaped the design:

- `list_environment_variables` returns **names and values**. A "names only" tool must strip values in the worker.
- `deploymentUrl` is returned by Convex and used as an outbound target together with a credential. The plugin only sends a
  credential to `https://*.convex.cloud` (checked before the call).
- Timestamps are milliseconds. `PATCH /deployments/{name}` `expiresAt` must be at least 30 minutes ahead and within the
  team's retention entitlement; `null` clears it.
- Team `list_deployments` is cursor-paginated (limit 100). Project `list_deployments` is not paginated.
- Deployment audit events carry `clientIp` and `clientUserAgent`; treat them as PII.
- Deploy keys carry an `allowedActions` list (for example `deployment:logs:view`, `deployment:metrics:view`, `deployment:data:view`,
  `deployment:env:view`, `deployment:deploy`). Slice 2 uses it to mint the cheapest key per capability instead of a broad one.
- Every list response is projected through an allowlist (`src/projection.ts`), so a field Convex adds later, or one that holds key
  material, cannot reach an agent.
- The Health page (failure rate, cache hit rate, scheduler lag, function metrics) and Insights have **no documented API**. Slice 1
  reports only what the documented APIs return and lists the rest under `unavailable`. They are UNSTABLE spikes for slice 2.

## 2. Tool catalog

Legend. **Cap**: capability required (section 3). **Kind**: R read, W write, D destructive (supports `dryRun`).
**PII**: N none, L low (member ids, key names), H may contain end-user data or secrets. **Default grant** is always **none**:
every tool needs an explicit grant (default deny). Starter presets are in section 3.

All tool names are `convex_<name>`. Slice column: 1 implemented here, 2 and 3 specified.

### Inventory

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `list_projects` | Mgmt `GET /teams/{team_id}/projects` (mapped projects only) | meta-read | R | N | 1 |
| `list_deployments` | Mgmt `GET /projects/{id}/list_deployments?deploymentType=` | meta-read | R | L (creator id) | 1 |
| `get_deployment` | Mgmt `GET /deployments/{name}` (type, reference, previewIdentifier, lastDeployTime, expiresAt, class, region) | meta-read | R | L | 1 |
| `quota` | Mgmt `GET /teams/{team_id}/list_deployments` (paginated count vs quota) | meta-read | R | N | 1 |
| `list_custom_domains` | Mgmt `GET /deployments/{name}/custom_domains` | meta-read | R | N | 1 |
| `list_deploy_keys` | Mgmt `GET /deployments/{name}/list_deploy_keys` (allowlisted metadata: id, name, times, creator, `allowedActions`; key material is dropped). `GET /projects/{id}/list_preview_deploy_keys` is slice 2 | meta-read | R | L | 1 |
| `list_audit_events` | Deployment `GET /list_audit_log_events` (action, time, actor kind; client IP, user agent and free-form metadata only with `data-read-pii`). The team-level Mgmt `GET /teams/{team_id}/list_audit_log_events` is slice 2 | logs-read | R | L / H | 1 |
| `list_classes_regions` | Mgmt `GET /teams/{team_id}/list_deployment_classes`, `list_deployment_regions` | meta-read | R | N | 1 |

### Health and usage

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `deployment_health` | Mgmt `GET /deployments/{name}` (lastDeployTime, expiresAt) + Deployment `GET /deployment_info`, `GET /get_current_usage` (Beta), `GET /list_usage_limits`. Lists `unavailable: [failureRate, cacheHitRate, schedulerLag, functionMetrics]` | health-read | R | N | 1 |
| `get_usage` | Deployment `GET /get_current_usage` (day and month per metric, `seedStatus`) | health-read | R | N | 1 |
| `list_usage_limits` | Deployment `GET /list_usage_limits` | health-read | R | N | 1 |
| `function_metrics`, failure rate, cache hit rate, scheduler lag | Dashboard internals | health-read | R | N | 2 **UNSTABLE** |
| `insights` (OCC conflicts, resource limits, 72 h) | Dashboard backend `usage/query`; needs a user session, not a management token | health-read | R | N | 2 **UNSTABLE**, may stay unavailable |

### Logs

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `logs` (tail/search, level and function filters) | CLI internal `/api/stream_function_logs` | logs-read | R | H | 2 **UNSTABLE** |
| `list_log_streams` (secrets redacted) | Deployment `GET /list_log_streams`, `/get_log_stream/{id}` | logs-read | R | H (sink URLs) | 2 |
| `create_log_stream`, `update_log_stream`, `rotate_log_stream_secret` | Deployment `POST /create_log_stream`, `/update_log_stream/{id}`, `/rotate_webhook_secret/{id}` | admin | W | H | 3 |
| `delete_log_stream` | Deployment `POST /delete_log_stream/{id}` | admin | D | N | 3 |

### Data

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `list_tables`, schema and indexes | CLI internal `/api/shapes2`, `_system/cli/tables` (no documents) | meta-read | R | N | 2 **UNSTABLE** |
| `read_table` (paginated) | `_system/cli/tableData` | data-read-pii | R | H | 2 **UNSTABLE** |
| `run_oneoff_query` (sandboxed, read-only) | `/api/run_test_function` | run-query + data-read-pii | R | H | 2 **UNSTABLE** |
| `export_snapshot` (ZIP) | `/api/export/request/zip`, `/api/export/zip/{ts}` | backup + data-read-pii | R | H | 3 **UNSTABLE** |
| `stream_export` | Deployment `POST /data/sync`, `GET /data/list_active_syncs` | backup + data-read-pii | R | H | 3 |
| `import_snapshot` | `/api/import/start_upload`, `upload_part`, `finish_upload`, `/api/perform_import` | restore-import | D | H | 3 **UNSTABLE** |

### Functions

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `function_spec` | `_system/cli/modules:apiSpec` | meta-read | R | N | 2 **UNSTABLE** |
| `run_query` | Public `POST /api/query` or `/api/run/{fn}` (deploy key) | run-query | R | H | 2 |
| `run_function` (mutation or action) | Public `POST /api/mutation`, `/api/action` | run-write | W | H | 3 |
| `list_scheduled`, `list_crons` | System query behind the dashboard Schedules page | meta-read | R | N | 2 **UNSTABLE** |
| `cancel_scheduled` | System mutation behind the Schedules page | run-write | D | N | 3 **UNSTABLE** |

### Environment variables

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `env_names` (values stripped in the worker) | Deployment `GET /list_environment_variables` | env-read-names | R | N | 2 |
| `env_get` | same endpoint, one name | env-read-values | R | H (secret class) | 2 |
| `env_set`, `env_remove` | Deployment `POST /update_environment_variables` (invalidates all subscriptions) | env-write | W / D | H | 3 |
| `project_env_defaults` (list, set) | Mgmt `GET /projects/{id}/list_default_environment_variables`, `POST .../update_default_environment_variables` | env-read-values / env-write | R / W | H | 3 |

### Lifecycle

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `set_preview_expiry` (max 7 days) | Mgmt `PATCH /deployments/{name}` `expiresAt` | lifecycle | W | N | 1 |
| `delete_preview` | Mgmt `POST /deployments/{name}/delete` (irreversible) | lifecycle | D | N | 1 |
| `reap_previews` (also an hourly job) | list + the two above | lifecycle | D | N | 1 |
| `create_deployment` (preview or dev only) | Mgmt `POST /projects/{id}/create_deployment` | lifecycle | W | N | 3 |
| `pause_deployment`, `unpause_deployment` (preview, dev, staging) | Deployment `POST /pause_deployment`, `/unpause_deployment` | lifecycle | D | N | 3 |
| `delete_dev` | Mgmt `POST /deployments/{name}/delete` | board-only | D | N | never an agent tool; board action or Decision |
| `transfer_deployment` | Mgmt `POST /deployments/{name}/transfer` | board-only | D | N | never an agent tool |

### Deploy

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `deploy_preview` (push code to a preview or dev deployment) | CLI internal `/api/deploy2/*` | deploy | W | N | 3 **UNSTABLE** |
| production deploy | n/a | n/a | n/a | n/a | **never a tool**: CI or a human gate |

### Keys, domains, limits, backups

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `create_deploy_key`, `create_preview_deploy_key` | Mgmt `POST /deployments/{name}/create_deploy_key`, `POST /projects/{id}/create_preview_deploy_key` (key returned once, never to the agent: stored as a company secret) | admin, board-only default | W | H | 3 |
| `delete_deploy_key`, `delete_preview_deploy_key` | Mgmt `POST .../delete_deploy_key`, `.../delete_preview_deploy_key` | admin, board-only default | D | N | 3 |
| `create_custom_domain`, `delete_custom_domain` | Mgmt `POST /deployments/{name}/create_custom_domain`, `.../delete_custom_domain` | admin, board-only default | W / D | N | 3 |
| `set_usage_limit`, `delete_usage_limit` | Deployment `POST /create_usage_limit`, `/update_usage_limit/{id}`, `/delete_usage_limit/{id}` | admin | W / D | N | 3 |
| `backup_list`, `backup_create`, `backup_download` | Dashboard only. CLI `export` for download | backup | R / W | H | 3 **UNSTABLE**, may stay unavailable |
| `backup_restore` | Dashboard only (wipes existing data) | restore-import, board-only | D | H | never an agent tool |

## 3. Environment and permission model

### 3.1 Environment classes (server-side, fail closed)

`production`, `staging`, `preview`, `dev`, `custom`. The class is computed in the worker from the **re-fetched** deployment
(`GET /deployments/{name}`), never from agent input.

1. The deployment's Convex project must be in the company's mapping and reserved for that company (section 3.4). Otherwise the call is refused with no class.
2. A deployment `name`, `reference` or `previewIdentifier` listed under the project's `environments.production` is `production`. This wins over everything.
3. `isDefault: true` on any type except `dev`, or `deploymentType: "prod"`, is `production`. A name or reference listed under `environments.staging` is `staging` unless step 2 or an `isDefault` default-prod already made it `production`.
4. `deploymentType: "preview"` is `preview`. `"dev"` is `dev`. `"custom"` is `custom`.
5. Anything else (missing or unknown type, local deployment, malformed record) is **`production`**.

Operator overrides can only name a class for an explicitly listed deployment; nothing is relaxed by pattern.

### 3.2 Capabilities

`meta-read`, `health-read`, `logs-read`, `data-read-pii`, `env-read-names`, `env-read-values`, `env-write`, `run-query`,
`run-write`, `deploy`, `lifecycle`, `backup`, `restore-import`, `admin`.

A grant is `company -> subject (agentId or role) -> environments[] -> capabilities[]`, stored in the company plugin config
(writable only by an instance administrator). **Default deny**: no grant, no call. Presets expand to capabilities:

| Preset | Capabilities |
| --- | --- |
| `observer` | meta-read, health-read |
| `triager` | observer + logs-read, env-read-names, run-query |
| `janitor` | observer + lifecycle |

Production rules, applied after the grant lookup and not overridable by config:

- On `production` (and `custom`), only `meta-read` and `health-read` are grantable by default. `logs-read`, `data-read-pii`, `run-query` need an explicit grant listing the class (mirrors Convex MCP `--cautiously-allow-production-pii`).
- `env-read-values`, `env-read-names` on production need an explicit grant too. Production **writes** (`env-write`, `run-write`, `deploy`, `restore-import`, `admin`) need a grant with `approval: "per-call"` and a board Decision per call (slice 3), or simply are not granted. `lifecycle` is never valid on production, staging, dev or custom for agents: only previews.
- Board-only capabilities (`delete_dev`, `transfer`, `restore`, keys and domains by default) have no agent tool.
- `deploy` to production does not exist.

### 3.3 Credentials stay server-side

Tokens are company secrets referenced by `secret_ref`; the worker resolves each one at most once per operation (a tool call or a reaper pass,
because the host limits secret resolution per minute) and never returns, logs or stores it. Cheapest credential first: Preview Deploy Key (get, expiry, delete
of that project's previews) -> project token -> team token, falling back to the next on 401/403. The team token also reads the Deployment API
(documented to accept team tokens) until slice 2 adds per-deployment keys scoped by `allowedActions`. A credential is sent only to `api.convex.dev`
or `https://*.convex.cloud` (checked before the call), and to `api.github.com` for the GitHub token.

### 3.4 Company isolation

Config alone grants nothing. `connection.connect` (instance administrator) verifies the token against Convex, then **reserves each mapped Convex project id for exactly one company** in an instance registry.
A call for a project that another company reserved, or one not in the registry for the caller's company, is refused. The caller company is the host-validated run context, never a parameter.

### 3.5 Every call

- **Audit**: `ctx.activity.log` with agent, run, tool, capability, environment class, deployment, outcome, and before/after state for writes. Credentials never included.
- **Rate limit**: per company and agent, configurable calls per minute (default 60), fail closed when exceeded.
- **Blast radius**: at most 20 deletions per run (configurable), at most 200 deployments per list call, expiry at most 7 days.
- **Dry run**: all destructive tools accept `dryRun`. The reaper is dry-run until `reaper.enabled`. `guards.dryRunOnly` forces dry-run for every destructive tool in a company.
- **PR guard (previews)**: a preview is kept when its identifier matches an open pull request (head branch, or `pr-<n>` style) or a branch with commits in the last N hours (default 24)
  on the mapped repository. Names are compared exactly and with separators normalized (`feat/login` = `feat-login`). "Branch gone" is concluded only from the full branch list, never from
  one missing name. Open pull requests and branches are re-read at delete time. Lists above 1000 entries, an unreadable repository, a missing token or repository, and a preview without
  an identifier all fail closed.
- **An expiry is a delayed delete.** An expiry sooner than the activity window follows the same guards and counts against the run's deletion cap. The reaper applies its own policy (below).
- **Delete outcome**: a delete that fails or goes unanswered is checked against Convex; if the deployment is gone it is reported as deleted, otherwise as unconfirmed, never as a clean failure.
- **Lookups**: "does not exist", "not reachable" and "belongs to another company or an unmapped project" return the same message, so deployment names cannot be probed.

## 4. Slice plan (stacked PRs)

1. **Slice 1 (this PR)**: connection and company registry, classification, grants and presets, audit, rate limit, inventory and health/usage read tools (documented APIs only), preview lifecycle (`set_preview_expiry`, `delete_preview`), the hourly reaper (dry-run default) with quota alert, API actions, CLI `paperclipai convex`, minimal UI.
2. **Slice 2**: logs, tables/schema, paginated reads, function spec, `run_query`, scheduled functions, env names then values, log stream reads, metrics and insights behind an `allowUnstable` flag with contract tests against recorded fixtures. Adds per-deployment deploy keys.
3. **Slice 3**: writes and admin: env write, `run_function`, `deploy_preview`, create/pause deployments, export/import, log stream writes, keys and domains, usage limits, per-call approvals (Decisions) for production writes.

UNSTABLE endpoints are wrapped behind one adapter module each, covered by fixture tests, and disabled until `allowUnstable` is set per company. They must be re-verified against a real deployment before slice 2 ships; no real Convex call is made in slice 1.

## 5. Slice 1 operator reference

Company plugin config (instance administrator writes it; every secret field is a `secret_ref`):

```json
{
  "teamId": "123",
  "teamToken": { "type": "secret_ref", "secretId": "<id>", "version": "latest" },
  "projects": [{
    "convexProjectId": "456", "name": "app", "repository": "org/app",
    "paperclipProjectId": "<uuid, optional>",
    "token": { "type": "secret_ref", "secretId": "<id>" },
    "previewDeployKey": { "type": "secret_ref", "secretId": "<id>" },
    "environments": { "production": ["<deployment name>"], "staging": ["<deployment name>"] }
  }],
  "github": { "token": { "type": "secret_ref", "secretId": "<id>" } },
  "grants": [{ "role": "devops", "preset": "janitor", "environments": ["preview"] }],
  "guards": { "activityHours": 24, "maxDeletesPerRun": 20, "callsPerMinute": 60, "dryRunOnly": false },
  "reaper": { "enabled": false, "ttlHours": 36, "quota": 300, "alertPercent": 80 }
}
```

`github.token` is a fine-grained, read-only token (Metadata, Pull requests, Contents) on the mapped repositories. Reusing the
company's GitHub App key to mint per-repository read tokens is planned for slice 2; slice 1 needs no App coupling.

Actions (`POST /api/plugins/vllnt.paperclip-convex/actions/<key>`, body `{companyId, params}`, board users only; contracts in OpenAPI):
`status`, `connection.connect`, `connection.disconnect`, `deployments.list`, `deployments.delete-preview`, `reaper.run`, `reaper.report`.
`connection.*`, `deployments.delete-preview` and a live `reaper.run` need an instance administrator. Config is written with the standard
plugin config API (`paperclipai plugin config:set vllnt.paperclip-convex -C <company> ...`), which only an instance administrator may call.
CLI: `paperclipai convex status|connect|report`, `paperclipai convex deployments list|reap [--dry-run]|delete-preview <name> [--dry-run]`.

### Reaper rules

Hourly job `convex-reaper` (also `reaper.run` and the `convex_reap_previews` tool). For each connected company and mapped project it lists previews and:

1. keeps anything classified staging or production, anything with an open PR or a recently active branch, and anything it cannot check;
2. deletes previews whose PR is closed or merged, or whose branch is gone and whose last deploy is older than `guards.activityHours`;
3. sets `expiresAt = lastDeployTime + ttlHours` on kept previews. It shortens an expiry, and it moves an expiry later after a redeploy only when that expiry is one the reaper set
   itself (it remembers them); an expiry a person chose is never extended. When the new moment is less than an hour away (a guarded preview idle for almost `ttlHours`), the reaper does
   not schedule it; it only gives a preview without any expiry `now + ttlHours`. Convex measures its own default expiry from creation and its docs do not say that a redeploy resets it, so the
   reaper does not rely on that. **Policy note:** as specified, a preview with an open pull request that is not redeployed for `ttlHours` expires and the next push recreates it;
   `guards.activityHours` keeps branches with recent commits from being deleted by the reaper, not from expiring;
4. counts all team deployments against `reaper.quota` and raises an issue (once a day) and an activity entry at `reaper.alertPercent`.

It is a dry run until `reaper.enabled` is true. When GitHub cannot be read for a project, it changes nothing in that project.
