import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Lets one test know a launch's id before it starts, to take its record name.
const launchIdBytes = vi.hoisted(() => ({ value: null as Buffer | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = (size: number) =>
    size === 8 && launchIdBytes.value ? Buffer.from(launchIdBytes.value) : actual.randomBytes(size);
  return { ...actual, randomBytes, default: { ...actual, randomBytes } };
});
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "@paperclipai/adapter-utils/ssh";
import { runChildProcess, runningProcesses, signalRunningProcess } from "@paperclipai/adapter-utils/server-utils";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

const sshFixtureSupport = await getSshEnvLabSupport();
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeStop = embeddedPostgresSupport.supported && sshFixtureSupport.supported && process.platform === "linux"
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported || !sshFixtureSupport.supported) {
  console.warn(
    `Skipping SSH remote process stop tests: ${embeddedPostgresSupport.reason ?? sshFixtureSupport.reason ?? "unsupported environment"}`,
  );
}

const MARKER_ENV = "PAPERCLIP_RUN_MARKER";
// Leaves a child in a session of its own, as an agent tool's background
// command does, then waits in the foreground.
const REMOTE_SCRIPT = "setsid sh -c 'exec sleep 600' & echo child=$!; echo leader=$$; echo ready; exec sleep 600";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

async function readProc(pid: number, file: "environ" | "cmdline"): Promise<string> {
  return readFile(`/proc/${pid}/${file}`, "utf8").catch(() => "");
}

async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid!;
}

