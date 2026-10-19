# Convex plugin

Operator reference for `vllnt.paperclip-convex` (`packages/plugins/plugin-convex`, bundled key `convex`). It lets the agents of a company
inspect and trim its Convex deployments, with access decided per **environment class** and per **agent** and enforced in the plugin worker.

Why it exists: a Convex team has a deployment quota (300). A team that leaks preview deployments hits `DeploymentQuotaReached`, and every
backend CI job then fails. Agents need to see, trim and eventually operate deployments without holding a credential that can touch production.

What is implemented here is slice 1. The tool catalog and the plan for slices 2 and 3 are in
[doc/plans/2026-10-18-convex-plugin.md](plans/2026-10-18-convex-plugin.md).

## Surfaces

The plugin has three surfaces: agent tools (`convex_*`), board actions (HTTP, contracts in OpenAPI), and the board UI and CLI that call
those actions. They are not at parity yet. The gaps are listed here and tracked in example-project.

| Operation | Agent tool | Board action | Board UI (Convex page) | CLI (`paperclipai convex`) |
| --- | --- | --- | --- | --- |
| Connection state, mapped projects, guards, reaper settings | `convex_list_projects` (projects only) | `status` | yes | `status` |
| Connect (verify credentials, reserve projects) | none by design | `connection.connect` | yes | `connect` |
| Disconnect | none by design | `connection.disconnect` | no | no |
| List deployments (paged) | `convex_list_deployments` | `deployments.list` | no | `deployments list` |
| Read one deployment | `convex_get_deployment` | none | no | no |
| Quota | `convex_quota` | in the reaper report | in the report | in the report |
| Plan or run the reaper | `convex_reap_previews` | `reaper.run` | yes | `deployments reap [--live]` |
| Last reaper report | none (a run returns it) | `reaper.report` | yes | `report` |
| Delete one preview | `convex_delete_preview` | `deployments.delete-preview` | no | `deployments delete-preview [--live]` |
| Set a preview's expiry | `convex_set_preview_expiry` | none | no | no |
| Health, usage, usage limits, custom domains, deploy keys, classes and regions, audit events | seven `convex_*` read tools | none | no | no |

Agent only, with no board equivalent yet: `convex_get_deployment`, `convex_quota`, `convex_deployment_health`, `convex_get_usage`,
`convex_list_usage_limits`, `convex_list_custom_domains`, `convex_list_deploy_keys`, `convex_list_classes_regions`, `convex_list_audit_events`
and `convex_set_preview_expiry`.

Every deletion is a dry run unless the caller passes `dryRun: false` (CLI: `--live`), on every surface.

## Configure

The company's plugin config is written by an instance administrator. Every secret field is a `secret_ref`; a plaintext token is rejected.

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
  "grants": [{ "agentId": "<agent uuid>", "preset": "janitor", "environments": ["preview"] }],
  "guards": { "activityHours": 24, "maxDeletesPerRun": 20, "callsPerMinute": 60, "dryRunOnly": false },
  "reaper": {
    "enabled": false, "ttlHours": 36, "quota": 300, "alertPercent": 80,
    "dev": { "enabled": false, "maxAgeDays": 7, "protect": ["dev/pinned-*"], "onlyPatterns": ["dev/ship-*", "dev/issue-*"], "maxDeletes": 20 },
    "ciPreviewTemplate": "pr{pr}-run{run}-s{shard}-a{attempt}",
    "supersededMinAgeMinutes": 60
  }
}
```

Write it with the plugin config API:

```sh
paperclipai plugin config:set vllnt.paperclip-convex -C <companyId> \
  --payload-json '{"configJson":{"teamId":"123","teamToken":{"type":"secret_ref","secretId":"<id>","version":"latest"},"projects":[{"convexProjectId":"456","name":"app","repository":"org/app"}]}}'
