import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchGitBundleIntoLocalRef,
  isMissingGitPrerequisiteError,
  isTransientGitBundleTransferError,
  retryTransientGitBundleTransfer,
} from "./git-workspace-sync.js";
import { restoreWorkspaceFromSshExecution, type SshRemoteExecutionSpec } from "./ssh.js";

// A workspace restore whose bundle stream is cut short fails in git with
// "fatal: early EOF / error: index-pack died".
// The sandbox is still live, so exporting again cures it. These tests cut a
// real bundle, check that git's own message is classified as transient, and
// drive the SSH restore with an `ssh` shim that truncates or kills the stream.

const execFileAsync = promisify(execFile);
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/**
 * A local repo at commit A, plus a bundle from a clone of it that holds one more
 * commit B of incompressible data. Importing the bundle into the local repo has
 * to read B's pack, so a cut bundle fails in index-pack.
 */
async function repoWithBundle(exportRef: string): Promise<{ repo: string; bundle: string }> {
  const repo = await tempDir("paperclip-bundle-retry-repo-");
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.name", "Paperclip Test"]);
  await git(repo, ["config", "user.email", "test@paperclip.dev"]);
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);

  const remote = await tempDir("paperclip-bundle-retry-remote-");
  await execFileAsync("git", ["clone", "-q", repo, remote]);
  await git(remote, ["config", "user.name", "Paperclip Test"]);
  await git(remote, ["config", "user.email", "test@paperclip.dev"]);
  await writeFile(path.join(remote, "work.bin"), randomBytes(256 * 1024));
  await git(remote, ["add", "work.bin"]);
  await git(remote, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "work"]);
  await git(remote, ["update-ref", exportRef, "HEAD"]);
  const bundle = path.join(path.dirname(remote), `${path.basename(remote)}.bundle`);
  await git(remote, ["bundle", "create", bundle, exportRef]);
  cleanupDirs.push(bundle);
  return { repo, bundle };
}

