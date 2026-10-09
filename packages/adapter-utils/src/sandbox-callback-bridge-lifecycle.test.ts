import { execFile as execFileCallback, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileSystemSandboxCallbackBridgeQueueClient,
  getSandboxCallbackBridgeServerSource,
  SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
  type StartedSandboxCallbackBridgeServer,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const BRIDGE_TOKEN = "lifecycle-test-token";
const HAS_BUSYBOX = (() => {
  try {
    execFileSync("busybox", ["true"]);
    return true;
  } catch {
    return false;
  }
})();

// Runs the bridge control commands on this host, the way an SSH runner runs
// them on a worker. `shell` is the worker's `sh`.
function createRunner(shell: string[] = ["/bin/sh"]) {
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const [command = "/bin/sh", ...prefix] = input.command === "bash" ? ["/bin/bash"] : shell;
      try {
        const result = await execFile(command, [...prefix, ...(input.args ?? [])], {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
          timeout: input.timeoutMs,
        });
        return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
      } catch (error) {
        const failure = error instanceof Error ? Object.assign({ stdout: "", stderr: "" }, error) : { stdout: "", stderr: String(error) };
        return { exitCode: 1, signal: null, timedOut: false, stdout: String(failure.stdout), stderr: String(failure.stderr), pid: null, startedAt };
      }
    },
  };
}

// A stand-in bridge that reports ready and then ignores SIGTERM.
const STUBBORN_BRIDGE = `
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
process.on("SIGTERM", () => {});
const ready = process.env.PAPERCLIP_BRIDGE_QUEUE_DIR + "/ready.json";
const server = createServer((req, res) => res.end("{}"));
server.listen(0, "127.0.0.1", async () => {
  await fs.writeFile(ready + ".tmp", JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: server.address().port }));
  await fs.rename(ready + ".tmp", ready);
});
`;

// A stand-in bridge that writes a broken ready file and keeps running.
const BROKEN_READY_BRIDGE = `
import { promises as fs } from "node:fs";
await fs.writeFile(process.env.PAPERCLIP_BRIDGE_QUEUE_DIR + "/../bridge.pid", String(process.pid));
await fs.writeFile(process.env.PAPERCLIP_BRIDGE_QUEUE_DIR + "/ready.json", "not json");
setInterval(() => {}, 1000);
`;

const roots: string[] = [];
const pids: number[] = [];
const stopFns: Array<() => Promise<void>> = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: timeoutMs, interval: 100 });
}

async function createRunRoot(): Promise<{ root: string; queueDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-lifecycle-"));
  roots.push(root);
  return { root, queueDir: path.join(root, "queue") };
}

async function startBridge(options: {
  root?: string;
  hostLeaseMs?: number;
  source?: string;
  shell?: string[];
} = {}): Promise<{ bridge: StartedSandboxCallbackBridgeServer; queueDir: string }> {
  const root = options.root ?? (await createRunRoot()).root;
  const assetRemoteDir = path.join(root, "server");
  await mkdir(assetRemoteDir, { recursive: true });
  await writeFile(path.join(assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT), options.source ?? getSandboxCallbackBridgeServerSource());
  const queueDir = path.join(root, "queue");
  const bridge = await startSandboxCallbackBridgeServer({
    runner: createRunner(options.shell),
    remoteCwd: root,
    assetRemoteDir,
    queueDir,
    bridgeToken: BRIDGE_TOKEN,
    runId: RUN_ID,
    timeoutMs: 30_000,
    responseTimeoutMs: 120_000,
    hostLeaseMs: options.hostLeaseMs ?? 120_000,
    lifetimeCheckMs: 200,
  });
  pids.push(bridge.pid);
  return { bridge, queueDir };
}