```

The config is validated when it is saved with the same strict parser the plugin applies at call time, so a typo, an unknown key, a grant for a
capability this version does not enforce, or a repository such as `../x` is reported at once. Warnings (the config is accepted): a grant by
`role` applies to every agent that has the role, including agents added later; `reaper.enabled` together with `guards.dryRunOnly` never acts.

`github.token` is a fine-grained, read-only token (Metadata, Pull requests, Contents) on the mapped repositories.

Then, as an instance administrator: `paperclipai convex connect -C <company>`, read `paperclipai convex deployments reap -C <company>` (a dry run),
and set `reaper.enabled` only when the plan is what you expect. A company without a valid config shows as `not-configured` in `status`, with the
reason in `configError`.

## Environment classes

`production`, `staging`, `preview`, `dev`, `custom`. The class is computed in the worker from the **re-fetched** deployment
(`GET /deployments/{name}`), never from agent input.

1. The deployment's Convex project must be in the company's mapping and reserved for that company. Otherwise the call is refused with no class.
2. A deployment `name`, `reference` or `previewIdentifier` listed under the project's `environments.production` is `production`. This wins over everything.
3. `isDefault: true` on any type except `dev`, or `deploymentType: "prod"`, is `production`. A name or reference listed under `environments.staging` is
   `staging` unless step 2 or an `isDefault` default-prod already made it `production`.
4. `deploymentType: "preview"` is `preview`. `"dev"` is `dev`. `"custom"` is `custom`.
5. Anything else (missing or unknown type, local deployment, malformed record) is **`production`**.

Operator overrides can only name a class for an explicitly listed deployment; nothing is relaxed by pattern.

## Capabilities and grants

Capabilities: `meta-read`, `health-read`, `logs-read`, `data-read-pii`, `lifecycle`. A capability exists only when a tool of this version enforces it;
a grant for any other name is rejected when the config is saved. A grant is `company -> subject (agentId or role) -> environments[] -> capabilities[]`.
**Default deny**: no grant, no call. Presets expand to capabilities:

| Preset | Capabilities |
| --- | --- |
| `observer` | meta-read, health-read |
| `janitor` | meta-read, health-read, lifecycle |

Every capability is granted per environment class: a grant that lists `preview` gives nothing on production. `lifecycle` is valid on previews only,
whatever the grant says. Grants apply to agent tools; a board user is not subject to grants, but is subject to every guard below.

## Credentials

Tokens are company secrets referenced by `secret_ref`. The worker resolves a secret on demand, keeps it in memory for at most a minute (the host limits
secret resolution per minute; a credential Convex rejects with 401 is dropped at once), and never returns, logs or persists it. The cheapest credential is
tried first: preview deploy key, then project token, then team token. The next one is tried when Convex answers 401, 403 or 404 (a key of another project
answers 403; a deployment the key cannot see answers 404). The credential that worked is tried first from then on. The team token also reads the Deployment
API. A credential is sent only to `api.convex.dev`, to the deployment's own host `https://<deployment name>.*.convex.cloud` (the host must start with the
deployment's name, so another tenant's host never receives it), and to `api.github.com` for the GitHub token.

The management API takes `Authorization: Bearer <token>`; a deployment's own host takes `Authorization: Convex <token>`.

## Company isolation

Config alone grants nothing. `connection.connect` (instance administrator) verifies the credentials with Convex, then **reserves each mapped Convex
project id for exactly one company** in an instance registry. A call for a project that another company reserved, or one not in the registry for the
caller's company, is refused. The caller's company is the host-validated run context, never a parameter.

## Guards on every call

- **Audit**: an activity entry with agent, run, tool, capability, environment class, deployment, outcome, and before and after state for writes. Credentials are never included.
- **Rate limit**: per company and agent, `guards.callsPerMinute` (default 60), fail closed.
- **Blast radius**: at most `guards.maxDeletesPerRun` deletions (default 20) per **agent run**, counted across every tool call of that run and kept for three
  days. It is not a limit per agent per day: a new run has a new allowance. The reaper has its own budget of the same size per pass. A list call returns at
  most 200 rows (default 50). An expiry is at most 7 days ahead.
- **Dry run by default**: `convex_delete_preview`, `convex_reap_previews`, `deployments.delete-preview` and `reaper.run` only plan unless `dryRun` is `false`.
  A real `convex_reap_previews` or `reaper.run` while `reaper.enabled` is off is refused. `guards.dryRunOnly` turns every real request of the company into a
  plan, and the result says so in `note`.
- **Hard delete guard** (`src/hard-guard.ts`, inside every delete, expiry and reaper path, after and independent of grants and company config): only cloud
  `preview` and `dev` deployments pass. Production, custom, unknown-type, local and default deployments never do, and neither does anything whose name,
  reference or preview identifier (the branch) contains one of the words `prod`, `prd`, `production`, `preprod`, `preproduction`, `staging`, `stage`, `stg`,
  `uat`, `live`, `main`, `master`, `release` or `releases` as a whole word. Words are split on punctuation, capitals and digits, an all-capitals run is read
  both ways, and the name is read once more ignoring capitals, so `staging2`, `releaseCandidate` and `PRODdb` count while `maintenance` and `domain` do not.
  Full-width letters are normalised, and a name with letters outside plain ASCII is never deleted, because a look-alike letter could hide a word. No grant,
  preset or setting loosens it. **False positives are expected and are the safe side**: a branch called `fix-live-reload` or `release-notes` is never
  deleted or shortened by the plugin and lives until Convex expires it. An expiry may still move later, because that postpones a deletion. The guard lets
  `dev` through; that allowance belongs to the dev-deployment work in PR #46, which shares these lines and is rebased by example-project.
