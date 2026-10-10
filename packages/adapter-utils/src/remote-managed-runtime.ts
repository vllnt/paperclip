import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  type SshConnectionConfig,
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  sshSyncBackDependencyExcludes,
  syncDirectoryToSsh,
  untrackedSshSyncBackDependencyDirNames,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

/**
 * A synced SSH run works in `<remoteRoot>/.paperclip-runtime/runs/<runId>/workspace`.
 * Nothing else writes under `runs/<runId>`, so that directory holds only the
 * run's own copy of the workspace.
 *
 * This is the only place that builds the path, and the run id is one plain
 * path segment, so two run ids never share a directory. The reaper's claim
 * relies on that: it looks only at leases of the directory's own run. An id
 * such as `..` or `a/../b` would alias another run's directory, so it throws.
 */
export function sshRunDirectory(remoteRoot: string, runId: string): string {
  // Anything else is one segment named by the id, so it aliases nothing.
  if (runId === "" || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\0")) {
    throw new Error("An SSH run directory name must be one plain path segment.");
  }
  return path.posix.join(remoteRoot, ".paperclip-runtime", "runs", runId);
}

/**
 * Written into `runs/<runId>` when the host holds no unsynced work there: after
 * the run's sync-back finished, or when preparation failed before any agent
 * ran. Only this marker allows {@link removeRestoredSshRunDirectory} to delete
 * the directory.
 */
export const SSH_RUN_RESTORED_MARKER = ".paperclip-restored";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes one run's `runs/<runId>` directory on an SSH host once its sync-back
 * finished. It is confined to that exact path: the run id must be a UUID, the
 * root must be a normalized absolute path, and every directory below the root
 * (`.paperclip-runtime`, `runs`, `<runId>`) must be a real directory, never a
 * symlink, so a link an agent planted cannot redirect the removal. `rm -rf`
 * and `find` do not follow symlinks inside the tree. Without the restored
 * marker the directory is kept, because it may hold the only copy of the run's
 * work. The marker is deleted last, so a removal that fails part way (for
 * example on a file it cannot delete) reports `rm_failed` and can be retried.
 */
export async function removeRestoredSshRunDirectory(input: {
  spec: SshConnectionConfig;
  remoteRoot: string;
  runId: string;
  timeoutMs?: number;
}): Promise<"removed" | "not_restored" | "absent" | "symlink" | "rm_failed"> {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error("Refusing to remove an SSH run directory for a run id that is not a UUID.");
  }
  const root = input.remoteRoot;
  if (!path.posix.isAbsolute(root) || root === "/" || path.posix.normalize(root) !== root || root.endsWith("/")) {
    throw new Error("Refusing to remove an SSH run directory under a root that is not a normalized absolute path.");
  }
  const runtimeDir = path.posix.join(root, ".paperclip-runtime");
  const runsDir = path.posix.join(runtimeDir, "runs");
  const runDir = sshRunDirectory(root, input.runId);
  const marker = path.posix.join(runDir, SSH_RUN_RESTORED_MARKER);
  const script = [
    `for dir in ${[runtimeDir, runsDir, runDir].map(shellQuote).join(" ")}; do`,
    '  if [ -L "$dir" ]; then echo symlink; exit 0; fi',
    '  if [ ! -d "$dir" ]; then echo absent; exit 0; fi',
    "done",
    `if [ -L ${shellQuote(marker)} ] || [ ! -f ${shellQuote(marker)} ]; then echo not_restored; exit 0; fi`,
    // Directories without owner rwx (a Go module cache, say) would stop rm -rf.
    // A per-directory `-exec ... ;` runs chmod before find descends into that
    // directory, so nested ones are reached too.
    `find ${shellQuote(runDir)} -type d ! -perm -700 -exec chmod u+rwx {} \\; 2>/dev/null || true`,
    // Delete the marker last and put it back if the directory itself stays, so
    // a failed removal can always be retried.
    `if find ${shellQuote(runDir)} -mindepth 1 -maxdepth 1 ! -name ${shellQuote(SSH_RUN_RESTORED_MARKER)} -exec rm -rf -- {} + 2>/dev/null \\`,
    `  && rm -f -- ${shellQuote(marker)} \\`,
    `  && { rmdir -- ${shellQuote(runDir)} 2>/dev/null || { : > ${shellQuote(marker)}; false; }; }; then`,
    "  echo removed",
    "else",
    "  echo rm_failed",
    "fi",
  ].join("\n");
  const result = await runSshCommand(input.spec, script, {
    timeoutMs: input.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024,
  });
  const outcome = result.stdout.trim().split("\n").pop();
  if (
    outcome === "removed" || outcome === "not_restored" || outcome === "absent" ||
    outcome === "symlink" || outcome === "rm_failed"
  ) {
    return outcome;
  }
  throw new Error("SSH run directory removal returned an unexpected result.");
}

