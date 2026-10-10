import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const BRIDGE_TOKEN = "lifecycle-test-token";
// The stop proves a process is the bridge through /proc, or through ps where
// there is no /proc (macOS). A few tests read /proc themselves.
const HAS_PROC = existsSync("/proc/self/stat");
const HAS_BUSYBOX = (() => {
  try {
    execFileSync("busybox", ["true"]);
    return true;
  } catch {
    return false;
  }
})();

interface RunnerOptions {
  // The worker's `sh`.
  shell?: string[];
  // Run the stop's control shell in a new process group with a `sleep`
  // bystander, whose id goes to this file. A signal to the control shell's
  // group would reach the bystander.
  groupBystanderFile?: string;
  // Rewrite a control script before it runs, as a worker with other files would see it.
  rewriteScript?: (script: string) => string;
  // Rewrite a control command's output.
  rewriteStdout?: (stdout: string, script: string) => string;
}

// Runs the bridge control commands on this host, the way an SSH runner runs
// them on a worker.
function createRunner(options: RunnerOptions = {}) {
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const [command = "/bin/sh", ...prefix] = input.command === "bash" ? ["/bin/bash"] : options.shell ?? ["/bin/sh"];
      const args = [...(input.args ?? [])];
      const original = args[1] ?? "";
      let script = options.rewriteScript ? options.rewriteScript(original) : original;
      const isStop = original.includes("kill -TERM");
      if (options.groupBystanderFile && isStop) script = `sleep 60 >/dev/null 2>&1 & echo $! > '${options.groupBystanderFile}'\n${script}`;
      args[1] = script;
      const child = spawn(command, [...prefix, ...args], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        detached: Boolean(options.groupBystanderFile) && isStop,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const exitCode: number | null = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
      if (options.rewriteStdout) stdout = options.rewriteStdout(stdout, original);
      return { exitCode, signal: null, timedOut: false, stdout, stderr, pid: null, startedAt };
    },
  };
}

