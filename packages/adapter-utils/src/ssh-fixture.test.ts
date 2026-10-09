import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  buildSshSpawnTarget,
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  readSshEnvLabFixtureStatus,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";
import {
  prepareRemoteManagedRuntime,
  reapSshRunDirectory,
  readSshDiskUsagePercent,
  removeRestoredSshRunDirectory,
  SSH_RUN_RESTORED_MARKER,
  sshRunDirectory,
} from "./remote-managed-runtime.js";

const SSH_FIXTURE_TEST_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);
let sshEnvLabUnsupportedReason: string | null = null;

// One entry per fixture root directory, registered at creation time so
// teardown survives a setup call that throws before the fixture starts, an
// assertion failure, or an early return on skip. `state` stays null until
// the fixture actually starts; a caller that stops the fixture itself still
// leaves the entry in the stack, so the drain below must be idempotent
// (stopSshEnvLabFixture is).
interface FixtureTeardownEntry {
  rootDir: string;
  state: SshEnvLabFixtureState | null;
}

const fixtureTeardowns: FixtureTeardownEntry[] = [];

// Creates the fixture root directory and registers its teardown entry in
// the same step, so a setup call that throws between here and the fixture
// start (mkdir, writeFile, git init) still leaves the root directory queued
// for removal.
async function createFixtureRootDir(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
  fixtureTeardowns.push({ rootDir, state: null });
  return rootDir;
}

async function drainFixtureTeardowns(): Promise<void> {
  while (fixtureTeardowns.length > 0) {
    const entry = fixtureTeardowns.pop();
    if (!entry) continue;
    if (entry.state) {
      try {
        await stopSshEnvLabFixture(entry.state);
      } catch (error) {
        // stopSshEnvLabFixture throws only when the listener survives
        // SIGKILL, and it deliberately keeps the root directory so a later
        // stop call can still find and signal it through the state file.
        // Report the failure but keep the root directory; do not remove it,
        // and do not rethrow, so a throw here cannot strand the entries
        // still left on the stack.
        console.error(
          `SSH env-lab fixture teardown failed for pid ${entry.state.pid} on port ${entry.state.port}:`,
          error,
        );
        continue;
      }
    }
    await rm(entry.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Finds the pid of a running sshd process by its config file path, the same
// way isSshEnvLabFixtureProcess identifies a fixture internally. Used by the
// readiness-failure regression test, which needs the pid of a fixture that
// startSshEnvLabFixture never returns because it throws before returning it.
async function findSshdPidByConfigPath(sshdConfigPath: string): Promise<number | null> {
  const stdout = await new Promise<string>((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], (error, out) => resolve(error ? "" : out));
  });
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex === -1) continue;
    const pid = Number.parseInt(trimmed.slice(0, spaceIndex), 10);
    const args = trimmed.slice(spaceIndex + 1);
    if (Number.isFinite(pid) && args.includes(sshdConfigPath)) {
      return pid;
    }
  }
  return null;
}

async function startSshEnvLabFixtureOrSkip(statePath: string, label: string) {
  // The teardown entry for this root directory must already exist: callers
  // create it with createFixtureRootDir() before they derive statePath, so
  // this only attaches the state to that entry instead of pushing a new
  // one (a root directory must never get two entries).
  const rootDir = path.dirname(statePath);
  const entry = fixtureTeardowns.find((candidate) => candidate.rootDir === rootDir);
  if (!entry) {
    throw new Error(
      `No fixture teardown entry for ${rootDir}. Call createFixtureRootDir() before starting a fixture.`,
    );
  }

  if (sshEnvLabUnsupportedReason) {
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  try {
    const state = await startSshEnvLabFixture({ statePath });
    entry.state = state;
    return state;
  } catch (error) {
    sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }
}

// Points os.tmpdir() at `dir` while `fn` runs, so a test can prove that no
// SSH sync-back staging directory outlives the restore.
async function withTmpdir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

async function listSyncBackStagingDirs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => entry.startsWith("paperclip-ssh-sync-back-"));
}

type TransferShimMode = "pass" | "truncate" | "enospc";

// Shadows `ssh` and `tar` on PATH while `fn` runs. The tar shim records how
// many sync-back staging dirs exist in $TMPDIR when each extract starts. The
// "truncate" mode cuts the remote archive stream short and exits like a
// dropped SSH connection; "enospc" extracts part of it and fails like tar on
// a full disk.
async function withTransferShims<T>(
  rootDir: string,
  mode: TransferShimMode,
  fn: () => Promise<T>,
): Promise<{ outcome: PromiseSettledResult<T>; stagingCounts: number[] }> {
  const binDir = path.join(rootDir, "shim-bin");
  const countLog = path.join(rootDir, "shim-staging-counts.log");
  const partial = path.join(rootDir, "shim-partial.tar");
  await mkdir(binDir, { recursive: true });
  const which = async (command: string) => (await execFileAsync("sh", ["-c", `command -v ${command}`])).stdout.trim();
  const [realSsh, realTar] = [JSON.stringify(await which("ssh")), JSON.stringify(await which("tar"))];
  await writeFile(path.join(binDir, "ssh"), [
    "#!/bin/sh",
    `if [ "$PAPERCLIP_SHIM_MODE" = truncate ]; then case "$*" in *"-cf - ."*) ${realSsh} "$@" | head -c 16384; exit 255;; esac; fi`,
    `exec ${realSsh} "$@"`,
  ].join("\n"), { mode: 0o755 });
  await writeFile(path.join(binDir, "tar"), [
    "#!/bin/sh",
    'if [ "$1" = "-xf" ]; then',
    `  ls "$TMPDIR" | grep -c '^paperclip-ssh-sync-back-' >> ${JSON.stringify(countLog)}`,
    '  if [ "$PAPERCLIP_SHIM_MODE" = enospc ]; then',
    `    head -c 16384 > ${JSON.stringify(partial)}; cat > /dev/null`,
    `    ${realTar} "$@" < ${JSON.stringify(partial)} 2>/dev/null`,
    '    echo "tar: ./big.bin: Wrote only 4096 of 10240 bytes: No space left on device" >&2',
    "    exit 2",
    "  fi",
    "fi",
    `exec ${realTar} "$@"`,
  ].join("\n"), { mode: 0o755 });

  const previous = { PATH: process.env.PATH, PAPERCLIP_SHIM_MODE: process.env.PAPERCLIP_SHIM_MODE };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.PAPERCLIP_SHIM_MODE = mode;
  let outcome: PromiseSettledResult<T>;
  try {
    outcome = (await Promise.allSettled([fn()]))[0]!;
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.PAPERCLIP_SHIM_MODE === undefined) delete process.env.PAPERCLIP_SHIM_MODE;
    else process.env.PAPERCLIP_SHIM_MODE = previous.PAPERCLIP_SHIM_MODE;
  }
  const counts = await readFile(countLog, "utf8").catch(() => "");
  return { outcome, stagingCounts: counts.split("\n").filter(Boolean).map(Number) };
}

async function initGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init"]);
  await git(dir, ["checkout", "-b", "main"]);
  await git(dir, ["config", "user.name", "Paperclip Test"]);
  await git(dir, ["config", "user.email", "test@paperclip.dev"]);
}

interface ParsedProgressLine {
  raw: string;
  percent: number | null;
  doneMb: number | null;
  totalMb: number | null;
}