export type SshRunDirectoryKeepReason =
  | "not_git_backed"
  | "worktree_dirty"
  | "preserve_failed"
  | "mount_point"
  | "seed_unknown"
  | "rm_failed";

export type SshRunDirectoryReapResult =
  | { outcome: "removed"; bytesFreed: number; preserved: string[] }
  | { outcome: "absent" }
  | { outcome: "symlink" }
  | { outcome: "unbounded" }
  | { outcome: "kept"; reason: SshRunDirectoryKeepReason; bytes: number; detail?: string };

/** Where a reaped run's preserved git state is kept, outside every `runs/<runId>`. */
export function sshPreservedBundlePath(remoteRoot: string, runId: string): string {
  return path.posix.join(remoteRoot, ".paperclip-runtime", "preserved", `${runId}.bundle`);
}

const PRESERVED_BUNDLE_MAX_KB = 1024 * 1024;
const PRESERVED_BUNDLE_RETENTION_DAYS = 30;
const REAP_KILL_GRACE_SECONDS = 30;

/**
 * Deletes one run's `runs/<runId>` directory on an SSH host for any finished
 * run, and reports the bytes it freed. It has the same path confinement as
 * {@link removeRestoredSshRunDirectory}. A directory with the restored marker
 * holds no unsynced work and goes at once. Without the marker the host may
 * hold the only copy of the run's work, so the directory goes only after its
 * local-only git state is safe. That state is: commits on HEAD past the commit
 * the run started from, branch tips outside HEAD, stash entries, a detached
 * head of an extra worktree, and uncommitted work (a snapshot commit of the
 * tracked and untracked files that git does not ignore). It is written to
 * `refs/paperclip/preserved/<runId>/*` and bundled into
 * `<root>/.paperclip-runtime/preserved/<runId>.bundle`, with the run's start
 * commit as the bundle's prerequisite, so only new objects are stored. The
 * directory is kept, with a reason, when the work is not a git repository,
 * when an extra worktree holds uncommitted work, or when the bundle cannot be
 * written and verified. Git runs with the repository's `core.fsmonitor` and
 * hooks switched off. Bundles older than 30 days are removed.
 *
 * The worker script has its own time limit, `timeoutMs` rounded up to whole
 * seconds, enforced by `timeout` on the worker (with a 30 s kill grace). A
 * dropped connection or a stalled caller therefore cannot leave a script
 * running past the caller's claim on the directory. A worker without
 * `timeout` is not reaped: the result is `unbounded` and nothing is changed.
 * A bundle already published for the run is reused only as a regular file that
 * verifies and lists every ref this pass computed at exactly the commit it has
 * now. Otherwise a new bundle is verified under a temporary name, the old one
 * is kept as `<runId>.superseded.bundle`, and the new one is renamed into
 * place; any failure, or a final mismatch, keeps the directory. The refs
 * reported are the ones the bundle holds. A run directory that is a mount point, or on another
 * device than `runs`, is kept as `mount_point`, and the delete stays on the
 * run directory's own filesystem.
 */
