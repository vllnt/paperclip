# Dependencies and disk on SSH workers

An SSH worker keeps one directory per run, `<root>/.paperclip-runtime/runs/<runId>`.
Two things decide how much disk a run takes there besides the repository itself:
what the upload sends, and where pnpm keeps its packages.

## One pnpm store per environment

Every process that Paperclip starts on an SSH worker gets
`npm_config_store_dir=<root>/.paperclip-runtime/pnpm-store`, where `<root>` is the
environment's configured workspace path. That includes the agent's own shell
commands, so installs the agent runs in its own worktrees use the same store.

- The store is on the same filesystem as the run directories, which lets pnpm
  hard-link packages out of it. A run's `node_modules` then costs the files that
  differ, not a full copy. (`du` on one run directory still shows the full size,
  because it counts a hard-linked file in every directory. Measure the worker with
  one `du` over the whole `runs` directory, or with `df`.)
- The store is outside every `runs/<runId>`. The run reaper removes only the run's
  own directory and never touches it.
- A store the caller already chose (`npm_config_store_dir` in the run's
  environment, in any letter case) is kept. The default is skipped when the root is
  not a normalized absolute path.
- Scope: the store belongs to the environment's root, not to a company. Runs of
  environments that use the same root on the same worker share one store.
  **A worker that serves more than one company needs one root per company.** Give
  each company's environment its own workspace path, for example
  `/srv/paperclip/<company>`. Then each company has its own `runs` directory and its
  own store, and no package file is shared between companies. Package files are
  content-addressed and public packages are the same for everyone, but a store also
  holds whatever a run installed from a private registry, and the files are
  writable (see below). Paperclip does not check that two companies use different
  roots.
- The store only grows. Pruning it (`pnpm store prune`) is not automatic.

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
