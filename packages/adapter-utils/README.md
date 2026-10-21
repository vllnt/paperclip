# @paperclipai/adapter-utils

Shared utilities for Paperclip adapters: process spawning, environment
injection, sandbox/SSH transport, workspace sync, and the round-trip helpers
that move code between the local execution-workspace cwd and wherever the
agent actually runs.

For the adapter-author guide see
[`docs/adapters/creating-an-adapter.md`](../../docs/adapters/creating-an-adapter.md)
and the in-repo notes at [`packages/adapters/AUTHORING.md`](../adapters/AUTHORING.md).

## Sandbox bridge deadlines

Command-managed bridge control operations (queue reads, input delivery, setup,
and cleanup) have a host-enforced deadline of at most 30 seconds per shell
command. A shorter configured timeout still applies. These operations cannot
inherit the agent run's hours-long lifetime or wait forever on a provider that
ignores its timeout. Long-lived agent session commands keep their own limits.

A control timeout reports a transport failure. It does not prove that the
remote command stopped and does not replay an uncertain write. The process
session closes failed input delivery and uses its existing shutdown path;
normal execution settlement must still verify termination.

## No-remote-git contract

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

Adapters that run the agent on a different host should use the SSH round-trip
helpers in [`src/ssh.ts`](./src/ssh.ts):

- `prepareWorkspaceForSshExecution({ spec, localDir, remoteDir })` — bundles
  the local cwd (tracked files, dirty edits, untracked additions, and the git
  history needed to reconstruct it) to `remoteDir` before the run starts. Runs
  with no `git remote` configured.
- `restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir, ... })` —
  syncs the remote cwd back into `localDir` after the run, including any new
  commits the agent created. Also runs with no `git remote` configured.

`prepareRemoteManagedRuntime` in
[`src/remote-managed-runtime.ts`](./src/remote-managed-runtime.ts) wraps both
calls for adapters that want a per-run remote workspace and an automatic
`restoreWorkspace()` finally hook.

The invariant is pinned by the `no-remote-git contract` case in
[`src/ssh-fixture.test.ts`](./src/ssh-fixture.test.ts), which asserts that a
remote-only commit propagates to the local worktree through the
prepare → restore round-trip with no git remote configured at any point. Do
not regress that test.

### What the SSH restore guarantees on the primary checkout

After a Git-backed restore, HEAD, the index and the working tree of the local
checkout agree, and nothing that landed there during the run is reverted or
deleted. Several runs can share one checkout.

- **The baseline comes first.** `prepareRemoteManagedRuntime` calls
  `planWorkspaceSeed`, snapshots the local directory, and only then calls
  `prepareWorkspaceForSshExecution`. A change that lands locally while the copy
  is seeded is therefore never read as an edit the run made, and a file created
  in that window is never deleted.
- **The index follows HEAD.** When the restore integrates the run's commits,
  `integrateImportedGitHead` moves the branch ref only. The restore resets the
  index to HEAD right after the ref moves, so the index follows HEAD even when
  the file merge then fails. After the merge it checks out, from HEAD, each
  tracked file that equals the blob the run committed but differs from the
  integrated HEAD. A plain `git commit` on the checkout never deletes the run's
  files. A reset that meets another git process's `index.lock` waits for it,
  for about two seconds.
- **A run that moved to another commit follows HEAD too.** A run that checks
  out an older commit of the local history and commits nothing integrates
  nothing, yet its copy holds that commit's files. When the run's HEAD differs
  from the local HEAD, the restore realigns those files the same way, without
  resetting the index. A run whose HEAD equals the local HEAD runs no hook, so
  a read-only run skips the merge lock unless the local HEAD moved during the
  run.
- **Known edges.** A file the run edited after its last commit differs from the
  run's committed blob, so on a true both-sides conflict the run's dirty file
  wins. A path the merge deleted locally while the copy still has it stays
  untracked. Symlinks and other non-regular files are not realigned.

The invariant is pinned by
[`src/ssh-restore-primary-coherence.test.ts`](./src/ssh-restore-primary-coherence.test.ts).
