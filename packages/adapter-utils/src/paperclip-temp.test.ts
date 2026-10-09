import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs, { promises as fsp, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaperclipTempDir,
  isPaperclipTempEntryHeld,
  removePaperclipTempDir,
  runWithPaperclipTempRun,
  sweepPaperclipTempEntries,
  SWEPT_PAPERCLIP_TEMP_PREFIXES,
  type PaperclipTempRunVerdict,
} from "./paperclip-temp.js";
import { disposeGitWorkspaceSnapshot, readGitWorkspaceSnapshot, withShallowGitWorkspaceClone } from "./git-workspace-sync.js";
import { createSandboxCallbackBridgeAsset } from "./sandbox-callback-bridge.js";
import { runChildProcess } from "./server-utils.js";
import { buildSshSpawnTarget, type SshRemoteExecutionSpec } from "./ssh.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";

const HOUR_MS = 60 * 60 * 1000;
const GRACE_MS = 15 * 60 * 1000;
const RUN_ID = "2f1d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
const OTHER_RUN_ID = "7e6d5c4b-3a29-4180-8f7e-6d5c4b3a2918";
const SWEPT = /^paperclip-(ssh-key|ssh-known-hosts|ssh-sync-back|ssh-bundle|workspace-baseline|codex-home-sync|bridge-asset|workspace-manifest|git-workspace|sandbox-sync|sandbox-restore|tar-list|syncin-fallback)-/;

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

function verdict(value: PaperclipTempRunVerdict) {
  return async (runIds: string[]) => new Map(runIds.map((runId) => [runId, value] as const));
}

const later = () => Date.now() + 3 * HOUR_MS;

function sweep(options: Partial<Parameters<typeof sweepPaperclipTempEntries>[0]> = {}) {
  return sweepPaperclipTempEntries({ tmpDir: tmp, minAgeMs: GRACE_MS, now: later(), classifyRuns: verdict("dead"), ...options });
}

async function sweptEntries(): Promise<string[]> {
  return (await fsp.readdir(tmp)).filter((name) => SWEPT.test(name)).sort();
}

// A dead run's entry as a restarted server finds it.
async function deadRunEntry(name: string, dir = tmp): Promise<string> {
  const entry = path.join(dir, name);
  await fsp.mkdir(entry);
  await fsp.writeFile(path.join(entry, "file"), "12345");
  return entry;
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
  await promisify(execFile)("chmod", ["-R", "u+rwx", root]).catch(() => undefined);
  await fsp.rm(root, { recursive: true, force: true });
});

