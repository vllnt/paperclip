# GitHub identity during agent execution

Shared agents use the GitHub connection of the person whose accepted instructions they are executing. Task ownership remains unchanged. GitHub is optional: ordinary work can start without a connection; a private checkout, authenticated API call, or commit can fail when that operation needs credentials or author metadata.

## Accepted instructions and continuations

`run_identity_contexts` records ordered revisions, stored message authors, originating causes, parent contexts, acceptance state, and redacted GitHub outcomes. `heartbeat_runs.active_identity_context_id` selects the current revision. Existing historical runs are not backfilled with inferred authorship.

Human messages use their stored authenticated author. Queued messages retain their delivery order. Accepting steering reserves a pending revision before delivery, then activates it after the provider acknowledgement. Rejected delivery leaves the prior revision active. An uncertain acknowledgement holds new credential acquisition; a later acknowledgement or its authenticated native event receipt reconciles the reservation. Replays cannot reactivate an older revision. Activation locks the task before the run, matching task and queue mutations so concurrent status changes cannot deadlock identity initialization.

Delegated work and interactions persist their originating context. Retries retain the originating run's active context. Background continuations carry their source run; dependency wakes use the task's continuation context, independently of its owner. Scheduled and webhook routines use the routine's responsible person; manual invocations use the caller, and edits preserve the routine's responsible person.

## Managed GitHub operations

Executions with managed GitHub configured receive token-free `git` and `gh` launchers. Each launcher invocation resolves one eligible credential from the current run's accepted identity at operation start. A `gh` command's child Git processes inherit that command's captured identity; later steering does not change already-started operations.

### Agent attribution

With a personal grant, GitHub shows the person as the author, committer, pusher and PR author. The broker can therefore also return the acting agent's name and run ID (never a credential), and the launchers mark agent text without changing the GitHub actor. A company's write identity policy turns this off with `bodyFooter: false` (the default for the App user, whose writes GitHub already badges with the App). Commits are never rewritten: GitHub's App badge (`performed_via_github_app`), the audit log and, with server-side signing, the signing key identify agent commits.

- `gh pr create|comment|review|edit` and `gh issue create|comment|edit` bodies end with `_Posted by Paperclip agent <agent> (run <run-id>)._`. This covers `--body`, `-b`, `--body=`, and `--body-file`/`-F` (including stdin). A body file is copied into the operation's private scratch directory; the agent's own file is never edited. `gh api` calls are not rewritten.
- GitHub rejects APPROVE and REQUEST_CHANGES reviews from a pull request's own author. When an agent acting as that account gets this refusal from `gh pr review --approve|--request-changes`, the launcher posts the same verdict as a comment review instead of failing. A branch protection rule that requires an approving review still needs another account.

Native runners retain a session-owned broker and launcher path across warm turns. The provider keeps an opaque transport token, not a GitHub credential or the previous run's signed capability. After acquiring exclusive session ownership, the controller binds the broker to the current company, agent, task, and run. Requests cannot choose another run or responsible person. The broker rejects requests while idle and discards credential responses if their run binding changed during acquisition. Each operation still rechecks the live run, accepted identity, grants, and trust policy through the shared credential resolver. Changing run IDs alone no longer replaces the provider process; changes to authentication mode, provider credentials, permissions, or other session configuration retain their existing retirement rules.

The session broker listens only on controller loopback and accepts only its authenticated GitHub credential operation. Remote executions reach it through the existing authenticated callback bridge. Its transport and launchers are retired with the provider session. If remote bridge startup fails, anonymous launchers keep ordinary work available; the next run retries setup with a fresh session. Controller restart/cold recovery still uses the existing checkpoint and process-recovery rules; the broker's in-memory authority is not persisted for adoption.

Other adapters continue using the run-scoped signed capability and public broker endpoint. That endpoint rejects browser origins and session cookies, validates a distinct signed runtime scope, and rechecks the company, agent, and live run. GitHub credentials are returned only to the managed command process, never persisted in identity history or injected into the long-lived provider process.

Low-trust executions cannot receive raw GitHub credentials, including dedicated
agent tokens. The broker rechecks current agent, project, task, and retained run
policies before credential resolution. An external guest's internal sponsor is
accountable for the task, but does not authorize using the sponsor's account.
Read-only access must use separately authorized tools that enforce that boundary.

Server-side Git operations and GitHub gateway calls follow the same selection rules. Approved gateway operations retain their signed originating identity. Connection audience and tool policies continue to apply to the selected person's connection. Native catalogs remain stable across identity changes, but each invocation resolves the selected grant again. Personal OAuth secret declarations survive connection pauses and metadata edits.

Managed commands disable ambient Git credential helpers, Git global/system configuration, host GitHub CLI configuration, and host SSH identity access. Per-operation GitHub CLI configuration is isolated in a writable configuration directory beneath the managed launcher directory. Missing credentials clear previous author and token values; no teammate, standing delegation, host token, or company-default user's account is substituted. Anonymous/local operations remain available where supported.

