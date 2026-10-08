import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// A child process that exits before it reads all of its stdin makes the
// parent's pending write fail with EPIPE. Before the fix, that error reached a
// stdin socket with no 'error' listener and crashed the whole server
// ("Unhandled 'error' event ... write EPIPE", pc01 2026-10-08, during the git
// bundle upload to a worker whose disk was full). These tests shadow `ssh` and
// `tar` on PATH with commands that exit without reading their input, so each
// SSH transfer path hits that EPIPE, or the pipe stall that replaces it when
// the exit is seen before the write.

const execFileAsync = promisify(execFile);
// Far larger than any socket buffer, so the write cannot finish before the
// child exits.
const LARGE_INPUT_BYTES = 8 * 1024 * 1024;

const cleanupDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// Puts executable shell shims first on PATH for the rest of the test.
async function shadowCommands(shims: Record<string, string>): Promise<void> {
  const binDir = await tempDir("paperclip-closed-input-bin-");
  for (const [name, body] of Object.entries(shims)) {
    await writeFile(path.join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

// Runs `fn` and returns its settled outcome plus every uncaught exception that
// fired while it ran, including late socket errors after it settled.
async function settleCapturingUncaught<T>(fn: () => Promise<T>): Promise<{
  outcome: PromiseSettledResult<T>;
  uncaught: unknown[];
}> {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  try {
    const outcome = (await Promise.allSettled([fn()]))[0]!;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { outcome, uncaught };
  } finally {
    process.off("uncaughtException", onUncaught);
  }
}

function errorCodes(errors: unknown[]): unknown[] {
  return errors.map((error) => (error as NodeJS.ErrnoException)?.code ?? String(error));
}

function rejectionMessage(outcome: PromiseSettledResult<unknown>): string {
  expect(outcome.status).toBe("rejected");
  const reason = (outcome as PromiseRejectedResult).reason;
  return reason instanceof Error ? reason.message : String(reason);
}

const SSH_EXITS_WITHOUT_READING =
  'echo "kex_exchange_identification: Connection closed by remote host" >&2\nexit 255';

function spec(remoteDir = "/remote/workspace"): SshRemoteExecutionSpec {
  return {
    host: "ssh.invalid",
    port: 22,
    username: "paperclip",
    remoteWorkspacePath: remoteDir,
    remoteCwd: remoteDir,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}

describe("SSH transfers whose child exits before reading its input", () => {
  it("runSshCommand reports the ssh failure instead of crashing on EPIPE", async () => {
    await shadowCommands({ ssh: SSH_EXITS_WITHOUT_READING });

    const { outcome, uncaught } = await settleCapturingUncaught(() =>
      runSshCommand(spec(), "cat > /dev/null", { stdin: "x".repeat(LARGE_INPUT_BYTES) }),
    );

    expect(errorCodes(uncaught)).toEqual([]);
    expect(rejectionMessage(outcome)).toContain("Connection closed by remote host");
  }, 20_000);

  // Two orders: ssh exits while tar is writing (EPIPE), or the ssh exit is
  // seen before tar writes at all (the write then stalls instead of failing).
  it.each([
    { order: "ssh exits mid-write", tarDelay: "" },
    { order: "ssh exits before tar writes", tarDelay: "sleep 1\n" },
  ])("syncDirectoryToSsh reports the ssh failure instead of crashing or hanging ($order)", async ({ tarDelay }) => {
    const realTar = (await execFileAsync("sh", ["-c", "command -v tar"])).stdout.trim();
    await shadowCommands({
      ssh: SSH_EXITS_WITHOUT_READING,
      tar: `${tarDelay}exec ${JSON.stringify(realTar)} "$@"`,
    });
    const localDir = await tempDir("paperclip-closed-input-src-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(LARGE_INPUT_BYTES));

    const { outcome, uncaught } = await settleCapturingUncaught(() =>
      syncDirectoryToSsh({ spec: spec(), localDir, remoteDir: "/remote/workspace" }),
    );

    expect(errorCodes(uncaught)).toEqual([]);
    expect(rejectionMessage(outcome)).toContain("Connection closed by remote host");
  }, 20_000);

  it("the git bundle upload reports the ssh failure instead of crashing on EPIPE", async () => {
    const localDir = await tempDir("paperclip-closed-input-repo-");
    const git = (args: string[]) => execFileAsync("git", ["-C", localDir, ...args]);
    await git(["init", "-q"]);
    await git(["config", "user.name", "Paperclip Test"]);
    await git(["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localDir, "big.bin"), randomBytes(LARGE_INPUT_BYTES));
    await git(["add", "big.bin"]);
    await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "big"]);
    await shadowCommands({ ssh: SSH_EXITS_WITHOUT_READING });

    const { outcome, uncaught } = await settleCapturingUncaught(() =>
      prepareWorkspaceForSshExecution({ spec: spec(), localDir }),
    );

    expect(errorCodes(uncaught)).toEqual([]);
    expect(rejectionMessage(outcome)).toContain("Connection closed by remote host");
  }, 20_000);

  // Two orders: tar exits while ssh is streaming (EPIPE), or the tar exit is
  // seen before ssh sends anything (the write then stalls instead of failing).
  it.each([
    { order: "tar exits mid-stream", sshDelay: "" },
    { order: "tar exits before ssh sends", sshDelay: "sleep 1\n" },
  ])("syncDirectoryFromSsh reports the local tar failure instead of crashing or hanging ($order)", async ({ sshDelay }) => {
    await shadowCommands({
      // The remote side streams an archive...
      ssh: `${sshDelay}head -c ${LARGE_INPUT_BYTES} /dev/zero`,
      // ...but the local extract stops reading and exits, like a full disk.
      tar: 'echo "tar: ./big.bin: Cannot write: No space left on device" >&2\nexit 2',
    });
    const localDir = await tempDir("paperclip-closed-input-dst-");
    await mkdir(path.join(localDir, "kept"));

    const { outcome, uncaught } = await settleCapturingUncaught(() =>
      syncDirectoryFromSsh({ spec: spec(), remoteDir: "/remote/workspace", localDir }),
    );

    expect(errorCodes(uncaught)).toEqual([]);
    expect(rejectionMessage(outcome)).toContain("No space left on device");
    // A failed restore never clears the local workspace.
    expect(await readdir(localDir)).toEqual(["kept"]);
  }, 20_000);
});