export async function reapSshRunDirectory(input: {
  spec: SshConnectionConfig;
  remoteRoot: string;
  runId: string;
  timeoutMs?: number;
  /**
   * The commit the run's workspace was uploaded from, as the server recorded it
   * before the upload. Without a valid one, an unrestored directory is kept
   * (`seed_unknown`), because the worker cannot say which commits are the run's own.
   */
  seed?: string | null;
  /** Test seam only: shell lines the worker runs at fixed points, to swap a path under the script. */
  testHooks?: { afterChecks?: string; afterConfine?: string; beforeBound?: string; afterRead?: string };
}): Promise<SshRunDirectoryReapResult> {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error("Refusing to reap an SSH run directory for a run id that is not a UUID.");
  }
  const root = input.remoteRoot;
  if (!path.posix.isAbsolute(root) || root === "/" || path.posix.normalize(root) !== root || root.endsWith("/")) {
    throw new Error("Refusing to reap an SSH run directory under a root that is not a normalized absolute path.");
  }
  // `/tmp` or `/home` is a place many things live, not a runtime base.
  if (root.split("/").filter(Boolean).length < 2) {
    throw new Error("Refusing to reap an SSH run directory under a root that is too shallow to be a runtime base.");
  }
  const q = shellQuote;
  const seed = typeof input.seed === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.seed) ? input.seed : "";
  const hook = (line: string | undefined) => (line ? [line] : []);
  const body = [
    `root=${q(root)}; id=${q(input.runId)}; ns=${q(`refs/paperclip/preserved/${input.runId}`)}; seed=${q(seed)}`,
    // The root is resolved once. Everything below is compared with this physical path.
    'canon=$(cd "$root" 2>/dev/null && pwd -P) || { echo absent; exit 0; }',
    'runtime="$root/.paperclip-runtime"; runs="$runtime/runs"; preserved="$runtime/preserved"',
    'for dir in "$runtime" "$runs" "$runs/$id"; do',
    '  if [ -L "$dir" ]; then echo symlink; exit 0; fi',
    '  if [ ! -d "$dir" ]; then echo absent; exit 0; fi',
    "done",
    ...hook(input.testHooks?.afterChecks),
    // Confine. A check on a path says nothing about the next use of that path,
    // since another process can swap a parent in between. So enter the run
    // directory, prove that the directory entered is the expected physical one,
    // and from here on use only paths relative to it: the working directory is
    // an inode, not a path, and no later swap of a parent can redirect it.
    'cd "$runs" 2>/dev/null || { echo absent; exit 0; }',
    'if [ "$(pwd -P)" != "$canon/.paperclip-runtime/runs" ]; then echo symlink; exit 0; fi',
    'if [ -L "$id" ]; then echo symlink; exit 0; fi',
    'cd "$id" 2>/dev/null || { echo absent; exit 0; }',
    'if [ "$(pwd -P)" != "$canon/.paperclip-runtime/runs/$id" ]; then echo symlink; exit 0; fi',
    ...hook(input.testHooks?.afterConfine),
    'dev_here=$(stat -c %d . 2>/dev/null || stat -f %d . 2>/dev/null); dev_runs=$(stat -c %d .. 2>/dev/null || stat -f %d .. 2>/dev/null)',
    'if [ -z "$dev_here" ] || [ "$dev_here" != "$dev_runs" ]; then echo "kept mount_point 0"; exit 0; fi',
    'if command -v mountpoint >/dev/null 2>&1 && mountpoint -q . 2>/dev/null; then echo "kept mount_point 0"; exit 0; fi',
    'ws=workspace; list=.paperclip-reap-refs; marker=.paperclip-restored; bundle="$canon/.paperclip-runtime/preserved/$id.bundle"',
    'kb=$(du -sk . 2>/dev/null | cut -f1); kb=${kb:-0}',
    'keep() { echo "kept $1 $kb"; exit 0; }',
    // Keeps the directory and names the git command that failed.
    'fail() { echo "detail $1"; keep preserve_failed; }',
    'isoid() { case "$1" in ""|*[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -ge 40 ]; }',
    // Threat model: the worker's git is trusted. A git that exits 0 and prints
    // false output is out of scope. Output that is cut short is in scope, and so is
    // a legitimate git state that the logic could misread.
    // rd NAME LABEL COMMAND...: runs a repository read into a file, ends the file
    // with a line that names the read and counts the lines before it, and checks
    // that line before anything uses the output. The data, without that line, is
    // then in "$list.NAME.body". A read that failed, or whose output lost its end
    // or some of its lines, keeps the directory.
    'rd() {',
    '  rname=$1; rlabel=$2; shift 2',
    '  "$@" > "$list.$rname" 2>/dev/null || fail "$rlabel"',
    '  rn=$(wc -l < "$list.$rname" | tr -d " ")',
    '  printf "__PCREAD %s OK %s\\n" "$rname" "$rn" >> "$list.$rname" || fail "$rlabel"',
    ...hook(input.testHooks?.afterRead),
    '  rcheck "$rname" "$rlabel"',
    "}",
    'rcheck() {',
    '  rtotal=$(wc -l < "$list.$1" | tr -d " ")',
    '  rlast=$(tail -n 1 "$list.$1")',
    '  [ "$rtotal" -ge 1 ] 2>/dev/null || fail "$2 truncated"',
    '  [ "$rlast" = "__PCREAD $1 OK $((rtotal - 1))" ] || fail "$2 truncated"',
    '  sed "\\$d" "$list.$1" > "$list.$1.body" || fail "$2"',
    "}",
    // Flushes a file, or a directory, to disk. A worker whose sync takes no
    // argument flushes everything.
    'fsync_path() { sync -- "$1" 2>/dev/null || sync; }',
    // True when bundle $1 verifies and its refs are exactly the computed ones:
    // the same number, each at the commit it has now. None missing, moved or extra.
    'matches() { G bundle verify "$1" >/dev/null 2>&1 || return 1; G bundle list-heads "$1" > "$list.published" 2>/dev/null || return 1; [ "$(grep -c . "$list.published")" = "$(grep -c . "$list")" ] || return 1; while IFS= read -r r; do want=$(G rev-parse -q --verify "$r") || return 1; grep -Fxq "$want $r" "$list.published" || return 1; done < "$list"; }',
    // A repository config the agent planted must not run commands here.
    'G() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c gc.auto=0 -C "$ws" "$@"; }',
    'export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Paperclip GIT_AUTHOR_EMAIL=reaper@paperclip.invalid GIT_COMMITTER_NAME=Paperclip GIT_COMMITTER_EMAIL=reaper@paperclip.invalid',
    'had_marker=0',
    'if [ -f "$marker" ] && [ ! -L "$marker" ]; then',
    "  had_marker=1",
    "else",
    '  if [ -L "$ws" ] || [ ! -d "$ws" ]; then keep not_git_backed; fi',
    '  if [ -L "$ws/.git" ] || [ -f "$ws/.git" ]; then keep preserve_failed; fi',
    '  if [ ! -d "$ws/.git" ]; then keep not_git_backed; fi',
    '  G rev-parse --git-dir >/dev/null 2>&1 || fail "git rev-parse"',
    // The commit the run's workspace was uploaded from, as the server recorded
    // it. It is never taken from the worker's reflog, which an agent can expire.
    // Without it the directory stays. Every commit that is not reachable from
    // the seed is the run's own, whatever the reflog says.
    '  if [ -z "$seed" ]; then keep seed_unknown; fi',
    // Exit 0 is "an ancestor", exit 1 is "not", and any other status is a failed
    // read, which keeps the directory.
    '  anc() { G merge-base --is-ancestor "$1" "$2" >/dev/null 2>&1; as=$?; if [ "$as" = 0 ]; then return 0; fi; if [ "$as" = 1 ]; then return 1; fi; fail "git merge-base"; }',
    // Every read below fails closed: a command that exits non-zero, whose output
    // lost its end (see rd), or that prints something that is not an object id
    // where one is due, keeps the directory. HEAD may be unborn (rev-parse exits
    // 1 and HEAD is a symbolic ref).
    '  G rev-parse -q --verify HEAD >/dev/null 2>&1; head_status=$?',
    '  if [ "$head_status" = 0 ]; then',
    '    rd head "git rev-parse HEAD" G rev-parse -q --verify HEAD',
    '    head=$(cat "$list.head.body"); isoid "$head" || fail "git rev-parse HEAD"',
    '  elif [ "$head_status" = 1 ] && G symbolic-ref -q HEAD >/dev/null 2>&1; then',
    '    head=""',
    "  else",
    '    fail "git rev-parse HEAD"',
    "  fi",
    '  : > "$list"',
    '  rd stale "git for-each-ref" G for-each-ref "--format=%(refname)" "$ns"',
    '  while IFS= read -r r; do if [ -n "$r" ]; then G update-ref -d "$r" || fail "git update-ref"; fi; done < "$list.stale.body"',
    '  add_ref() { isoid "$2" || fail "git object id"; if anc "$2" "$seed"; then return 0; fi; G update-ref "$ns/$1" "$2" || fail "git update-ref"; echo "$ns/$1" >> "$list"; }',
    '  [ -n "$head" ] && add_ref head "$head"',
    '  rd heads "git for-each-ref" G for-each-ref "--format=%(objectname) %(refname)" refs/heads',
    '  while IFS=" " read -r obj ref; do',
    '    [ -n "$obj$ref" ] || continue',
    '    isoid "$obj" || fail "git for-each-ref"',
    '    if [ -n "$head" ] && anc "$obj" "$head"; then continue; fi',
    '    add_ref "${ref#refs/heads/}" "$obj"',
    '  done < "$list.heads.body"',
    '  index=0',
    '  rd stash "git stash list" G stash list --format=%H',
    '  while IFS= read -r obj; do if [ -n "$obj" ]; then add_ref "stash-$index" "$obj"; fi; index=$((index + 1)); done < "$list.stash.body"',
    '  rd trees "git worktree list" G worktree list --porcelain',
    '  index=0; main=1; tree=""; detached=""; prunable=""; treehead=""',
    '  while IFS= read -r line || [ -n "$line" ]; do',
    '    case "$line" in',
    '      "worktree "*) tree="${line#worktree }"; detached=""; prunable=""; treehead="" ;;',
    '      "HEAD "*) treehead="${line#HEAD }" ;;',
    '      detached) detached=1 ;;',
    '      prunable*) prunable=1 ;;',
    '      "")',
    '        if [ -n "$tree" ] && [ "$main" = 0 ] && [ -z "$prunable" ]; then',
    '          rd wtstatus "git status (extra worktree)" git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$tree" status --porcelain',
    '          if [ -s "$list.wtstatus.body" ]; then keep worktree_dirty; fi',
    '          if [ -n "$detached" ] && [ -n "$treehead" ]; then',
    '            wtneed=1; if [ -n "$head" ] && anc "$treehead" "$head"; then wtneed=0; fi',
    '            if [ "$wtneed" = 1 ]; then add_ref "worktree-head-$index" "$treehead"; fi',
    "          fi",
    '          index=$((index + 1))',
    '        fi',
    '        main=0; tree="" ;;',
    '    esac',
    '  done < "$list.trees.body"',
    // Uncommitted work: a snapshot commit of what git tracks or would track.
    // The index file is named relative to the repository, which is `-C workspace`.
    '  rd status "git status" G status --porcelain',
    '  if [ -s "$list.status.body" ]; then',
    '    idx=../.paperclip-reap-index; rm -f .paperclip-reap-index',
    '    if [ -n "$head" ]; then GIT_INDEX_FILE="$idx" G read-tree HEAD || fail "git read-tree"; fi',
    '    GIT_INDEX_FILE="$idx" G add -A || fail "git add"',
    '    tree_id=$(GIT_INDEX_FILE="$idx" G write-tree) || fail "git write-tree"',
    '    if [ -n "$head" ]; then snap=$(G commit-tree "$tree_id" -p "$head" -m "Paperclip preserved worktree") || fail "git commit-tree"; else snap=$(G commit-tree "$tree_id" -m "Paperclip preserved worktree") || fail "git commit-tree"; fi',
    '    rm -f .paperclip-reap-index',
    '    add_ref worktree "$snap"',
    '  fi',
    '  if [ -s "$list" ]; then',
    '    set --; while IFS= read -r r; do set -- "$@" "$r"; done < "$list"',
    '    if [ -n "$seed" ]; then set -- "$@" "^$seed"; fi',
    // Written inside the confined directory first, then moved into the
    // preserved directory, which is confined the same way.
    '    G bundle create ../.paperclip-reap.bundle "$@" >/dev/null 2>&1 || { rm -f .paperclip-reap.bundle; keep preserve_failed; }',
    '    size=$(du -k .paperclip-reap.bundle 2>/dev/null | cut -f1); size=${size:-0}',
    `    if [ "$size" -gt ${PRESERVED_BUNDLE_MAX_KB} ]; then rm -f .paperclip-reap.bundle; keep preserve_failed; fi`,
    '    mkdir -p "$preserved" 2>/dev/null || { rm -f .paperclip-reap.bundle; keep preserve_failed; }',
    // What is at the published path: nothing (0), a regular file (4), or anything
    // else, a link included (2).
    '    ( cd "$preserved" 2>/dev/null && [ "$(pwd -P)" = "$canon/.paperclip-runtime/preserved" ] || exit 2',
    '      if [ -L "./$id.bundle" ]; then exit 2; fi',
    '      if [ -e "./$id.bundle" ]; then if [ -f "./$id.bundle" ]; then exit 4; fi; exit 2; fi',
    '      exit 0 ); pub=$?',
    '    if [ "$pub" != 0 ] && [ "$pub" != 4 ]; then rm -f .paperclip-reap.bundle; keep preserve_failed; fi',
    // An existing bundle is reused, untouched, only when its refs are exactly the
    // computed ones. Otherwise the new bundle is moved into the preserved
    // directory under a unique temporary name, verified, flushed to disk, the old
    // bundle is kept as <id>.superseded.bundle (a hard link, so nothing is
    // copied), and the new one is renamed into place.
    '    if [ "$pub" = 4 ] && matches "$bundle"; then',
    '      rm -f .paperclip-reap.bundle',
    "    else",
    '      staged=$( cd "$preserved" 2>/dev/null && [ "$(pwd -P)" = "$canon/.paperclip-runtime/preserved" ] || exit 2',
    '        tmp=$(mktemp "./.$id.bundle.XXXXXX") || exit 2',
    '        mv -f -- "$canon/.paperclip-runtime/runs/$id/.paperclip-reap.bundle" "$tmp" || { rm -f -- "$tmp"; exit 2; }',
    '        echo "$tmp" ) || { rm -f .paperclip-reap.bundle; fail "bundle staging"; }',
    '      G bundle verify "$canon/.paperclip-runtime/preserved/$staged" >/dev/null 2>&1 || { ( cd "$preserved" 2>/dev/null && rm -f -- "$staged" ); fail "git bundle verify"; }',
    '      ( cd "$preserved" 2>/dev/null && [ "$(pwd -P)" = "$canon/.paperclip-runtime/preserved" ] || exit 2',
    // The file is flushed before the rename, and the directory after it, so a
    // crash cannot leave the directory entry behind a deleted run directory.
    '        fsync_path "$staged"',
    '        if [ "$pub" = 4 ]; then ln -f -- "./$id.bundle" "./$id.superseded.bundle" || exit 2; fi',
    '        mv -f -- "$staged" "./$id.bundle" || exit 2',
    '        fsync_path .',
    '        exit 0 ) || { ( cd "$preserved" 2>/dev/null && rm -f -- "$staged" ); fail "bundle publish"; }',
    "    fi",
    '    rm -f .paperclip-reap.bundle',
    '    matches "$bundle" || fail "bundle check"',
    '    while IFS= read -r r; do echo "preserved $r"; done < "$list"',
    "  fi",
    "fi",
    `( cd "$preserved" 2>/dev/null && [ "$(pwd -P)" = "$canon/.paperclip-runtime/preserved" ] && find . -maxdepth 1 -type f \\( -name '*.bundle' -o -name '.*.bundle.*' \\) -mtime +${PRESERVED_BUNDLE_RETENTION_DAYS} -exec rm -f -- {} + ) 2>/dev/null || true`,
    // Directories without owner rwx (a Go module cache, say) would stop the
    // delete. A per-directory chmod runs before find descends into that
    // directory. -xdev keeps both passes on the run directory's own filesystem,
    // so a mount below it keeps its contents (the delete fails on the mount point).
    'find . -xdev -type d ! -perm -700 -exec chmod u+rwx {} \\; 2>/dev/null || true',
    // Empty the directory we are inside, then remove the marker, then the
    // directory itself from its parent, which must still be the real `runs`.
    'if find . -mindepth 1 -depth -xdev ! -path ./.paperclip-restored -delete 2>/dev/null \\',
    '  && rm -f -- .paperclip-restored \\',
    '  && ( cd .. 2>/dev/null && [ "$(pwd -P)" = "$canon/.paperclip-runtime/runs" ] && rmdir -- "$id" 2>/dev/null ); then',
    '  echo "removed $kb"',
    "else",
    // A failed removal keeps a restored directory removable. A directory that
    // had no marker never gets one, so the next attempt saves its state again.
    '  if [ "$had_marker" = 1 ]; then : > .paperclip-restored 2>/dev/null || true; fi',
    '  keep rm_failed',
    "fi",
  ].join("\n");
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const script = [
    `body=${q(body)}`,
    ...(input.testHooks?.beforeBound ? [input.testHooks.beforeBound] : []),
    `if command -v timeout >/dev/null 2>&1; then exec timeout -k ${REAP_KILL_GRACE_SECONDS} ${Math.ceil(timeoutMs / 1000)} sh -c "$body"; fi`,
    "echo unbounded",
  ].join("\n");
  const result = await runSshCommand(input.spec, script, { timeoutMs, maxBuffer: 256 * 1024 });
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const preserved = lines.filter((line) => line.startsWith("preserved ")).map((line) => line.slice("preserved ".length));
  const last = lines[lines.length - 1] ?? "";
  if (last === "absent" || last === "symlink" || last === "unbounded") return { outcome: last };
  const removed = /^removed (\d+)$/.exec(last);
  if (removed) return { outcome: "removed", bytesFreed: Number(removed[1]) * 1024, preserved };
  const kept = /^kept (not_git_backed|worktree_dirty|preserve_failed|mount_point|seed_unknown|rm_failed) (\d+)$/.exec(last);
  if (kept) {
    const detail = lines.filter((line) => line.startsWith("detail ")).map((line) => line.slice("detail ".length)).pop();
    return {
      outcome: "kept",
      reason: kept[1] as SshRunDirectoryKeepReason,
      bytes: Number(kept[2]) * 1024,
      ...(detail && /^[a-z0-9 ()-]{1,60}$/i.test(detail) ? { detail } : {}),
    };
  }
  throw new Error("SSH run directory reap returned an unexpected result.");
}

