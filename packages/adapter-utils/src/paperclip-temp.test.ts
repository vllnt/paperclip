import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaperclipTempDir,
  isPaperclipTempEntryHeld,
  removePaperclipTempDir,
  sweepPaperclipTempEntries,
  touchHeldPaperclipTempEntries,
} from "./paperclip-temp.js";
import { createSandboxCallbackBridgeAsset } from "./sandbox-callback-bridge.js";
import { runChildProcess } from "./server-utils.js";
import { buildSshSpawnTarget, type SshRemoteExecutionSpec } from "./ssh.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";

const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 2 * HOUR_MS;
const SWEPT = /^paperclip-(ssh-key|ssh-known-hosts|ssh-sync-back|ssh-bundle|workspace-baseline|codex-home-sync|bridge-asset)-/;

const spec: SshRemoteExecutionSpec = {
  host: "127.0.0.1",
  port: 22,
  username: "agent",
  remoteWorkspacePath: "/remote",
  remoteCwd: "/remote",
  privateKey: "test-private-key",
  knownHosts: "test-known-hosts",
  strictHostKeyChecking: true,
};

let root = "";
let tmp = "";
let bin = "";
const originalTmpdir = process.env.TMPDIR;
const children: ChildProcess[] = [];

async function sweptEntries(): Promise<string[]> {
  return (await fsp.readdir(tmp)).filter((name) => SWEPT.test(name)).sort();
}

// A stand-in for `ssh` on PATH: it prints `ssh-output` if present, then waits.
async function installFakeSsh(): Promise<void> {
  const script = path.join(bin, "ssh");
  await fsp.writeFile(script, `#!/bin/sh\n[ -f "${root}/ssh-output" ] && cat "${root}/ssh-output"\nexec sleep 600\n`);
  await fsp.chmod(script, 0o755);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-temp-sweep-test-"));
  tmp = path.join(root, "tmp");
  bin = path.join(root, "bin");
  await fsp.mkdir(tmp);
  await fsp.mkdir(bin);
  await installFakeSsh();
  // os.tmpdir() reads TMPDIR on every call, so creators in this process use `tmp`.
  process.env.TMPDIR = tmp;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, "exit");
      process.kill(-child.pid, "SIGKILL");
      await exited;
    }
  }
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await fsp.rm(root, { recursive: true, force: true });
});

describe("startup sweep after a killed run", () => {
  // Load tsx as an --import hook so the evaluated code runs in the spawned
  // process itself; killing its process group kills the whole run.
  const loader = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url));
  const sshModule = fileURLToPath(new URL("./ssh.ts", import.meta.url));

  it("removes the sync-back staging dir and SSH auth files a run killed mid-sync-back left", async () => {
    // A tar stream of one whole file with no end-of-archive marker, so the
    // receiving tar extracts the file and then waits for more.
    const remote = path.join(root, "remote");
    await fsp.mkdir(remote);
    await fsp.writeFile(path.join(remote, "big.txt"), "x".repeat(64 * 1024));
    const archive = path.join(root, "archive.tar");
    await promisify(execFile)("tar", ["-cf", archive, "-C", remote, "big.txt"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = await fsp.readFile(archive);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    await fsp.writeFile(path.join(root, "ssh-output"), bytes.subarray(0, Math.ceil(end / 512) * 512));

    const localDir = path.join(root, "local");
    await fsp.mkdir(localDir);
    const child = spawn(process.execPath, ["--import", loader, "--eval", `
      import { syncDirectoryFromSsh } from ${JSON.stringify(sshModule)};
      await syncDirectoryFromSsh({
        spec: ${JSON.stringify(spec)},
        remoteDir: "/remote",
        localDir: ${JSON.stringify(localDir)},
      });
    `], {
      env: { ...process.env, TMPDIR: tmp, PATH: `${bin}:${process.env.PATH ?? ""}` },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    // Wait until the staging dir holds the whole file: the run is mid-sync-back.
    await vi.waitFor(async () => {
      expect(child.exitCode, stderr).toBeNull();
      const staging = (await sweptEntries()).find((name) => name.startsWith("paperclip-ssh-sync-back-"));
      expect(staging).toBeDefined();
      const stats = await fsp.stat(path.join(tmp, staging ?? "", "big.txt"));
      expect(stats.size).toBe(64 * 1024);
    }, { timeout: 20_000, interval: 100 });

    // Kill the whole run, as a restart does. No `finally` runs.
    const exited = once(child, "exit");
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await exited;
    const leftovers = await sweptEntries();
    expect(leftovers.map((name) => name.replace(/[^-]+$/, ""))).toEqual([
      "paperclip-ssh-key-",
      "paperclip-ssh-known-hosts-",
      "paperclip-ssh-sync-back-",
    ]);

    // Just after the restart the entries are recent, so the sweep keeps them.
    const early = await sweepPaperclipTempEntries({ tmpDir: tmp, maxAgeMs: MAX_AGE_MS });
    expect(early).toMatchObject({ removed: 0, recent: 3 });

    const later = await sweepPaperclipTempEntries({ tmpDir: tmp, maxAgeMs: MAX_AGE_MS, now: Date.now() + 3 * HOUR_MS });
    expect(later).toMatchObject({ removed: 3, failed: 0, held: 0 });
    expect(later.freedBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(await sweptEntries()).toEqual([]);
  }, 60_000);
});

describe("sweepPaperclipTempEntries", () => {
  const later = () => Date.now() + 3 * HOUR_MS;

  it("keeps held entries, other names, files and symlinks, and removes stale unheld dirs", async () => {
    const held = await createPaperclipTempDir("paperclip-ssh-sync-back-");
    const stale = path.join(tmp, "paperclip-ssh-sync-back-stale1");
    await fsp.mkdir(stale);
    await fsp.writeFile(path.join(stale, "file"), "12345");
    const other = path.join(tmp, "paperclip-git-workspace-abc123");
    await fsp.mkdir(other);
    await fsp.writeFile(path.join(tmp, "paperclip-ssh-key-file"), "not a dir");
    const outside = path.join(root, "outside");
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "keep"), "keep");
    await fsp.symlink(outside, path.join(tmp, "paperclip-ssh-key-link"));

    const result = await sweepPaperclipTempEntries({ tmpDir: tmp, maxAgeMs: MAX_AGE_MS, now: later() });

    expect(result).toEqual({ removed: 1, freedBytes: 5, held: 1, recent: 0, failed: 0 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(held)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "paperclip-ssh-key-file"))).toBe(true);
    expect(fs.existsSync(path.join(outside, "keep"))).toBe(true);

    await removePaperclipTempDir(held);
    expect(fs.existsSync(held)).toBe(false);
    expect(isPaperclipTempEntryHeld(held)).toBe(false);
  });

  it("never sweeps a live run's disk-backed baseline", async () => {
    const workspace = path.join(root, "workspace");
    await fsp.mkdir(workspace);
    await fsp.writeFile(path.join(workspace, "a.txt"), "a");
    const baseline = await captureDirectorySnapshot(workspace, { diskBacked: true });
    expect(await sweptEntries()).toHaveLength(1);

    const result = await sweepPaperclipTempEntries({ tmpDir: tmp, maxAgeMs: MAX_AGE_MS, now: later() });
    expect(result).toMatchObject({ removed: 0, held: 1 });

    await disposeDirectorySnapshot(baseline);
    expect(await sweptEntries()).toEqual([]);
  });

  it("refreshes held entries and forgets ones already removed", async () => {
    const kept = await createPaperclipTempDir("paperclip-bridge-asset-");
    const gone = await createPaperclipTempDir("paperclip-bridge-asset-");
    const old = new Date(Date.now() - 10 * HOUR_MS);
    await fsp.utimes(kept, old, old);
    await fsp.rm(gone, { recursive: true });

    await touchHeldPaperclipTempEntries();

    expect(Date.now() - (await fsp.stat(kept)).mtimeMs).toBeLessThan(60_000);
    expect(isPaperclipTempEntryHeld(gone)).toBe(false);
    await removePaperclipTempDir(kept);
  });
});

