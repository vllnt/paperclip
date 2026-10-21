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
- **A run that made no commit leaves Git alone.** The restore compares the
  run's HEAD with the seed head, the local HEAD the copy was seeded from. When
  they match, it writes the run's file edits only: it integrates nothing,
  changes no index entry and realigns nothing. Whatever the host did with its
  HEAD, index and branches during the run stays as it is: a commit, a
  `git revert -n`, a branch switch, an amend, a `reset --soft`. A read-only
  run that changed no file skips the merge lock.
- **The index moves with HEAD, only where HEAD moved.** When the run
  committed, `integrateImportedGitHead` moves the branch ref after the merge's
  preflight and before its first write. The restore then brings the index
  entries of the paths that this move changed to the new HEAD, in one git
  command. Every other entry stays: a change staged by hand stays staged, and
  so does the staged part of a partly staged file. A plain `git commit` on the
  checkout never deletes the run's files.
- **A failure before the first write moves nothing.** A merge that refuses
  never moves the ref. When the index cannot follow, because another git
  process kept `index.lock` for more than about two seconds, the ref goes back
  with a compare-and-swap. HEAD, the index and the files then still agree, and
  the next restore integrates again. Every index write waits for a
  short-lived `index.lock`.
- **The files the merge wrote follow HEAD.** Among the paths the merge wrote,
  each tracked file that equals the run's commit but differs from the
  integrated HEAD is a stale copy of history and is checked out from HEAD. A
  tracked file that the merge removed for that reason comes back. This covers a
  run that checks out an older commit and commits nothing. A path the merge did
  not write is never touched.
- **Each step logs its duration.** After the transfer, the run log gets one
  line for each step: `[paperclip] Restore snapshot`, `integrate`, `index`
  (with the time spent waiting for the index lock), `copy` and `realign`.
- **Known edges.** A file the run edited after its last commit differs from the
  run's commit, so on a true both-sides conflict the run's dirty file wins. On
  a path that the run's commits changed, the index takes the new HEAD's
  version, even when the host had staged a change there. A failure after the
  first write (a copy or a realign error) leaves the ref moved. A run that
  committed while the host switched branches is merged into the branch the
  host has checked out. A path the merge deleted locally while the copy still
  has it stays untracked. Symlinks and other non-regular files are not
  realigned.

The invariant is pinned by
[`src/ssh-restore-primary-coherence.test.ts`](./src/ssh-restore-primary-coherence.test.ts).