- **An expiry is a delayed delete.** An agent's expiry earlier than the largest of the preview's current deadline, the deadline the reaper would give it
  (`lastDeployTime + ttlHours`, or `now + ttlHours` for a stale preview) and `now + activityHours` (at most 168) follows the deletion guards and counts against
  the run's deletion cap. Extending a deadline (up to 7 days) is free. The result of `convex_set_preview_expiry` says `countsAsDeletion` and gives
  `earliestFreeExpiresAt`.
- **Evidence before a delete.** An agent's delete needs the same evidence the reaper uses: a closed or merged pull request, or a branch that is gone and has
  been idle for `activityHours`. A closed pull request counts only if its head repository is the mapped repository (a fork cannot name a preview into
  deletion), and it was closed after the preview's last deploy and after the branch's last commit (a reused branch name is a new preview). A preview of an
  open pull request or a recently active branch is kept.
- **Cheap refusals first**: a run that has used its deletion allowance is refused before any network call.
- **Delete outcome**: a delete Convex answers 404, or does not answer, is checked against Convex. If the deployment is gone it is reported as deleted
  (`deleted-verified` in the audit log) and the allowance is given back for a 404; otherwise it is reported as unconfirmed, never as a clean failure.
  A definitive refusal (a 4xx other than 408 and 429) gives the allowance back.
- **Lookups**: "does not exist", "not reachable" and "belongs to another company or an unmapped project" return the same message, so deployment names
  cannot be probed. The message points to `convex_list_deployments`. A call without `name` is told how to pass it.

## The reaper

An hourly job `convex-reaper` (also `reaper.run` and `convex_reap_previews`). For each connected company and mapped project it lists previews and:

1. keeps anything classified staging or production, anything the hard guard blocks, anything with an open pull request or a recently active branch, and
   anything it cannot check;
2. deletes previews whose pull request is closed or merged, or whose branch is gone, in both cases only if the preview has been idle for `activityHours`;
3. sets `expiresAt = lastDeployTime + ttlHours` on kept previews. It shortens an expiry, and it moves an expiry later after a redeploy only when that expiry
   is one the reaper set itself or that an agent set through the tool (it remembers them); an expiry a person chose is never extended. The expiry is recorded
   before Convex is changed and taken back only when Convex refuses the change for certain. When the new moment is less than two hours away, the reaper does
   not schedule it (two hours leaves one hourly pass to see a redeploy); it only gives a preview without any expiry `now + ttlHours`;
4. counts all team deployments against `reaper.quota` and raises one issue each time usage reaches a new 5% level at or above `alertPercent` (not one a day) and
   an activity entry, with a new entry after a day at the same level.

5. **superseded previews of open pull requests.** CI makes one preview per run, shard and attempt, so one pull request can hold dozens. With `reaper.ciPreviewTemplate` (text with `{pr}` once, and optionally `{run}`,
   `{shard}`, `{attempt}` and one flat optional `[ ... ]` part, for example `pr{pr}[-run{run}]-s{shard}-a{attempt}`) the reaper reads the pull request, run, shard and attempt from each preview name. A template must have a letter in its literal text and must not put two numbers next to each other (`pr{pr}{run}` could not be read reliably; use `pr{pr}-run{run}`). A template is not a regular
   expression: it compiles to literals and bounded digit groups and matches the whole name, so a hostile branch name cannot make the worker spin. For an open pull request it deletes a preview that a newer preview of the **same
   shard** replaced (a later run, or a later attempt of the same run; without run numbers, a later attempt), if it has been idle for `supersededMinAgeMinutes` (default 60) and the newer preview still exists at the moment of deletion.
   A shard that was not re-run keeps its newest preview, and numbered and unnumbered previews are never compared. The order and the idle time are checked again on the fresh records at delete time. Without a template, nothing
   about open pull requests is deleted. The template's pull request number is authoritative: a closed pull request is only evidence for a preview when its number matches. The report shows how many previews the template matched
   (`ciMatched`), so a template that never matches is visible. An agent deleting one preview by hand never gets this exception;
6. **dev policy** (below).

### Dev policy

