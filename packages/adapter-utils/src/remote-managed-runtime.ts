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
 */
export function sshRunDirectory(remoteRoot: string, runId: string): string {
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
    // Read-only directories (a Go module cache, say) would stop rm -rf.
    `find ${shellQuote(runDir)} -type d ! -perm -200 -exec chmod u+w {} + 2>/dev/null || true`,
    `if find ${shellQuote(runDir)} -mindepth 1 -maxdepth 1 ! -name ${shellQuote(SSH_RUN_RESTORED_MARKER)} -exec rm -rf -- {} + \\`,
    `  && rm -f -- ${shellQuote(marker)} && rmdir -- ${shellQuote(runDir)}; then echo removed; else echo rm_failed; fi`,
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
