import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRemoteRunTempDirectory,
  prepareRemoteRunTempDirectory,
  remoteRunTempDirectory,
  type AdapterExecutionTarget,
} from "./execution-target.js";
import type { RunProcessResult } from "./server-utils.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // A test may leave read-only trees behind.
    spawnSync("chmod", ["-R", "u+rwx", root]);
    await rm(root, { recursive: true, force: true });
  }
});

// A sandbox whose commands run on this host, with `remoteCwd` as its working directory.
async function localSandbox(options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ root: string; target: AdapterExecutionTarget }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-"));
  roots.push(root);
  const runner = {
    execute: async (input: { command: string; args?: string[]; cwd?: string }): Promise<RunProcessResult> => {
      const result = spawnSync(input.command, input.args ?? [], { cwd: input.cwd, encoding: "utf8", env: options.env });
      return {
        exitCode: result.status, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr,
        pid: null, startedAt: new Date().toISOString(),
      };
    },
  };
  return { root, target: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: root, runner } };
}

describe("remoteRunTempDirectory", () => {
  it("puts an SSH run's temp directory beside its workspace, under the lease root", () => {
    const target = {
      kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/realized/root",
      spec: { host: "h", port: 22, username: "u", remoteWorkspacePath: "/ws", remoteCwd: "/lease/root", privateKey: null, knownHosts: null, strictHostKeyChecking: false },
    };
    expect(remoteRunTempDirectory({ runId: RUN_ID, target })).toBe(`/lease/root/.paperclip-runtime/runs/${RUN_ID}/tmp`);
  });

  it("puts a sandbox run's temp directory under the sandbox runtime directory", async () => {
    const { root, target } = await localSandbox();
    expect(remoteRunTempDirectory({ runId: RUN_ID, target })).toBe(`${root}/.paperclip-runtime/tmp/${RUN_ID}`);
  });

  it("gives a local run none", () => {
    expect(remoteRunTempDirectory({ runId: RUN_ID, target: null })).toBeNull();
    expect(remoteRunTempDirectory({ runId: RUN_ID, target: { kind: "local", environmentId: null, leaseId: null } })).toBeNull();
  });

  it.each(["", "/", "relative/root", "/srv/../etc", "/srv/w/", "/srv//w"])(
    "gives a remote run under the root %j none, as the reaper refuses such a root",
    (remoteCwd) => {
      const runner = { execute: async () => { throw new Error("no command may run"); } };
      const sandbox: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd, runner };
      const ssh: AdapterExecutionTarget = {
        kind: "remote", transport: "ssh", remoteCwd: "/realized/root",
        spec: { host: "h", port: 22, username: "u", remoteWorkspacePath: remoteCwd, remoteCwd, privateKey: null, knownHosts: null, strictHostKeyChecking: false },
      };
      expect(remoteRunTempDirectory({ runId: RUN_ID, target: sandbox })).toBeNull();
      expect(remoteRunTempDirectory({ runId: RUN_ID, target: ssh })).toBeNull();
    },
  );

  it("refuses a run id that is not one plain segment", async () => {
    const { target } = await localSandbox();
    for (const runId of ["../other", "a/b", "", "."]) {
      expect(() => remoteRunTempDirectory({ runId, target }), runId).toThrow("Invalid run temp directory run ID");
    }
  });
});

