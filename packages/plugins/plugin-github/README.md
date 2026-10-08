# GitHub for Paperclip

A fork-bundled plugin in `vllnt/paperclip` (`packages/plugins/plugin-github`) using **your own GitHub App**, independent of Paperclip Cloud. Version **0.11.0** makes Paperclip the working surface for the full issue-to-PR loop: GitHub issues become native tasks, agents can work and use GitHub tools, Paperclip can fan out multiple review agents, and approved PRs can be reviewed, merged or auto-merged from Paperclip. New Task can create a linked GitHub issue. GitHub remains the source of truth; Paperclip is the control and execution surface.

## Install and connect

Self-hosted instances of the fork install this plugin automatically on startup once it is built (bundled key `github`, like Providers). The Docker image builds it. In a source checkout, build it before starting Paperclip:

```sh
pnpm --filter @vllnt/paperclip-github build
```

This package is not published to npm.

An existing local install uses `POST /api/plugins/vllnt.paperclip-github/upgrade`. Added capabilities stage an `upgrade_pending` version; an instance administrator reviews its manifest and enables it with `POST /api/plugins/vllnt.paperclip-github/enable`. Configuration, secrets and sync records survive this upgrade. Do not uninstall or purge the plugin to upgrade it.

1. Open **GitHub** in Paperclip and click **Create GitHub App**. Paperclip prefills the manifest, callback URLs and permissions, exchanges the one-time code, and saves the private key in Paperclip Secrets.
2. Approve the App on GitHub and choose the organizations/repositories it can access.
3. Open **Projects → Add Project → Add GitHub repo**, or edit an existing project’s repositories. The native picker uses this plugin’s connection.
4. Open **Tasks**. Issues appear in the normal task list, with a GitHub badge. There is no second external task list.
5. Open **GitHub → Sync & automations**, install the managed workflow skill, and edit it from Paperclip Skills when you need to change review or merge policy.

For Apps created by earlier versions: open the permission links on the plugin page, enable the permissions below, save on GitHub, and approve the updated permissions for each installation. Then click **Refresh**. Read-only installations can still import issues; writes stay pending until access is granted. No key replacement or reconnection is needed.

| GitHub App permission | Access | Used for |
| --- | --- | --- |
| Repository Metadata | Read | Repository discovery |
| Repository Issues | Read and write | Issues, comments, labels and milestones |
| Repository Pull requests | Read and write | PRs, reviews, reviewers and branch update requests |
| Repository Contents | Read and write | Merge and auto-merge |
| Repository Checks | Read and write | PR check results and re-run requests |
| Commit statuses | Read | PR status contexts |
| Organization Projects | Read and write | Organization Projects v2 |

Normal repository operations use fresh installation tokens restricted to the selected repository and required permission. Issue transfers include both accessible repositories in the same installation; organization Projects use an installation token with the permissions needed for project items. This Paperclip deployment is Tailnet-only: setup leaves GitHub webhook delivery disabled, creates no public route or Funnel, and scheduled polling is the event path. The advanced existing-App form accepts an App ID and PEM.

## Manage with the API/CLI

Each company uses its own GitHub App. A company's plugin config names its App ID
and a reference to the company secret holding the App's private key. The config
alone grants nothing: `company-app.connect` verifies the key with GitHub and then
reserves the App ID for that company in the instance registry. A company can use
its App only while the registry reserves that App ID for it and it has not been
disconnected. One App ID is never reserved for two companies, so a config that
names another company's App fails closed. Upgrading from 0.10.1 therefore leaves
every company disconnected until an instance administrator runs
`company-app.connect` for it.

Owner pins live in plugin state, written only by `allowed-owners.set`, which
resolves each login to its numeric GitHub account ID through the company's App
installations. Plugin config holds no owner list. An empty or legacy login-only
owner list denies every installation and repository.

Run the sequence below once with an instance administrator's board API key. It
reads each private key from a file into an environment variable that only
`secrets create --value-env` sees; command lines carry secret IDs, never keys.

