import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshConnectionConfig,
  type SshEnvLabFixtureState,
} from "./ssh.js";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import { openSshMultiplex, sshControlDirFits, SSH_MULTIPLEX_MAX_CHANNELS, type SshMultiplex } from "./ssh-multiplex.js";

// Every test runs against a real loopback sshd and counts its
// `Accepted publickey` lines: one per SSH connection.

const cleanups: Array<() => Promise<void>> = [];
// The image has no sshd: these blocks show as skipped there, not as passed.
const sshSupport = await getSshEnvLabSupport();

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function startFixture(sshdConfigExtra: string[] = []) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-mux-test-"));
  const statePath = path.join(rootDir, "state.json");
  cleanups.push(async () => {
    await stopSshEnvLabFixture(statePath).catch(() => false);
    await rm(rootDir, { recursive: true, force: true });
  });
  let state: SshEnvLabFixtureState;
  try {
    state = await startSshEnvLabFixture({ statePath, sshdConfigExtra });
  } catch (error) {
    // For example as root, where the fixture's sshd refuses the login.
    console.warn(`Skipping SSH multiplex test: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const config = await buildSshEnvLabFixtureConfig(state);
  const logins = async () =>
    (await readFile(state.sshdLogPath, "utf8")).split("\n").filter((line) => line.includes("Accepted publickey")).length;
  return { state, config, logins };
}

function hold(config: SshConnectionConfig, scopeId: string): SshMultiplex {
  const multiplex = openSshMultiplex(config, scopeId);
  cleanups.push(() => multiplex.release());
  return multiplex;
}

function runnerFor(state: SshEnvLabFixtureState, config: SshConnectionConfig, multiplex: SshMultiplex | null) {
  const runner = createSshCommandManagedRuntimeRunner({
    spec: { ...config, remoteCwd: state.workspaceDir },
    multiplex,
  });
  return (script: string, signal?: AbortSignal) =>
    runner.execute({ command: "sh", args: ["-c", script], timeoutMs: 30_000, signal });
}

async function controlPathOf(multiplex: SshMultiplex, config: SshConnectionConfig): Promise<string> {
  const channel = await multiplex.channel(config);
  channel.done();
  const option = channel.args.find((arg) => arg.startsWith("ControlPath="));
  if (!option || option === "ControlPath=none") throw new Error("no shared connection");
  return option.slice("ControlPath=".length);
}

function masterCheck(config: SshConnectionConfig, controlPath: string): Promise<{ running: boolean; pid: number | null }> {
  return new Promise((resolve) => {
    execFile("ssh", [
      "-o", "BatchMode=yes", "-o", `ControlPath=${controlPath}`, "-O", "check",
      "-p", String(config.port), `${config.username}@${config.host}`,
    ], (error, _stdout, stderr) => {
      const pid = /pid=(\d+)/.exec(stderr)?.[1];
      resolve({ running: !error, pid: pid ? Number(pid) : null });
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Waits up to 5 s for a process to exit (a zombie that is never reaped counts as alive).
async function exited(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 250 && isAlive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return !isAlive(pid);
}

// Every process below the fixture's listener: the per-connection sshd
// processes and their children.
function sessionProcesses(listenerPid: number): number[] {
  const children = (pid: number) => {
    try {
      return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  const found: number[] = [];
  for (let queue = children(listenerPid); queue.length > 0;) {
    const pid = queue.shift()!;
    found.push(pid);
    queue.push(...children(pid));
  }
  return found;
}

describe.skipIf(!sshSupport.supported)("SSH multiplexing for short bridge commands", () => {
  it("runs twenty commands over one SSH connection", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const run = runnerFor(fixture.state, fixture.config, hold(fixture.config, "env-a"));
    const before = await fixture.logins();

    for (let index = 0; index < 20; index += 1) {
      const result = await run(`echo step-${index}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`step-${index}`);
    }

    // Without the shared connection this was 20 logins.
    expect((await fixture.logins()) - before).toBe(1);
  }, 120_000);

  it(`shares a master with at most ${SSH_MULTIPLEX_MAX_CHANNELS} commands; the 21st concurrent one falls back and succeeds`, async () => {
    // The 11 direct connections start at once. sshd's default `MaxStartups
    // 10:30:100` drops some new connections above 10, which this test does not
    // measure.
    const fixture = await startFixture(["MaxStartups 100"]);
    if (!fixture) return;
    const run = runnerFor(fixture.state, fixture.config, hold(fixture.config, "env-a"));
    expect((await run("true")).exitCode).toBe(0);
    const before = await fixture.logins();

    const results = await Promise.all(
      Array.from({ length: 21 }, (_, index) => run(`sleep 2; echo done-${index}`)),
    );

    expect(results.map((result) => result.exitCode)).toEqual(Array(21).fill(0));
    expect(results.map((result) => result.stdout.trim())).toEqual(
      Array.from({ length: 21 }, (_, index) => `done-${index}`),
    );
    // 10 channels on the warm master, 11 direct connections.
    expect((await fixture.logins()) - before).toBe(21 - SSH_MULTIPLEX_MAX_CHANNELS);
  }, 120_000);

  it("falls back to a direct connection when sshd refuses a channel", async () => {
    const fixture = await startFixture(["MaxSessions 3"]);
    if (!fixture) return;
    const run = runnerFor(fixture.state, fixture.config, hold(fixture.config, "env-a"));
    expect((await run("true")).exitCode).toBe(0);
    const before = await fixture.logins();

    const results = await Promise.all(Array.from({ length: 6 }, () => run("sleep 2; echo ok")));

    expect(results.map((result) => [result.exitCode, result.stdout.trim()])).toEqual(Array(6).fill([0, "ok"]));
    // sshd took 3 channels on the master and refused 3, which connected directly.
    expect((await fixture.logins()) - before).toBe(3);
  }, 120_000);

  it("ends the master and removes its socket directory when the last hold is released", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const first = hold(fixture.config, "env-a");
    const second = hold(fixture.config, "env-a");
    const run = runnerFor(fixture.state, fixture.config, first);
    expect((await run("true")).exitCode).toBe(0);
    const controlPath = await controlPathOf(first, fixture.config);
    const master = await masterCheck(fixture.config, controlPath);
    expect(master.running).toBe(true);

    await first.release();
    expect((await masterCheck(fixture.config, controlPath)).running).toBe(true);
    await second.release();

    expect((await masterCheck(fixture.config, controlPath)).running).toBe(false);
    expect(existsSync(path.dirname(controlPath))).toBe(false);
    expect(await exited(master.pid!)).toBe(true);
    // A released hold runs later commands on a direct connection.
    const before = await fixture.logins();
    expect((await run("true")).exitCode).toBe(0);
    expect((await fixture.logins()) - before).toBe(1);
  }, 120_000);

  it("recovers from a killed master with a new connection to the same target", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const multiplex = hold(fixture.config, "env-a");
    const run = runnerFor(fixture.state, fixture.config, multiplex);
    expect((await run("true")).exitCode).toBe(0);
    const controlPath = await controlPathOf(multiplex, fixture.config);
    const master = await masterCheck(fixture.config, controlPath);
    process.kill(master.pid!, "SIGKILL");
    expect(await exited(master.pid!)).toBe(true);
    const before = await fixture.logins();

    const result = await run('echo "$SSH_CONNECTION"');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split(" ").at(-1)).toBe(String(fixture.config.port));
    expect((await fixture.logins()) - before).toBe(1);
    // The new connection is the master for the next commands.
    expect((await masterCheck(fixture.config, controlPath)).running).toBe(true);
    expect((await run("true")).exitCode).toBe(0);
    expect((await fixture.logins()) - before).toBe(1);
  }, 120_000);

  it("never shares a master across environments or credentials", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const config = fixture.config;
    const envA = hold(config, "env-a");
    const variants = [
      hold(config, "env-b"),
      hold({ ...config, knownHosts: `${config.knownHosts}\n` }, "env-a"),
      hold({ ...config, privateKey: `${config.privateKey}\n` }, "env-a"),
      hold({ ...config, strictHostKeyChecking: false }, "env-a"),
      hold({ ...config, host: "localhost" }, "env-a"),
      hold({ ...config, port: config.port + 1 }, "env-a"),
      hold({ ...config, username: `${config.username}-other` }, "env-a"),
    ];
    const variantConfigs = [
      config,
      { ...config, knownHosts: `${config.knownHosts}\n` },
      { ...config, privateKey: `${config.privateKey}\n` },
      { ...config, strictHostKeyChecking: false },
      { ...config, host: "localhost" },
      { ...config, port: config.port + 1 },
      { ...config, username: `${config.username}-other` },
    ];
    const sameAsA = hold(config, "env-a");

    const pathA = await controlPathOf(envA, config);
    const variantPaths = await Promise.all(variants.map((multiplex, index) => controlPathOf(multiplex, variantConfigs[index]!)));

    expect(new Set([pathA, ...variantPaths]).size).toBe(1 + variants.length);
    expect(await controlPathOf(sameAsA, config)).toBe(pathA);
    for (const controlPath of [pathA, ...variantPaths]) {
      expect(path.basename(controlPath)).toBe("%C");
      expect(path.basename(path.dirname(controlPath))).toMatch(/^paperclip-ssh-mux-/);
    }
    const before = await fixture.logins();
    for (const multiplex of [envA, variants[0]!, variants[1]!, sameAsA]) {
      const runConfig = multiplex === variants[1] ? variantConfigs[1]! : config;
      expect((await runnerFor(fixture.state, runConfig, multiplex)("true")).exitCode).toBe(0);
    }
    expect((await fixture.logins()) - before).toBe(3);
  }, 120_000);

  it("connects directly for a config the hold was not opened for", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const multiplex = hold(fixture.config, "env-a");
    const run = runnerFor(fixture.state, fixture.config, multiplex);
    expect((await run("true")).exitCode).toBe(0);
    const before = await fixture.logins();

    // Same target, other credentials: never through the hold's master.
    const other = runnerFor(fixture.state, { ...fixture.config, privateKey: "not a key" }, multiplex);
    const result = await other("echo through-master");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("through-master");
    expect((await fixture.logins()) - before).toBe(0);
  }, 120_000);

  it("retires a master that stopped answering, so the next command connects again", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const multiplex = hold(fixture.config, "env-a");
    const runner = createSshCommandManagedRuntimeRunner({
      spec: { ...fixture.config, remoteCwd: fixture.state.workspaceDir },
      multiplex,
    });
    const run = (script: string, timeoutMs: number) => runner.execute({ command: "sh", args: ["-c", script], timeoutMs });
    expect((await run("true", 30_000)).exitCode).toBe(0);
    // The master's connection stays open but its sshd stops answering, as
    // after a dropped network path.
    const frozen = sessionProcesses(fixture.state.pid);
    expect(frozen.length).toBeGreaterThan(0);
    for (const pid of frozen) process.kill(pid, "SIGSTOP");
    cleanups.push(async () => {
      for (const pid of frozen) {
        try {
          process.kill(pid, "SIGCONT");
        } catch {
          // gone
        }
      }
    });
    const before = await fixture.logins();

    const hung = await run("echo hung", 2_000);
    expect(hung.timedOut).toBe(true);
    const startedAt = Date.now();
    const next = await run("echo fresh", 30_000);

    expect(next.exitCode).toBe(0);
    expect(next.stdout.trim()).toBe("fresh");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect((await fixture.logins()) - before).toBe(1);
  }, 120_000);

  it("lets a command still on the master finish when the last hold is released", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const multiplex = openSshMultiplex(fixture.config, "env-a");
    const run = runnerFor(fixture.state, fixture.config, multiplex);
    expect((await run("true")).exitCode).toBe(0);

    const pending = run("sleep 2; echo finished");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await multiplex.release();
    const result = await pending;

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("finished");
  }, 120_000);

  it.each([
    ["direct", false],
    ["shared", true],
  ])("stops an aborted %s command at once", async (_label, shared) => {
    const fixture = await startFixture();
    if (!fixture) return;
    const run = runnerFor(fixture.state, fixture.config, shared ? hold(fixture.config, "env-a") : null);
    expect((await run("true")).exitCode).toBe(0);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = run("sleep 30; echo finished", controller.signal);
    setTimeout(() => controller.abort(), 500);

    const result = await pending;

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("finished");
  }, 120_000);
});

