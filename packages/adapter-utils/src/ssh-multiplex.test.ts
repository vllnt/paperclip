import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function startFixture(sshdConfigExtra: string[] = []) {
  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    console.warn(`Skipping SSH multiplex test: ${support.reason}`);
    return null;
  }
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

async function controlPathOf(multiplex: SshMultiplex): Promise<string> {
  const channel = await multiplex.channel();
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

describe("SSH multiplexing for short bridge commands", () => {
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
    const controlPath = await controlPathOf(first);
    const master = await masterCheck(fixture.config, controlPath);
    expect(master.running).toBe(true);

    await first.release();
    expect((await masterCheck(fixture.config, controlPath)).running).toBe(true);
    await second.release();

    expect((await masterCheck(fixture.config, controlPath)).running).toBe(false);
    expect(existsSync(path.dirname(controlPath))).toBe(false);
    expect(isAlive(master.pid!)).toBe(false);
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
    const controlPath = await controlPathOf(multiplex);
    const master = await masterCheck(fixture.config, controlPath);
    process.kill(master.pid!, "SIGKILL");
    while (isAlive(master.pid!)) await new Promise((resolve) => setTimeout(resolve, 20));
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
    const envA = hold(fixture.config, "env-a");
    const envB = hold(fixture.config, "env-b");
    const otherKnownHosts = hold({ ...fixture.config, knownHosts: `${fixture.config.knownHosts}\n` }, "env-a");
    const sameAsA = hold(fixture.config, "env-a");

    const paths = await Promise.all([envA, envB, otherKnownHosts, sameAsA].map(controlPathOf));

    expect(new Set(paths.slice(0, 3)).size).toBe(3);
    expect(paths[3]).toBe(paths[0]);
    for (const controlPath of paths) {
      expect(path.basename(controlPath)).toBe("%C");
      expect(path.basename(path.dirname(controlPath))).toMatch(/^paperclip-ssh-mux-/);
    }
    const before = await fixture.logins();
    for (const multiplex of [envA, envB, otherKnownHosts, sameAsA]) {
      expect((await runnerFor(fixture.state, fixture.config, multiplex)("true")).exitCode).toBe(0);
    }
    expect((await fixture.logins()) - before).toBe(3);
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

describe("callback bridge worker over a shared SSH connection", () => {
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
      `const option = (await hold.channel()).args.find((arg) => arg.startsWith("ControlPath="));`,
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
  });
});