Without a managed identity, local commits can use an explicitly configured
repository identity or `git -c user.name=... -c user.email=...`. The launcher
leaves author/committer environment variables unset and requires configured
identity instead of guessing the host user's details. Managed shell profiles
remove empty identity overrides after environment merging, so agents do not
need to unset them per command. A captured managed identity still takes
precedence over repository configuration.

Remote launchers prepend their directory to the execution target's effective
`PATH`. An explicit remote `PATH` override is preserved; otherwise Paperclip
reads the provider's environment before staging the launcher shell files.
This keeps legacy NVM and user-local agent installations available alongside
newer images with system-wide CLIs. The generated shell files retain that
combined path with managed `git` and `gh` first. The launcher directory has
its own CommonJS package scope, so the extensionless Node launchers work
inside repositories that declare `"type": "module"` without changing the
project's package configuration. Sandbox command checks use
the same sanitized environment as execution, so a CLI visible only in the
provider's default environment cannot pass the launch check. Failed path
discovery stops startup instead of silently falling back to a minimal path.

Scripts that previously read a persistent `GH_TOKEN` must use managed `git`, `gh`, or GitHub gateway tools. Managed execution skips legacy GitHub token bindings in agent, environment, project, and routine configuration before secret preflight. Configure personal or dedicated access through the GitHub connection instead. Directly invoking an unmanaged executable or retaining a token obtained during an earlier invocation is outside the managed invocation contract.

## Write identity: who acts on GitHub

The GitHub plugin's write identity policy (one per company, changed only by
instance administrators) decides who acts on GitHub for managed `git`/`gh` and
for the plugin's own writes. Without a saved policy nothing changes: `git`/`gh`
use the run's identity and the plugin writes as its App.

`userSource` says who "the user" is:

- **`run`**: the run's normal selection above (the agent's dedicated account,
  otherwise the responsible person's personal connection). Per action
  (commit, push, pull request, comment) and per `owner/name` glob override, a
  write uses that user or the company's App (`<slug>[bot]`, with a token for
  that one repository). `missingUserConnection: "use_bot"` lets a user write
  without a connection fall back to the App; `"fail"` stops it.
- **`app`**: the one person (`userLogin`) who authorized the company's own
  GitHub App. Writes use that person's GitHub App user token; reads use the
  App's installation. GitHub limits the user token to the App's installation
  and permissions, so the fence also holds for a captured token. Every action
  writes as the user and nothing ever falls back to the App bot.

### The App user (`userSource: "app"`)

**Consent.** An administrator runs `user-authorization.start`; the person enters
the code at github.com/login/device; `user-authorization.poll` stores the
result. The App must have Device Flow and "Expire user authorization tokens"
on: an access token valid for more than 8 hours, or a refresh token without an
expiry, is refused. The access token stays in the plugin worker's memory. The
rotating refresh token is written back to the company secret bound at the
plugin's `userRefreshToken` config path (`ctx.secrets.storeOwn`) and never
reaches a run. Refreshes, rotations and revocations run one at a time per
company, so a refresh in flight can never overwrite a revocation.

**Every operation goes to the plugin**, reads included. The run's own GitHub
connection is never consulted for that company, a plugin that cannot answer
fails closed, and a saved policy keeps the company in managed mode, so turning
writes off never hands runs back to a host or bot credential.

| Operation | Credential |
|---|---|
| Read (`fetch`, `clone`, `gh pr view`, `gh api` GET…) | Read-only installation token for one fenced repository, or for all fenced repositories when the command names none (GraphQL, search). Either carries org Projects read when the installation grants it. Cached 50 minutes. |
| Local command (`status`, `commit`, `rebase`…), or a git command that only reaches local paths | No token: only the person's commit identity, plus the signing key for commit-creating commands. |
| Write | The user token, after the gates below. |

**The App only reads (I-RO).** For a company whose policy has
`userSource: "app"`, every installation token the plugin mints for its App
(managed reads, the issue mirror, sync, catalog listing, board reads) asks for
an explicit read-only permission subset and names either one repository or the
company's fenced repositories (`installationRepositories`, default the write
allowlist); it is never installation-wide. A request for any write scope,
without the subset, installation-wide or outside the fence throws before
GitHub is called, so no code path can fall back to an App write. The check runs
on every mint, and saving the policy drops cached tokens and the catalog, so a
company that switches to the App user loses App writes at once. Companies
without that policy keep their App's write tokens.

Every installation token Paperclip asks GitHub for, in the plugin and in the
server's native GitHub code (chat bots, reviews, checks, repository inventory,
receipt reactions, webhook recovery), goes through one function,
`mintGitHubInstallationToken` (`packages/shared/src/github-installation-token.ts`);
a test fails if `access_tokens` appears anywhere else. On the server the fence
applies when the company writes as its App user, or when the App is the one
an App-user company's GitHub plugin is connected to; an unreadable policy
counts as an empty fence. The native GitHub connector (bot registration, bot
credentials, repository inventory) is refused for such a company and such an
App with a clear error (`github_app_user_identity`). Its chat runtime is
refused too: the Chat SDK GitHub adapter mints installation-wide App tokens
inside the dependency, so the server never starts or hands out a GitHub chat
runtime for such a company or App, and saving an identity policy stops every
running GitHub runtime that is now refused. A server process other than the
one that saved the policy stops its runtime the next time it asks for it; a
runtime it already holds keeps running until then.

