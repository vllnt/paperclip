# SSH run directory reaper

Every SSH run works in its own `<remote root>/.paperclip-runtime/runs/<runId>`
directory on the worker. The directory holds a full copy of the workspace, so
finished runs fill the worker's disk if nothing removes them (519 directories,
67 GB on 2026-10-08; about 35 runs and 17 GB an hour on one worker on
2026-10-09). The reaper removes them for every worker and every terminal run
status.

## When a directory is removed

- **On lease release.** When an ephemeral SSH lease releases, expires, or
  fails, and its run is `succeeded`, `failed`, `cancelled`, `interrupted`, or
  `timed_out`, the server removes `runs/<runId>`. The release does not wait for
  it.
- **By a sweep.** Every 10 minutes the server looks at SSH leases released in
  the last 14 days whose directory it has not decided about, or whose kept
  decision is older than the keep window (below). It removes a
  directory when its run is terminal, no other lease of the run is `active`,
  `retained`, or `pending_cleanup`, and the lease finished at least
  `PAPERCLIP_SSH_RUN_REAPER_MAX_AGE_MINUTES` ago (default 60). Above
  `PAPERCLIP_SSH_RUN_REAPER_DISK_PRESSURE_PERCENT` disk use on the worker
  (default 80) the threshold is
  `PAPERCLIP_SSH_RUN_REAPER_PRESSURE_MAX_AGE_MINUTES` (default 15).
- **Not on release:** the last run of an agent task session. The sweep removes
  it once it is old enough, without a session check. Nothing reads an earlier
  run's directory: session state holds the worker's identity and the provider's
  session id, every run uploads its own directory (Codex saves the run's own
  directory as the session's working directory, so it never resumes into an
  earlier one), and a retry or continuation is a new run with a new directory.
- **After the keep window.** A kept directory (see below) is tried again by the
  sweep once `PAPERCLIP_SSH_RUN_REAPER_KEEP_WINDOW_HOURS` (default 24) have
  passed since the decision: `not_git_backed`, `preserve_failed`, `rm_failed`,
  `external_worktree`, and `worktree_dirty` decisions recorded before the reaper
  saved extra worktrees. A directory that is not a git repository is then deleted, because
  nothing in it can be saved, unless a git repository lies below it or its
  `workspace` is a link: that one stays kept. The others go through the save
  step again and are kept again, for another window, if it still fails. Retries
  stop once the lease is older than the sweep's 14-day look-back. `symlink` and
  `root_mismatch` stay kept.

A directory with the `.paperclip-restored` marker holds no unsynced work and is
removed at once. Without the marker the worker may hold the only copy of the
run's work, so the reaper first saves what is local-only.

## What is saved first

Written to `refs/paperclip/preserved/<runId>/*` in the run's repository and
bundled into `<remote root>/.paperclip-runtime/preserved/<runId>.bundle`. The
bundle stores only objects after the commit the run started from, so it is
small. Bundles older than 30 days are removed.

| Local-only state | Ref |
| --- | --- |
| Commits on HEAD after the start commit | `head` |
| A branch tip that HEAD does not contain | the branch name |
| Each stash entry | `stash-<n>` |
| The detached HEAD of an extra worktree | `worktree-head-<n>` |
| Uncommitted work: tracked and untracked files git does not ignore, as a snapshot commit | `worktree` |
| The same for each extra worktree (`git worktree list`), on top of its HEAD | `worktree-dirty-<n>` |

To bring a run's work back, fetch from the bundle into a clone that has the
start commit:

```sh
git fetch <remote root>/.paperclip-runtime/preserved/<runId>.bundle \
  'refs/paperclip/preserved/<runId>/*:refs/paperclip/preserved/<runId>/*'
```

Git runs with the repository's `core.fsmonitor` and hooks switched off. Files
that git ignores (`node_modules`, build output) are not saved.

## When a directory is kept

The directory stays, with a reason in the activity entry (written once per
reason) and in the lease's `metadata.sshRunDirectory`. The API returns it with
the lease (`GET /api/environment-leases/:leaseId` and the lease lists), and the
CLI with `environment lease`, `environment leases` and `environment
leases:list`:

- `not_git_backed`: no marker and not a git repository, so nothing can be saved.
  It is kept for the keep window, then deleted.
- `worktree_dirty`: an extra worktree had uncommitted work. Only decisions from
  before the reaper saved extra worktrees have this reason; they are tried again
  after the keep window.
- `preserve_failed`: the state could not be saved (for example a file in an
  extra worktree could not be read), the bundle could not be written, was over
  1 GiB, or did not verify; or `.git` is a link or a file; or the start commit is
  unknown. It is tried again after the keep window.
- `rm_failed`: the removal failed. It is retried up to 5 times, then again after
  each keep window.
