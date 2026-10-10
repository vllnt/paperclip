import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// A sandbox whose commands run on this host, with `remoteCwd` as its working directory.
async function localSandbox(): Promise<{ root: string; target: AdapterExecutionTarget }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-temp-"));
  roots.push(root);
  const runner = {
    execute: async (input: { command: string; args?: string[]; cwd?: string }): Promise<RunProcessResult> => {
      const result = spawnSync(input.command, input.args ?? [], { cwd: input.cwd, encoding: "utf8" });
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

    await cleanupRemoteRunTempDirectory({ runId: RUN_ID, target });

    expect(existsSync(dir ?? "")).toBe(false);
    expect(existsSync(other ?? "")).toBe(true);
    // A second cleanup, as a replayed teardown, is harmless.
    await cleanupRemoteRunTempDirectory({ runId: RUN_ID, target });
  });

  it("does nothing for a local run", async () => {
    expect(await prepareRemoteRunTempDirectory({ runId: RUN_ID, target: null })).toBeNull();
    await cleanupRemoteRunTempDirectory({ runId: RUN_ID, target: null });
  });
});