```sh
export PAPERCLIP_API_URL="${PAPERCLIP_API_URL:?Set the Paperclip URL}"
export PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:?Set an instance-administrator board API key}"
V_AGENTS_PEM="${V_AGENTS_PEM:?Set the path of the v-agents private key file}"
ANTHM_AGENTS_PEM="${ANTHM_AGENTS_PEM:?Set the path of the anthm-agents private key file}"
PLUGIN=vllnt.paperclip-github
VLLNT=dc1d1a01-1c00-4a67-89f9-4efdde86c7ec
ANTHM=2cae571f-5b44-4253-b73b-7700335a4ccf
json_id() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).id))'; }

# 1. Store each App private key as a company secret; keep only the secret ID.
VLLNT_SECRET_ID="$(GITHUB_APP_PEM="$(cat "$V_AGENTS_PEM")" paperclipai secrets create -C "$VLLNT" \
  --name 'GitHub App v-agents private key' --provider local_encrypted --value-env GITHUB_APP_PEM --json | json_id)"
ANTHM_SECRET_ID="$(GITHUB_APP_PEM="$(cat "$ANTHM_AGENTS_PEM")" paperclipai secrets create -C "$ANTHM" \
  --name 'GitHub App anthm-agents private key' --provider local_encrypted --value-env GITHUB_APP_PEM --json | json_id)"

# 2. Save each company's App config. config:set replaces the whole config and
#    requires {"configJson": {...}}, so merge into the current config to keep
#    settings such as a personal token. A webhook secret reference belongs to
#    its App and is kept only when the App ID is unchanged.
set_app_config() { # <companyId> <appId> <appSlug> <privateKeySecretId>
  local current payload
  current="$(paperclipai plugin config "$PLUGIN" -C "$1" --json)"
  payload="$(CURRENT="$current" node -e '
    const [appId, slug, secretId] = process.argv.slice(1);
    const { webhookSecret, ...current } = JSON.parse(process.env.CURRENT || "null")?.configJson ?? {};
    if (webhookSecret && current.appId === appId) current.webhookSecret = webhookSecret;
    process.stdout.write(JSON.stringify({ configJson: { ...current, appId, appSlug: slug, appName: slug,
      privateKey: { type: "secret_ref", secretId, version: "latest" } } }));' "$2" "$3" "$4")"
  paperclipai plugin config:set "$PLUGIN" -C "$1" --payload-json "$payload" --json
}
set_app_config "$VLLNT" 5203754 v-agents "$VLLNT_SECRET_ID"
set_app_config "$ANTHM" 5203763 anthm-agents "$ANTHM_SECRET_ID"

# 3. Verify each key with GitHub and reserve each App ID for its company.
paperclipai plugin action "$PLUGIN" company-app.connect -C "$VLLNT" \
  --params-json "{\"appId\":\"5203754\",\"privateKeySecretId\":\"$VLLNT_SECRET_ID\"}" --json
paperclipai plugin action "$PLUGIN" company-app.connect -C "$ANTHM" \
  --params-json "{\"appId\":\"5203763\",\"privateKeySecretId\":\"$ANTHM_SECRET_ID\"}" --json

# 4. Pin each company's GitHub owners to numeric account IDs. Install the
#    company's App on each owner first.
BNT_OWNER='bnt''vllnt' # shell concatenation yields the GitHub login
paperclipai plugin action "$PLUGIN" allowed-owners.set -C "$VLLNT" \
  --params-json "{\"owners\":[\"vllnt\",\"maiaos\",\"$BNT_OWNER\"]}" --json
paperclipai plugin action "$PLUGIN" allowed-owners.set -C "$ANTHM" \
  --params-json '{"owners":["Anthm-FR"]}' --json

# 5. Expect "connection": "connected", the company's own App and its owners.
for company in "$VLLNT" "$ANTHM"; do
  paperclipai plugin action "$PLUGIN" company-app.status -C "$company" --params-json '{}' --json
done

# 6. List the repositories each company can reach.
for company in "$VLLNT" "$ANTHM"; do
  paperclipai plugin action "$PLUGIN" repositories.list -C "$company" --params-json '{"refresh":true}' --json
done
```

A test runs this block verbatim against a stub CLI, so keep it runnable when
editing it.

The stable company-management action keys are:

- `company-app.status` returns `configured` and `connection`: `connected`,
  `disconnected`, `not-configured` (no App config) or `not-connected` (config
  saved, but `company-app.connect` has not reserved this App ID for the company).
- `company-app.connect`, `company-app.disconnect`
- `company-app.release` with `{"appId":"..."}` releases a reservation left by a
  deleted or abandoned company. Its former owner, if it still exists, fails
  closed until it connects again.
- `allowed-owners.get`, `allowed-owners.set` (GitHub logins are case-insensitive;
  both return the logins and the pinned `accounts` with numeric IDs)
- `repositories.list` (returns only allowlisted owners)
- `sync.trigger` (starts one company’s sync and returns its company ID)
- `sync-status` reports `connection` without loading the private key.