function parseProgressLine(line: string): ParsedProgressLine {
  const trimmed = line.trimEnd();
  const percentMatch = trimmed.match(/:\s*(\d+)%\s*\(([\d.]+)\/([\d.]+) MB\)$/);
  if (percentMatch) {
    return {
      raw: trimmed,
      percent: Number.parseInt(percentMatch[1]!, 10),
      doneMb: Number.parseFloat(percentMatch[2]!),
      totalMb: Number.parseFloat(percentMatch[3]!),
    };
  }
  const mbMatch = trimmed.match(/:\s*([\d.]+) MB$/);
  if (mbMatch) {
    return { raw: trimmed, percent: null, doneMb: Number.parseFloat(mbMatch[1]!), totalMb: null };
  }
  return { raw: trimmed, percent: null, doneMb: null, totalMb: null };
}

describe("ssh env-lab fixture", () => {
  afterEach(drainFixtureTeardowns);
  // Backstop: if a throw inside afterEach ever leaves an entry on the stack,
  // this drains it too instead of stranding a listener until the process exits.
  afterAll(drainFixtureTeardowns);

  it("starts an isolated sshd fixture and executes commands through it", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const quotedWorkspace = JSON.stringify(started.workspaceDir);
    const result = await runSshCommand(
      config,
      `cd ${quotedWorkspace} && pwd`,
    );

    expect(result.stdout.trim()).toBe(started.workspaceDir);
    const status = await readSshEnvLabFixtureStatus(statePath);
    expect(status.running).toBe(true);

    await stopSshEnvLabFixture(started);

    const stopped = await readSshEnvLabFixtureStatus(statePath);
    expect(stopped.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("resolves a relative statePath to the same absolute state across start, status, and stop", async () => {
    const rootDir = await createFixtureRootDir();
    const absoluteStatePath = path.join(rootDir, "state.json");
    // A path relative to the test process's own working directory. This is
    // the shape a caller outside this file's own resolveEnvLabSshStatePath
    // helper can pass; startSshEnvLabFixture must resolve it up front so the
    // persisted state and every derived path stay absolute.
    const relativeStatePath = path.relative(process.cwd(), absoluteStatePath);

    if (sshEnvLabUnsupportedReason) {
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }

    const entry = fixtureTeardowns.find((candidate) => candidate.rootDir === rootDir);
    if (!entry) {
      throw new Error(`No fixture teardown entry for ${rootDir}.`);
    }

    let state: SshEnvLabFixtureState;
    try {
      state = await startSshEnvLabFixture({ statePath: relativeStatePath });
    } catch (error) {
      sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    entry.state = state;

    expect(state.statePath).toBe(absoluteStatePath);
    expect(state.rootDir).toBe(rootDir);

    const running = await readSshEnvLabFixtureStatus(relativeStatePath);
    expect(running.running).toBe(true);
    expect(running.state?.statePath).toBe(absoluteStatePath);

    const stopped = await stopSshEnvLabFixture(relativeStatePath);
    expect(stopped).toBe(true);
    entry.state = null;

    const afterStop = await readSshEnvLabFixtureStatus(relativeStatePath);
    expect(afterStop.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("forwards stdin to remote SSH commands", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH stdin forwarding test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remotePath = path.posix.join(started.workspaceDir, "stdin-forwarded.txt");

    await runSshCommand(
      config,
      `cat > ${JSON.stringify(remotePath)}`,
      {
        stdin: "hello over ssh stdin\n",
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(remotePath)}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    expect(result.stdout).toBe("hello over ssh stdin\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not treat an unrelated reused pid as the running fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    await stopSshEnvLabFixture(started);
    await mkdir(path.dirname(statePath), { recursive: true });

    await writeFile(
      statePath,
      JSON.stringify({ ...started, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const staleStatus = await readSshEnvLabFixtureStatus(statePath);
    expect(staleStatus.running).toBe(false);

    const restarted = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture restart test");
    if (!restarted) return;
    expect(restarted.pid).not.toBe(process.pid);

    await stopSshEnvLabFixture(restarted);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects a forged state file and cannot signal an unrelated local process", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    // A process this test does not own. A forged state must never be able
    // to target it for SIGTERM or SIGKILL.
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    const bystanderPid = bystander.pid;
    if (!bystanderPid) {
      throw new Error("Failed to spawn the bystander process for this regression test.");
    }

    try {
      const baseState = {
        kind: "ssh_openbsd" as const,
        bindHost: "127.0.0.1",
        host: "127.0.0.1",
        port: 0,
        username: os.userInfo().username,
        rootDir,
        workspaceDir: path.join(rootDir, "workspace"),
        statePath,
        createdAt: new Date().toISOString(),
        clientPrivateKeyPath: path.join(rootDir, "client_key"),
        clientPublicKeyPath: path.join(rootDir, "client_key.pub"),
        hostPrivateKeyPath: path.join(rootDir, "host_key"),
        hostPublicKeyPath: path.join(rootDir, "host_key.pub"),
        authorizedKeysPath: path.join(rootDir, "authorized_keys"),
        knownHostsPath: path.join(rootDir, "known_hosts"),
        sshdConfigPath: path.join(rootDir, "sshd_config"),
        sshdLogPath: path.join(rootDir, "sshd.log"),
      };

      const forgedVariants = [
        // An empty sshdConfigPath used to defeat the identity check: an
        // empty string is a substring of every command line.
        { ...baseState, pid: bystanderPid, sshdConfigPath: "" },
        // A sshdConfigPath outside the fixture root.
        { ...baseState, pid: bystanderPid, sshdConfigPath: "/etc/ssh/sshd_config" },
        // A non-positive pid.
        { ...baseState, pid: 0 },
        { ...baseState, pid: -1 },
      ];

      for (const forged of forgedVariants) {
        await writeFile(statePath, JSON.stringify(forged, null, 2), { mode: 0o600 });

        const status = await readSshEnvLabFixtureStatus(statePath);
        expect(status.running).toBe(false);
        expect(status.state).toBeNull();

        const stopped = await stopSshEnvLabFixture(statePath);
        expect(stopped).toBe(false);
      }

      // No forged state ever reached the identity check or a signal call,
      // so the bystander process is still alive.
      expect(() => process.kill(bystanderPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(bystanderPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("stops the fixture listener and frees its loopback port", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH teardown regression test");
    if (!started) return;
    const { pid, port, bindHost } = started;

    await stopSshEnvLabFixture(started);

    let pidStillRunning = true;
    try {
      process.kill(pid, 0);
    } catch {
      pidStillRunning = false;
    }
    expect(pidStillRunning).toBe(false);

    // Bind the exact port to prove it is free; a stopped process is not
    // proof the OS released the socket.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, bindHost, () => {
        probe.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("leaves no live listener and no root directory when the fixture fails readiness", async () => {
    if (sshEnvLabUnsupportedReason) {
      console.warn(`Skipping SSH readiness-failure cleanup test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping SSH readiness-failure cleanup test: ${sshEnvLabUnsupportedReason}`);
      return;
    }

    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const sshdConfigPath = path.join(rootDir, "sshd_config");

    // sshd binds through bindHost (127.0.0.1) and stays alive; the readiness
    // check targets an unreachable RFC 5737 TEST-NET-3 address instead, so it
    // fails on every attempt without ever reaching a real host. Poll for the
    // resulting sshd process concurrently, since startSshEnvLabFixture never
    // returns a state on this path (it throws before writing one).
    let capturedPid: number | null = null;
    const pollDeadline = Date.now() + 5_000;
    const pollForPid = (async () => {
      while (capturedPid === null && Date.now() < pollDeadline) {
        capturedPid = await findSshdPidByConfigPath(sshdConfigPath);
        if (capturedPid === null) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();

    await expect(
      startSshEnvLabFixture({
        statePath,
        host: "203.0.113.1",
        readinessTimeoutMs: 1_000,
      }),
    ).rejects.toThrow();

    await pollForPid;
    expect(capturedPid).not.toBeNull();

    let pidStillRunning = true;
    try {
      process.kill(capturedPid!, 0);
    } catch {
      pidStillRunning = false;
    }
    expect(pidStillRunning).toBe(false);

    await expect(stat(rootDir)).rejects.toThrow();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("builds a remote script that sources login profiles but no nvm", async () => {
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/workspace",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "node",
      args: ["--version"],
      env: { FOO: "bar" },
    });

    // The remote script rides the last ssh argument. The SSH target is an
    // operator-configured host that can expose `node` only through a login
    // profile, so the wrapper sources the profiles. It no longer sources
    // `nvm.sh`; a profile that adds nvm still runs.
    const remoteScript = String(target.args.at(-1) ?? "");
    expect(remoteScript).not.toContain("nvm.sh");
    expect(remoteScript).not.toContain("NVM_DIR");
    // Source /etc/profile so a host that exposes the PATH through
    // /etc/profile.d scripts still resolves node and the agent CLI.
    expect(remoteScript).toContain("/etc/profile");
    expect(remoteScript).toContain(".profile");
    expect(remoteScript).toContain(".bash_profile");
    expect(remoteScript).toContain(".zprofile");
    // Fall back to .bashrc when no .bash_profile exists, so a host that adds
    // nvm in .bashrc still resolves node under a non-login SSH command.
    expect(remoteScript).toContain(".bashrc");
    // The last ssh argument wraps the script as `sh -c '...'`, so the inner
    // quotes are escaped. Assert the command still runs: cd, env, and the argv.
    expect(remoteScript).toContain("cd ");
    expect(remoteScript).toContain("/srv/paperclip/workspace");
    expect(remoteScript).toContain("exec env ");
    expect(remoteScript).toContain("node");
    expect(remoteScript).toContain("--version");
    await target.cleanup();
  });

  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("syncs a local directory into the remote fixture workspace", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "message.txt"), "hello from paperclip\n", "utf8");
    await writeFile(path.join(localDir, "._message.txt"), "should never sync\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(path.posix.join(remoteDir, "message.txt"))} && if [ -e ${JSON.stringify(path.posix.join(remoteDir, "._message.txt"))} ]; then echo appledouble-present; fi`,
    );

    expect(result.stdout).toContain("hello from paperclip");
    expect(result.stdout).not.toContain("appledouble-present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports throttled upload progress with a clamped percent and terminal 100% line", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    // Multiple files large enough that tar emits several pipe chunks, so the
    // byte counter crosses several step boundaries before the stream closes.
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH upload progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-progress");

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryToSsh({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir,
      remoteDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Syncing workspace to ssh");
    }
    // Monotonically increasing byte counts.
    const doneSeries = lines.map((line) => line.doneMb ?? 0);
    for (let index = 1; index < doneSeries.length; index += 1) {
      expect(doneSeries[index]!).toBeGreaterThanOrEqual(doneSeries[index - 1]!);
    }
    // Percent clamped to <= 99% on every line emitted before the stream closed.
    for (const line of lines.slice(0, -1)) {
      if (line.percent != null) expect(line.percent).toBeLessThanOrEqual(99);
    }
    // Terminal completion line is 100% with matching done/total.
    const last = lines.at(-1)!;
    expect(last.percent).toBe(100);
    expect(last.doneMb).toBe(last.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports restore progress with a terminal completion line", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");
    const restoreDir = path.join(rootDir, "restore-target");

    await mkdir(localDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH restore progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const remoteDir = path.posix.join(started.workspaceDir, "restore-source");

    await syncDirectoryToSsh({ spec, localDir, remoteDir });

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryFromSsh({
      spec,
      remoteDir,
      localDir: restoreDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Restoring workspace from ssh");
    }
    // Terminal completion line: either an exact 100% (probe succeeded) or a
    // final MB-received line (probe unavailable). Either is a valid terminal.
    const last = lines.at(-1)!;
    expect(last.percent === 100 || (last.percent === null && last.doneMb !== null)).toBe(true);
    // The restored files round-tripped through the byte-counting transport.
    await expect(readFile(path.join(restoreDir, "blob-0.bin"))).resolves.toEqual(
      Buffer.alloc(256 * 1024, 1),
    );
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports exact git-history import percentage from the known bundle size", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.bin"), Buffer.alloc(256 * 1024, 7));
    await git(localRepo, ["add", "tracked.bin"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH git import progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const lines: ParsedProgressLine[] = [];
    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
    });

    const importLines = lines.filter((line) => line.raw.includes("Importing git history to ssh"));
    expect(importLines.length).toBeGreaterThan(0);
    // Known bundle size -> exact percentage with no "workspace" label.
    for (const line of importLines) {
      expect(line.raw).not.toContain("workspace");
      expect(line.percent).not.toBeNull();
    }
    const lastImport = importLines.at(-1)!;
    expect(lastImport.percent).toBe(100);
    expect(lastImport.doneMb).toBe(lastImport.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("can dereference local symlinks while syncing to the remote fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(sourceDir, "auth.json"), "{\"token\":\"secret\"}\n", "utf8");
    await symlink(path.join(sourceDir, "auth.json"), path.join(localDir, "auth.json"));

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH symlink sync test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-follow-links");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
      followSymlinks: true,
    });

    const result = await runSshCommand(
      config,
      `if [ -L ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))} ]; then echo symlink; else echo regular; fi && cat ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))}`,
    );

    expect(result.stdout).toContain("regular");
    expect(result.stdout).toContain("{\"token\":\"secret\"}");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("clears stale files when plain SSH preparation is retried", async () => {
    const rootDir = await createFixtureRootDir();
    const localDir = path.join(rootDir, "plain-local");
    await mkdir(path.join(localDir, "node_modules"), { recursive: true });
    await git(localDir, ["init"]);
    await writeFile(path.join(localDir, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(localDir, "removed.txt"), "remove on retry");
    const binary = Buffer.from([0, 255, 1]);
    await writeFile(path.join(localDir, "node_modules", "personal.bin"), binary);
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH plain retry");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const input = { spec: { ...config, remoteCwd: started.workspaceDir }, localDir,
      remoteDir: started.workspaceDir, workspaceFileMode: "all" as const };
    expect(await prepareWorkspaceForSshExecution(input)).toEqual({ gitBacked: false });
    expect(await readFile(path.join(started.workspaceDir, "node_modules", "personal.bin"))).toEqual(binary);
    await rm(path.join(localDir, "removed.txt"));
    await prepareWorkspaceForSshExecution(input);
    await expect(stat(path.join(started.workspaceDir, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(started.workspaceDir, "node_modules", "personal.bin"))).toEqual(binary);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips a git workspace through the SSH fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(localRepo, "._tracked.txt"), "should stay local only\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    const originalHead = await git(localRepo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH workspace round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const remoteStatus = await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git status --short`,
    );
    expect(remoteStatus.stdout).toContain("M tracked.txt");
    expect(remoteStatus.stdout).toContain("?? untracked.txt");
    expect(remoteStatus.stdout).not.toContain("._tracked.txt");

    await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && git add tracked.txt untracked.txt && git commit -m "remote update" >/dev/null && printf "remote dirty\\n" > tracked.txt && printf "remote extra\\n" > remote-only.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const restoredHead = await git(localRepo, ["rev-parse", "HEAD"]);
    expect(restoredHead).not.toBe(originalHead);
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    expect(await git(localRepo, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(localRepo, ["status", "--short"])).not.toContain("._tracked.txt");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves both concurrent SSH restores in a shared git workspace", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    expect(preparedA.workspaceRemoteDir).not.toBe(preparedB.workspaceRemoteDir);

    await runSshCommand(
      config,
      `printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "run-a.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "run-b.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves nested per-run files across sequential SSH restores with stale baselines", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "sequential nested SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/claude_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/codex_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await preparedA.restoreWorkspace();
    await preparedB.restoreWorkspace();

    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/claude_local.md"), "utf8")).resolves
      .toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/codex_local.md"), "utf8")).resolves
      .toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips remote git commits through the managed runtime restore path", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "managed-runtime SSH git round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "committed\\n" > tracked.txt && git add tracked.txt && git commit -m "remote update" >/dev/null && printf "dirty remote\\n" > tracked.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    await expect(readFile(path.join(localRepo, "tracked.txt"), "utf8")).resolves.toBe("dirty remote\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("propagates remote commits to the local worktree with no git remote configured (no-remote-git contract)", async () => {
    // Locks in the architectural contract documented in
    // packages/adapter-utils/README.md and packages/adapters/AUTHORING.md:
    // the local execution-workspace cwd is the only persistence boundary
    // across runs. No adapter may depend on a git remote for cross-run state.
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    // Assert there is no git remote configured before we begin, and verify
    // that no point in the round-trip introduces one. `git remote` returns an
    // empty string when no remotes exist (and exit code 0).
    expect(await git(localRepo, ["remote"])).toBe("");

    const started = await startSshEnvLabFixtureOrSkip(
      statePath,
      "no-remote-git contract test",
    );
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-no-remote",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    // Remote commit lands a deliverable that must show up locally via
    // sync-back alone — no `git push`, no fetch from any origin.
    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "deliverable\\n" > tracked.txt && git add tracked.txt && git commit -m "remote-only commit" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe(
      "remote-only commit",
    );
    expect(await readFile(path.join(localRepo, "tracked.txt"), "utf8")).toBe(
      "deliverable\n",
    );
    // Final assertion: still no git remote — restore did not silently add one.
    expect(await git(localRepo, ["remote"])).toBe("");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("merges concurrent remote commits through the managed runtime restore path", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent managed-runtime SSH git merge test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedA.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run a\\n" > run-a.txt && git add run-a.txt && git commit -m "remote update a" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedB.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run b\\n" > run-b.txt && git add run-b.txt && git commit -m "remote update b" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toContain("Paperclip SSH sync merge");

    const recentSubjects = await git(localRepo, ["log", "--pretty=%s", "-3"]);
    expect(recentSubjects).toContain("remote update a");
    expect(recentSubjects).toContain("remote update b");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("keeps remote dependency trees out of the managed-runtime SSH sync-back without touching host copies", async () => {
    // Spaces in the local and remote (run id) paths exercise shell quoting;
    // the archive's `./` member prefix exercises tar's pattern match. TMPDIR
    // stays space-free: ssh splits its UserKnownHostsFile option on spaces.
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local workspace");
    const stagingTmp = path.join(rootDir, "tmp");

    await mkdir(stagingTmp, { recursive: true });
    await initGitRepo(localRepo);
    await writeFile(path.join(localRepo, ".gitignore"), "node_modules/\n.turbo/\n", "utf8");
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", ".gitignore", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    // A host-side install that predates the run.
    await mkdir(path.join(localRepo, "node_modules", "host-dep"), { recursive: true });
    await writeFile(path.join(localRepo, "node_modules", "host-dep", "index.js"), "host\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "managed-runtime SSH dependency exclusion test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run deps",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    expect(prepared.workspaceRemoteDir).toContain("run deps");

    // The run reinstalls dependencies, builds, and edits source remotely.
    await runSshCommand(
      config,
      [
        `cd ${JSON.stringify(prepared.workspaceRemoteDir)}`,
        "rm -rf node_modules/host-dep",
        "mkdir -p node_modules/.pnpm/remote-dep/node_modules/remote-dep packages/app/node_modules/nested .turbo dist",
        "mkdir -p 'pkg with space/node_modules/dep' 'pkg with space/src'",
        "printf dep > 'pkg with space/node_modules/dep/index.js'",
        "printf 'spaced\\n' > 'pkg with space/src/a b.ts'",
        "printf remote > node_modules/.pnpm/remote-dep/node_modules/remote-dep/index.js",
        // An unreadable file makes the remote tar fail if it ever archives
        // node_modules, so a pass proves the tree is excluded at the source
        // rather than transferred and filtered on the host. (Vacuous as root.)
        "printf locked > node_modules/.pnpm/remote-dep/locked.bin",
        "chmod 000 node_modules/.pnpm/remote-dep/locked.bin",
        "printf nested > packages/app/node_modules/nested/index.js",
        "printf cache > .turbo/run.log",
        "printf built > dist/index.js",
        "printf 'remote\\n' > tracked.txt",
        "printf 'new\\n' > packages/app/main.ts",
      ].join(" && "),
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    const progressLines: string[] = [];
    await withTmpdir(stagingTmp, () => prepared.restoreWorkspace((line) => {
      progressLines.push(line);
    }));

    // Source edits and build output (which a repository may track) come back.
    await expect(readFile(path.join(localRepo, "tracked.txt"), "utf8")).resolves.toBe("remote\n");
    await expect(readFile(path.join(localRepo, "packages/app/main.ts"), "utf8")).resolves.toBe("new\n");
    await expect(readFile(path.join(localRepo, "dist/index.js"), "utf8")).resolves.toBe("built");
    await expect(readFile(path.join(localRepo, "pkg with space/src/a b.ts"), "utf8")).resolves.toBe("spaced\n");
    // Remote dependency and cache trees stay on the remote...
    await expect(stat(path.join(localRepo, "pkg with space/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(localRepo, "node_modules/.pnpm"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(localRepo, "packages/app/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(localRepo, ".turbo"))).rejects.toMatchObject({ code: "ENOENT" });
    // ...and the host's own install is neither deleted nor replaced.
    await expect(readFile(path.join(localRepo, "node_modules/host-dep/index.js"), "utf8")).resolves.toBe("host\n");
    expect(progressLines.some((line) => line.includes("Restoring workspace from ssh"))).toBe(true);
    expect(await listSyncBackStagingDirs(stagingTmp)).toEqual([]);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("restores relative symlinks verbatim through the managed-runtime SSH sync-back", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");
    const stagingTmp = path.join(rootDir, "tmp");

    await mkdir(stagingTmp, { recursive: true });
    await initGitRepo(localRepo);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await symlink("tracked.txt", path.join(localRepo, "alias.txt"));
    await git(localRepo, ["add", "tracked.txt", "alias.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "managed-runtime SSH symlink restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-symlinks",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && ln -s tracked.txt remote-alias.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await withTmpdir(stagingTmp, () => prepared.restoreWorkspace());

    // Staging paths must never leak into the persistent workspace as targets.
    expect(await readlink(path.join(localRepo, "alias.txt"))).toBe("tracked.txt");
    expect(await readlink(path.join(localRepo, "remote-alias.txt"))).toBe("tracked.txt");
    await expect(readFile(path.join(localRepo, "remote-alias.txt"), "utf8")).resolves.toBe("base\n");
    expect(await git(localRepo, ["status", "--short", "--", "alias.txt"])).toBe("");
    expect(await listSyncBackStagingDirs(stagingTmp)).toEqual([]);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("keeps relative symlinks relative when restoring a directory in place", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-source");
    const restoreDir = path.join(rootDir, "restore-target");
    const stagingTmp = path.join(rootDir, "tmp");

    await mkdir(localDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    await mkdir(stagingTmp, { recursive: true });
    await writeFile(path.join(localDir, "target.txt"), "target\n", "utf8");
    await symlink("target.txt", path.join(localDir, "link.txt"));

    const started = await startSshEnvLabFixtureOrSkip(statePath, "in-place SSH symlink restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const remoteDir = path.posix.join(started.workspaceDir, "symlink-source");

    await syncDirectoryToSsh({ spec, localDir, remoteDir });
    await withTmpdir(stagingTmp, () => syncDirectoryFromSsh({ spec, remoteDir, localDir: restoreDir }));

    expect(await readlink(path.join(restoreDir, "link.txt"))).toBe("target.txt");
    await expect(readFile(path.join(restoreDir, "link.txt"), "utf8")).resolves.toBe("target\n");
    expect(await listSyncBackStagingDirs(stagingTmp)).toEqual([]);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { failure: "a missing remote workspace", mode: "pass" as const, removeRemote: true },
    { failure: "a dropped connection mid-archive", mode: "truncate" as const, removeRemote: false },
    { failure: "a full disk during extract", mode: "enospc" as const, removeRemote: false },
  ])("stages one copy, then removes it and keeps the host workspace after $failure", async ({ mode, removeRemote }) => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-workspace");
    const stagingTmp = path.join(rootDir, "tmp");

    await mkdir(localDir, { recursive: true });
    await mkdir(stagingTmp, { recursive: true });
    await writeFile(path.join(localDir, "keep.txt"), "host\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH sync-back failure cleanup test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: `run-restore-failure-${mode}`,
      adapterKey: "test-adapter",
      workspaceLocalDir: localDir,
    });
    // Remote edits that a broken transfer must not half-apply. The large file
    // keeps the archive well past the shims' 16 KiB cut.
    await runSshCommand(
      config,
      removeRemote
        ? `rm -rf ${JSON.stringify(prepared.workspaceRemoteDir)}`
        : `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && printf 'remote\\n' > keep.txt && head -c 262144 /dev/urandom > big.bin`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    const { outcome, stagingCounts } = await withTransferShims(rootDir, mode, () =>
      withTmpdir(stagingTmp, () => prepared.restoreWorkspace()));

    expect(outcome.status).toBe("rejected");
    // One staging copy of the remote tree at a time, removed afterwards.
    expect(stagingCounts).toEqual([1]);
    expect(await listSyncBackStagingDirs(stagingTmp)).toEqual([]);
    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("host\n");
    await expect(stat(path.join(localDir, "big.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("leaves the target untouched when an in-place SSH restore loses its connection", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-source");
    const restoreDir = path.join(rootDir, "restore-target");
    const stagingTmp = path.join(rootDir, "tmp");

    await mkdir(localDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    await mkdir(stagingTmp, { recursive: true });
    await writeFile(path.join(localDir, "big.bin"), Buffer.alloc(256 * 1024, 7));
    await writeFile(path.join(restoreDir, "keep.txt"), "host\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "in-place SSH restore disconnect test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const remoteDir = path.posix.join(started.workspaceDir, "disconnect-source");
    await syncDirectoryToSsh({ spec, localDir, remoteDir });

    const { outcome } = await withTransferShims(rootDir, "truncate", () =>
      withTmpdir(stagingTmp, () => syncDirectoryFromSsh({ spec, remoteDir, localDir: restoreDir })));

    expect(outcome.status).toBe("rejected");
    expect(await readdir(restoreDir)).toEqual(["keep.txt"]);
    expect(await listSyncBackStagingDirs(stagingTmp)).toEqual([]);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("syncs remote edits under a dependency name that the Git workspace tracks", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await initGitRepo(localRepo);
    await mkdir(path.join(localRepo, "action", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(localRepo, "action", "node_modules", "dep", "index.js"), "v1\n", "utf8");
    await git(localRepo, ["add", "action/node_modules/dep/index.js"]);
    await git(localRepo, ["commit", "-m", "vendor dep"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "tracked dependency name SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-tracked-deps",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    await runSshCommand(
      config,
      [
        `cd ${JSON.stringify(prepared.workspaceRemoteDir)}`,
        'git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev"',
        "printf 'v2\\n' > action/node_modules/dep/index.js",
        "git add action/node_modules/dep/index.js && git commit -m 'bump vendored dep' >/dev/null",
        "mkdir -p .turbo && printf cache > .turbo/run.log",
      ].join(" && "),
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    // The tracked name keeps syncing, so HEAD and the working tree agree.
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("bump vendored dep");
    await expect(readFile(path.join(localRepo, "action/node_modules/dep/index.js"), "utf8")).resolves.toBe("v2\n");
    expect(await git(localRepo, ["diff", "HEAD", "--name-only"])).toBe("");
    // Untracked names are still excluded.
    await expect(stat(path.join(localRepo, ".turbo"))).rejects.toMatchObject({ code: "ENOENT" });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("copies dependency-named trees exactly in all-files mode", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "plain-directory");

    await mkdir(path.join(localDir, "node_modules"), { recursive: true });
    await mkdir(path.join(localDir, ".cache"), { recursive: true });
    await writeFile(path.join(localDir, "node_modules", "kept.js"), "host\n", "utf8");
    await writeFile(path.join(localDir, ".cache", "state.json"), "v1\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "all-files SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-all-files",
      adapterKey: "test-adapter",
      workspaceLocalDir: localDir,
      workspaceFileMode: "all",
    });
    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && test -f node_modules/kept.js && printf 'v2\\n' > .cache/state.json && printf remote > node_modules/new.js`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localDir, ".cache/state.json"), "utf8")).resolves.toBe("v2\n");
    await expect(readFile(path.join(localDir, "node_modules/new.js"), "utf8")).resolves.toBe("remote");
    await expect(readFile(path.join(localDir, "node_modules/kept.js"), "utf8")).resolves.toBe("host\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);
});

// Every SSH run syncs into `<remoteCwd>/.paperclip-runtime/runs/<runId>`, and
// nothing removed it: 519 finished runs filled a worker disk on 2026-10-08.
// The lease release now deletes it, but only once the sync-back left its
// restored marker, and only through real directories below the root.
describe("SSH run directory cleanup", () => {
  afterEach(drainFixtureTeardowns);
  afterAll(drainFixtureTeardowns);

  async function startRun(label: string) {
    const rootDir = await createFixtureRootDir();
    const localDir = path.join(rootDir, "local-workspace");
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "big.bin"), Buffer.alloc(256 * 1024, 7));
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), label);
    if (!started) return null;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const runId = randomUUID();
    const prepared = await prepareRemoteManagedRuntime({ spec, runId, adapterKey: "test-adapter", workspaceLocalDir: localDir });
    const runDir = sshRunDirectory(started.workspaceDir, runId);
    return { rootDir, localDir, spec, runId, runDir, prepared };
  }

  it("removes a run directory once its sync-back finished", async () => {
    const run = await startRun("SSH run directory removal test");
    if (!run) return;
    expect(run.prepared.workspaceRemoteDir).toBe(path.posix.join(run.runDir, "workspace"));
    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("not_restored");

    await run.prepared.restoreWorkspace();
    await expect(stat(path.join(run.runDir, SSH_RUN_RESTORED_MARKER))).resolves.toBeTruthy();

    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("removed");
    await expect(stat(run.runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("absent");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("keeps the run directory when the sync-back fails, even after an earlier restore", async () => {
    const run = await startRun("SSH run directory failed restore test");
    if (!run) return;
    await run.prepared.restoreWorkspace();
    await writeFile(path.join(run.runDir, "workspace", "unsynced.txt"), "agent work\n");

    const { outcome } = await withTransferShims(run.rootDir, "enospc", () => run.prepared.restoreWorkspace());

    expect(outcome.status).toBe("rejected");
    await expect(stat(path.join(run.runDir, SSH_RUN_RESTORED_MARKER))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("not_restored");
    await expect(readFile(path.join(run.runDir, "workspace", "unsynced.txt"), "utf8")).resolves.toBe("agent work\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it.each(["runs", "run"])("never follows a symlinked %s directory out of the runtime root", async (linked) => {
    const run = await startRun(`SSH run directory symlink test (${linked})`);
    if (!run) return;
    await run.prepared.restoreWorkspace();
    // Move the real tree outside the root and leave a link in its place.
    const outside = path.join(run.rootDir, "outside");
    const linkPath = linked === "runs" ? path.dirname(run.runDir) : run.runDir;
    await rename(linkPath, outside);
    await symlink(outside, linkPath);

    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("symlink");
    expect((await readdir(outside)).length).toBeGreaterThan(0);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("removes read-only trees and never follows a symlink inside the run directory", async () => {
    const run = await startRun("SSH run directory contents test");
    if (!run) return;
    await run.prepared.restoreWorkspace();
    const outside = path.join(run.rootDir, "outside-target");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "outside\n");
    await symlink(outside, path.join(run.runDir, "workspace", "escape"));
    const readOnly = path.join(run.runDir, "workspace", "modcache");
    await mkdir(path.join(readOnly, "sealed"), { recursive: true });
    await writeFile(path.join(readOnly, "locked.txt"), "x");
    await writeFile(path.join(readOnly, "sealed", "inner.txt"), "x");
    await chmod(path.join(readOnly, "sealed"), 0o000);
    await chmod(readOnly, 0o555);

    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("removed");
    await expect(stat(run.runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(outside, "keep.txt"), "utf8")).resolves.toBe("outside\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("keeps the marker when the run directory itself cannot be removed, so a retry works", async () => {
    const run = await startRun("SSH run directory retry test");
    if (!run) return;
    await run.prepared.restoreWorkspace();
    const runsDir = path.dirname(run.runDir);
    await chmod(runsDir, 0o555);
    try {
      await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
        .resolves.toBe("rm_failed");
      await expect(stat(path.join(run.runDir, SSH_RUN_RESTORED_MARKER))).resolves.toBeTruthy();
    } finally {
      await chmod(runsDir, 0o755);
    }
    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("removed");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not accept a symlinked marker", async () => {
    const run = await startRun("SSH run directory symlinked marker test");
    if (!run) return;
    const elsewhere = path.join(run.rootDir, "fake-marker");
    await writeFile(elsewhere, "");
    await symlink(elsewhere, path.join(run.runDir, SSH_RUN_RESTORED_MARKER));

    await expect(removeRestoredSshRunDirectory({ spec: run.spec, remoteRoot: run.spec.remoteCwd, runId: run.runId }))
      .resolves.toBe("not_restored");
    await expect(stat(path.join(run.runDir, "workspace"))).resolves.toBeTruthy();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("marks a run directory removable when preparation fails before any agent ran", async () => {
    // The failure comes from an unreadable file, which root can still read.
    if (process.getuid?.() === 0) return;
    const rootDir = await createFixtureRootDir();
    const localDir = path.join(rootDir, "local-workspace");
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "ok.txt"), "ok\n");
    // An unreadable file makes the local tar of the upload fail.
    await writeFile(path.join(localDir, "unreadable.txt"), "secret\n");
    await chmod(path.join(localDir, "unreadable.txt"), 0o000);
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH run directory failed prepare test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const runId = randomUUID();
    const runDir = sshRunDirectory(started.workspaceDir, runId);

    await expect(prepareRemoteManagedRuntime({ spec, runId, adapterKey: "test-adapter", workspaceLocalDir: localDir }))
      .rejects.toThrow();

    await expect(stat(path.join(runDir, SSH_RUN_RESTORED_MARKER))).resolves.toBeTruthy();
    await expect(removeRestoredSshRunDirectory({ spec, remoteRoot: spec.remoteCwd, runId })).resolves.toBe("removed");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("refuses run ids that are not UUIDs and roots that are not normalized absolute paths", async () => {
    const spec = {
      host: "ssh.invalid", port: 22, username: "paperclip", remoteWorkspacePath: "/srv/w",
      privateKey: null, knownHosts: null, strictHostKeyChecking: false,
    };
    for (const runId of ["../../etc", "run-commit", "", `${randomUUID()}/..`]) {
      await expect(removeRestoredSshRunDirectory({ spec, remoteRoot: "/srv/w", runId })).rejects.toThrow("not a UUID");
    }
    for (const remoteRoot of ["", "/", "srv/w", "/srv/../etc", "/srv/w/", "/srv//w"]) {
      await expect(removeRestoredSshRunDirectory({ spec, remoteRoot, runId: randomUUID() })).rejects.toThrow("normalized absolute path");
    }
  });
});

describe("SSH run directory reaper", () => {
  afterEach(drainFixtureTeardowns);
  afterAll(drainFixtureTeardowns);

  async function startHost(label: string) {
    const rootDir = await createFixtureRootDir();
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), label);
    if (!started) return null;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const root = started.workspaceDir;
    const reap = (runId: string) => reapSshRunDirectory({ spec, remoteRoot: root, runId });
    const preservedBundle = (runId: string) => path.join(root, ".paperclip-runtime", "preserved", `${runId}.bundle`);
    // A run's workspace the way an SSH run leaves it: a git repository in runs/<id>/workspace.
    async function gitRun(options: { restored?: boolean } = {}) {
      const runId = randomUUID();
      const runDir = sshRunDirectory(root, runId);
      const workspace = path.join(runDir, "workspace");
      await mkdir(workspace, { recursive: true });
      await git(workspace, ["init", "-q", "-b", "main"]);
      await git(workspace, ["config", "user.name", "Paperclip Test"]);
      await git(workspace, ["config", "user.email", "test@paperclip.dev"]);
      await writeFile(path.join(workspace, "tracked.txt"), "base\n");
      await git(workspace, ["add", "tracked.txt"]);
      await git(workspace, ["commit", "-q", "-m", "base"]);
      await writeFile(path.join(runDir, "ballast.bin"), Buffer.alloc(300 * 1024, 1));
      if (options.restored) await writeFile(path.join(runDir, SSH_RUN_RESTORED_MARKER), "");
      return { runId, runDir, workspace };
    }
    // A clone of the project as the host already has it, to prove a preserved ref is usable.
    async function hostClone(workspace: string) {
      const clone = path.join(rootDir, `host-${randomUUID()}`);
      await git(rootDir, ["clone", "-q", workspace, clone]);
      return clone;
    }
    return { rootDir, root, spec, reap, preservedBundle, gitRun, hostClone };
  }

  it("removes a restored run directory and reports the bytes it freed", async () => {
    const host = await startHost("SSH reaper restored test");
    if (!host) return;
    const run = await host.gitRun({ restored: true });
    await git(run.workspace, ["branch", "feature"]);

    const result = await host.reap(run.runId);

    expect(result).toMatchObject({ outcome: "removed", preserved: [] });
    expect(result.outcome === "removed" && result.bytesFreed).toBeGreaterThan(300 * 1024);
    await expect(stat(run.runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(host.reap(run.runId)).resolves.toMatchObject({ outcome: "absent" });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("removes a failed run's directory without a marker when it holds no local-only git state", async () => {
    const host = await startHost("SSH reaper clean git test");
    if (!host) return;
    const run = await host.gitRun();
    await git(run.workspace, ["branch", "merged-already"]);

    await expect(host.reap(run.runId)).resolves.toMatchObject({ outcome: "removed", preserved: [] });

    await expect(stat(run.runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.dirname(host.preservedBundle(run.runId)))).rejects.toMatchObject({ code: "ENOENT" });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves a branch tip outside HEAD under refs/paperclip/preserved before it deletes", async () => {
    const host = await startHost("SSH reaper branch test");
    if (!host) return;
    const run = await host.gitRun();
    const clone = await host.hostClone(run.workspace);
    await git(run.workspace, ["checkout", "-q", "-b", "agent/feature"]);
    await writeFile(path.join(run.workspace, "feature.txt"), "agent commit\n");
    await git(run.workspace, ["add", "feature.txt"]);
    await git(run.workspace, ["commit", "-q", "-m", "agent work"]);
    const tip = await git(run.workspace, ["rev-parse", "HEAD"]);
    await git(run.workspace, ["checkout", "-q", "main"]);

    const result = await host.reap(run.runId);

    expect(result).toMatchObject({ outcome: "removed", preserved: [`refs/paperclip/preserved/${run.runId}/agent/feature`] });
    await expect(stat(run.runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await git(clone, ["fetch", "-q", host.preservedBundle(run.runId), `refs/paperclip/preserved/${run.runId}/agent/feature:refs/paperclip/preserved/${run.runId}/agent/feature`]);
    expect(await git(clone, ["rev-parse", `refs/paperclip/preserved/${run.runId}/agent/feature`])).toBe(tip);
    expect(await git(clone, ["show", `${tip}:feature.txt`])).toBe("agent commit");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves commits made on HEAD since the run started, which a failed sync-back never brought home", async () => {
    const host = await startHost("SSH reaper head commit test");
    if (!host) return;
    const run = await host.gitRun();
    const clone = await host.hostClone(run.workspace);
    await writeFile(path.join(run.workspace, "agent.txt"), "agent commit on main\n");
    await git(run.workspace, ["add", "agent.txt"]);
    await git(run.workspace, ["commit", "-q", "-m", "agent work on HEAD"]);
    const tip = await git(run.workspace, ["rev-parse", "HEAD"]);

    const result = await host.reap(run.runId);

    expect(result).toMatchObject({ outcome: "removed", preserved: [`refs/paperclip/preserved/${run.runId}/head`] });
    await git(clone, ["fetch", "-q", host.preservedBundle(run.runId), `refs/paperclip/preserved/${run.runId}/head:refs/paperclip/preserved/${run.runId}/head`]);
    expect(await git(clone, ["rev-parse", `refs/paperclip/preserved/${run.runId}/head`])).toBe(tip);
    expect(await git(clone, ["show", `${tip}:agent.txt`])).toBe("agent commit on main");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves stash entries and uncommitted work", async () => {
    const host = await startHost("SSH reaper stash test");
    if (!host) return;
    const run = await host.gitRun();
    const clone = await host.hostClone(run.workspace);
    await writeFile(path.join(run.workspace, "tracked.txt"), "stashed edit\n");
    await git(run.workspace, ["stash", "push", "-q", "-m", "parked"]);
    await writeFile(path.join(run.workspace, "tracked.txt"), "unsaved edit\n");
    await writeFile(path.join(run.workspace, "new-file.txt"), "never committed\n");
    await writeFile(path.join(run.workspace, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(run.workspace, "ignored.log"), "noise\n");

    const result = await host.reap(run.runId);

    expect(result.outcome).toBe("removed");
    const refs = result.outcome === "removed" ? result.preserved : [];
    expect(refs).toEqual(expect.arrayContaining([`refs/paperclip/preserved/${run.runId}/stash-0`, `refs/paperclip/preserved/${run.runId}/worktree`]));
    for (const ref of refs) await git(clone, ["fetch", "-q", host.preservedBundle(run.runId), `${ref}:${ref}`]);
    expect(await git(clone, ["show", `refs/paperclip/preserved/${run.runId}/stash-0:tracked.txt`])).toBe("stashed edit");
    expect(await git(clone, ["show", `refs/paperclip/preserved/${run.runId}/worktree:tracked.txt`])).toBe("unsaved edit");
    expect(await git(clone, ["show", `refs/paperclip/preserved/${run.runId}/worktree:new-file.txt`])).toBe("never committed");
    await expect(git(clone, ["show", `refs/paperclip/preserved/${run.runId}/worktree:ignored.log`])).rejects.toThrow();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves the branch of a clean extra worktree and keeps the directory when an extra worktree has uncommitted work", async () => {
    const host = await startHost("SSH reaper worktree test");
    if (!host) return;
    const clean = await host.gitRun();
    const cleanTree = path.join(clean.runDir, "extra-tree");
    await git(clean.workspace, ["worktree", "add", "-q", "-b", "side-branch", cleanTree]);
    await writeFile(path.join(cleanTree, "side.txt"), "side\n");
    await git(cleanTree, ["add", "side.txt"]);
    await git(cleanTree, ["commit", "-q", "-m", "side work"]);
    const dirty = await host.gitRun();
    const dirtyTree = path.join(dirty.runDir, "extra-tree");
    await git(dirty.workspace, ["worktree", "add", "-q", "-b", "wip-branch", dirtyTree]);
    await writeFile(path.join(dirtyTree, "uncommitted.txt"), "wip\n");

    await expect(host.reap(clean.runId)).resolves.toMatchObject({
      outcome: "removed", preserved: [`refs/paperclip/preserved/${clean.runId}/side-branch`],
    });
    await expect(host.reap(dirty.runId)).resolves.toMatchObject({ outcome: "kept", reason: "worktree_dirty" });

    await expect(stat(clean.runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(dirtyTree, "uncommitted.txt"), "utf8")).resolves.toBe("wip\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("keeps an unrestored run directory that is not a git repository", async () => {
    const host = await startHost("SSH reaper plain directory test");
    if (!host) return;
    const runId = randomUUID();
    const runDir = sshRunDirectory(host.root, runId);
    await mkdir(path.join(runDir, "workspace"), { recursive: true });
    await writeFile(path.join(runDir, "workspace", "work.txt"), "only copy\n");

    await expect(host.reap(runId)).resolves.toMatchObject({ outcome: "kept", reason: "not_git_backed" });

    await expect(readFile(path.join(runDir, "workspace", "work.txt"), "utf8")).resolves.toBe("only copy\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("keeps the directory when the preserved state cannot be written", async () => {
    const host = await startHost("SSH reaper preserve failure test");
    if (!host) return;
    const run = await host.gitRun();
    await git(run.workspace, ["checkout", "-q", "-b", "agent/work"]);
    await writeFile(path.join(run.workspace, "work.txt"), "work\n");
    await git(run.workspace, ["add", "work.txt"]);
    await git(run.workspace, ["commit", "-q", "-m", "work"]);
    await git(run.workspace, ["checkout", "-q", "main"]);
    // A file where the preserved directory must go.
    await mkdir(path.join(host.root, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(host.root, ".paperclip-runtime", "preserved"), "in the way");

    await expect(host.reap(run.runId)).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });

    expect(await git(run.workspace, ["rev-parse", "agent/work"])).toMatch(/^[0-9a-f]{40}$/);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not run commands from a repository config the agent planted", async () => {
    const host = await startHost("SSH reaper hostile config test");
    if (!host) return;
    const run = await host.gitRun();
    const canary = path.join(host.rootDir, "canary");
    await git(run.workspace, ["config", "core.fsmonitor", `touch ${canary}; echo`]);
    await writeFile(path.join(run.workspace, "dirty.txt"), "x\n");

    await host.reap(run.runId);

    await expect(stat(canary)).rejects.toMatchObject({ code: "ENOENT" });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("touches nothing outside runs/<runId>, and never follows a symlinked .git or directory", async () => {
    const host = await startHost("SSH reaper scope test");
    if (!host) return;
    const reaped = await host.gitRun({ restored: true });
    const sibling = await host.gitRun();
    await writeFile(path.join(host.root, "project-file.txt"), "shared\n");
    await mkdir(path.join(host.root, ".paperclip-runtime", "other"), { recursive: true });
    await writeFile(path.join(host.root, ".paperclip-runtime", "other", "keep.txt"), "keep\n");
    const outside = path.join(host.rootDir, "outside-repo");
    await mkdir(outside, { recursive: true });
    await git(outside, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(outside, "file.txt"), "outside\n");
    const linked = await host.gitRun();
    await rm(path.join(linked.workspace, ".git"), { recursive: true });
    await symlink(path.join(outside, ".git"), path.join(linked.workspace, ".git"));
    const linkedRun = await host.gitRun({ restored: true });
    const moved = path.join(host.rootDir, "moved-run");
    await rename(linkedRun.runDir, moved);
    await symlink(moved, linkedRun.runDir);

    await expect(host.reap(reaped.runId)).resolves.toMatchObject({ outcome: "removed" });
    await expect(host.reap(linked.runId)).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });
    await expect(host.reap(linkedRun.runId)).resolves.toMatchObject({ outcome: "symlink" });

    await expect(stat(sibling.runDir)).resolves.toBeTruthy();
    await expect(readFile(path.join(host.root, "project-file.txt"), "utf8")).resolves.toBe("shared\n");
    await expect(readFile(path.join(host.root, ".paperclip-runtime", "other", "keep.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(readFile(path.join(outside, "file.txt"), "utf8")).resolves.toBe("outside\n");
    expect(await readdir(path.join(outside, ".git", "refs"))).not.toContain("paperclip");
    await expect(readdir(moved)).resolves.toContain("workspace");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("refuses run ids that are not UUIDs", async () => {
    const spec = { host: "ssh.invalid", port: 22, username: "paperclip", remoteWorkspacePath: "/srv/w", remoteCwd: "/srv/w", privateKey: "x", knownHosts: "x", strictHostKeyChecking: true } as never;
    await expect(reapSshRunDirectory({ spec, remoteRoot: "/srv/w", runId: "../../etc" })).rejects.toThrow(/not a UUID/);
  });

  it("reads the worker's disk usage as a percentage", async () => {
    const host = await startHost("SSH reaper disk usage test");
    if (!host) return;

    const percent = await readSshDiskUsagePercent({ spec: host.spec, remoteRoot: host.root });

    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThanOrEqual(100);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);
});

describe("SSH run directory reaper path swaps", () => {
  afterEach(drainFixtureTeardowns);
  afterAll(drainFixtureTeardowns);

  // A host with a restored run directory, and a decoy `runs` directory elsewhere
  // that holds a same-named run directory with its own restored marker.
  async function swapSetup(label: string) {
    const rootDir = await createFixtureRootDir();
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), label);
    if (!started) return null;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const root = started.workspaceDir;
    const runId = randomUUID();
    const runDir = sshRunDirectory(root, runId);
    await mkdir(path.join(runDir, "workspace"), { recursive: true });
    await writeFile(path.join(runDir, "workspace", "own.txt"), "own\n");
    await writeFile(path.join(runDir, SSH_RUN_RESTORED_MARKER), "");
    const runsDir = path.dirname(runDir);
    const decoyRuns = path.join(rootDir, "decoy-runs");
    await mkdir(path.join(decoyRuns, runId), { recursive: true });
    await writeFile(path.join(decoyRuns, runId, "victim.txt"), "must survive\n");
    await writeFile(path.join(decoyRuns, runId, SSH_RUN_RESTORED_MARKER), "");
    const canary = path.join(rootDir, "hook-ran");
    // Move the real `runs` aside and put a link to the decoy in its place.
    const swap = `mv '${runsDir}' '${runsDir}.moved' && ln -s '${decoyRuns}' '${runsDir}' && : > '${canary}'`;
    return { rootDir, spec, root, runId, runDir, runsDir, decoyRuns, canary, swap };
  }

  it("does not delete through a parent that is swapped for a link after the checks", async () => {
    const host = await swapSetup("SSH reaper swap after checks");
    if (!host) return;

    const result = await reapSshRunDirectory({
      spec: host.spec, remoteRoot: host.root, runId: host.runId, testHooks: { afterChecks: host.swap },
    });

    await expect(stat(host.canary)).resolves.toBeTruthy();
    expect(result.outcome).toBe("symlink");
    await expect(readFile(path.join(host.decoyRuns, host.runId, "victim.txt"), "utf8")).resolves.toBe("must survive\n");
    await expect(stat(path.join(host.decoyRuns, host.runId, SSH_RUN_RESTORED_MARKER))).resolves.toBeTruthy();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("deletes only the run directory it confined itself to when a parent is swapped during the removal", async () => {
    const host = await swapSetup("SSH reaper swap after confine");
    if (!host) return;

    const result = await reapSshRunDirectory({
      spec: host.spec, remoteRoot: host.root, runId: host.runId, testHooks: { afterConfine: host.swap },
    });

    await expect(stat(host.canary)).resolves.toBeTruthy();
    expect(["removed", "kept"]).toContain(result.outcome);
    await expect(readFile(path.join(host.decoyRuns, host.runId, "victim.txt"), "utf8")).resolves.toBe("must survive\n");
    await expect(stat(path.join(host.decoyRuns, host.runId, SSH_RUN_RESTORED_MARKER))).resolves.toBeTruthy();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("refuses a root that is too shallow to be a runtime base", async () => {
    const spec = { host: "ssh.invalid", port: 22, username: "paperclip", remoteWorkspacePath: "/tmp", remoteCwd: "/tmp", privateKey: "x", knownHosts: "x", strictHostKeyChecking: true } as never;
    await expect(reapSshRunDirectory({ spec, remoteRoot: "/tmp", runId: randomUUID() })).rejects.toThrow(/not deep enough|too shallow/);
  });
});