describe("prepareRemoteRunTempDirectory and cleanupRemoteRunTempDirectory", () => {
  it("creates a private directory for the run and removes only that run's", async () => {
    const { root, target } = await localSandbox();
    const otherRunId = "99999999-2222-4333-8444-555555555555";

    const dir = await prepareRemoteRunTempDirectory({ runId: RUN_ID, target });
    const other = await prepareRemoteRunTempDirectory({ runId: otherRunId, target });
    expect(dir).toBe(`${root}/.paperclip-runtime/tmp/${RUN_ID}`);
    expect((await stat(dir ?? "")).mode & 0o777).toBe(0o700);
    await mkdir(path.join(dir ?? "", "clone", "nested"), { recursive: true });

    await expect(cleanupRemoteRunTempDirectory({ runId: RUN_ID, target })).resolves.toBe("removed");

    expect(existsSync(dir ?? "")).toBe(false);
    expect(existsSync(other ?? "")).toBe(true);
    // A second cleanup, as a replayed teardown, is harmless.
    await expect(cleanupRemoteRunTempDirectory({ runId: RUN_ID, target })).resolves.toBe("absent");
  });

  it("creates nothing for a remote run under a root the reaper would refuse", async () => {
    const runner = { execute: async () => { throw new Error("no command may run"); } };
    const target: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: "/", runner };
    await expect(prepareRemoteRunTempDirectory({ runId: RUN_ID, target })).rejects.toThrow("normalized absolute path");
  });

  // An agent can replace a directory in the path with a link. Neither call may
  // follow it: the files the link points at stay, and nothing is created there.
  it.each([
    [".paperclip-runtime", ["tmp", RUN_ID]],
    [".paperclip-runtime/tmp", [RUN_ID]],
  ])("changes nothing through a link that replaced %s", async (linked, below) => {
    const { root, target } = await localSandbox();
    const outside = path.join(root, "outside");
    const canary = path.join(outside, ...below, "canary");
    await mkdir(path.dirname(canary), { recursive: true });
    await writeFile(canary, "keep\n");
    await mkdir(path.dirname(path.join(root, linked)), { recursive: true });
    await symlink(outside, path.join(root, linked));

    await expect(cleanupRemoteRunTempDirectory({ runId: RUN_ID, target })).resolves.toBe("symlink");
    await expect(prepareRemoteRunTempDirectory({ runId: RUN_ID, target })).rejects.toThrow("link");

    expect(existsSync(canary)).toBe(true);
    expect(await readdir(path.dirname(canary))).toEqual(["canary"]);
  });

  it("prepares the directory where chmod reads its arguments as BSD chmod does", async () => {
    // BSD chmod stops reading options at the mode, so a `--` after the mode is
    // a file name it cannot find. This stand-in parses the same way.
    const shimDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bsd-chmod-"));
    roots.push(shimDir);
    const realChmod = spawnSync("sh", ["-c", "command -v chmod"], { encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(shimDir, "chmod"), [
      "#!/bin/sh",
      'opts=""',
      'while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -[RHLPfhv]*) opts="$opts $1"; shift;; *) break;; esac; done',
      'mode=$1; shift; status=0',
      'for f in "$@"; do',
      '  if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo "chmod: $f: No such file or directory" >&2; status=1; continue; fi',
      `  ${realChmod} $opts "$mode" "$f" || status=1`,
      "done",
      "exit $status",
      "",
    ].join("\n"), { mode: 0o755 });
    const { root, target } = await localSandbox({ env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` } });

    const dir = await prepareRemoteRunTempDirectory({ runId: RUN_ID, target });

    expect(dir).toBe(`${root}/.paperclip-runtime/tmp/${RUN_ID}`);
    expect((await stat(dir ?? "")).mode & 0o777).toBe(0o700);
    await expect(cleanupRemoteRunTempDirectory({ runId: RUN_ID, target })).resolves.toBe("removed");
  });

  // Root removes them without the grant.
  it.skipIf(process.getuid?.() === 0)("removes read-only trees in the run's directory", async () => {
    const { target } = await localSandbox();
    const dir = await prepareRemoteRunTempDirectory({ runId: RUN_ID, target });
    // A Go module cache, for example, is read-only.
    const cache = path.join(dir ?? "", "modcache");
    await mkdir(path.join(cache, "sealed"), { recursive: true });
    await writeFile(path.join(cache, "sealed", "inner.txt"), "x");
    await chmod(path.join(cache, "sealed"), 0o000);
    await chmod(cache, 0o555);

    await cleanupRemoteRunTempDirectory({ runId: RUN_ID, target });

    expect(existsSync(dir ?? "")).toBe(false);
  });

  it("changes no mode through a link that replaced the run's directory", async () => {
    const { root, target } = await localSandbox();
    const dir = await prepareRemoteRunTempDirectory({ runId: RUN_ID, target }) ?? "";
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "sealed"), { recursive: true });
    await chmod(path.join(outside, "sealed"), 0o500);
    await rm(dir, { recursive: true });
    await symlink(outside, dir);

    await expect(cleanupRemoteRunTempDirectory({ runId: RUN_ID, target })).resolves.toBe("removed");

    expect(existsSync(dir)).toBe(false);
    expect((await stat(path.join(outside, "sealed"))).mode & 0o777).toBe(0o500);
  });

  it("does nothing for a local run", async () => {
    expect(await prepareRemoteRunTempDirectory({ runId: RUN_ID, target: null })).toBeNull();
    await expect(cleanupRemoteRunTempDirectory({ runId: RUN_ID, target: null })).resolves.toBe("absent");
  });
});