- `external_worktree`: the run's repository has a worktree registered outside
  `runs/<runId>` (an agent's `git worktree add ../<folder>`), and that folder
  still exists. Deleting the run directory would leave the folder without its
  repository, so the directory stays, with the folder's path in
  `externalWorktree`. This applies to restored runs too. The reaper reads git's
  registration files (`workspace/.git/worktrees/*/gitdir`) and runs no git in
  the folder. After each keep window it looks again, also past the sweep's
  14-day look-back, and removes the run directory once the folder is gone. It
  never removes the folder itself.
- `symlink`: a link replaced `.paperclip-runtime`, `runs`, or the run directory.
- `root_mismatch`: the root recorded on the lease is not the root the environment
  is configured with now (or the lease did not record that root), or it is too
  shallow to be a runtime base, such as `/tmp`. The reaper never deletes under a
  root the environment does not own.

Nothing outside `runs/<runId>` is deleted, and no link is followed.

## Races

A run directory is `runs/<runId>` under one root on one host. A lease of another
run on the same root, even with the same host and `providerLeaseId`, uses its own
`runs/<otherId>`, and the reaper does not wait for it; if it did, nothing could
be reaped on a worker that is always busy. The claim is therefore keyed by host,
port, user, root, and run id. That is sound because of one invariant, which three
things keep true:

1. **One builder, one segment.** `sshRunDirectory` is the only code that makes the
   path, and it throws for a run id that is not one plain path segment (empty,
   `.`, `..`, or containing `/` or NUL). Distinct ids never share a directory.
2. **A run prepares only its own id on the target's root.** The heartbeat acquires
   the run's lease with `heartbeatRunId: run.id`, builds the target from that
   lease's `remoteCwd`, and gives the adapter `runId: run.id`. The other callers
   of `prepareAdapterExecutionTargetRuntime` pass their own base
   (`agent-files/<agent>/<run>`, which nests the run directory away from
   `<root>/.paperclip-runtime/runs/`) or `syncWorkspace: false` (no run
   directory). The reaper acts only on a lease whose run id is a UUID with a
   finished `heartbeat_runs` row, and refuses any other id, such as the login
   flows' `claude-login-<uuid>`.
3. **Tests.** `remote-managed-runtime.test.ts` pins the builder,
   `ssh-run-directory-callers.test.ts` fails when a new file starts preparing a
   remote runtime without review, and `ssh-run-directory-reaper.test.ts` keeps a
   live lease of another run on the same host and root from keeping this
   directory.

If a flow ever needs two run ids on one directory, key the claim on the directory
instead of the run.

- **Claim.** A short transaction locks every lease row of the directory (same
  key), in id order, and only then decides, so two replicas or two sweeps that
  reach the same directory through different lease rows cannot both win: the
  second waits, then sees the first one's claim. The claim also fails while any
  lease of the run is `active`, `retained`, or `pending_cleanup`. It is recorded
  in the lease's `metadata.sshRunDirectory` (`state: "reaping"`) with an owner
  token. The reaper checks for a busy lease once more after the claim and before
  the remote delete, and gives the claim back if one appeared.
- **Owner and renewal.** While it works, the owner renews the claim every minute
  (`renewedAt`). A claim is stale when it was not renewed for 15 minutes, so a
  removal that outlasts that window keeps its claim while the server lives, and a
  dead owner's claim expires. Before the delete and before recording the outcome,
  the owner checks under the same row locks that no other lease row of the
  directory holds a live claim, so a reaper that stalled and was replaced through
  a sibling lease row neither deletes nor records. A remote command that fails or
  times out after it was sent does not give the claim back, because it may still
  run on the worker: the claim stops being renewed, expires, and the sweep tries
  again.
- **Acquire.** When an SSH lease starts for a run, it checks for a fresh claim on
  that run after its own lease is visible. If there is one, the new lease fails
  and the run must start again. Between the two checks, one side always sees the
  other.
- **Crash.** A claim not renewed for 15 minutes (a server died mid-removal) is
  reclaimed by the next sweep.
- **Residual.** A server frozen for more than 15 minutes after it sent the delete
  can lose its claim while the command still runs on the worker. Then two reapers
  may delete one directory of a finished run. The run id is never prepared again
  (a retry gets a new id), so nothing live is under it; closing this fully means
  renaming the directory on the worker before deleting it.

On the worker, the script resolves the root once, then enters `runs/<runId>`
and compares the physical path (`pwd -P`) with the expected one. Everything after
that is relative to that directory, which is an inode and not a path, so a parent
swapped for a link afterwards cannot redirect a delete. A swap before that point
is detected by the comparison and reported as `symlink`. Saving the bundle into
`preserved/` is confined the same way. The git commands that save state still run
against `workspace/` inside the run directory, which the agent controls.

## Records

- Activity `environment.ssh_run_directory_reaped` for each removal, with
  `bytesFreed`, `trigger` (`lease_release` or `sweep`), the preserved refs, and
  the bundle path.
- Activity `environment.ssh_run_directory_kept`, once per reason, with the reason.
- A log line per removal with `bytesFreed`, and one per sweep with the totals.

The server has no metrics backend. Sum `details.bytesFreed` over the activity
entries to chart freed bytes.
