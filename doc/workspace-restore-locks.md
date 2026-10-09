# Workspace restore locks

Workspace restore and agent-file collection serialize writes to each canonical
target directory. Their lock files live in
`<instance root>/locks/directory-merge`, outside the writable target. All writers
must use the same instance root and a filesystem with reliable SQLite file
locking. Network filesystems that do not provide that locking are not supported.

Each target has a permanent `<hash>.lock.sqlite` file. An open SQLite
`BEGIN IMMEDIATE` transaction holds its reserved file lock for the entire write
operation. Contenders retry without blocking the Node event loop. Closing the
connection releases the lock; the operating system also releases it when the
process exits or crashes. Independent targets use different files and can
proceed concurrently.

Parallel runs on one project workspace, or on one agent's directory, take the
lock one at a time, and one merge of a large tree can hold it for more than 30
seconds. A workspace restore and the agent directory lifecycle lock therefore
time out only after 10 minutes **without queue progress**. Each time a ticket
ahead of a contender leaves, its budget starts again, so a deep queue of healthy
holders never times out a contender, while a stuck holder or a stuck head of
the queue still does. Set `PAPERCLIP_WORKSPACE_RESTORE_LOCK_WAIT_MS` (1 second
to 1 hour) to change that budget. Other writers, such as credential files, keep
a 30-second budget with the same rule. A timeout still fails the run with
`restore_lock_timeout` and the owner diagnostics below.

While a workspace restore waits, it writes a line to the run log about every 30
seconds, for example `[paperclip] Waiting for the workspace merge lock: another
run has held it for 95s, 2 queued ahead (waited 60s).` The line holds wait times
and a count only, never the lock path, the target path, or a process id. The
report is not awaited, so a slow or stuck run log cannot delay the restore or
the contenders queued behind it.

A run that fails on this timeout ends with the error code
`workspace_restore_lock_timeout`, not `adapter_failed`, and its result carries
`workspaceRestoreFailure: "restore_lock_timeout"`. The server then asks for a
bounded transient retry, as it does for other self-clearing failures. That retry
still obeys the reconciliation guard: if the adapter had already started, so
provider work may have run, the server does not queue a second run and an
operator must reconcile the first. Only a timeout before any provider work, such
as the lock for a restarted agent directory at run start, is re-queued.
Contenders are admitted in arrival order. Each takes a ticket in
`<hash>.lock.queue.sqlite`, and only the oldest live ticket tries the lock, so
a newer restore cannot overtake an older one. The tickets order attempts only;
the `.lock.sqlite` transaction above remains the sole authority for mutual
exclusion, so a lost or stale ticket can delay a contender but never admit two.
While queued, a contender holds an SQLite lock on its own
`<hash>.lock.waiter-<uuid>.sqlite` file. The operating system releases that
lock if the contender crashes, so the next contender sees an unlocked file,
removes the dead ticket and the file, and moves on. This takes up to about one
second per dead ticket. PIDs, ages, and clocks do not decide whether a ticket
is dead. The queue file can be deleted while no instance is writing; it holds
no state that outlives a queue.

A restore whose files match the run's baseline, and whose remote Git HEAD is
already in the local history, has nothing to apply. It returns without taking
the lock, so read-only runs do not lengthen the queue. Snapshot walks and SSH
sync archives never include a merge's staged `.paperclip-merge-<uuid>` files.
A snapshot walk treats an entry as absent when another writer deletes or
renames it, or replaces its parent directory with a file, during the walk.

A merge never writes, deletes, or renames through a link. Another restore can
leave a link where the run saw a directory (`a -> /elsewhere`), and a path such
as `a/b` would then resolve outside the workspace. Before it writes anything,
the merge refuses with `DIRECTORY_MERGE_CONFLICT` when an ancestor of an entry it
will apply is a link or a file in the target, or is not a directory in the run's
own snapshot (a snapshot with a link `a` and a child `a/b` is refused whole), so
a refused merge leaves the target as it was. A directory that the merge itself
replaces first is not refused. An I/O failure part way through a merge is a
different case: the merge is not transactional, and a retry from the same
baseline is safe.