Invoke them with `paperclipai plugin action <pluginKey|pluginId> <actionKey>
-C <companyId> [--params-json <json> | --params-file <path>]`. The generic
`paperclipai plugin data <pluginKey|pluginId> <dataKey>` command uses the same
`-C`, `--params-json` and `--params-file` options for plugins that register data
handlers. The equivalent host routes are
`POST /api/plugins/:pluginId/actions/:key` and
`POST /api/plugins/:pluginId/data/:key`, with body `{companyId, params}`.

Connection, release, allowlist and App-creation actions require a board user who
is an instance administrator. Status, owner reads, repository listing and sync
triggering remain company-scoped. No action returns a secret value or
installation token, and only one returns a private key: `complete-setup` returns
the private key of a newly created App once, to the instance administrator who
created it, and the settings page immediately stores it as a company secret.
`company-app.disconnect` leaves the Paperclip secret in place so a later
reconnect can reuse it, while releasing the App ID for another company; revoke
the App or delete the secret separately when it should no longer be usable.

Scheduled sync and webhook routing read the connected companies from persisted
plugin state on every run, so they keep working after a worker restart without a
config replay. Plugin health reports how many companies are connected and says
so explicitly when none is. Webhook delivery stays disabled on this Tailnet-only
deployment. A request that does reach the endpoint is rejected with the same
message unless its signature matches a connected company's webhook secret; only
then does the plugin load that company's key and confirm the installation with
its App.

## GitHub inside Tasks and Projects

Open **Tasks** for issues and pull requests. Clicking a GitHub issue or PR number
opens its full view in the native task's right panel. The conversation remains
visible; the panel supports multiple record tabs, Properties, and files. Open
additional linked PRs from the panel's **+** launcher. The panel can be resized
or expanded with the existing window controls.

Use the Tasks toolbar's **GitHub → Pull requests** entry to browse linked
repositories and open a PR as a native tracking task. Repeated opens reuse that
task, including after a failed response. PR tracking tasks initially import open
PRs as Todo and closed/merged PRs as Done; later opens preserve your native task
status. Revision-specific agent review tasks remain separate and are created per
selected reviewer so each perspective is independently inspectable.

Use **New Task → Project → Create in → GitHub · owner/repository** to create a
GitHub issue and its associated task together. The submit button reads
**Create GitHub issue**. Paperclip remains the initial destination. Choosing a
repository is explicit, and retries reuse the same task and publication intent.

GitHub Projects management lives in the native project's GitHub tab. The GitHub
sidebar page contains connection, repository access, permissions and automation
settings. Old GitHub issue/PR page links open the associated native task.

All issues in project-linked repositories import automatically. Issues discovered
through GitHub Projects also receive a native task, provided the App can access
the repository. The worker uses the same cached provider reads and write checks
from each native view.

### Issues

Browse open/closed issues with pagination and search within loaded results, open an exact issue number, create issues, edit title/description, close/reopen, assign GitHub users, replace/clear labels, and set/remove milestones. Read/post/edit/delete comments, react to the issue body or comments, pin it, lock/unlock conversations, transfer an issue to another accessible repository in the same installation, or delete it with typed confirmation. Subscribe or unsubscribe from GitHub notifications for the item. GitHub enforces actor ownership and admin restrictions on comments, transfers and deletion. A deleted GitHub issue does not delete its native Paperclip task.

**Repository labels & milestones** provides create/edit/delete controls and milestone dates. A linked native task’s GitHub panel also has **Manage GitHub issue**, so its GitHub metadata and conversation can be managed from that task. Direct GitHub edits trigger the existing task reconciliation; competing native edits still produce a conflict instead of silently overwriting.

### Pull requests

Browse PRs, create from existing head/base branches (draft by default), edit title/body/base, close/reopen, mark ready or convert to draft, and manage labels, assignees and milestones. Request/remove user or team reviewers. Read the conversation, commits, paginated file patches, checks, reviews, inline comments and review threads. Re-run a failed or completed check run when the App has Checks write access; each run shows its status and GitHub details link. Post a review comment, approve or request changes; add a line comment, reply/edit/delete comments, resolve/reopen a thread, or dismiss a review with a reason and confirmation.

Merge, squash or rebase through GitHub’s merge API, enable/disable auto-merge, and request an update from the base branch. Merge and auto-merge require typed `owner/repository#number` confirmation. Review, inline comment, update-branch and merge operations verify the current head SHA; merges also pass that SHA to GitHub so a concurrent push cannot merge an unseen commit. GitHub retains all branch protection and merge rules. No force merge, branch deletion or check override is provided. GitHub still owns branch protection, merge queue policy and workflow cancellation.