describe.skipIf(!sshSupport.supported)("callback bridge worker over a shared SSH connection", () => {
  it("serves ten requests and ten idle seconds over one SSH connection", async () => {
    const fixture = await startFixture();
    if (!fixture) return;
    const multiplex = hold(fixture.config, "env-a");
    const runner = createSshCommandManagedRuntimeRunner({
      spec: { ...fixture.config, remoteCwd: fixture.state.workspaceDir },
      multiplex,
    });
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({ runner, remoteCwd: fixture.state.workspaceDir });
    // The fixture's "remote" workspace is a local directory, so the test can
    // queue requests the way the in-sandbox bridge does.
    const queueDir = path.join(fixture.state.workspaceDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const before = await fixture.logins();
    const worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      authorizeRequest: () => null,
      handleRequest: async () => ({ status: 200, body: "{}" }),
    });
    cleanups.push(() => worker.stop());
    await mkdir(directories.requestsDir, { recursive: true });

    for (let index = 0; index < 10; index += 1) {
      const id = `request-${index}`;
      await writeFile(path.join(directories.requestsDir, `${id}.json`), JSON.stringify({
        id, method: "GET", path: "/api/agents/me", query: "", headers: {}, body: "", createdAt: new Date().toISOString(),
      }));
      const responsePath = path.join(directories.responsesDir, `${id}.json`);
      while (!existsSync(responsePath)) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(JSON.parse(await readFile(responsePath, "utf8")).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await worker.stop();

    // Each request is a size, a read, a write and a remove, and the queue
    // listing runs all the time: one login each without the shared connection.
    const opened = (await fixture.logins()) - before;
    console.info(`bridge worker over a shared connection: ${opened} SSH connections for 10 requests in about 10 s`);
    expect(opened).toBe(1);
  }, 120_000);
});

describe("SSH control socket directory", () => {
  const offline = {
    host: "127.0.0.1", port: 22, username: "user", remoteWorkspacePath: "/w",
    privateKey: "key", knownHosts: "hosts", strictHostKeyChecking: true,
  };

  it("connects directly when the target has no environment id", async () => {
    const multiplex = openSshMultiplex(offline, null);
    await expect(multiplex.channel(offline)).resolves.toMatchObject({ args: ["-o", "ControlPath=none"] });
    await multiplex.release();
  });

  it("does not put the socket below a temp root that other users may write", async () => {
    // Short, so the socket path would fit there and only the owner check decides.
    const unsafe = await mkdtemp("/tmp/pu-");
    cleanups.push(() => rm(unsafe, { recursive: true, force: true }));
    await chmod(unsafe, 0o777);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = unsafe;
    try {
      const multiplex = openSshMultiplex(offline, "env-unsafe-root");
      cleanups.push(() => multiplex.release());
      const channel = await multiplex.channel(offline);
      const option = channel.args.find((arg) => arg.startsWith("ControlPath="))!;
      channel.done();

      expect(option.startsWith(`ControlPath=${unsafe}`)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  it("is private while held and gone when the process exits", () => {
    // A server that exits without stopping its runs (a restart) still removes
    // its sockets; each master then exits after its idle time.
    const modulePath = fileURLToPath(new URL("./ssh-multiplex.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", [
      `import { statSync } from "node:fs";`,
      `import path from "node:path";`,
      `import { openSshMultiplex } from ${JSON.stringify(modulePath)};`,
      `const hold = openSshMultiplex({ host: "127.0.0.1", port: 22, username: "user", remoteWorkspacePath: "/w",`,
      `  privateKey: "key", knownHosts: "hosts", strictHostKeyChecking: true }, "env-a");`,
      `const option = (await hold.channel({ host: "127.0.0.1", port: 22, username: "user", remoteWorkspacePath: "/w",`,
      `  privateKey: "key", knownHosts: "hosts", strictHostKeyChecking: true })).args.find((arg) => arg.startsWith("ControlPath="));`,
      `const dir = path.dirname(option.slice("ControlPath=".length));`,
      `console.log(JSON.stringify({ dir, mode: statSync(dir).mode & 0o777 }));`,
    ].join("\n")], { encoding: "utf8" });
    const { dir, mode } = JSON.parse(output.trim()) as { dir: string; mode: number };

    expect(path.basename(dir)).toMatch(/^paperclip-ssh-mux-/);
    expect(mode).toBe(0o700);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("SSH control socket path", () => {
  it("fits the longest real path under the macOS socket limit", () => {
    // os.tmpdir() on Linux, plus the mkdtemp name; `%C` adds 40 characters.
    expect(sshControlDirFits("/tmp/paperclip-ssh-mux-AbCdEf")).toBe(true);
    // A macOS os.tmpdir() leaves no room, so the module uses /tmp there.
    expect(sshControlDirFits("/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/paperclip-ssh-mux-AbCdEf")).toBe(false);
    expect(sshControlDirFits("/tmp/with space/paperclip-ssh-mux-AbCdEf")).toBe(false);
    expect(sshControlDirFits("/tmp/100%/paperclip-ssh-mux-AbCdEf")).toBe(false);
    expect(sshControlDirFits("/tmp/${HOME}/paperclip-ssh-mux-AbCdEf")).toBe(false);
    expect(sshControlDirFits("~/paperclip-ssh-mux-AbCdEf")).toBe(false);
  });
});