A switch to the App user also closes App writes already in flight: a token
GitHub mints while the company switches is revoked
(`DELETE /installation/token`) instead of handed out; the plugin revokes the
App write tokens it minted in the last hour when the policy is saved, and the
server refuses an App write credential the plugin returned under the previous
policy. **Remaining window:** an App write token minted by an earlier plugin
worker process (before a restart) is not known to the new one and stays valid
until it expires, at most one hour after it was minted; treat the hour after
a switch to the App user as that window.

**Only github.com.** Every destination a command names must be a github.com
repository: `-R`/`--repo`, `GH_REPO`, URL arguments, `gh repo` repository
arguments, `gh api` endpoints and `--hostname`, git URL targets, every push URL
and the remote's fetch URL. Another host (including GitHub Enterprise and
`*.ghe.com` hosts, `github.localhost`, `ssh.github.com`), a remote helper
(`transport::address`), a URL with a query or fragment, or a name Paperclip
cannot read refuses the whole command, reads included. These refusals, and
the unknown git commands and options below, apply to every company, with or
without a write identity policy: they protect the credential itself. The
launcher pins `GH_HOST=github.com` and drops `CODESPACES`. Remote names are
percent-decoded and normalized before the wiki and fence checks; a configured
remote name is resolved before an argument is read as a path, and option values
(`--depth 1`, `-b branch`) are never read as the destination. `gh api`
endpoints are read the way GitHub routes them (decoded, without duplicate
slashes or `.` segments, GraphQL in any case); `repositories/<id>/…`, `..`
and a path with only one of the `{owner}`/`{repo}` placeholders are refused,
and a write must go to `repos/OWNER/REPO/…` or `graphql` (`markdown` rendering
is a read). gh fills placeholders (`{branch}`, `:branch`, …) from the
checkout, and a branch can be named `tags/pkg@1` or `pulls/1/merge`, so a
write's endpoint after `repos/OWNER/REPO/` and its `ref`, `tag` or `tag_name`
must be written out. `gh auth token`, `gh auth git-credential`,
`gh auth status` with `--show-token` in any spelling (`-t`, `-at`,
`--show-token=true`, `-t=true`) and `gh config` reading a token
(`gh config get -h github.com oauth_token`) are refused: they print the
credential.

gh acts on exactly the repository Paperclip checked. Without `-R` or
`GH_REPO`, the launcher reports the checkout's saved default repository
(`gh repo set-default`, `remote.<name>.gh-resolved`), which gh uses before the
remotes; that repository is the one checked (two saved defaults are refused),
and after the check the launcher sets `GH_REPO` to it, so gh cannot pick
another remote or default. The managed gh launcher reads gh's argv with the
classifier's own grammar (`packages/shared/src/gh-command.ts`, embedded in the
launcher as is): every command the classifier calls a write is one the
launcher does not run without a managed credential, including a method inside
a cluster of short options (`gh api -iXPOST …`), and every command the launcher
runs without one is a plain read for the classifier. An explicit `GET` or
`HEAD` (any case or clustering) reads, its fields becoming the query string
(`gh api -X GET search/issues -f q=…`); any other method, `--input`, or fields
without a method may write. A command that prints a credential never runs at
all: the launcher refuses it before asking Paperclip, with or without a managed
credential. `gh repo view|edit|fork|archive|unarchive|…` without a repository
argument act on the saved default or remote even when `GH_REPO` is set (gh
ignores it for them), so both count, and a write needs them to agree; the
launcher always reports the remotes and saved default for this, `GH_REPO` or
not.
A gh command must start with its group and verb (`gh pr merge …`), with only
`-R OWNER/REPO` allowed before the group or the verb; an empty argument before
the verb is refused (gh skips it when it finds the command), and `-R` must
stand on its own (not inside a cluster such as `-dR…`). For writes, put
`-R OWNER/REPO` right after the command, since the option before it may take
it as its value. A cut report and a URL rewrite also refuse the command for
every company; a long PR or issue body, title or notes is not a cut report.

**Known git commands only.** git subcommands are an allowlist: local commands
run without a token; `fetch`, `pull`, `clone`, `ls-remote`, `submodule
add/update` and `lfs` downloads read; `push` and `lfs push` write. Network
plumbing (`send-pack`, `fetch-pack`, `upload-pack`, `receive-pack`,
`http-push`, `remote-*`), credential helpers, `git remote update/show/prune`,
`archive --remote`, aliases and any other command are refused, and so is a
global option Paperclip does not know (it could shift where the command is).
The options of `push`, `fetch`, `pull`, `clone` and `ls-remote` are read from
exact tables: abbreviated long options and unknown short options are refused,
so an option's value is never taken for the destination. A push to a local
path stays a write (refused under the App user, which needs a repository).
A privileged action is checked whatever access the command reports.
A push never recurses into submodules: their remotes are not checked. The
launcher always runs git with `push.recurseSubmodules=no` (command-line scope,
above repository config such as `submodule.recurse`), and a
`--recurse-submodules` value other than `no` or `check` is refused. git reads
`-c` and `--config-env` after that setting, so a push may set only these keys
on its command line: `user.name`, `user.email`, `core.quotePath`, `color.*`,
`advice.*`, `push.default`, `push.followTags`, `push.autoSetupRemote`,
`remote.pushDefault`, `branch.*.remote`, `branch.*.pushRemote` and
`remote.*.url`, `remote.*.pushUrl`, `remote.*.push` (any case). Anything else
(`submodule.recurse`, `push.recurseSubmodules`, `include.path`,
`credential.helper`…) refuses the push; `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`
and `GIT_CONFIG_PARAMETERS` from the run are removed before git runs. `push.followTags`, in any boolean spelling and with or without
refspecs, makes the push a tag push (`tagPush`). Every `GIT_CONFIG*`
variable (including a bare `GIT_CONFIG`, which redirects `git config` but not
`git push`) is removed before the launcher reads where a push goes.