describe("transient git bundle transfer errors", () => {
  it("classifies the error git raises for a truncated bundle", async () => {
    const { bundle } = await repoWithBundle("refs/test/export");
    const whole = await readFile(bundle);
    const cutBundle = path.join(path.dirname(bundle), "cut.bundle");
    cleanupDirs.push(cutBundle);
    await writeFile(cutBundle, whole.subarray(0, Math.floor(whole.length / 2)));
    const target = await tempDir("paperclip-bundle-retry-target-");
    await git(target, ["init", "-q"]);

    const outcome = await fetchGitBundleIntoLocalRef({
      localDir: target,
      bundlePath: cutBundle,
      exportRef: "refs/test/export",
      importedRef: "refs/test/imported",
      baseSha: "0".repeat(40),
    }).then(() => null, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("early EOF");
    expect(isTransientGitBundleTransferError(outcome)).toBe(true);
    expect(isMissingGitPrerequisiteError(outcome)).toBe(false);
  });

  it.each([
    ["fatal: early EOF\nerror: index-pack died", true],
    ["ssh terminated by signal SIGKILL", true],
    ["ssh terminated by signal SIGTERM: client_loop: send disconnect", true],
    ["error: Repository lacks these prerequisite commits:", false],
    ["Permission denied (publickey).", false],
    ["ssh exited with code 255", false],
  ])("isTransientGitBundleTransferError(%j) is %s", (message, expected) => {
    expect(isTransientGitBundleTransferError(new Error(message))).toBe(expected);
  });
});

describe("retryTransientGitBundleTransfer", () => {
  const transient = () => new Error("fatal: early EOF\nerror: index-pack died");

  it("returns the first success without waiting", async () => {
    const waits: number[] = [];
    const result = await retryTransientGitBundleTransfer(async () => "ok", { sleep: async (ms) => void waits.push(ms) });
    expect(result).toBe("ok");
    expect(waits).toEqual([]);
  });

  it("retries a transient failure with the configured backoff, then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryTransientGitBundleTransfer(async () => {
      calls += 1;
      if (calls < 3) throw transient();
      return calls;
    }, { delaysMs: [10, 20], sleep: async (ms) => void waits.push(ms) });
    expect(result).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it("rethrows a non-transient failure on the first attempt", async () => {
    const waits: number[] = [];
    let calls = 0;
    const failure = new Error("Permission denied (publickey).");
    await expect(retryTransientGitBundleTransfer(async () => {
      calls += 1;
      throw failure;
    }, { sleep: async (ms) => void waits.push(ms) })).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("rethrows the last transient failure once the retry budget is spent", async () => {
    let calls = 0;
    const failures = [transient(), transient(), transient()];
    await expect(retryTransientGitBundleTransfer(async () => {
      throw failures[calls++]!;
    }, { delaysMs: [1, 1], sleep: async () => undefined })).rejects.toBe(failures[2]);
    expect(calls).toBe(3);
  });

  it("makes a single attempt when the delay list is empty", async () => {
    let calls = 0;
    await expect(retryTransientGitBundleTransfer(async () => {
      calls += 1;
      throw transient();
    }, { delaysMs: [], sleep: async () => undefined })).rejects.toThrow("early EOF");
    expect(calls).toBe(1);
  });
});

function sshSpec(): SshRemoteExecutionSpec {
  return {
    host: "ssh.invalid",
    port: 22,
    username: "paperclip",
    remoteWorkspacePath: "/remote/workspace",
    remoteCwd: "/remote/workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}

/**
 * Shadows `ssh` so the remote bundle export behaves per attempt, and any other
 * remote command (the workspace tar that follows) streams an empty archive.
 * `attempts` is one shell snippet per export attempt; the last one repeats.
 */
async function shadowSshExport(input: { attempts: string[] }): Promise<{ countFile: string }> {
  const binDir = await tempDir("paperclip-bundle-retry-bin-");
  const stateDir = await tempDir("paperclip-bundle-retry-state-");
  const countFile = path.join(stateDir, "count");
  const cases = input.attempts
    .map((body, index) => `    ${index + 1}) ${body} ;;`)
    .join("\n");
  const fallback = input.attempts[input.attempts.length - 1]!;
  const script = [
    "#!/bin/sh",
    'case "$*" in',
    '  *"bundle create"*)',
    `    n=$(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(countFile)}`,
    '    case "$n" in',
    cases,
    `    *) ${fallback} ;;`,
    "    esac",
    "    ;;",
    "  *) tar -cf - -T /dev/null ;;",
    "esac",
    "",
  ].join("\n");
  await writeFile(path.join(binDir, "ssh"), script, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return { countFile };
}

async function attemptCount(countFile: string): Promise<number> {
  return Number((await readFile(countFile, "utf8").catch(() => "0")).trim());
}

describe("restoreWorkspaceFromSshExecution bundle export", () => {
  const exportRef = "refs/paperclip/ssh-sync/export";

  it("exports again when the stream ends early with a clean exit", async () => {
    const { repo, bundle } = await repoWithBundle(exportRef);
    const cut = `head -c 4096 ${JSON.stringify(bundle)}`;
    const whole = `cat ${JSON.stringify(bundle)}`;
    const { countFile } = await shadowSshExport({ attempts: [cut, whole] });

    await restoreWorkspaceFromSshExecution({ spec: sshSpec(), localDir: repo });

    expect(await attemptCount(countFile)).toBe(2);
  }, 30_000);

  it("exports again when a signal ends ssh mid-stream", async () => {
    const { repo, bundle } = await repoWithBundle(exportRef);
    const killed = `head -c 4096 ${JSON.stringify(bundle)}; kill -9 $$`;
    const whole = `cat ${JSON.stringify(bundle)}`;
    const { countFile } = await shadowSshExport({ attempts: [killed, whole] });

    await restoreWorkspaceFromSshExecution({ spec: sshSpec(), localDir: repo });

    expect(await attemptCount(countFile)).toBe(2);
  }, 30_000);

  it("reports the signal, not a clean exit, when every attempt is killed", async () => {
    const { repo, bundle } = await repoWithBundle(exportRef);
    const killed = `head -c 4096 ${JSON.stringify(bundle)}; kill -9 $$`;
    const { countFile } = await shadowSshExport({ attempts: [killed] });

    await expect(restoreWorkspaceFromSshExecution({ spec: sshSpec(), localDir: repo }))
      .rejects.toThrow("ssh terminated by signal SIGKILL");

    expect(await attemptCount(countFile)).toBe(3);
  }, 30_000);

  it("does not retry a failure that a fresh export cannot cure", async () => {
    const { repo, bundle } = await repoWithBundle(exportRef);
    const denied = 'echo "Permission denied (publickey)." >&2; exit 255';
    const { countFile } = await shadowSshExport({ attempts: [denied] });

    await expect(restoreWorkspaceFromSshExecution({ spec: sshSpec(), localDir: repo }))
      .rejects.toThrow("Permission denied");

    expect(await attemptCount(countFile)).toBe(1);
  }, 30_000);
});