**Delegate review to Paperclip agents** creates one linked Todo task per selected perspective. Agent Channels, GitHub bot identity, comments, formal approvals and request-changes actions are owned by Paperclip’s native GitHub connector. The plugin keeps a legacy login mapping only for routing GitHub reviewer requests; it never impersonates an agent or claims a distinct review author. Enable and assign the native GitHub chat connector before enabling agent wake in an automation rule. Agent checkout credentials remain separate.

### GitHub Projects v2

Browse organization projects, create a project, edit title/summary/README, close/reopen, change visibility, or delete with typed confirmation. Add existing issues/PRs, create/edit drafts, convert a draft to a repository issue, archive/restore/remove items, and change item order. Manage repository links.

Read and edit **text, number, date, single-select and iteration fields**, including clearing a value. Create, rename and delete custom fields; replace single-select options or an iteration schedule with confirmation because GitHub may clear existing item values. Built-in issue/PR fields are edited on the source item. Projects and items are paginated; restricted content stays restricted. These are GitHub Projects, distinct from native Paperclip Projects.

Personal Projects use **Connection settings → Personal Projects access**. Create a classic user token with `project` scope from the prefilled link, paste it once, and the plugin verifies the account before storing it in encrypted Paperclip Secrets. Add `repo` scope only if private repository content is needed; authorize SSO where required. The token is only used for personal Projects, not repository/PR actions, and is never stored in plugin config. Only the authenticated user’s personal projects are exposed. Organization Projects continue to use your App. While the company writes as its GitHub App user (see App user identity below), personal Projects are read-only: the personal token is outside that identity's fence, kill switch, throttle and audit.

### Write safety and recovery

All management actions require a Paperclip board user and the selected company’s connected App. Repository IDs must be discovered through that App; project ownership, item/field membership and comment/thread ownership are read back before mutation. Browser input cannot supply an arbitrary API path or GraphQL query. A body-free activity entry is written before each provider mutation.

Mutations use a company-scoped durable request receipt. Double submits with the same request ID execute once. A lost network response stays unconfirmed and is not blindly retried. Refresh the item and check the outcome before starting a new action. Definitive HTTP permission/validation rejections may retry. Validation that fails before a provider mutation does not leave a pending receipt. A successful write whose view cannot refresh is explicitly shown as saved.

### Write identity: who acts on GitHub

One policy per company (instance administrators change it with
`write-identity.set`; board users read it with `write-identity.get`). Without a
saved policy, agent `git`/`gh` act as the run's user and this plugin writes as
the App. Full rules: [`doc/execution-github-identity.md`](../../../doc/execution-github-identity.md#write-identity-who-acts-on-github).

- **`userSource: "run"`** (the **Write identity** panel): per action and
  `owner/name` override, a write uses the run's user (dedicated account or the
  responsible person's connection) or the App (`<app-slug>[bot]`). This
  plugin's tools keep writing as the App.
- **`userSource: "app"`**: every write is done by one person (`userLogin`)
  through this company's own App user token; reads and the issue mirror stay on
  the App installation. This plugin's sync write-back, board actions and agent
  tools write as that person too, through the same gates.

**The App only reads under `userSource: "app"` (I-RO).** The decision is per
company and is read on every token mint: for such a company, every App
installation token (managed reads, issue mirror, sync, catalog listing, board
reads) is read-only and names one repository by ID or the company's fenced
repositories by name, never the whole installation. A write scope, a missing
permission subset, an installation-wide token or a repository outside the
fence is refused before GitHub is called, so nothing falls back to an App
write. Saving the policy drops cached tokens and the catalog, so switching a
company to the App user removes its App writes at once: App write tokens this
worker minted in the last hour are revoked, and a token GitHub mints during the
switch is revoked instead of used (tokens from an earlier worker process expire
within the hour). Companies with `userSource: "run"` or no policy keep their
App's write tokens (sync write-back, board actions, organization Projects,
agent tools and `bot` writes). The check is Paperclip's one mint function
(`@paperclipai/shared/github-installation-token`), which the server's native
GitHub code uses too; the native GitHub connector is refused for an App-user
company and for its App.

#### App user setup (anthm)

GitHub side (an Anthm-FR owner):

1. `anthm-agents` App settings: turn on **Device Flow**, keep **Expire user
   authorization tokens** on, generate a client secret. Permissions: add
   Actions write and Deployments write; set Checks to read; never add
   Statuses write or Administration; Workflows write only if agents may edit
   CI. Approve the change on the Anthm-FR installation.
2. Narrow the installation to **Only select repositories** with exactly the
   repositories in `installationRepositories`.