describe("startup sweep after a killed run", () => {
  // Load tsx as an --import hook so the evaluated code runs in the spawned
  // process itself; killing its process group kills the whole run.
  const loader = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url));
  const sshModule = fileURLToPath(new URL("./ssh.ts", import.meta.url));
  const tempModule = fileURLToPath(new URL("./paperclip-temp.ts", import.meta.url));

  it("removes the sync-back staging dir and SSH auth files a run killed mid-sync-back left, once its run is dead", async () => {
    // A tar stream of one file with no end-of-archive marker, so the receiving
    // tar extracts what it gets and then waits for more.
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
      import { runWithPaperclipTempRun } from ${JSON.stringify(tempModule)};
      import { syncDirectoryFromSsh } from ${JSON.stringify(sshModule)};
      await runWithPaperclipTempRun(${JSON.stringify(RUN_ID)}, () => syncDirectoryFromSsh({
        spec: ${JSON.stringify(spec)},
        remoteDir: "/remote",
        localDir: ${JSON.stringify(localDir)},
      }));
    `], {
      env: { ...process.env, TMPDIR: tmp, PATH: `${bin}:${process.env.PATH ?? ""}` },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    // Wait until the staging dir holds part of the file: the run is mid-sync-back.
    // GNU tar writes only whole 10 KiB records, so the tail can stay unwritten.
    let extractedBytes = 0;
    await vi.waitFor(async () => {
      expect(child.exitCode, stderr).toBeNull();
      const staging = (await sweptEntries()).find((name) => name.startsWith("paperclip-ssh-sync-back-"));
      expect(staging).toBeDefined();
      extractedBytes = (await fsp.stat(path.join(tmp, staging ?? "", "big.txt"))).size;
      expect(extractedBytes).toBeGreaterThan(0);
    }, { timeout: 90_000, interval: 100 });

    // Kill the whole run, as a restart does. No `finally` runs.
    const exited = once(child, "exit");
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await exited;
    const leftovers = await sweptEntries();
    expect(leftovers.map((name) => name.replace(/[^-]+$/, ""))).toEqual([
      `paperclip-ssh-key-${RUN_ID}-`,
      `paperclip-ssh-known-hosts-${RUN_ID}-`,
      `paperclip-ssh-sync-back-${RUN_ID}-`,
    ]);

    // Just after the restart the entries are recent, and later they stay while
    // the run is live.
    expect(await sweep({ now: Date.now() })).toMatchObject({ removed: 0, kept: { recent: 3 } });
    expect(await sweep({ classifyRuns: verdict("run_live") })).toMatchObject({ removed: 0, kept: { run_live: 3 } });
    expect(await sweptEntries()).toHaveLength(3);

    const removed = await sweep();
    expect(removed).toMatchObject({ removed: 3, kept: {}, deferred: 0 });
    expect(removed.freedBytes).toBeGreaterThanOrEqual(extractedBytes);
    expect(await sweptEntries()).toEqual([]);
  }, 150_000);
});

describe("proof that the run is dead", () => {
  it("keeps a live run's old directory while a live process holds a file open in it", async () => {
    const entry = await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Ab12Cd`);
    const holder = spawn(process.execPath, ["-e", `
      const fd = require("node:fs").openSync(${JSON.stringify(path.join(entry, "file"))}, "r+");
      process.stdout.write("open\\n");
      setInterval(() => require("node:fs").fstatSync(fd), 1000);
    `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(holder);
    await once(holder.stdout ?? holder, "data");

    const result = await sweep({ classifyRuns: verdict("run_live") });

    expect(result).toMatchObject({ removed: 0, kept: { run_live: 1 } });
    expect(fs.existsSync(path.join(entry, "file"))).toBe(true);
    expect(holder.exitCode).toBeNull();
  });

  it("keeps entries whose run it cannot prove dead", async () => {
    await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Ab12Cd`);
    await deadRunEntry(`paperclip-ssh-key-${OTHER_RUN_ID}-Ef34Gh`);

    // Only one run is known; the other counts as missing.
    expect(await sweep({ classifyRuns: async () => new Map([[RUN_ID, "run_recent"]]) }))
      .toMatchObject({ removed: 0, kept: { run_recent: 1, run_missing: 1 } });
    expect(await sweep({ classifyRuns: verdict("lease_busy") })).toMatchObject({ removed: 0, kept: { lease_busy: 2 } });
    expect(await sweep({ classifyRuns: async () => { throw new Error("database down"); } }))
      .toMatchObject({ removed: 0, kept: { db_error: 2 } });
    expect(await sweptEntries()).toHaveLength(2);
  });

  it("never removes an entry without a run id", async () => {
    await deadRunEntry("paperclip-ssh-sync-back-Ab12Cd");
    const outsideRun = await createPaperclipTempDir("paperclip-ssh-sync-back-");
    const badRun = await runWithPaperclipTempRun("run-1", () => createPaperclipTempDir("paperclip-ssh-bundle-"));
    await removePaperclipTempDir(outsideRun).catch(() => undefined);
    await deadRunEntry(path.basename(outsideRun));
    await removePaperclipTempDir(badRun).catch(() => undefined);
    await deadRunEntry(path.basename(badRun));

    expect(await sweep()).toMatchObject({ removed: 0, kept: { unattributed: 3 } });
    expect(await sweptEntries()).toHaveLength(3);
  });

  it("names an entry with the run it was created in", async () => {
    const dir = await runWithPaperclipTempRun(RUN_ID.toUpperCase(), () => createPaperclipTempDir("paperclip-tar-list-"));
    expect(path.basename(dir)).toMatch(new RegExp(`^paperclip-tar-list-${RUN_ID}-[A-Za-z0-9]{6}$`));
    await removePaperclipTempDir(dir);
  });
});

describe("prefix allowlist", () => {
  it("rejects a prefix that is not allowlisted or leaves the temp dir", async () => {
    for (const prefix of ["paperclip-codex-home-sync-/../../outside-", "paperclip-other-", "../paperclip-ssh-key-"]) {
      await expect(Reflect.apply(createPaperclipTempDir, undefined, [prefix])).rejects.toThrow("Unknown Paperclip temp prefix");
    }
    expect((await fsp.readdir(root)).filter((name) => name.startsWith("outside-"))).toEqual([]);
    expect(await fsp.readdir(tmp)).toEqual([]);
  });

  it("allows only one-segment prefixes", () => {
    for (const prefix of SWEPT_PAPERCLIP_TEMP_PREFIXES) expect(prefix).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("confinement", () => {
  it("removes only under the real temp dir when the TMPDIR link changes during the sweep", async () => {
    const realRoot = path.join(root, "real");
    const otherRoot = path.join(root, "other");
    await fsp.mkdir(realRoot);
    await fsp.mkdir(otherRoot);
    const link = path.join(root, "tmp-link");
    await fsp.symlink(realRoot, link);
    const name = `paperclip-ssh-sync-back-${RUN_ID}-Ab12Cd`;
    await deadRunEntry(name, realRoot);
    await deadRunEntry(name, otherRoot);

    // Point the link elsewhere right after the sweep lists the entries.
    const realReaddir = fsp.readdir.bind(fsp);
    let swapped = false;
    vi.spyOn(fsp, "readdir").mockImplementation(async (target, options) => {
      const listing = await realReaddir(target, options);
      if (!swapped && (String(target) === link || String(target) === realRoot)) {
        swapped = true;
        await fsp.unlink(link);
        await fsp.symlink(otherRoot, link);
      }
      return listing;
    });

    expect(await sweep({ tmpDir: link })).toMatchObject({ removed: 1 });
    expect(fs.existsSync(path.join(realRoot, name))).toBe(false);
    expect(fs.existsSync(path.join(otherRoot, name, "file"))).toBe(true);
  });

  it("keeps an entry that was replaced after it was checked", async () => {
    const entry = await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Ab12Cd`);
    const realLstat = fsp.lstat.bind(fsp);
    let replaced = false;
    vi.spyOn(fsp, "lstat").mockImplementation(async (target, options) => {
      const stats = await realLstat(target, options);
      if (!replaced && String(target) === entry) {
        replaced = true;
        fs.renameSync(entry, `${entry}-moved`);
        fs.mkdirSync(entry);
        fs.writeFileSync(path.join(entry, "replacement"), "keep");
      }
      return stats;
    });

    expect(await sweep()).toMatchObject({ removed: 0, kept: { changed: 1 } });
    expect(fs.existsSync(path.join(entry, "replacement"))).toBe(true);
  });

  it("stops at a mount point inside an entry", async () => {
    const entry = await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Ab12Cd`);
    const mount = path.join(entry, "mnt");
    await fsp.mkdir(mount);
    await fsp.writeFile(path.join(mount, "data"), "keep");
    // Report `mnt` on another device, as a mount there would be.
    const realLstat = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, "lstat").mockImplementation(async (target, options) => {
      const stats = await realLstat(target, options);
      if (String(target) !== mount) return stats;
      const mounted: Stats = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: Number(stats.dev) + 1 });
      return mounted;
    });

    expect(await sweep()).toMatchObject({ removed: 0, kept: { mount_point: 1 } });
    expect(fs.existsSync(path.join(mount, "data"))).toBe(true);
  });

  it("keeps held entries, symlinks, files and other names", async () => {
    const held = await runWithPaperclipTempRun(RUN_ID, () => createPaperclipTempDir("paperclip-ssh-sync-back-"));
    const outside = path.join(root, "outside");
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "keep"), "keep");
    await fsp.symlink(outside, path.join(tmp, `paperclip-ssh-key-${RUN_ID}-Link01`));
    await fsp.writeFile(path.join(tmp, `paperclip-ssh-key-${RUN_ID}-File01`), "not a dir");
    await deadRunEntry("paperclip-run-abc123");
    const stale = await deadRunEntry(`paperclip-ssh-bundle-${RUN_ID}-Stal01`);

    const result = await sweep();

    expect(result).toEqual({ removed: 1, freedBytes: 5, kept: { held: 1, symlink: 1, not_directory: 1 }, deferred: 0 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(held)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "paperclip-run-abc123"))).toBe(true);
    expect(fs.existsSync(path.join(outside, "keep"))).toBe(true);
    await removePaperclipTempDir(held);
    expect(isPaperclipTempEntryHeld(held)).toBe(false);
  });

  it("removes entries that hold a read-only directory without changing a symlink target", async () => {
    const outside = path.join(root, "outside-readonly");
    await fsp.mkdir(outside);
    await fsp.chmod(outside, 0o555);
    const readOnlyTree = async (entry: string) => {
      await fsp.mkdir(path.join(entry, "cache", "mod"), { recursive: true });
      await fsp.writeFile(path.join(entry, "cache", "mod", "file"), "12345");
      await fsp.symlink(outside, path.join(entry, "cache", "mod", "link"));
      await fsp.chmod(path.join(entry, "cache", "mod"), 0o555);
      await fsp.chmod(path.join(entry, "cache"), 0o555);
    };
    const held = await runWithPaperclipTempRun(RUN_ID, () => createPaperclipTempDir("paperclip-ssh-sync-back-"));
    await readOnlyTree(held);
    const stale = path.join(tmp, `paperclip-ssh-sync-back-${RUN_ID}-ReadOn`);
    await fsp.mkdir(stale);
    await readOnlyTree(stale);

    await removePaperclipTempDir(held);
    const result = await sweep();

    expect(fs.existsSync(held)).toBe(false);
    expect(result).toMatchObject({ removed: 1 });
    expect(fs.existsSync(stale)).toBe(false);
    expect((await fsp.stat(outside)).mode & 0o777).toBe(0o555);
  });

  it("reports the first entry it cannot remove", async () => {
    const stale = await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Busy01`);
    const realRmdir = fsp.rmdir.bind(fsp);
    vi.spyOn(fsp, "rmdir").mockImplementation(async (target, options) => {
      if (String(target) === stale) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return realRmdir(target, options);
    });

    expect(await sweep()).toMatchObject({
      removed: 0,
      kept: { rm_failed: 1 },
      firstFailure: `paperclip-ssh-sync-back-${RUN_ID}-Busy01: EBUSY`,
    });
  });
});