/**
 * The share of the worker's disk in use for the filesystem holding
 * `remoteRoot`, from 0 to 100.
 */
export async function readSshDiskUsagePercent(input: {
  spec: SshConnectionConfig;
  remoteRoot: string;
  timeoutMs?: number;
}): Promise<number> {
  const result = await runSshCommand(
    input.spec,
    `df -Pk ${shellQuote(input.remoteRoot)} | awk 'NR==2 { gsub("%", "", $5); print $5 }'`,
    { timeoutMs: input.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 },
  );
  const percent = Number(result.stdout.trim());
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("The worker's disk usage could not be read.");
  }
  return percent;
}

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  const runDir = syncWorkspace ? sshRunDirectory(baseWorkspaceRemoteDir, input.runId) : null;
  const workspaceRemoteDir = runDir ? path.posix.join(runDir, "workspace") : baseWorkspaceRemoteDir;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const marker = runDir ? path.posix.join(runDir, SSH_RUN_RESTORED_MARKER) : null;
  // Best effort: without the marker the run directory is only kept.
  // This relies on each run id being prepared once, before any agent runs in
  // it (every caller does so: a retry gets a new run id).
  const markNothingToKeep = async () => {
    if (!runDir || !marker) return;
    await runSshCommand(input.spec, `if [ -d ${shellQuote(runDir)} ]; then : > ${shellQuote(marker)}; fi`)
      .catch(() => undefined);
  };

  const preparedWorkspace = syncWorkspace
    ? await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
      }).catch(async (error: unknown) => {
        // No agent ran, so a partial upload holds nothing to keep.
        await markNothingToKeep();
        throw error;
      })
    : null;
  // The sync-back tar and the merge both use the baseline's exclude list, so
  // dependency trees listed here stay on the remote and the host's own copies
  // are left alone. A Git workspace keeps syncing any name it tracks. A plain
  // directory cannot say, so it drops them all, as the sandbox lane does.
  // "all" mode is the exact-copy contract for plain persistent directories:
  // agent-file checkpoints validate every downloaded byte against a manifest,
  // so it applies only the caller's `workspaceExclude`.
  const baselineSnapshot = preparedWorkspace
    ? await captureDirectorySnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.gitBacked
          ? [
              ...GIT_ARCHIVE_EXCLUDES,
              ".paperclip-runtime",
              ...sshSyncBackDependencyExcludes(await untrackedSshSyncBackDependencyDirNames(input.workspaceLocalDir)),
            ]
          : [
              ".paperclip-runtime",
              ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : sshSyncBackDependencyExcludes()),
            ],
      })
    : null;

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      });
    }
  } catch (error) {
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress: input.onProgress,
      });
    }
    await markNothingToKeep();
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      // The restored marker lets the lease release delete `runs/<runId>`. Clear
      // an earlier restore's marker first, so a restore that fails below never
      // leaves one behind; write it only after every step succeeded.
      const markerCleared = marker
        ? await runSshCommand(input.spec, `rm -f -- ${shellQuote(marker)}`).then(() => true, () => false)
        : false;
      if (preparedWorkspace && baselineSnapshot) {
        await restoreWorkspaceFromSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          baselineSnapshot,
          restoreGitHistory: preparedWorkspace.gitBacked,
          onProgress,
        });
      }
      for (const asset of input.assets ?? []) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: path.posix.join(runtimeRootDir, asset.key),
          readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
        });
      }
      if (markerCleared) await markNothingToKeep();
    },
  };
}