afterEach(async () => {
  for (const stop of stopFns.splice(0)) await stop().catch(() => undefined);
  for (const pid of pids.splice(0)) {
    if (!(pid > 0)) continue;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  for (const root of roots.splice(0)) {
    // A stand-in bridge records its own pid here, in case its test failed early.
    const standIn = Number(await readFile(path.join(root, "bridge.pid"), "utf8").catch(() => "0"));
    if (standIn > 0) {
      try {
        process.kill(standIn, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("sandbox callback bridge process lifetime", () => {
  it("stops the bridge on interrupt even while a request waits for its response", async () => {
    const { bridge, queueDir } = await startBridge();
    expect(bridge.pid).toBeGreaterThan(0);

    // No host worker answers, so the request stays open, as when a run is
    // interrupted in the middle of an API call.
    const pending = fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
    }).catch(() => null);
    const { requestsDir } = sandboxCallbackBridgeDirectories(queueDir);
    await vi.waitFor(async () => {
      expect((await readdir(requestsDir)).some((name) => name.endsWith(".json"))).toBe(true);
    }, { timeout: 15_000, interval: 50 });

    await bridge.stop();

    expect(isAlive(bridge.pid)).toBe(false);
    await pending;
  }, 60_000);

  it.runIf(process.platform === "linux")("starts the bridge as the leader of its own process group, tagged with its run", async () => {
    const { bridge } = await startBridge();

    const stat = await readFile(`/proc/${bridge.pid}/stat`, "utf8");
    const processGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    expect(processGroup).toBe(bridge.pid);
    const argv = (await readFile(`/proc/${bridge.pid}/cmdline`, "utf8")).split("\0");
    expect(argv).toContain(`--paperclip-run-id=${RUN_ID}`);
    const environ = (await readFile(`/proc/${bridge.pid}/environ`, "utf8")).split("\0");
    expect(environ).toContain(`PAPERCLIP_BRIDGE_RUN_ID=${RUN_ID}`);

    await bridge.stop();
    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it("kills a bridge that ignores SIGTERM", async () => {
    const { bridge } = await startBridge({ source: STUBBORN_BRIDGE });
    expect(isAlive(bridge.pid)).toBe(true);

    await bridge.stop();

    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it("never signals an unrelated process that the pid file names", async () => {
    const { bridge, queueDir } = await startBridge();
    const unrelated: ChildProcess = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    pids.push(unrelated.pid ?? 0);
    await writeFile(sandboxCallbackBridgeDirectories(queueDir).pidFile, `${unrelated.pid}\n`);

    await bridge.stop();

    expect(isAlive(unrelated.pid ?? 0)).toBe(true);
    // The process the bridge reported as ready is still stopped.
    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it("stops a bridge that started but failed its readiness check", async () => {
    const { root } = await createRunRoot();

    await expect(startBridge({ root, source: BROKEN_READY_BRIDGE })).rejects.toThrow("invalid readiness JSON");

    const pid = Number(await readFile(path.join(root, "bridge.pid"), "utf8"));
    pids.push(pid);
    expect(pid).toBeGreaterThan(0);
    await waitUntilDead(pid, 10_000);
  }, 60_000);

  it.runIf(HAS_BUSYBOX)("stops the bridge when the worker shell is busybox ash", async () => {
    const { bridge } = await startBridge({ shell: ["busybox", "sh"] });

    await bridge.stop();

    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it("keeps a bridge while its host polls, and the bridge exits after the host stops", async () => {
    const hostLeaseMs = 5_000;
    const { root, queueDir } = await createRunRoot();
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      hostLeaseRefreshMs: 200,
      handleRequest: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }),
    });
    let workerStopped = false;
    stopFns.push(async () => {
      if (!workerStopped) await worker.stop();
    });
    const { bridge } = await startBridge({ root, hostLeaseMs });

    // A live run: the bridge outlives two leases and still relays.
    await new Promise((resolve) => setTimeout(resolve, 2 * hostLeaseMs));
    expect(isAlive(bridge.pid)).toBe(true);
    const response = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
    });
    expect(response.status).toBe(200);

    // The host stops without stopping the bridge, as on a server restart or a
    // lost run.
    await worker.stop();
    workerStopped = true;
    await waitUntilDead(bridge.pid, hostLeaseMs + 10_000);
  }, 90_000);

  it("exits when a newer bridge takes over its queue directory", async () => {
    // The next run on a reused sandbox starts its bridge in the same queue
    // directory. The lease is long, so only the takeover can end the earlier
    // bridge within the test.
    const { root } = await createRunRoot();
    const { bridge: earlier } = await startBridge({ root });
    const { bridge: newer } = await startBridge({ root });

    await waitUntilDead(earlier.pid, 15_000);
    expect(isAlive(newer.pid)).toBe(true);

    await newer.stop();
    expect(isAlive(newer.pid)).toBe(false);
  }, 60_000);

  it("exits when its queue directory is removed", async () => {
    // The lease is long, so only the removal can end the bridge within the test.
    const { bridge, queueDir } = await startBridge();

    await rm(queueDir, { recursive: true, force: true });

    await waitUntilDead(bridge.pid, 15_000);
  }, 60_000);
});