3. Add the public signing key below to the person's account as an **SSH
   signing key**.

Paperclip side (instance administrator, continuing the sequence above):

```sh
# Secrets: the App client secret, a placeholder the plugin overwrites with the
# rotating refresh token, and the ed25519 signing key (ssh-keygen -t ed25519 -N "").
CLIENT_SECRET_ID="$(GITHUB_SECRET="$(cat "$ANTHM_CLIENT_SECRET_FILE")" paperclipai secrets create -C "$ANTHM" \
  --name 'anthm-agents client secret' --provider local_encrypted --value-env GITHUB_SECRET --json | json_id)"
REFRESH_SECRET_ID="$(GITHUB_SECRET=unset paperclipai secrets create -C "$ANTHM" \
  --name 'anthm-agents user refresh token' --provider local_encrypted --value-env GITHUB_SECRET --json | json_id)"
SIGNING_SECRET_ID="$(GITHUB_SECRET="$(cat "$ANTHM_SIGNING_KEY_FILE")" paperclipai secrets create -C "$ANTHM" \
  --name 'Paperclip anthm agents signing key' --provider local_encrypted --value-env GITHUB_SECRET --json | json_id)"
# Merge into the company config: userClientId (the App's client ID, not a secret),
# userClientSecret, userRefreshToken and signingKey as {type:"secret_ref",secretId,version:"latest"}.

# Policy. Writes start on songtrivia and anthm-fr; the other repositories stay
# readable until the review gate is live (add them to allowedRepositories later).
paperclipai plugin action "$PLUGIN" write-identity.set -C "$ANTHM" --params-json '{"policy":{
  "default":{"commit":"user","push":"user","pullRequest":"user","comment":"user"},
  "userSource":"app","userLogin":"'"$BNT_OWNER"'","enabled":false,
  "allowedRepositories":["Anthm-FR/songtrivia","Anthm-FR/anthm-fr"],
  "installationRepositories":["Anthm-FR/songtrivia","Anthm-FR/anthm-fr","Anthm-FR/linkzic","Anthm-FR/wordzic","Anthm-FR/nextdle"],
  "installationPermissions":{"actions":"write","checks":"read","contents":"write","deployments":"write","issues":"write",
    "metadata":"read","organization_projects":"write","pull_requests":"write","statuses":"read"},
  "privileged":{"adminMerge":true,"deploymentApproval":true,"workflowDispatch":true,"wiki":true,
    "release":false,"tagPush":false,"pushToMain":false,"editWorkflows":false},
  "throttle":{"perMinute":30,"perHour":300},"bodyFooter":false}}' --json

# Consent: show the code, the person enters it at https://github.com/login/device,
# then poll every few seconds until "authorized" with "fence": {"ok": true}.
paperclipai plugin action "$PLUGIN" user-authorization.start -C "$ANTHM" --params-json '{}' --json
paperclipai plugin action "$PLUGIN" user-authorization.poll -C "$ANTHM" --params-json '{}' --json

# Turn writes on (the same policy with "enabled": true); the save re-checks the fence.
```

`user-authorization.check` re-runs the fence check; `user-authorization.status`
shows the person, token expiry and the last check (never a token). Any drift
turns writes off; fix it, then save the policy with `"enabled": true` again.
The kill switch is the same save with `"enabled": false`: writes stop at the
next command, reads continue.

## Native tasks and synchronization
## Native tasks and synchronization

- Open GitHub issues import as **Todo**. Completed issues import as **Done**; “not planned” issues as **Cancelled**. Pull requests become native tracking tasks when opened from the Tasks PR browser.
- **New Task → Create in** offers **Paperclip** or **GitHub · owner/repository** for the selected project. The initial choice is Paperclip; an explicit choice is remembered per company and project. GitHub creates one linked native task and one GitHub issue. Attachments, agent execution settings, budgets and approvals stay in Paperclip.
- Title, description and open/closed state sync both ways. Backlog, Todo, In Progress, In Review and Blocked all correspond to GitHub Open; changing between those native statuses does not reset the task. Done closes as completed; Cancelled closes as not planned; reopening on GitHub returns the task to Todo.
- GitHub webhooks are not delivered to this Tailnet-only Paperclip. Setup leaves the webhook subscription inactive; the scheduled one-minute sync is the event path. If a delivery reaches the endpoint anyway, it is accepted only when its HMAC signature matches a connected company’s webhook secret and its installation belongs to that company’s App.
- Native filters, search, assignment and task detail work normally because imported issues are ordinary tasks. The task’s **GitHub** panel opens its exact source issue, publishes an existing task, links an existing GitHub issue, or resolves a conflict.
- Linking an existing issue explicitly adopts GitHub title, description and state on the next sync. An issue already linked to another native task cannot be linked twice.
- A GitHub issue shared by multiple linked projects produces one task. New imports use the linked project with the smallest stable ID; an existing task keeps its linked project. Moving the task to a project without the repository pauses its synchronization. Unlinking repositories never deletes tasks or GitHub issues.
- Native deletion is retained as a plugin mapping tombstone. Remote deletion or loss of access never deletes a native task automatically.