Dev deployments whose `lastDeployTime` (or `createTime` if never deployed) is older than `reaper.dev.maxAgeDays` (default 7, 1 to 90) are deleted by the reaper, **if they match the company's allow list
`reaper.dev.onlyPatterns`**. Convex does not say who made a dev deployment, so the plugin never guesses: with no allow list it deletes nothing and lists the candidates in the report
(for example `["dev/ship-*", "dev/issue-*"]` for agent-made names). The allow list must be narrow: a pattern ending in `*` needs a `/` and at least three characters after it (`dev/ship-*`; `*`, `dev*` and `dev/*` are rejected). It never deletes a default deployment (each member's own `dev/<member>`), a deployment the hard guard blocks, the shared pools
`dev/paperclip-agents`, `dev/local-*` and `dev/qa-*`, anything matching `reaper.dev.protect` (which wins over the allow list), or one of unknown age. Patterns are exact names, or a prefix ending in a
single `*` (a `*` anywhere else is rejected), matched without case. It is **plan only** until `reaper.enabled` and `reaper.dev.enabled` are both true; a dry run, `guards.dryRunOnly`, or a pass an agent started
(`convex_reap_previews`) never delete dev deployments. At most `reaper.dev.maxDeletes` (default 20) per run across all projects, apart from the preview cap. Each deletion is re-fetched first, checked again, audited
with its before-state, and confirmed with a follow-up read (an unreadable follow-up is recorded as `deleted-unverified`). Listing and deleting dev deployments needs a Team Access Token (a project token that can
list also works); a preview deploy key cannot, so the plugin never uses one for dev deployments, not even for the first read.
The plan appears in the report even while the policy is off, so read it before enabling.


`ttlHours` is 3 to 168. It is a dry run until `reaper.enabled` is true. When GitHub cannot be read for a project, the reaper changes nothing in that project.

A pass is bounded. It stops starting work after 4 minutes (the host stops a job after 5), plans up to six previews at a time, changes at most 100 expiries
per project per pass, and stops a project after three failures in a row to reach Convex. The report says why in `incomplete`, and `deferred` counts what was
not examined; the next hourly pass continues with the oldest previews. Before each write the pass reads the config and the connection again: turning the
reaper off, disconnecting the company or shutting the worker down stops it. Companies share one pass budget, and the company with the oldest report goes first.

A pass that is already running is **joined, not repeated**: one pass runs and at most one waits behind it. Concurrent requests (a manual run during the
hourly job, two agents) share the result of the pass they joined. A plan and a real run are kept apart.

Reports keep every entry on the Convex page; the `convex_reap_previews` tool returns counts and the first 25 entries of each preview and dev list, with `truncated`.

## Known limits

- Preview matching assumes Convex derives the preview identifier from the branch name (case and separators are normalized). If a CI step truncates,
  prefixes or renames the identifier, the open-pull-request check and the "branch gone" test can miss. Read the dry-run plan before setting `reaper.enabled`.
- Open pull requests and branches are listed up to 1000 entries each; more fails closed (nothing is deleted). The list of closed pull requests is read
  for the 500 most recently updated ones, and a partial list is acceptable, because a pull request missing from it means "no evidence", never "delete".
- A redeploy between the last check and the delete can race the delete. The window is a few seconds: the open-pull-request and branch
  checks are repeated right before each delete, which narrows it and does not remove it.
- A redeploy shortly before an expiry the reaper set can be missed: the last hourly pass before that moment has already listed the preview, and a skipped pass
  (the worker was down) widens the window. Convex then deletes the preview at the expiry although it was redeployed; the next deploy of the branch creates it again.
- An agent can shorten a preview's expiry within the rules above; a shortened expiry is a deletion by Convex when it passes, and the plugin cannot take it back.
- The deletion limit (`guards.maxDeletesPerRun`, 20 by default) is per agent run. A new run starts with a new allowance, so an agent that holds `lifecycle` on
  `preview` can delete that many previews in every run it starts. Each delete still passes the hard guard, the open-pull-request and branch checks and the
  evidence requirement, and each one is audited. `guards.dryRunOnly` stops all of it.
- A lookup by a name that is not one of the company's deployments tries the mapped projects' credentials in turn and is refused when none finds it. The plugin
  remembers which credential answered, and `guards.callsPerMinute` (per agent, in memory) limits how often an agent can ask.
- The last reaper report is stored whole and replaced on each pass (about 50 KB for 300 previews), and `status` reads it back. The agent tool returns at most 25
  entries per list.
- The quota counts up to 10,000 team deployments. Above that, or with project-scoped tokens only, the answer is `lowerBound: true` or `partial: true`: a minimum.
- `convex_list_projects` reads the company config only; it does not call Convex.
- The health fields Convex shows in its dashboard (failure rate, cache hit rate, scheduler lag, function metrics, insights) have no documented API. The
  health tool lists them under `unavailable`.
- Convex measures its default preview expiry from creation; its docs do not say a redeploy resets it. The reaper follows redeploys only for expiries it set itself.
- Single worker: rate limits, the secret cache, the quota cache and the pass coalescing live in the worker process.

## Test

```sh
pnpm --filter @vllnt/paperclip-convex test
pnpm --filter @vllnt/paperclip-convex typecheck
```

The tests use in-memory Convex and GitHub fakes; nothing calls a real service.