**GraphQL.** `gh api graphql` queries are parsed: any `mutation` or
`subscription` in the document is a write, a document Paperclip cannot read is
refused, and a query or body read from a file or stdin (`-F query=@file`,
`--input`) is refused. Mutations name their target by node ID, so only these
are allowed, each field named directly (no fragments): `addComment`,
`resolveReviewThread`, `unresolveReviewThread` and
`addPullRequestReviewThreadReply` (comments), and the organization Project item
mutations (`addProjectV2ItemById`, `updateProjectV2ItemFieldValue`, …). Merges,
refs, commits and the rest go through gh commands or REST endpoints, which
carry the repository and the privileged checks. REST fields read from a file are refused where the ref,
tag or branch decides the privileged action.

**Gates on every write**, in order: the kill switch (`enabled`); the repository
in `allowedRepositories` (exact `owner/name`; a `.wiki` counts as its
repository; look-alikes such as `songtrivia-old` never match; a write whose
repository Paperclip cannot tell is refused, except organization Projects);
each privileged action's toggle; a fence check younger than 3 hours; the
admin-merge guard; and the throttle (`perMinute`, `perHour` per GitHub user).

| Privileged action | Detected from | Default |
|---|---|---|
| `adminMerge` | `gh pr merge --admin`, `PUT …/pulls/N/merge` | on |
| `deploymentApproval` | `POST …/actions/runs/N/pending_deployments`, creating deployments or deployment statuses | on |
| `workflowDispatch` | `gh workflow run/enable/disable`, `gh run rerun/cancel`, `…/dispatches`, run reruns | on |
| `wiki` | any command on a `.wiki` remote | on |
| `release` | `gh release` writes, `…/releases` writes | off |
| `tagPush` | pushes to `refs/tags/*`, tag refs through the API | off |
| `pushToMain` | pushes or API writes to `main`/`master`, `gh repo sync`, `merge-upstream` | off |
| `editWorkflows` | a push whose new commits change `.github/workflows/**`, contents API writes there | off |

**Workflow files and the base branch.** A push whose new commits change
`.github/workflows/**` needs `editWorkflows`, with one exception: an agent keeps
a pull request current by merging its base branch, and the base branch's own
workflow changes come in with that merge. With `editWorkflows` off, the plugin
lets such a push through when it is one commit to one named branch and every
workflow path the new commits change is, at the pushed tip, byte for byte what
the base branch has now (same git mode and blob), or gone from both. The
checkout reports each path with its mode and blob ID (the rename of a workflow,
or a move out of the directory, shows as a deletion plus an addition). The
plugin reads the base branch from GitHub at that moment with the App's
read-only token: the base of the open pull request from the pushed branch, else
the repository's default branch. Whoever opens a pull request chooses its base,
so the base counts only when it is the default branch or a protected branch;
workflow files on any other branch are not taken as reviewed. It refuses when the
branch has open pull requests into different bases, when the base cannot be read
in full, when the push is more than one commit or one branch, changes more than
100 workflow paths or a path longer than 300 characters (the report then carries
no paths and the toggle decides), and for every symlink or submodule among the
changed paths, whether or not the base branch has the same. The refusal names
the paths that differ; the audit record lists all of them, and the base branch
and its commit when the comparison passed. An agent's own edit, a rename, a mode
change, or a deletion the base branch does not share is refused as before. This
applies to the App user identity only (with `userSource: "run"` the toggle
decides as before), and it unlocks no other toggle: `pushToMain`, `tagPush` and
the rest still apply.

This lifts Paperclip's refusal only. GitHub has its own: it refuses a push that
changes workflow files from an App without the Workflows write permission, which
is why the hard limit below is to keep that permission off. Whether GitHub counts
a merge of the base branch's own workflow files as such a change was not
verified. If it does, these pushes still fail at GitHub until a human grants the
permission, and then the checkout's report of the pushed paths is the only gate
that remains.

Release tags (`name@version`) and bulk tag pushes (`--tags`, `--follow-tags`,
`--mirror`, tag patterns) are refused whatever the toggles: only the
repository's release workflow creates release tags. Writes are also refused
when Paperclip cannot be sure where they go: a push to several push URLs or
repositories, a checkout with its own `url.*.insteadOf` rewrites, a push whose
repository config can push more than the current branch (`push.default`,
remote push refspecs, `push.followTags`), a `gh` command that could pick
between several remotes without `-R`, a `gh api` ref or tag hidden in an
`--input` or `-F name=@file` file, and a command too long to report whole.