- Every displayed issue has an **Open task** link (or its task identifier). Creation failures are shown on the issue and retry on the next read. Deleted native tasks stay deleted and are clearly labeled.
- When a previously projectless issue’s repository is linked to a project, its existing task joins that project on the next sync. Manual moves to an unrelated project still pause synchronization.

## Read caching

Repository discovery, issue/PR pages and details, comments, diffs, and Projects reads share a worker-local cache for 30 seconds. Repeated and simultaneous requests reuse the same result. Company and credential fingerprints isolate entries; the cache holds no tokens, persists nothing to disk, retains at most 64 entries, and skips responses over 1 MB. Errors are not cached and expired data is not returned as fresh.

**Refresh** fetches current GitHub data. Successful or uncertain writes invalidate the company cache, and connection changes clear it. Provider writes, merge/review head checks and ownership checks always use fresh data. Access revocations can take up to 30 seconds to affect an already cached read; they cannot authorize a provider write. The view shows when its data was fetched and retains an explicit error if refreshing fails.

The Tasks toolbar polls local sync status every 30 seconds while idle and every second during sync. Page/focus refreshes reuse a sync report less than a minute old; **Sync now** bypasses that limit and the discovery cache. Background synchronization still reads GitHub issue changes directly every minute.

## Event routing

Open **GitHub → Sync & automations → Add rule** for mechanical task routing. Review, merge and monitoring policy is configured in the managed **GitHub review workflow** skill.

Example: **If GitHub assignee is `alex`, repository is `acme/api`, and label is `bug`, then assign to `API Engineer`, move to Todo and set High priority.** Optionally enable **Wake assigned agent** to request a run through Paperclip’s normal assignment, checkout and budget controls.

Conditions support GitHub assignee, repository, label and open/closed state. Conditions within a rule are combined with AND. Rules run in listed order; the first matching enabled rule wins. Rules apply when imported, when the matching rule changes, or when that rule is edited. Unchanged rules do not continually overwrite manual task routing. Closed tasks can receive assignment/priority changes but stay closed and never wake agents. Active execution defers incoming edits and routing until the run releases the task.

No routing rules are enabled until saved. GitHub users and Paperclip agents are separate identities: selecting an agent does not invent or change a GitHub account assignment. Pause automatic sync using the same settings section. Explicit publication remains available while background sync is paused.

## Failures and recovery

- Competing edits to the same title, description or state pause that pair. Open its GitHub panel and choose **Use GitHub** or **Use Paperclip**. The plugin does not use silent last-write-wins. GitHub has no conditional PATCH API: it re-reads changed pairs before writing, but simultaneous edits during the network request cannot be made atomic across both systems.
- Native creation uses the host’s durable, plugin-namespaced idempotency key. A retry does not create a second task. Separate source issues with identical titles remain distinct.
- GitHub creation stores intent before POST and includes a hidden HTML receipt in the body. If the response is lost, sync searches all repository issue pages for that receipt. An uncertain POST is never automatically repeated. If no receipt can be found, check GitHub and use **Link an existing GitHub issue**; do not remove receipts from pending publications. Definitive permission/rate-limit rejections can retry after recovery.
- Partial repository failures retain successful tasks and appear in **Sync needs attention**. The compact **GitHub** control inside the Tasks toolbar shows warnings, last sync time, **Sync now**, and a configuration link. A green connection indicator means repository discovery succeeded; it does not imply every task was synchronized.
- GitHub assignees, labels and issue bodies are treated as data. Rules are validated fields, not executable expressions. Rule saves and native mutations use host activity logging.
- Disconnect marks the company disconnected and stops provider access. Projects, native tasks, sync records, config and vault secrets remain. Revoke GitHub installations/keys on GitHub when appropriate.

## Boundaries

This release supports the management operations listed above on GitHub.com. It does not replace repository administration or every GitHub feature: saved Project view/layout configuration, sub-issue/dependency graphs, attachment upload, merge queues, code editing/conflict resolution and branch deletion remain on GitHub. Issue/comment reactions and check reruns are supported where the App permissions allow them; GitHub Actions workflow administration remains on GitHub. GitHub API limits also apply (for example large/binary file diffs and the PR files endpoint limit).