// A stand-in bridge that reports ready and then ignores SIGTERM. It marks a
// received SIGTERM in `term-received`.
const STUBBORN_BRIDGE = `
import { createServer } from "node:http";
import { promises as fs, writeFileSync } from "node:fs";
const queueDir = process.env.PAPERCLIP_BRIDGE_QUEUE_DIR;
process.on("SIGTERM", () => writeFileSync(queueDir + "/term-received", ""));
const ready = queueDir + "/ready.json";
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
  runner?: RunnerOptions;
} = {}): Promise<{ bridge: StartedSandboxCallbackBridgeServer; queueDir: string; entrypoint: string }> {
  const root = options.root ?? (await createRunRoot()).root;
  const assetRemoteDir = path.join(root, "server");
  await mkdir(assetRemoteDir, { recursive: true });
  const entrypoint = path.join(assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  await writeFile(entrypoint, options.source ?? getSandboxCallbackBridgeServerSource());
  const queueDir = path.join(root, "queue");
  const bridge = await startSandboxCallbackBridgeServer({
    runner: createRunner(options.runner),
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
  return { bridge, queueDir, entrypoint };
}

// A process that is not the bridge but whose argv names its entrypoint and run.
function spawnBystander(entrypoint: string): ChildProcess {
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", entrypoint, `--paperclip-run-id=${RUN_ID}`], {
    detached: true,
    stdio: "ignore",
  });
  pids.push(bystander.pid ?? 0);
  return bystander;
}

afterEach(async () => {
  for (const stop of stopFns.splice(0)) await stop().catch(() => undefined);
  for (const pid of pids.splice(0)) {
    if (!(pid > 1)) continue;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  for (const root of roots.splice(0)) {
    // Stand-ins and bystanders record their own pid here, in case a test failed early.
    for (const file of ["bridge.pid", "bystander.pid"]) {
      const pid = Number(await readFile(path.join(root, file), "utf8").catch(() => "0"));
      if (pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
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

  it("starts the bridge as the leader of its own process group, tagged with its run and start", async () => {
    const { bridge } = await startBridge();

    const processGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(bridge.pid)], { encoding: "utf8" }).trim());
    expect(processGroup).toBe(bridge.pid);
    const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(bridge.pid)], { encoding: "utf8" }).trim().split(" ");
    expect(command).toContain(`--paperclip-run-id=${RUN_ID}`);
    expect(command.some((arg) => /^--paperclip-bridge-instance=[0-9a-f-]{36}$/.test(arg))).toBe(true);
    if (HAS_PROC) {
      const environ = (await readFile(`/proc/${bridge.pid}/environ`, "utf8")).split("\0");
      expect(environ).toContain(`PAPERCLIP_BRIDGE_RUN_ID=${RUN_ID}`);
    }

    await bridge.stop();
    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it("kills a bridge that ignores SIGTERM", async () => {
    const { bridge } = await startBridge({ source: STUBBORN_BRIDGE });
    expect(isAlive(bridge.pid)).toBe(true);

    await bridge.stop();

    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it.runIf(HAS_PROC)("sends no SIGKILL when the process id was reused after SIGTERM (fake /proc)", async () => {
    const { root } = await createRunRoot();
    const fakeProc = path.join(root, "fake-proc");
    let stopping = false;
    const { bridge, queueDir } = await startBridge({
      root,
      source: STUBBORN_BRIDGE,
      runner: {
        // Only the stop reads the fake /proc; the launch records the real start time.
        rewriteScript: (script) => (stopping ? script.replaceAll("/proc/", `${fakeProc}/`) : script),
      },
    });
    // `self` tells the stop that this host has /proc.
    await mkdir(path.join(fakeProc, "self"), { recursive: true });
    await mkdir(path.join(fakeProc, "sys", "kernel"), { recursive: true });
    // /proc files report size 0, so copy their content, not the file.
    await writeFile(path.join(fakeProc, "sys", "kernel", "pid_max"), await readFile("/proc/sys/kernel/pid_max"));
    const fakeDir = path.join(fakeProc, String(bridge.pid));
    await mkdir(fakeDir);
    const realStat = await readFile(`/proc/${bridge.pid}/stat`, "utf8");
    await writeFile(path.join(fakeDir, "stat"), realStat);
    await writeFile(path.join(fakeDir, "cmdline"), await readFile(`/proc/${bridge.pid}/cmdline`));

    stopping = true;
    const stopped = bridge.stop();
    // Right after SIGTERM the process id belongs to another process: the
    // start time changes.
    await vi.waitFor(() => expect(existsSync(path.join(queueDir, "term-received"))).toBe(true), { timeout: 10_000, interval: 10 });
    const head = realStat.slice(0, realStat.lastIndexOf(")") + 2);
    const fields = realStat.slice(head.length).trim().split(" ");
    fields[19] = String(Number(fields[19]) + 1);
    await writeFile(path.join(fakeDir, "stat"), `${head}${fields.join(" ")}\n`);
    await stopped;

    // The stand-in ignores SIGTERM, so only a SIGKILL could have ended it.
    expect(isAlive(bridge.pid)).toBe(true);
  }, 60_000);

  it("never signals a bystander whose argv names the bridge's entrypoint and run", async () => {
    const { bridge, queueDir, entrypoint } = await startBridge();
    const bystander = spawnBystander(entrypoint);
    await writeFile(sandboxCallbackBridgeDirectories(queueDir).pidFile, `${bystander.pid}\n`);

    await bridge.stop();

    expect(isAlive(bystander.pid ?? 0)).toBe(true);
    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it("signals nothing for a pid file of 0, -1, 1 or junk, and spares the control shell's group", async () => {
    for (const recorded of ["0", "-1", "1", "junk"]) {
      const { root } = await createRunRoot();
      const bystanderFile = path.join(root, "bystander.pid");
      const { bridge, queueDir } = await startBridge({ root, runner: { groupBystanderFile: bystanderFile } });
      await writeFile(sandboxCallbackBridgeDirectories(queueDir).pidFile, `${recorded}\n`);

      await bridge.stop();

      const bystander = Number(await readFile(bystanderFile, "utf8"));
      expect(isAlive(bystander), `pid file ${recorded}`).toBe(true);
    }
  }, 120_000);

  it("signals nothing when the launch recorded process id 0", async () => {
    const { root } = await createRunRoot();
    const bystanderFile = path.join(root, "bystander.pid");
    const { bridge } = await startBridge({
      root,
      runner: {
        groupBystanderFile: bystanderFile,
        rewriteStdout: (stdout, script) => (script.includes("setsid") ? stdout.replace(/"pid":\d+/, "\"pid\":0") : stdout),
      },
    });

    await bridge.stop();

    expect(isAlive(Number(await readFile(bystanderFile, "utf8")))).toBe(true);
    // Unproven, so left to its own lease.
    expect(isAlive(bridge.pid)).toBe(true);
  }, 60_000);

  it("leaves a newer bridge's process and metadata when an older bridge stops", async () => {
    const { root } = await createRunRoot();
    const { bridge: older } = await startBridge({ root });
    const { bridge: newer, queueDir } = await startBridge({ root });
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const pidFile = await readFile(directories.pidFile, "utf8");
    const readyFile = await readFile(directories.readyFile, "utf8");

    await older.stop();

    expect(isAlive(newer.pid)).toBe(true);
    expect(await readFile(directories.pidFile, "utf8")).toBe(pidFile);
    expect(await readFile(directories.readyFile, "utf8")).toBe(readyFile);
    await newer.stop();
  }, 60_000);

  it("stops a bridge that started but failed its readiness check", async () => {
    const { root } = await createRunRoot();

    await expect(startBridge({ root, source: BROKEN_READY_BRIDGE })).rejects.toThrow("invalid readiness JSON");

    const pid = Number(await readFile(path.join(root, "bridge.pid"), "utf8"));
    pids.push(pid);
    expect(pid).toBeGreaterThan(0);
    await waitUntilDead(pid, 10_000);
  }, 60_000);

  it("stops the bridge where only ps can inspect it, as on macOS", async () => {
    const { root } = await createRunRoot();
    const hidden = path.join(root, "no-proc");
    // On Linux the control scripts see no /proc; on macOS there is none.
    const { bridge } = await startBridge({ root, runner: { rewriteScript: (script) => script.replaceAll("/proc/", `${hidden}/`) } });
    expect(isAlive(bridge.pid)).toBe(true);

    await bridge.stop();

    expect(isAlive(bridge.pid)).toBe(false);
  }, 60_000);

  it.runIf(HAS_PROC && HAS_BUSYBOX)("stops the bridge when the worker shell is busybox ash", async () => {
    const { bridge } = await startBridge({ runner: { shell: ["busybox", "sh"] } });

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
  }, 60_000);

  it("exits when its queue directory is removed", async () => {
    // The lease is long, so only the removal can end the bridge within the test.
    const { bridge, queueDir } = await startBridge();

    await rm(queueDir, { recursive: true, force: true });

    await waitUntilDead(bridge.pid, 15_000);
  }, 60_000);
});