**Operations agents never perform.** These are refused for every company,
with or without a write identity policy, and no toggle turns them on. No token
is handed out, and the refusal (`Denied: agents never …`, naming the route) is
recorded as `github.write_identity_resolved` with the agent and run:

| Operation | Refused routes |
|---|---|
| Archive, unarchive, delete, rename, transfer or change the settings of a repository | `gh repo archive\|unarchive\|delete\|rename\|edit\|transfer`; any `gh api` write to `repos/OWNER/REPO` (or `repositories/ID`) itself or to `…/transfer`; GraphQL `archiveRepository`, `unarchiveRepository`, `updateRepository`, `transferRepository` |
| Delete or force-push a default or protected branch | `main`, `master`, `staging` and `production` always (any casing: `Production` too): `git push` with `--delete`/`-d`, `:main`, `+…:main`, `-f`/`--force`/`--force-with-lease` reaching `main`, `--mirror`, `--prune` or `--force` with branch patterns, `+:`, and a push without refspecs whose repository config may force or prune; `gh repo sync --force` without a branch; `DELETE …/git/refs/heads/main`, `PATCH` there with `force` not `false` or a body Paperclip cannot read; `POST …/branches/main/rename`. Any other branch the same forms name (and `gh repo sync --force --branch BRANCH`) when GitHub reports it as the default or a protected branch, or cannot be read (below). GraphQL `deleteRef`, `updateRef`, `updateRefs` (they name the ref by node ID, so every branch: use `git push`) |
| Change branch protection or rulesets | writes to `…/branches/BRANCH/protection/**`, `…/tags/protection/**`, `…/rulesets/**`, `orgs/ORG/rulesets/**`; GraphQL `create`/`update`/`deleteBranchProtectionRule` and `…RepositoryRuleset` |
| Change webhooks | writes to `…/hooks/**`, `orgs/ORG/hooks/**` |
| Change secrets, variables or deploy keys | `gh secret`/`gh variable` writes, `gh repo deploy-key` writes; writes to `…/actions/secrets/**` and `…/actions/variables/**`, `…/dependabot/secrets/**`, `…/codespaces/secrets/**` (repository and organization), `…/keys/**` |
| Delete deployments, change or delete environments, or mark a deployment inactive | writes to `…/environments/**`, `DELETE …/deployments/ID`, `POST …/deployments/ID/statuses` with `state=inactive` or a body Paperclip cannot read; GraphQL `deleteDeployment`, `createDeploymentStatus`, `create`/`update`/`deleteEnvironment` |

Requests that could hide one of them are refused for every company as well: a
GraphQL query or body from a file or stdin or in a `-F` value with a gh
placeholder, an unreadable GraphQL document, mutation fragments or
subscriptions, any GraphQL mutation outside the comment and Project fence (it
names its target by node ID), a `gh api` write whose endpoint Paperclip cannot
route (`..`, a bad encoding, half-filled placeholders) or holds a gh placeholder
after `repos/{owner}/{repo}` (gh fills `{branch}` after the check, and a branch
may be named `heads/main` or `hooks/1`), and a gh option before the verb. A
`state` or `force` value from a query string, a file or a placeholder counts as
unknown, and only a literal `force=false` is not forced. Routes are matched
case-insensitively, after decoding, and a branch name may hold slashes.
Deployment statuses other than `inactive` stay `deploymentApproval`.

**The name floor does not ask GitHub.** `main`, `master`, `staging` and `production` (any casing) are refused for a delete, force-push, rename or hard-reset even when GitHub says the branch is neither the default nor protected. A fast-forward push to one of them is still an ordinary write.

**Default and protected branches are GitHub's.** For any other branch a write
forces, deletes, renames or hard-resets, Paperclip reads from GitHub, with the
run's own read credential (used on the server, never handed out): the
repository's default branch (`GET /repos/OWNER/REPO`), the branch's classic
protection (`GET …/branches/BRANCH`, `protected`), and the active ruleset
rules for its name (`GET …/rules/branches/BRANCH`, every page). The branch is
protected when it has classic protection or any active rule other than those
that only check commits, names or merges (`creation`, `required_signatures`,
`required_linear_history`, commit and name patterns, file restrictions,
`workflows`, `code_scanning`, `copilot_code_review`); a rule type Paperclip
does not know protects it. The write is refused when the branch is the
default (compared case-insensitively) or protected, and also when GitHub
cannot be read or answers unclearly: the classifier refuses a branch it has no
answer for from this very operation, so any caller that skips the read fails
closed. The read happens for every such write and nothing is kept: no cache
across runs, companies or requests, so a change at GitHub applies at once. A write that forces, deletes,
renames or hard-resets a branch is also refused when Paperclip cannot tell
which repository it targets: a push report without its remote or push URLs, a
gh placeholder path, a wiki, or a target that only looks like a local path
(an unreported remote name reads the same way). Name the repository, or push
from the managed launcher, which reports the destination. Feature branches GitHub does
not protect may still be force-pushed (with or without a lease) and deleted.