Native task title/description/state sync remains bidirectional. Labels, assignees and comments can now be edited directly on GitHub through these screens; they are not mirrored to Paperclip’s native labels, agent identity or chat. GitHub Projects field conditions are not yet automation-rule inputs. PR review delegation is explicit; merge and auto-merge remain guarded actions that require a current head SHA, GitHub branch protections and explicit confirmation. This Tailnet-only release has no public webhook route or Funnel; Enterprise Server remains outside this release.

Company-scoped configuration and state prevent cross-company task access. Board actions validate their authenticated company; background jobs use only companies delivered through authorized plugin configuration and each company’s own App. Version 0.11.0 requires the native `chat.endpoints.read` host bridge for agent routing and ships an editable `github-review-workflow` company skill. GitHub App permissions still require installation approval. Plugin workers and same-origin plugin UI are trusted code, subject to the SDK’s supported capability gates; this is not a sandbox.

Private keys are stored only in Paperclip Secrets. Config contains vault references, never PEMs. Setup state is random, hashed, company/user/browser-bound, expires after 55 minutes and is consumed before exchange. Tokens are short-lived and not persisted. Setup always keeps the required inactive `https://example.com/events` placeholder because GitHub webhooks are not delivered to this Tailnet-only Paperclip. If a webhook secret is configured, deliveries are HMAC verified against the exact raw body before any key is loaded, then routed by installation ID for the signing company only; unknown installations, missing secrets and bad signatures fail closed with one uniform error. Browser callback URLs may use localhost.

Repository discovery is bounded to 1,000 installations and 1,000 repositories per installation and reports truncation. Issue pages are all followed, with 20-second provider timeouts and a 4 MB response limit. Initial synchronization time depends on linked issue volume. Host additions required: `projectRepositories`, `taskListToolbar` (alongside `taskListSection`), `taskCreation`, SDK issue project updates and idempotency options, and the staged upgrade approval fix. Older hosts need these extensions before installing this version.

## Development and verification

From the repository root:

```sh
pnpm --filter @vllnt/paperclip-github dev        # watch build
pnpm --filter @vllnt/paperclip-github typecheck
pnpm --filter @vllnt/paperclip-github test
pnpm --filter @vllnt/paperclip-github build
```

The plugin uses the workspace `@paperclipai/plugin-sdk` and `@paperclipai/shared`; runtime SDK code is bundled in `dist/worker.js`. The host supplies React and the UI bridge. No Paperclip server internals are imported by the plugin.

Installed plugins watch rebuilt `dist/` output; refresh the browser for UI changes.

For a live acceptance pass, use a disposable repository, link it in Projects, compare native imports, create a task with the GitHub destination, edit each side, close/reopen, and save an assignee-to-agent rule with wake disabled before opting into execution. Automated provider tests use fixtures; they never post test issues into your repositories.

## 0.5.0 — Task links and details

Native Tasks lists now show source issue and linked pull request columns. Use
Columns to hide either; selections stay local to the company and collection.
Click a number to open its native task panel. The full view includes an external
GitHub link. The PR menu and the task's GitHub section in the right Properties
sidebar also offer **View PR** inside Paperclip. The sidebar shows
repository, sync/conflict state, GitHub state, author, assignees, labels,
milestone and update time when available. PR review tasks additionally show
branches and requested reviewers.

PR links come from GitHub's `closedByPullRequestsReferences`, including closed
and manually linked PRs, capped at 10 per issue with overflow indicated. This
includes closing relationships, not arbitrary textual mentions. Reads are
batched (20 issues per GraphQL request), scoped to the company/App, and cached
for 30 seconds. Missing PR permission is shown as a settings shortcut, not as
"no PRs". The sidebar Refresh bypasses the cache. Access still requires the
App installation to approve Pull requests read (write for management).

Connection setup keeps permission details under **Enable PRs & Projects**.
It lists only missing App permissions and the installations needing approval.
Native project linking remains in Projects. An unavailable repository warning
names the project so a stale link can be removed there.

This version requires the host's `taskCreation.linksAction` contribution support
from this development checkout. Rebuild the host and upgrade the local plugin
when moving from 0.4.0; a plugin bundle alone cannot add native host columns.

## 0.6.0 — Native task record panels

