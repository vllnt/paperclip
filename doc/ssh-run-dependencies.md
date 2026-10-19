# Dependencies and disk on SSH workers

An SSH worker keeps one directory per run, `<root>/.paperclip-runtime/runs/<runId>`.
Two things decide how much disk a run takes there besides the repository itself:
what the upload sends, and where pnpm keeps its packages.

## One pnpm store per environment

Every process that Paperclip starts on an SSH worker gets
`npm_config_store_dir=<root>/.paperclip-runtime/pnpm-store` unless something else
has already chosen a store. `<root>` is the environment's configured workspace
path. The default is set in the one prelude that every remote command starts with
(the spawn target, the managed-runtime runner, the direct shell command and
`runSshCommand` all use it), and it reaches the agent's own shell commands, so
installs the agent runs in its own worktrees use the same store.

**Which store wins**, highest first. The default applies only when none of the
others sets a store.

| Order | Source | How it is found |
| --- | --- | --- |
| 1 | An environment variable the caller passes | `npm_config_store_dir`, in any letter case |
| 2 | The project | `store-dir` in a `.npmrc`, or `storeDir` in `pnpm-workspace.yaml`, in the command's working directory or any parent |
| 3 | The worker user | `store-dir` in `$npm_config_userconfig` or `~/.npmrc`, or in `~/.config/pnpm/rc` |
| 4 | Paperclip | `<root>/.paperclip-runtime/pnpm-store` |

For 2 and 3 the prelude only looks for the setting and, if it finds one, sets
nothing, so pnpm reads that file itself. A commented-out line does not count. The
working directory is the one the command runs in (the run's workspace, or the
`cwd` a caller gives). Not looked at: pnpm's global `etc/npmrc` and settings made
only through other environment variables. A root that is not a normalized
absolute path gets no default.

- The store is on the same filesystem as the run directories, which lets pnpm
  hard-link packages out of it. A run's `node_modules` then costs the files that
  differ, not a full copy. (`du` on one run directory still shows the full size,
  because it counts a hard-linked file in every directory. Measure the worker with
  one `du` over the whole `runs` directory, or with `df`.)
- The store is outside every `runs/<runId>`. The run reaper removes only the run's
  own directory and never touches it.
- **Scope: the store belongs to the environment's root. It does not belong to a
  company.** An environment is a record of the instance, not of one company, so
  every company that may use it shares its root, its `runs` directory and its
  store. Paperclip does not keep two companies' stores apart, and it does not check
  which companies use an environment. The boundary between companies is the host
  and the worker user, not a path: under one worker user, a run of one company can
  already write anywhere under the root, so a separate store path would isolate
  nothing. **Companies that must not share files need separate environments (a
  separate host or worker user), not separate store paths.** Package files are
  content-addressed and public packages are the same for everyone, but a store
  also holds whatever a run installed from a private registry, and its files are
  writable (see below).
- The store only grows. Pruning it (`pnpm store prune`) is not automatic, and a safe
  prune needs a moment when no install runs on that root.

Hard-linked files are shared between runs, and the store's files are writable by
the SSH user (mode 600 or 664 on a typical pnpm 9 store). A run that edits a file
inside `node_modules` in place edits it for every run that links to it, now and
later. This is a channel between runs of one environment that separate copies did
not have. It does not reach the run's working tree or its uncommitted changes.

## What the upload leaves out

For a workspace that is a git repository, the history goes over as a bundle and the
working tree goes over as a tar. The tar leaves out `node_modules`, `.pnpm-store`,
`.next`, `.turbo` and `.cache` at any depth, as the sync back to the host already
does. A name that the repository tracks somewhere keeps being sent, and so does
any other file, ignored or not. If git cannot say what is tracked, nothing is left
out. The run installs what it needs on the worker.

Not covered: a workspace that is not a git repository, and the exact-copy mode
that agent files use. Both send everything, as before. `dist`, `build` and other
output directories that a repository may track are not on the list.