**gh aliases, extensions and unknown commands.** gh runs an alias or an
extension for a name it does not know, and either can run any command, so a
gh command group that is not one of gh's own (gh 2.97) is refused for every
company, whatever its arguments (`gh deployment delete`, for example, is not a
gh command). `gh alias set|import`, `gh extension exec` and `gh copilot` are
refused too. `gh alias list|delete`, `gh extension list|search|install|…`,
gh's built-in `co` alias (`pr checkout`) and the help topics stay reads.

An **admin merge** needs the pull request number and the full expected head
commit SHA (`gh pr merge <n> --admin --match-head-commit <40-character sha>`,
or the API `sha`); an abbreviation is refused. Every `gh pr merge` option must
be one Paperclip knows and exactly one pull request may be named. The plugin reads the pull
request, the base branch's rules and classic branch protection, and the head's
check runs with the App's read-only token, and refuses unless the head equals
that SHA exactly, the base branch's classic protection is on and binds
administrators ("Do not allow bypassing the above settings", `enforce_admins`),
the base branch requires at least one check, and every required check, from
rulesets and classic branch protection, concluded `success` in its latest run
(from the pinned integration when the rule names one). GitHub's branch read
(`GET /repos/{owner}/{repo}/branches/{branch}`) never includes `enforce_admins`;
it reports administrators as bound with
`protection.required_status_checks.enforcement_level: "everyone"`
(`non_admins` when they are not). Paperclip reads that value, and an explicit
value decides. If a response carries `enforce_admins` too, it counts only when
`enforcement_level` is absent, and `enforce_admins.enabled: false` always
refuses: contradictory data fails closed. When administrators
are not bound, `--admin` skips every rule of the branch; a ruleset does not
stand in for that, because the read-only token cannot see a ruleset's bypass
actors. Paperclip checks the ruleset's required checks itself; its other rules
(for example required reviews) bind `--admin` only when the App user is not a
bypass actor of that ruleset. Branch protection Paperclip cannot read refuses
the merge, and so does a branch that requires no check (the checks that
happened to report are not a bound). The
plugin's own merge (board action and agent tool) and a raw
`PUT …/pulls/N/merge` count as admin merges, so the same rules apply to them.
The result is part of the audit record.

**Protected-path merge guard.** Agents act as the App user, and GitHub does not
let that person approve their own pull requests, so CODEOWNERS cannot keep
agent changes out of protected paths. Every merge as the App user (managed
`gh pr merge`, admin or not, the REST merge endpoint, the plugin's board action
and agent tool) is refused when the pull request touches a protected path, and
the refusal names the files and says that a human must merge it (the App user,
in the GitHub web UI). The protected list comes from the base branch, never the
head: `.github/**`, `CODEOWNERS` (at any depth) in every repository; in the
control repository (`Anthm-FR/anthm-fr`, or any repository with a tiers file)
also `paperclip/**`, `scripts/**`, `ROADMAP.md`, `data/company/strategy/**` and
the `protectedPaths` of `paperclip/tiers.yaml` read at the base commit. A tiers
file Paperclip cannot read or parse (anything but a plain `- path` list)
refuses the merge. The files are every file of the pull request (renames count
both names, deletions count), read whole at the expected head: a list GitHub
cuts (3,000 files) or that does not match the pull request's file count, or a
head or base that moves during the check, refuses. A merge must name its full
head SHA (`--match-head-commit`, the API `sha`), so a push after the check fails
it at GitHub. Auto-merge and the merge queue are refused as the App user (Phase
1), and GraphQL merge, auto-merge and queue mutations are refused like every
unchecked mutation. The guard adds to `pushToMain`, which stays off. One
exception: a pull request whose only protected change is `paperclip/skills.lock`
merges when every changed lock entry changes only its `snapshotHash`, belongs
to a skill under `plugins/anthm/skills/<name>` that the same pull request
changes, and that skill is not itself protected; anything else in the lock
(`owner`, an added skill, a duplicate JSON key) refuses. A pattern `x/**` also
covers `x` itself (a file, symlink or submodule of that name), and a pull
request without a file count refuses. An open pull request's base branch never
changes as the App user (`gh pr edit --base`/`-B`, the REST `base` field or a
body Paperclip cannot read, the board and tool edit), so a pull request checked
against one base cannot be retargeted to `main` before its merge; GraphQL
`updatePullRequest` is refused like every unchecked mutation.

