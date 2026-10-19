# Convex plugin: tool catalog and slice plan

Plan for `vllnt.paperclip-convex` (`packages/plugins/plugin-convex`). What slice 1 does today, how it is configured and which guards it applies is in the
operator reference, [doc/convex-plugin.md](../convex-plugin.md). This file is the catalog of what Convex offers, which of it is built, and the order of the rest.

Status: slice 1 is in [PR #42](https://github.com/vllnt/paperclip/pull/42) (example-project). Slices 2 and 3 are specified here and ship as separate PRs.
Gaps between the agent tools, the board UI and the CLI are in example-project.

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
- `deploymentUrl` is returned by Convex and used as an outbound target together with a credential. The plugin sends a credential only to the deployment's own
  `https://<name>.*.convex.cloud` host (checked before the call).
- Timestamps are milliseconds. `PATCH /deployments/{name}` `expiresAt` must be at least 30 minutes ahead and within the team's retention entitlement; `null` clears it.
- Team `list_deployments` is cursor-paginated (limit 100). Project `list_deployments` is not paginated.
- Deployment audit events carry `clientIp` and `clientUserAgent`; treat them as PII.
- Deploy keys carry an `allowedActions` list (for example `deployment:logs:view`, `deployment:metrics:view`, `deployment:data:view`, `deployment:env:view`,
  `deployment:deploy`). Slice 2 uses it to mint the cheapest key per capability instead of a broad one.
- Every response is projected through an allowlist (`src/projection.ts`), so a field Convex adds later, or one that holds key material, cannot reach an agent.
- The Health page (failure rate, cache hit rate, scheduler lag, function metrics) and Insights have **no documented API**. Slice 1 reports only what the
  documented APIs return and lists the rest under `unavailable`. They are UNSTABLE spikes for slice 2.

## 2. Tool catalog

Legend. **Cap**: the capability a tool needs. **Kind**: R read, W write, D destructive (supports `dryRun`). **PII**: N none, L low (member ids, key names),
H may contain end-user data or secrets. **Default grant** is always **none**: every tool needs an explicit grant (default deny). All tool names are `convex_<name>`.
Slice: 1 built in #42, 2 and 3 specified.

The plugin declares a capability only when a tool that enforces it ships. Slice 1 declares `meta-read`, `health-read`, `logs-read`, `data-read-pii` and
`lifecycle`. The others named below (`env-read-names`, `env-read-values`, `env-write`, `run-query`, `run-write`, `deploy`, `backup`, `restore-import`, `admin`)
and the `triager` preset (observer plus `logs-read`, `env-read-names`, `run-query`) arrive with the slice-2 and slice-3 tools that use them, together with
the rule that production writes need a per-call board approval. Until then a config that names them is rejected.

### Inventory

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `list_projects` | The company config (mapped projects only; no Convex call) | meta-read | R | N | 1 |
| `list_deployments` | Mgmt `GET /projects/{id}/list_deployments?deploymentType=`, paged by name, compact rows | meta-read | R | L (creator id) | 1 |
| `get_deployment` | Mgmt `GET /deployments/{name}` (type, reference, previewIdentifier, lastDeployTime, expiresAt, class, region) | meta-read | R | L | 1 |
| `quota` | Mgmt `GET /teams/{team_id}/list_deployments` (paginated count vs quota; shared for a minute) | meta-read | R | N | 1 |
| `list_custom_domains` | Mgmt `GET /deployments/{name}/custom_domains` | meta-read | R | N | 1 |
| `list_deploy_keys` | Mgmt `GET /deployments/{name}/list_deploy_keys` (allowlisted metadata: id, name, times, creator, `allowedActions`; key material is dropped). `GET /projects/{id}/list_preview_deploy_keys` is slice 2 | meta-read | R | L | 1 |
| `list_audit_events` | Deployment `GET /list_audit_log_events` (last 24 hours unless `from` is given; action, time, actor kind; client IP, user agent and metadata only with `data-read-pii`). The team-level Mgmt `GET /teams/{team_id}/list_audit_log_events` is slice 2 | logs-read | R | L / H | 1 |
| `list_classes_regions` | Mgmt `GET /teams/{team_id}/list_deployment_classes`, `list_deployment_regions` | meta-read | R | N | 1 |

### Health and usage

| Tool | Convex source | Cap | Kind | PII | Slice |
| --- | --- | --- | --- | --- | --- |
| `deployment_health` | Mgmt `GET /deployments/{name}` (lastDeployTime, expiresAt) + Deployment `GET /deployment_info`, `GET /get_current_usage` (Beta), `GET /list_usage_limits`. Lists `unavailable: [failureRate, cacheHitRate, schedulerLag, functionMetrics, insights]` | health-read | R | N | 1 |
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
| `set_preview_expiry` (0.5 to 168 hours) | Mgmt `PATCH /deployments/{name}` `expiresAt` | lifecycle | W | N | 1 |
| `delete_preview` | Mgmt `POST /deployments/{name}/delete` (irreversible; dry run by default) | lifecycle | D | N | 1 |
| `reap_previews` (also an hourly job) | list + the two above (dry run by default) | lifecycle | D | N | 1 |
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

## 3. Slice plan

1. **Slice 1 ([#42](https://github.com/vllnt/paperclip/pull/42))**: connection and company registry, classification, grants and presets (`observer`, `janitor`), audit, rate limit,
   inventory and health/usage read tools (documented APIs only), preview lifecycle (`set_preview_expiry`, `delete_preview`), the hourly reaper (dry run by default) with
   quota alert, board actions, CLI `paperclipai convex`, minimal UI. Surface gaps: example-project.
2. **Slice 2**: logs, tables/schema, paginated reads, function spec, `run_query`, scheduled functions, env names then values, log stream reads, metrics and insights
   behind an `allowUnstable` flag with contract tests against recorded fixtures. Adds per-deployment deploy keys, the `triager` preset and the capabilities its tools need.
3. **Slice 3**: writes and admin: env write, `run_function`, `deploy_preview`, create/pause deployments, export/import, log stream writes, keys and domains,
   usage limits, per-call approvals (Decisions) for production writes.

UNSTABLE endpoints are wrapped behind one adapter module each, covered by fixture tests, and disabled until `allowUnstable` is set per company. They must be
re-verified against a real deployment before slice 2 ships. Slice 1 makes no real Convex call in its tests.

Reusing the company's GitHub App key to mint per-repository read tokens (instead of a fine-grained token in config) is planned for slice 2.
