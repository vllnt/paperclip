import {
  cleanupRemoteRunTempDirectory,
  prepareRemoteRunTempDirectory,
} from "@paperclipai/adapter-utils/execution-target";
import { buildHeartbeatRunScratchEnv } from "./run-scratch.js";

type RemoteRunTempLocation = Parameters<typeof prepareRemoteRunTempDirectory>[0];

/** What a remote run's own temp directory adds to the run. */
export interface HeartbeatRemoteRunTemp {
  /** Env entries to merge into the run's adapter env. */
  env: Record<string, string>;
  /** The run context's `paperclipScratch`. */
  scratchContext: Record<string, unknown>;
  /** Pass to {@link cleanupHeartbeatRemoteRunTemp} once the run is terminal. */
  cleanupLocation: RemoteRunTempLocation;
}

/**
 * Gives a remote run (SSH or sandbox) its own temp directory on the target and
 * points `TMPDIR`, `TMP` and `TEMP` at it, so agents stop filling the worker's
 * shared `/tmp`. It returns `null` and changes nothing when:
 *
 * - the target is local (local runs keep their own scratch directory);
 * - the agent uses the native runner, whose provider session outlives a run and
 *   must not inherit a run path that is deleted afterwards;
 * - the run's env already sets `TMPDIR` (an operator choice, which wins).
 *
 * An operator `TMP` or `TEMP` also stays; only the unset keys are pointed at
 * the directory.
 *
 * @param input.native - Whether the agent uses the native runner.
 * @param input.env - The run's adapter env before this change.
 * @returns The additions, or `null`.
 * @throws When the target cannot create the directory.
 */
export async function prepareHeartbeatRemoteRunTemp(
  input: RemoteRunTempLocation & { native: boolean; env: Record<string, unknown> },
  prepare = prepareRemoteRunTempDirectory,
): Promise<HeartbeatRemoteRunTemp | null> {
  if (input.native || input.target?.kind !== "remote") return null;
  const operatorTmpdir = input.env.TMPDIR;
  if (typeof operatorTmpdir === "string" && operatorTmpdir.trim().length > 0) return null;
  const location = { runId: input.runId, target: input.target };
  const dir = await prepare(location);
  if (!dir) return null;
  const scratchEnv = buildHeartbeatRunScratchEnv(input.env, { dir });
  return {
    env: scratchEnv.env,
    // The same type as local scratch, so session fingerprints ignore the
    // run-owned path.
    scratchContext: {
      type: "heartbeat_run",
      location: "remote",
      dir,
      cleanupPolicy: "terminal_run",
      tempKeysApplied: scratchEnv.tempKeysApplied,
    },
    cleanupLocation: location,
  };
}

/**
 * Removes a remote run's temp directory; call at a terminal status, once the
 * run's remote process is proven stopped, before the lease is released.
 *
 * @returns `symlink` when it kept the directory because a link or a file
 *   replaced a directory in its path.
 */
export async function cleanupHeartbeatRemoteRunTemp(
  location: RemoteRunTempLocation,
  cleanup = cleanupRemoteRunTempDirectory,
): ReturnType<typeof cleanupRemoteRunTempDirectory> {
  return await cleanup(location);
}