Issue/PR management no longer lives on the GitHub settings page. Full record
views use the native task panel, with rendered Markdown, comments, PR code,
reviews, checks and existing mutation controls. Task sync conflicts can be
resolved from the issue panel. Record tabs are local to the account/company/task;
restored and deep-linked records are checked against current links before the
host mounts a plugin view. Missing access has an explicit retry/error state.

This package requires the accompanying host changes for `PluginTaskLink.panel`
and `PluginDetailTabProps.context.taskRecordId`. A plugin upgrade alone cannot
add native panel support to an older Paperclip host. No extra GitHub permission
is introduced by this version; PR access still needs installation approval.


## 0.9.2 — Paperclip-first execution and review workflow

Issue and PR panels start in **Conversation**, showing the description, dated
comments and a **Write / Preview** composer. **Post comment** publishes to GitHub
as the connected App. The Paperclip conversation remains separate. PRs also have
**Files**, **Reviews**, **Checks** and **Commits** in a compact horizontal tab bar.
Files show their patches directly. Review comments, replies, decisions and thread
resolution remain available; editing, triage, merge and other actions use focused
dialogs instead of expandable sections in the record view. GitHub permission
checks, reviewed-commit checks and typed destructive confirmations remain in force.

Draft comments and supported record forms survive tab changes in the same browser
session, scoped to the current user/company/repository/record. Successful saves
clear their draft; confirmations and wake options are not restored. Exact pending
request IDs survive record remounts so a failed response can be retried without
silently creating a second GitHub write. These browser drafts do not sync across
devices and are separate from the plugin's provider-read cache.

### Agent execution and review fan-out

A GitHub issue imported into Tasks is an ordinary Paperclip task. A saved event-routing
rule can assign it to an agent and request its normal Paperclip wakeup. The agent
works in the linked project workspace, then uses the plugin's scoped tools to read
the issue or PR, create or edit issues and PRs, comment, request reviewers, submit
a review, rerun a check, and merge or enable auto-merge. Every tool call is scoped
to the run's company, project and agent, requires an explicitly selected
`owner/name` repository, and records an activity receipt.

Agent Settings shows the native Paperclip GitHub channel assigned to each agent.
Selecting several channel-backed agents creates several linked review tasks for
the same PR revision, so their perspectives stay independent. Native Paperclip
owns bot identity and governed formal reviews; the plugin App remains the
repository/task management actor.


## 0.12.0 — Write identity and the App user

- Per-action write identity (App or the run's user) with repository overrides,
  stored per company (**Write identity** panel).
- `userSource: "app"`: one person's App user token for every write, the App
  installation for reads, device-flow consent, a rotating refresh token kept in
  a company secret, an hourly fence check that turns writes off on drift, a
  kill switch, a repository allowlist, privileged-action toggles, a write
  throttle, an admin-merge guard, a protected-path merge guard (no agent merge
  touching `.github/**`, CODEOWNERS or, in the control repository, `paperclip/**`,
  `scripts/**` and the base branch's `paperclip/tiers.yaml` list; no auto-merge
  or merge queue) and server-side commit signing.
- Declares `writeIdentityAction`, `signCommitAction` and the
  `secrets.write-own` capability; upgrading asks the operator to approve it.
  Behaviour is unchanged until a policy is saved.

## 0.11.0 — Company GitHub Apps and owner allowlists

GitHub App credentials, owner allowlists and repository discovery can be managed
per company through the Paperclip action bridge and CLI. Scheduled sync runs in
the host-authorized company context for each connected company. See **Manage
with the API/CLI** above for the vllnt and anthm setup.

## 0.10.1 — Native connector boundary and skill-first workflow

The plugin now treats Paperclip’s native GitHub connector as the authority for Agent Channels, bot identity and governed formal reviews. The plugin owns the user’s GitHub App connection, repository and Projects management, caching, webhooks, task synchronization and safe provider actions. The GitHub page’s **Sync & automations** disclosure checks for an active native GitHub channel and links to `/apps/chat/connect?provider=github&purpose=chat`; agent assignment, reviewer routing and wake operations require a channel assigned to each selected agent. Custom review and merge policy belongs in the editable `github-review-workflow` Paperclip skill; GitHub branch protections remain the final merge gate.

### Skills and per-repository policy

Install the bundled **GitHub review workflow** skill from the plugin setup action
(or from Company → Skills). Edit the skill for each company’s review and merge
policy: required bot perspectives, human approval, request-changes rules,
auto-merge conditions, merge-queue handling and post-merge monitoring. The
plugin enforces provider permissions, current-SHA guards, idempotency and task
receipts; the skill decides when an agent should act. Use native GitHub branch
protections as the final repository-level guard.