describeStop("SSH remote process stop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  let fixtureRoot = "";
  let fixture: SshEnvLabFixtureState | null = null;
  let sshConfig!: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>;
  let companyId = "";
  let agentId = "";
  const leftovers: number[] = [];

  type SeededEnvironment = Parameters<ReturnType<typeof environmentRuntimeService>["acquireRunLease"]>[0]["environment"];

  async function seedEnvironment(config: typeof sshConfig): Promise<SeededEnvironment> {
    const environmentId = randomUUID();
    const secret = await secretService(db).create(companyId, {
      name: `stop-key-${randomUUID()}`, provider: "local_encrypted", value: String(config.privateKey),
    });
    await secretService(db).createBinding({
      companyId, secretId: secret.id, targetType: "environment", targetId: environmentId, configPath: "privateKeySecretRef",
    });
    const [row] = await db.insert(environments).values({
      id: environmentId, companyId, name: `SSH ${environmentId.slice(0, 8)}`, driver: "ssh", status: "active",
      config: { ...config, privateKey: null, privateKeySecretRef: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    }).returning();
    return row! as unknown as SeededEnvironment;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-remote-stop-");
    db = createDb(tempDb.connectionString);
    runtime = environmentRuntimeService(db);
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-remote-stop-"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix: `S${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "paused", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
  }, 120_000);

  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  afterAll(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture);
    await rm(fixtureRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  /** A running SSH run: a lease, and the agent command launched the way adapters launch it. */
  async function startRun(options: { environment: SeededEnvironment; terminalResultCleanup?: boolean }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "running",
      processPid: await deadPid(), processLossRetryCount: 9, nextEventSeq: 1, startedAt: new Date(),
      updatedAt: new Date(Date.now() - 60_000),
    });
    const acquired = await runtime.acquireRunLease({
      companyId, environment: options.environment, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null,
    });
    const logs: string[] = [];
    let ready!: () => void;
    const readySeen = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const done = runChildProcess(runId, "sh", ["-c", REMOTE_SCRIPT], {
      cwd: process.cwd(),
      env: { FOO: "bar" },
      timeoutSec: 0,
      graceSec: 1,
      onLog: async (stream, chunk) => {
        logs.push(`${stream}:${chunk}`);
        if (logs.join("").includes("ready\n")) ready();
      },
      remoteExecution: { ...sshConfig, remoteCwd: sshConfig.remoteWorkspacePath },
      ...(options.terminalResultCleanup
        ? { terminalResultCleanup: { hasTerminalResult: ({ stdout }) => stdout.includes("ready\n"), graceMs: 50 } }
        : {}),
    });
    await readySeen;
    const output = logs.join("");
    const leader = Number(/leader=(\d+)/.exec(output)?.[1]);
    const child = Number(/child=(\d+)/.exec(output)?.[1]);
    leftovers.push(leader, child);
    return { runId, leaseId: acquired.lease.id, done, logs, leader, child };
  }

  async function runEvents(runId: string) {
    return db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
  }

  async function lease(leaseId: string) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;
  }

  it("stops the leader and its child in another session before it releases a stopped run's lease", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment });
    // Stop: the server signals the local ssh client, as a cancel does.
    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGTERM");
    const result = await run.done;
    expect(result.exitCode).toBe(255);
    expect(alive(run.leader) && alive(run.child)).toBe(true);

    await runtime.releaseRunLeases(run.runId);

    expect(alive(run.leader)).toBe(false);
    expect(alive(run.child)).toBe(false);
    const released = await lease(run.leaseId);
    expect(released.status).toBe("released");
    expect(released.metadata?.remoteProcessStop).toMatchObject({ outcome: "stopped", survived: 0 });
    expect((released.metadata?.remoteProcessStop as { matched: number }).matched).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("stops the remote processes after an unmanaged background task cleanup", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment, terminalResultCleanup: true });
    const result = await run.done;
    expect(result.terminalResultCleanup?.stopReason).toBe("unmanaged_background_task_stopped");
    expect(alive(run.leader) && alive(run.child)).toBe(true);

    await runtime.releaseRunLeases(run.runId);

    expect(alive(run.leader)).toBe(false);
    expect(alive(run.child)).toBe(false);
  }, 60_000);

  it("stops a lost run's remote processes on restart recovery, before the lease is released, and logs the count", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment });
    // The server died: its ssh client is gone and nothing stopped the remote side.
    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGKILL");
    await run.done;
    runningProcesses.delete(run.runId);
    expect(alive(run.leader) && alive(run.child)).toBe(true);

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(alive(run.leader)).toBe(false);
    expect(alive(run.child)).toBe(false);
    const [reaped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.runId));
    expect(reaped!.errorCode).toBe("process_lost");
    expect((await lease(run.leaseId)).status).not.toBe("active");
    const stopped = (await runEvents(run.runId)).filter((event) => event.eventType === "remote_processes_stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.payload).toMatchObject({ survived: 0 });
  }, 60_000);

  it("logs an unreachable worker on restart recovery and still finishes the reap", async () => {
    const reachable = await seedEnvironment(sshConfig);
    const run = await startRun({ environment: reachable });
    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGKILL");
    await run.done;
    runningProcesses.delete(run.runId);
    // The worker the run was launched on has gone away.
    const launched = await lease(run.leaseId);
    await db.update(environmentLeases)
      .set({ metadata: { ...launched.metadata, port: await closedLoopbackPort() } })
      .where(eq(environmentLeases.id, run.leaseId));

    const startedAt = Date.now();
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(Date.now() - startedAt).toBeLessThan(40_000);
    const [reaped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.runId));
    expect(reaped!.errorCode).toBe("process_lost");
    expect((await lease(run.leaseId)).status).not.toBe("active");
    const partial = (await runEvents(run.runId)).filter((event) => event.eventType === "remote_kill_partial");
    expect(partial).toHaveLength(1);
    expect(partial[0]!.payload).toMatchObject({ reason: "worker_unreachable" });
  }, 90_000);

  it("stops on the worker the lease was acquired on after the environment is edited", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment });
    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGKILL");
    await run.done;
    runningProcesses.delete(run.runId);
    const config = (environment as unknown as { config: Record<string, unknown> }).config;
    await db.update(environments)
      .set({ config: { ...config, port: await closedLoopbackPort(), remoteWorkspacePath: "/nonexistent-paperclip-root" } })
      .where(eq(environments.id, environment.id));

    await runtime.releaseRunLeases(run.runId);

    expect(alive(run.leader)).toBe(false);
    expect(alive(run.child)).toBe(false);
    expect((await lease(run.leaseId)).metadata?.remoteProcessStop).toMatchObject({ outcome: "stopped" });
  }, 60_000);

  it("records a partial stop when the lease's environment is no longer SSH", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment });
    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGKILL");
    await run.done;
    runningProcesses.delete(run.runId);
    // Only one local environment may exist; drop the one the migration seeds.
    await db.delete(environments).where(eq(environments.driver, "local"));
    await db.update(environments).set({ driver: "local", config: {} }).where(eq(environments.id, environment.id));

    const outcomes = await runtime.stopRunProcesses(run.runId);

    expect(outcomes).toMatchObject([{ outcome: "partial", partial: "environment_changed" }]);
  }, 60_000);

  it("records a partial stop, not silence, when the lease's environment was deleted", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment });
    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGKILL");
    await run.done;
    runningProcesses.delete(run.runId);
    await db.delete(environments).where(eq(environments.id, environment.id));

    const outcomes = await runtime.stopRunProcesses(run.runId);

    expect(outcomes).toMatchObject([{ outcome: "partial", partial: "environment_deleted", matched: 0 }]);
    expect((await lease(run.leaseId)).metadata?.remoteProcessStop).toMatchObject({ outcome: "partial", partial: "environment_deleted" });
  }, 60_000);

  it("gives a launch refused for a taken record name exactly one unsafe_record_dir event", async () => {
    const environment = await seedEnvironment(sshConfig);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "running",
      processPid: await deadPid(), processLossRetryCount: 9, nextEventSeq: 1, startedAt: new Date(),
      updatedAt: new Date(Date.now() - 60_000),
    });
    await runtime.acquireRunLease({
      companyId, environment, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null,
    });
    const victim = await mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    const recordDir = path.join(sshConfig.remoteWorkspacePath, ".paperclip-runtime", "processes", runId);
    await mkdir(recordDir, { recursive: true });
    launchIdBytes.value = Buffer.from("0123456789abcdef", "hex");
    let result: Awaited<ReturnType<typeof runChildProcess>>;
    try {
      await symlink(victim, path.join(recordDir, "0123456789abcdef.json"));
      result = await runChildProcess(runId, "sh", ["-c", "echo started"], {
        cwd: process.cwd(), env: {}, timeoutSec: 30, graceSec: 1, onLog: async () => {},
        remoteExecution: { ...sshConfig, remoteCwd: sshConfig.remoteWorkspacePath },
      });
    } finally {
      launchIdBytes.value = null;
    }
    expect(result.exitCode).toBe(125);
    expect(result.stdout).not.toContain("started");
    runningProcesses.delete(runId);

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    const remote = (await runEvents(runId))
      .filter((event) => event.eventType.startsWith("remote_"))
      .map((event) => [event.eventType, (event.payload as { reason?: string }).reason]);
    expect(remote).toEqual([["remote_kill_partial", "unsafe_record_dir"]]);
    expect(await readdir(victim)).toEqual([]);
  }, 60_000);

  it("keeps the run marker out of argv, logs, run events, lease metadata and the process record", async () => {
    const environment = await seedEnvironment(sshConfig);
    const run = await startRun({ environment });
    const environ = (await readProc(run.leader, "environ")).split("\0");
    const entry = environ.find((value) => value.startsWith(`${MARKER_ENV}=`));
    expect(entry).toMatch(new RegExp(`^${MARKER_ENV}=[0-9a-f]{32}$`));
    const markerValue = entry!.slice(MARKER_ENV.length + 1);
    const sshClient = runningProcesses.get(run.runId)!.child.pid!;
    const argvs = await Promise.all([sshClient, run.leader, run.child].map((pid) => readProc(pid, "cmdline")));
    const recordDir = path.join(sshConfig.remoteWorkspacePath, ".paperclip-runtime", "processes", run.runId);
    const records = await Promise.all((await readdir(recordDir)).map((file) => readFile(path.join(recordDir, file), "utf8")));
    expect(records.length).toBeGreaterThan(0);

    signalRunningProcess(runningProcesses.get(run.runId)!, "SIGKILL");
    await run.done;
    runningProcesses.delete(run.runId);
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    const events = await runEvents(run.runId);
    expect(events.some((event) => event.eventType === "remote_processes_stopped")).toBe(true);
    const haystacks = [
      ...argvs,
      run.logs.join(""),
      JSON.stringify(events),
      JSON.stringify((await lease(run.leaseId)).metadata),
      ...records,
    ];
    for (const haystack of haystacks) expect(haystack).not.toContain(markerValue);
  }, 60_000);
});