Each write, delete, directory removal, and rename then re-validates its own
path. **The guarantee that a swapped path cannot redirect an operation holds on
Linux only, which is where the server runs.** There the merge opens each
directory from the previous one with `O_DIRECTORY` and `O_NOFOLLOW` and operates
through `/proc/self/fd/<n>/name`, which stays bound to the directory it
validated even if its path is swapped for a link a moment later; a swapped path
is refused or acts on the original directory, never on the outside. Node has no
`openat` and macOS has no such path. Off Linux the merge falls back to path
re-checks: it checks every ancestor again with `lstat` and a `realpath`
containment test immediately before the operation, makes missing directories one
level at a time, and stages each copy in the target root rather than beside its
destination, so a long copy cannot write through a link. That narrows the race
but does not close it: a link swapped in between the last check and the
operation can still make a write land outside the workspace (a reviewer probe did
this on macOS). Do not rely on the fallback for a workspace that untrusted code
can write while a restore runs. The lock keeps other merges out of the window; a
writer that does not take the lock is not covered by either mode. A plain file
in the way of a delete means the entry is already gone and the delete is
skipped, and a delete never removes a directory's contents.

A merge killed while it copies a file leaves its `.paperclip-merge-<uuid>`
staging file in the workspace. Walks hide these names, so the file would keep
its directory non-empty after the run deleted that directory. When a merge
removes or replaces a directory and finds it non-empty, it deletes the staging
files directly inside it and retries once. It deletes only a regular file owned
by the server's user, older than 15 minutes, found by `lstat` and never through
a link, and it never recurses. It first checks every directory from the
workspace root down with `lstat` and refuses a path that has a link or a
non-directory in it, then checks that the resolved path stays under the root, so
a link inside the workspace cannot lead the cleanup to a directory outside it. A directory that holds anything else stays.

This uses the same built-in `node:sqlite` dependency as workspace manifests.
See [SQLite file locking](https://www.sqlite.org/lockingv3.html) for the reserved
lock contract. No application database or schema migration is involved.

The adjacent `<hash>.lock.owner.json` records a PID and creation time only for
bounded timeout diagnostics. Missing, stale, or incorrect metadata cannot grant
or retain ownership. PID reuse, PID namespaces, and wall-clock changes do not
decide whether a writer owns the lock.

**Never delete, replace, or move a `.lock.sqlite` file while an instance can
write to it.** Its stable inode is part of the locking contract. Replacing it
could let two writers lock different files for the same target. Files remain
after release, including for targets that no longer exist. Their diagnostic
owner sidecars are normally removed after release.

## Upgrade from directory locks

Older versions created `<hash>.lock/owner.json` and checked only whether the
recorded PID existed. A server restart could reuse that PID and leave an orphaned
lock permanently protected. Those records cannot establish a process lifetime or
PID namespace, so the new implementation never guesses that a legacy holder is
dead. An existing legacy directory continues to block admission.

Do not run old and new lock protocols concurrently against the same instance
root. An old process does not participate in the SQLite lock protocol.

1. Drain and stop **all** old server and worker processes that can write to the
   instance root, including processes on other hosts or in other containers.
2. Preserve any unfinished-run evidence needed for recovery. After all writers
   are stopped, move leftover legacy `<hash>.lock/` directories to an operator
   scratch directory outside the lock root. Do not remove `.lock.sqlite` files.
3. Start all writers on the new version. Verify that a run completes both the
   provider turn and file collection/restore. A successful model response alone
   does not prove that its local file changes were saved.

The same drain requirement applies to rollback. Existing permanent SQLite files
can remain on disk; older versions ignore them. Do not infer that a legacy lock
is safe to remove from its age, an absent PID, or a successful task response.

This change prevents new orphaned ownership. It cannot recover file changes
that an earlier failed collection discarded.
