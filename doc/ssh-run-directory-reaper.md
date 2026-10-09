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
  the last 14 days whose directory it has not decided about. It removes a
  directory when its run is terminal, no other lease of the run is `active`,
  `retained`, or `pending_cleanup`, and the lease finished at least
  `PAPERCLIP_SSH_RUN_REAPER_MAX_AGE_MINUTES` ago (default 360). Above
  `PAPERCLIP_SSH_RUN_REAPER_DISK_PRESSURE_PERCENT` disk use on the worker
  (default 80) the threshold is
  `PAPERCLIP_SSH_RUN_REAPER_PRESSURE_MAX_AGE_MINUTES` (default 15).
- **Not on release:** the last run of an agent task session. The sweep removes
  it once it is old enough. Resume itself does not read `runs/<runId>`: session
  state holds the worker's identity and the provider's session id, and every run
  uploads its own directory.

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

To bring a run's work back, fetch from the bundle into a clone that has the
start commit:

```sh
git fetch <remote root>/.paperclip-runtime/preserved/<runId>.bundle \
  'refs/paperclip/preserved/<runId>/*:refs/paperclip/preserved/<runId>/*'
```

Git runs with the repository's `core.fsmonitor` and hooks switched off.

## When a directory is kept

The directory stays, with a reason in the activity entry and in the lease's
`metadata.sshRunDirectory`:

- `not_git_backed`: no marker and not a git repository, so nothing can be saved.
- `worktree_dirty`: an extra worktree has uncommitted work.
- `preserve_failed`: the bundle could not be written, was over 1 GiB, or did not
  verify; or `.git` is a link or a file; or the start commit is unknown.
- `rm_failed`: the removal failed. It is retried up to 5 times.
- `symlink`: a link replaced `.paperclip-runtime`, `runs`, or the run directory.
- `root_mismatch`: the root recorded on the lease is not the root the environment
  is configured with now (or the lease did not record that root), or it is too
  shallow to be a runtime base, such as `/tmp`. The reaper never deletes under a
  root the environment does not own.

Nothing outside `runs/<runId>` is deleted, and no link is followed.

## Races

A run directory is `runs/<runId>` under one root on one host. The only code that
makes that path (`prepareRemoteManagedRuntime`, called from
`prepareAdapterExecutionTargetRuntime`) takes the run id of the run that owns the
lease, so only leases of the same run can use the directory. A lease of another
run on the same root uses its own `runs/<otherId>`, and the reaper does not wait
for it; if it did, nothing could be reaped on a worker that is always busy. The
claim is therefore keyed by host, port, user, root, and run id.

- **Claim.** A short transaction locks every lease row of the directory (same
  key), in id order, and only then decides, so two replicas or two sweeps that
  reach the same directory through different lease rows cannot both win: the
  second waits, then sees the first one's claim. The claim also fails while any
  lease of the run is `active`, `retained`, or `pending_cleanup`. It is recorded
  in the lease's `metadata.sshRunDirectory` (`state: "reaping"`). The reaper
  checks for a busy lease once more after the claim and before the remote delete,
  and gives the claim back if one appeared.
- **Acquire.** When an SSH lease starts for a run, it checks for a fresh claim on
  that run after its own lease is visible. If there is one, the new lease fails
  and the run must start again. Between the two checks, one side always sees the
  other.
- **Crash.** A claim older than 15 minutes (a server died mid-removal) is
  reclaimed by the next sweep.

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
- Activity `environment.ssh_run_directory_kept`, once, with the reason.
- A log line per removal with `bytesFreed`, and one per sweep with the totals.

The server has no metrics backend. Sum `details.bytesFreed` over the activity
entries to chart freed bytes.