describe("temp entries on failure paths", () => {
  function authPaths(args: string[]): { key: string; knownHosts: string } {
    const key = args[args.indexOf("-i") + 1] ?? "";
    const knownHosts = args.find((arg) => arg.startsWith("UserKnownHostsFile="))?.slice("UserKnownHostsFile=".length) ?? "";
    return { key, knownHosts };
  }

  it("creates the private key 0600 in a 0700 dir and removes it first", async () => {
    const target = await buildSshSpawnTarget({ spec, command: "agent", args: [], env: {} });
    const { key, knownHosts } = authPaths(target.args);
    expect((await fsp.stat(key)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.dirname(key))).mode & 0o777).toBe(0o700);
    expect(await fsp.readFile(key, "utf8")).toBe("test-private-key\n");

    // A failure removing the known-hosts file must not skip the key.
    const realRm = fsp.rm.bind(fsp);
    const removed: string[] = [];
    vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      removed.push(String(target));
      if (String(target) === path.dirname(knownHosts)) throw new Error("EBUSY");
      return realRm(target, options);
    });
    await target.cleanup?.();

    expect(removed[0]).toBe(path.dirname(key));
    expect(fs.existsSync(path.dirname(key))).toBe(false);
  });

  it("removes the known-hosts file when writing the key fails", async () => {
    const realWriteFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes("paperclip-ssh-key-")) throw new Error("ENOSPC");
      return realWriteFile(file, data, options);
    });

    await expect(buildSshSpawnTarget({ spec, command: "agent", args: [], env: {} })).rejects.toThrow("ENOSPC");
    expect(await sweptEntries()).toEqual([]);
  });

  it("removes the SSH auth files when the run's spawn throws", async () => {
    await expect(runChildProcess("run-spawn-throws", "agent", [], {
      cwd: root,
      // A NUL byte makes spawn throw synchronously, before any child event.
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_VALUE: "a\u0000b" },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
      remoteExecution: spec,
    })).rejects.toThrow();

    await vi.waitFor(async () => expect(await sweptEntries()).toEqual([]));
  });

  it("removes the bridge asset dir when writing the entrypoint fails", async () => {
    const realWriteFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes("paperclip-bridge-asset-")) throw new Error("ENOSPC");
      return realWriteFile(file, data, options);
    });

    await expect(createSandboxCallbackBridgeAsset()).rejects.toThrow("ENOSPC");
    expect(await sweptEntries()).toEqual([]);
  });
});