**Fence check.** At authorization, on save and hourly (from the sync job), the
plugin compares what the user token reaches with the policy: the user, exactly
one App installation with selected repositories equal to
`installationRepositories` (default: the write allowlist), and installation
permissions, and the App's own permissions (which include account
permissions such as SSH keys that a user token carries), equal to
`installationPermissions` (`statuses` write, `administration` and `secrets` are
never accepted). Each fenced repository is also pinned by its GitHub ID at
the first good check: a name that later reaches another repository (deleted
and recreated, or renamed over), or that the user token and the App see as
different repositories, is drift. Saving the policy (or authorizing again)
accepts the repositories GitHub has then. Any difference, or a revoked
authorization, sets `enabled` to false and records `github.fence_violation`;
an administrator turns writes back on after fixing it. The kill switch, the
allowlist, the privileged toggles and the authorization are read again right
before the user token is handed out (after a slow admin-merge check, and for
board writes inside the company's write queue), and read tokens are cached per
policy version: a read token minted while the policy changed is revoked, not
used. A list longer than Paperclip reads (more than 10 pages of
installations or repositories) counts as drift and fails closed; so does an
admin merge whose check runs, commit statuses or branch rules run past 10 pages.
If GitHub cannot be reached, writes pause until the next successful check
without being switched off.
`installationRepositories` may be larger than `allowedRepositories`: the extra
repositories stay readable and writes are staged.

**Commit signing.** With a signing key bound at `signingKey`, local commits are
signed: the launcher sets git's `gpg.ssh.program` to its own
`paperclip-ssh-sign`, which sends each commit object through the run bridge to
`POST /runtime-tools/github/sign` (native sessions use their session broker's
route of the same name). The plugin signs (SSHSIG, ed25519) only an exact git
commit object: headers `tree`, `parent`*, `author`, `committer` and an optional
`encoding`, nothing else (no `gpgsig`, no `mergetag`), all object IDs of one
hash kind, no NUL byte, valid UTF-8. Tags are never signed: a signed tag can
name any object, including one the person never wrote. Author and committer
must be the person's noreply identity; the committer time must be within 10
minutes of the server's clock, and an author time may be up to 30 days old
(amended or rebased commits). Rebasing someone else's commits, or
commits older than 30 days, is therefore refused; use `--reset-author`. The
server signs only for a run whose own managed git command that creates commits
(`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `commit-tree`,
`pull`) started in the last 30 minutes; tags are not signed. The key never leaves the server.
Low-trust runs and a switched-off identity cannot sign. Add the public key to
the person's GitHub account as a signing key.

**Refusals never run.** A refused write, and any command Paperclip refuses to
check (another host, an unknown git command…), is answered with `failClosed`;
the launcher exits without running it. A `gh` command naming another host does
not run without a managed credential either. A `gh` command that may write and obtained
no managed credential at all (broker unreachable, rejected, absent) does not
run either, so a worker's `gh` wrapper cannot write as a bot instead; on that
path no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or
`GITHUB_ENTERPRISE_TOKEN` of the run reaches the command.

**Audit.** Granted user-identity writes are recorded as
`github.user_identity_write` with the run, agent, issue key, repository,
action, privileged actions, head SHA or pushed SHAs, Actions run and approval
state, and the admin-merge evidence. Refused and App writes are
`github.write_identity_resolved`; signatures are `github.commit_signed` with the
object's SHA-256. Tokens and command arguments are never recorded. The daily
"done in this person's name" list is:

```
GET /api/companies/{companyId}/audit/agent-actions?actorScope=all&action=github.user_identity_write&from={24 hours ago}
```

(`…/audit/agent-actions.csv` exports it.) The plugin's own writes (sync
write-back, board actions, agent tools) pass the same gates and use the same
action. Personal Projects (the board's personal token) never write while the
company writes as its App user, because that token is outside the fence.

**Revoke drill.** Revoke the App under the person's GitHub Settings →
Applications → Authorized GitHub Apps. GitHub rejects every token it issued at
once; the next refresh fails, the next fence check turns writes off and
records `github.fence_violation`, and reads continue on the installation. In
Paperclip, `user-authorization.revoke` forgets the tokens, overwrites the
stored refresh token and switches writes off (`enabled: false`); a device
flow that GitHub answers after the revoke is discarded. Writes resume only
after a new authorization and an administrator re-enabling them (saving the
policy with `enabled: true`).

**Limits.** A command holding a GitHub token talks to GitHub directly with
verified TLS: the launcher sets `http.sslVerify=true` and an empty `http.proxy`
for git, refuses a git command whose config still sends GitHub traffic through
a proxy or other TLS trust (URL-specific `http.<url>.proxy` or `sslVerify`,
`http.sslCAInfo`, `http.sslCAPath`, `http.curloptResolve`), and removes the run's
`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (any case), `GIT_SSL_NO_VERIFY`,
`GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
`NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE` and git's curl tracing variables from
it; gh always gets a fresh private `GH_CONFIG_DIR`. Such a command therefore
cannot use a proxy the network needs. The allowlist, toggles, throttle and
guard hold on the managed path only. An agent that captures a user token (for example from a git hook, a
program named `gh` later in `PATH`, or a gh extension, which all run with the
token in their environment) can skip them for at most 8 hours; the hard limits are GitHub's: the App
installation's repositories and permissions (keep Workflows write off so
workflow files cannot change), and the repositories' rulesets. The
`editWorkflows` check reads the checkout's history, which an agent controls. The
base-branch comparison trusts the same report of the pushed tip; only the base
side comes from GitHub.
`pushToMain` knows `main` and `master` only.

With `userSource: "run"`, the kill switch withholds the run's token entirely
(reads too, since that token can write); local commands keep their identity.
A run-mode allowlist refuses writes whose repository Paperclip cannot tell.

## Legacy hosts and networking
## Legacy hosts and networking

When no managed GitHub connection is installed for an agent, standard-trust
local and SSH executions retain that execution host's existing Git and GitHub
CLI credentials, configuration, credential helpers, and SSH agent. Paperclip
does not import controller credentials into an SSH target. Sandbox, plugin,
and low-trust executions do not receive this compatibility fallback. Once a
managed connection is configured, unavailable or revoked access never falls
back to host authentication. Switching modes replaces the provider process
while preserving the settled conversation.

Runner network access is independent of GitHub credentials. The controller
enables networking for standard-trust execution. Low-trust runs and runners
without a controller network decision retain a restricted default. An operator
can set `PAPERCLIP_RUNNER_NETWORK_ACCESS=disabled` to restrict normal execution;
user environment bindings cannot override that decision. Outer execution-
environment network restrictions still apply. The controller projects the assigned worktree's Git metadata paths so
Git can operate without exposing unrelated workspace or provider state. The
sandbox also receives read access to validated provider executable resources
and the target host's DNS and CA files, including resolver symlink targets
outside `/etc`. Provider credential directories remain isolated.

A managed broker outage does not prevent local Git operations. Launchers clear
credentials and run the command without authentication, with a redacted error
category identifying configuration setup, transport, or capability rejection.
They do not retain a previous operation's token or replay a GitHub operation.

Healthy eligible grants for the same stable GitHub account ID take precedence
over duplicates with failed health checks. Credential acquisition can retry
once against another grant for that same principal and account, before any
GitHub operation begins. Run identity diagnostics include the selected
connection and grant IDs, without credential values. Access-refresh conflicts
retry once against current state and never turn a concurrency conflict into
a reconnect requirement.

## Dedicated accounts and diagnostics

An explicit dedicated-agent grant overrides personal selection. Revoked, disabled, unavailable, or ambiguous dedicated grants do not fall back to a person's account. Removing the dedicated configuration restores personal selection.

Connection setup and permissions display: “This agent uses this GitHub account for everyone's work, instead of the person giving instructions.”

The GitHub permissions page shows repositories across all connected accounts in one scrollable list. It has no account filter or repository search. Repository icons, private-repository indicators, refresh, and GitHub configuration links remain available. The “Add More Repos on GitHub” button opens GitHub’s app installation and repository-access setup.

Multiple eligible connections for the same GitHub account are treated as one
identity, using GitHub's stable account ID rather than its login. The resolver
selects an available grant, preferring the newest authorization with a stable
ID tie-breaker. Duplicate eligibility includes an active credential record with
the correct owner, the OAuth access-token reference, and repository access
metadata. It keeps that grant's credential and connection policy together;
it does not combine repository access or bypass connection audiences. Distinct
accounts or unidentifiable duplicate grants remain ambiguous. Managed commands
print the redacted reason when GitHub access is unavailable, while unrelated
local operations can still proceed without credentials.

Run details show identity revisions and redacted GitHub results: responsible person, selected login when available, personal/dedicated source, and an unavailable reason. Tasks do not receive an additional identity indicator or takeover action.

## Deployment and verification

Deploy the schema, server broker, launcher staging, and runtime environment contract together. Already-running processes retain their original environment; only newly dispatched processes receive the broker contract. Run-scoped capabilities remain valid only while their bound run is active.

Focused coverage lives in `run-identity.test.ts`, `github-operation-credentials.test.ts`, and `github-launcher.test.ts`, alongside the native steering, gateway, routine, and callback-bridge suites. Live acceptance additionally requires two authenticated Paperclip users, two authorized GitHub accounts, and a designated disposable repository for push verification. Local commit metadata and mocked API results do not replace that live push test.

### Release procedure

1. Back up the instance database using the normal deployment procedure.
2. Build and deploy one revision containing migrations 0240–0245, the server broker, managed launchers, and the runner artifacts. Run the standard pending-migration check before admitting new runs. These additive migrations are safe to replay and do not infer authorship for historical runs.
3. Let pre-rollout executions finish with their original runtime contract. New executions must have an active identity context and the managed launcher capability before provider startup.
4. Check one ordinary run without a GitHub connection, then an authenticated GitHub operation. Inspect the run details for the responsible person and credential outcome. Verify a queued continuation on the same conversation.
5. If rollback is needed, finish or explicitly stop executions using the new broker before removing its endpoint. Keep the additive schema and identity history. Do not drop identity columns or tables to roll back application code.

Remote acceptance uses the existing paid runner workflow with a narrow selection. Run it against the same immutable revision as the release; a successful local test does not qualify a different remote runner artifact.

Identity history survives deletion of the originating agent or run, so surviving
subtasks and approvals retain their responsible person. The company foreign key and company-deletion service remove
these company-scoped records when their company is deleted. Run-scoped adapters remove their managed launcher files at the terminal boundary.
Native warm sessions retain their token-free launchers and inactive broker until
session retirement; environment deletion and orderly controller shutdown close
idle owners first. Cleanup failures are logged and do not change the run result.