describe("bounded work", () => {
  it("removes at most the entry cap per pass, oldest first", async () => {
    const names: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      names.push(`paperclip-ssh-sync-back-${RUN_ID}-Old00${index}`);
      await deadRunEntry(names[index] ?? "");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(await sweep({ maxEntries: 3 })).toMatchObject({ removed: 3, deferred: 2 });
    expect(await sweptEntries()).toEqual(names.slice(3));
  });

  it("removes key material before older entries", async () => {
    await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Old001`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await deadRunEntry(`paperclip-ssh-key-${RUN_ID}-New001`);

    expect(await sweep({ maxEntries: 1 })).toMatchObject({ removed: 1, deferred: 1 });
    expect(await sweptEntries()).toEqual([`paperclip-ssh-sync-back-${RUN_ID}-Old001`]);
  });

  it("leaves everything for the next pass when the time budget is spent", async () => {
    await deadRunEntry(`paperclip-ssh-sync-back-${RUN_ID}-Old001`);
    await deadRunEntry(`paperclip-ssh-bundle-${RUN_ID}-Old002`);

    expect(await sweep({ timeBudgetMs: -1 })).toMatchObject({ removed: 0, deferred: 2 });
    expect(await sweptEntries()).toHaveLength(2);
  });
});

describe("registry", () => {
  async function initGitRepo(): Promise<string> {
    const workspace = path.join(root, "repo");
    await fsp.mkdir(workspace);
    await fsp.writeFile(path.join(workspace, "a.txt"), "a");
    const git = (...args: string[]) => promisify(execFile)("git", ["-C", workspace, ...args]);
    await git("init", "-q");
    await git("add", "a.txt");
    await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    return workspace;
  }

  it("never sweeps a live run's disk-backed baseline", async () => {
    const workspace = path.join(root, "workspace");
    await fsp.mkdir(workspace);
    await fsp.writeFile(path.join(workspace, "a.txt"), "a");
    const baseline = await runWithPaperclipTempRun(RUN_ID, () => captureDirectorySnapshot(workspace, { diskBacked: true }));
    expect(await sweptEntries()).toHaveLength(1);

    expect(await sweep()).toMatchObject({ removed: 0, kept: { held: 1 } });

    await disposeDirectorySnapshot(baseline);
    expect(await sweptEntries()).toEqual([]);
  });

  it("stops holding a git workspace snapshot's manifest dir when it is disposed", async () => {
    const workspace = await initGitRepo();
    const before = new Set(await fsp.readdir(tmp));

    const snapshot = await readGitWorkspaceSnapshot(workspace);
    expect(snapshot).not.toBeNull();
    const manifest = (await fsp.readdir(tmp)).filter((name) => !before.has(name)).map((name) => path.join(tmp, name));
    expect(manifest).toHaveLength(1);
    expect(isPaperclipTempEntryHeld(manifest[0] ?? "")).toBe(true);

    await disposeGitWorkspaceSnapshot(snapshot);
    expect(fs.existsSync(manifest[0] ?? "")).toBe(false);
    expect(isPaperclipTempEntryHeld(manifest[0] ?? "")).toBe(false);
  });

  it("holds a shallow git clone while it is in use and removes it after", async () => {
    const workspace = await initGitRepo();
    await runWithPaperclipTempRun(RUN_ID, async () => {
      const snapshot = await readGitWorkspaceSnapshot(workspace);
      if (!snapshot) throw new Error("expected a git workspace snapshot");
      let clone = "";
      await withShallowGitWorkspaceClone({ localDir: workspace, snapshot }, async (cloneDir) => {
        clone = cloneDir;
        expect(await sweep()).toMatchObject({ removed: 0 });
        expect(fs.existsSync(path.join(cloneDir, "a.txt"))).toBe(true);
      });
      expect(fs.existsSync(clone)).toBe(false);
      expect(isPaperclipTempEntryHeld(clone)).toBe(false);
      await disposeGitWorkspaceSnapshot(snapshot);
    });
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
    const realRmdir = fsp.rmdir.bind(fsp);
    const removed: string[] = [];
    vi.spyOn(fsp, "rmdir").mockImplementation(async (target, options) => {
      removed.push(String(target));
      if (String(target) === path.dirname(knownHosts)) throw new Error("EBUSY");
      return realRmdir(target, options);
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

    await vi.waitFor(async () => expect(await sweptEntries()).toEqual([]), { timeout: 10_000 });
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
