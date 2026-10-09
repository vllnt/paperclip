import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentTaskSessions,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "@paperclipai/adapter-utils/ssh";
import { sshRunDirectory } from "@paperclipai/adapter-utils/remote-managed-runtime";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { sshRunDirectoryReaperService } from "../services/ssh-run-directory-reaper.ts";
import { secretService } from "../services/secrets.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

const execFileAsync = promisify(execFile);
const sshFixtureSupport = await getSshEnvLabSupport();
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeReaper = embeddedPostgresSupport.supported && sshFixtureSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported || !sshFixtureSupport.supported) {
  console.warn(
    `Skipping SSH run directory reaper tests: ${embeddedPostgresSupport.reason ?? sshFixtureSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"] as const;

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

describeReaper("SSH run directory reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  let fixtureRoot = "";
  let fixture: SshEnvLabFixtureState | null = null;
  let sshConfig!: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>;
  let runsDir = "";
  let environment!: Awaited<ReturnType<typeof seedEnvironment>>["environment"];
  let companyId = "";
  let agentId = "";

  async function seedEnvironment() {
    companyId = randomUUID();
    agentId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    const secret = await secretService(db).create(companyId, {
      name: `reaper-key-${randomUUID()}`, provider: "local_encrypted", value: String(sshConfig.privateKey),
    });
    await secretService(db).createBinding({
      companyId, secretId: secret.id, targetType: "environment", targetId: environmentId, configPath: "privateKeySecretRef",
    });
    const [row] = await db.insert(environments).values({
      id: environmentId, companyId, name: "Fixture SSH", driver: "ssh", status: "active",
      config: { ...sshConfig, privateKey: null, privateKeySecretRef: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      createdAt: new Date(), updatedAt: new Date(),
    }).returning();
    return { environment: row! as unknown as Parameters<typeof runtime.acquireRunLease>[0]["environment"] };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-run-reaper-");
    db = createDb(tempDb.connectionString);
    runtime = environmentRuntimeService(db);
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-run-reaper-"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    runsDir = path.join(sshConfig.remoteWorkspacePath, ".paperclip-runtime", "runs");
    environment = (await seedEnvironment()).environment;
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture);
    await rm(fixtureRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  // A run the way a worker leaves it: a lease on the host and runs/<id>/workspace on its disk.
  async function startRun(options: { status?: string; git?: boolean; restored?: boolean } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    const acquired = await runtime.acquireRunLease({ companyId, environment, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null });
    const runDir = sshRunDirectory(sshConfig.remoteWorkspacePath, runId);
    const workspace = path.join(runDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(runDir, "ballast.bin"), Buffer.alloc(200 * 1024, 3));
    if (options.git !== false) {
      await git(workspace, ["init", "-q", "-b", "main"]);
      await git(workspace, ["config", "user.name", "Paperclip Test"]);
      await git(workspace, ["config", "user.email", "test@paperclip.dev"]);
      await writeFile(path.join(workspace, "tracked.txt"), "base\n");
      await git(workspace, ["add", "tracked.txt"]);
      await git(workspace, ["commit", "-q", "-m", "base"]);
    } else {
      await writeFile(path.join(workspace, "work.txt"), "only copy\n");
    }
    if (options.restored) await writeFile(path.join(runDir, ".paperclip-restored"), "");
    await db.update(heartbeatRuns).set({ status: options.status ?? "failed" }).where(eq(heartbeatRuns.id, runId));
    return { runId, runDir, workspace, leaseId: acquired.lease.id };
  }

  const activityFor = (runId: string, action: string) =>
    db.select().from(activityLog).where(and(eq(activityLog.entityId, runId), eq(activityLog.action, action)));
  const leaseMetadata = async (leaseId: string) =>
    (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]?.metadata ?? {};
  const exists = (target: string) => stat(target).then(() => true, () => false);
  const reaper = () => sshRunDirectoryReaperService(db);

  it.each(TERMINAL_STATUSES)("removes the run directory of a %s run on lease release, with an activity entry and the bytes freed", async (status) => {
    const run = await startRun({ status });
    await writeFile(path.join(sshConfig.remoteWorkspacePath, "project-file.txt"), "shared\n");

    await runtime.releaseRunLeases(run.runId);

    await vi.waitFor(async () => expect(await exists(run.runDir)).toBe(false), { timeout: 15_000, interval: 100 });
    await vi.waitFor(async () => expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    const [entry] = await activityFor(run.runId, "environment.ssh_run_directory_reaped");
    expect(entry).toMatchObject({ companyId, actorType: "system", entityType: "heartbeat_run", runId: run.runId });
    expect(entry!.details).toMatchObject({ trigger: "lease_release", outcome: "removed", preserved: [] });
    expect((entry!.details as { bytesFreed: number }).bytesFreed).toBeGreaterThan(200 * 1024);
    expect(await leaseMetadata(run.leaseId)).toMatchObject({ sshRunDirectory: { state: "removed", trigger: "lease_release" } });
    expect(await readFile(path.join(sshConfig.remoteWorkspacePath, "project-file.txt"), "utf8")).toBe("shared\n");
  });

  it("preserves local-only git state before it removes a failed run's directory", async () => {
    const run = await startRun({ status: "failed" });
    await git(run.workspace, ["checkout", "-q", "-b", "agent/feature"]);
    await writeFile(path.join(run.workspace, "feature.txt"), "agent commit\n");
    await git(run.workspace, ["add", "feature.txt"]);
    await git(run.workspace, ["commit", "-q", "-m", "agent work"]);
    await git(run.workspace, ["checkout", "-q", "main"]);

    await runtime.releaseRunLeases(run.runId);

    await vi.waitFor(async () => expect(await exists(run.runDir)).toBe(false), { timeout: 15_000, interval: 100 });
    const bundle = path.join(sshConfig.remoteWorkspacePath, ".paperclip-runtime", "preserved", `${run.runId}.bundle`);
    expect(await exists(bundle)).toBe(true);
    await vi.waitFor(async () => expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    const [entry] = await activityFor(run.runId, "environment.ssh_run_directory_reaped");
    expect(entry!.details).toMatchObject({ preserved: [`refs/paperclip/preserved/${run.runId}/agent/feature`], preservedBundle: bundle });
  });

  it("keeps a directory it cannot preserve, and records why once", async () => {
    const run = await startRun({ status: "failed", git: false });

    await runtime.releaseRunLeases(run.runId);

    await vi.waitFor(async () => expect(await activityFor(run.runId, "environment.ssh_run_directory_kept")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    expect(await readFile(path.join(run.workspace, "work.txt"), "utf8")).toBe("only copy\n");
    expect((await activityFor(run.runId, "environment.ssh_run_directory_kept"))[0]!.details).toMatchObject({ reason: "not_git_backed" });
    expect(await leaseMetadata(run.leaseId)).toMatchObject({ sshRunDirectory: { state: "kept", reason: "not_git_backed" } });
    // A later sweep does not look at it again.
    const summary = await reaper().sweep({ now: new Date(Date.now() + 48 * HOUR_MS) });
    expect(summary.examined).toBe(0);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_kept")).toHaveLength(1);
  });

  // `releaseRunLeases` releases every active lease of a run, so a lease that is
  // still busy after it is one that is waiting for cleanup or retained.
  it.each(["pending_cleanup", "retained"] as const)("keeps the directory while the run holds another %s lease", async (siblingStatus) => {
    const run = await startRun({ status: "failed" });
    await db.insert(environmentLeases).values({
      companyId, environmentId: environment.id, heartbeatRunId: run.runId, status: siblingStatus, leasePolicy: "ephemeral",
      provider: "ssh", providerLeaseId: `ssh://other/${randomUUID()}`, metadata: { remoteCwd: sshConfig.remoteWorkspacePath },
    });

    await runtime.releaseRunLeases(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await exists(run.runDir)).toBe(true);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(0);
  });

  it("does not remove the directory of a run that is still running", async () => {
    const run = await startRun({ status: "running" });

    await runtime.releaseRunLeases(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await exists(run.runDir)).toBe(true);
  });

  it("skips a session's last run on release and lets the sweep remove it once it is old enough", async () => {
    const run = await startRun({ status: "failed" });
    await db.insert(agentTaskSessions).values({
      companyId, agentId, adapterType: "codex_local", taskKey: `task-${randomUUID()}`, lastRunId: run.runId,
    });

    await runtime.releaseRunLeases(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await exists(run.runDir)).toBe(true);
    expect(await leaseMetadata(run.leaseId)).not.toHaveProperty("sshRunDirectory");

    const young = await reaper().sweep({ now: new Date(Date.now() + 1 * HOUR_MS), readDiskUsagePercent: async () => 10 });
    expect(young.removed).toBe(0);
    expect(await exists(run.runDir)).toBe(true);

    const old = await reaper().sweep({ now: new Date(Date.now() + 7 * HOUR_MS), readDiskUsagePercent: async () => 10 });
    expect(old.removed).toBe(1);
    expect(await exists(run.runDir)).toBe(false);
    expect((await activityFor(run.runId, "environment.ssh_run_directory_reaped"))[0]!.details).toMatchObject({ trigger: "sweep" });
  });

  it("sweeps orphans: terminal, old enough, no active or pending cleanup lease, and not decided before", async () => {
    // A directory whose release-time removal never happened (a crash after the lease released).
    const orphan = await startRun({ status: "timed_out" });
    const young = await startRun({ status: "failed" });
    const live = await startRun({ status: "running" });
    const pending = await startRun({ status: "failed" });
    for (const run of [orphan, young, live, pending]) {
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, run.leaseId));
    }
    await db.update(environmentLeases).set({ releasedAt: new Date(Date.now() - 10 * HOUR_MS) }).where(eq(environmentLeases.id, orphan.leaseId));
    await db.update(environmentLeases).set({ releasedAt: new Date(Date.now() - 10 * HOUR_MS) }).where(eq(environmentLeases.id, live.leaseId));
    await db.update(environmentLeases).set({ releasedAt: new Date(Date.now() - 10 * HOUR_MS) }).where(eq(environmentLeases.id, pending.leaseId));
    await db.insert(environmentLeases).values({
      companyId, environmentId: environment.id, heartbeatRunId: pending.runId, status: "pending_cleanup", leasePolicy: "ephemeral",
      provider: "ssh", providerLeaseId: `ssh://pending/${randomUUID()}`, metadata: { remoteCwd: sshConfig.remoteWorkspacePath },
    });

    const summary = await reaper().sweep({ readDiskUsagePercent: async () => 10 });

    expect(summary).toMatchObject({ removed: 1, diskPressure: false });
    expect(summary.bytesFreed).toBeGreaterThan(200 * 1024);
    expect(await exists(orphan.runDir)).toBe(false);
    expect(await exists(young.runDir)).toBe(true);
    expect(await exists(live.runDir)).toBe(true);
    expect(await exists(pending.runDir)).toBe(true);
    expect((await activityFor(orphan.runId, "environment.ssh_run_directory_reaped"))[0]!.details).toMatchObject({ trigger: "sweep", outcome: "removed" });
    expect((await reaper().sweep({ readDiskUsagePercent: async () => 10 })).removed).toBe(0);
  });

  it("shortens the age threshold when the worker's disk is more than 80% full", async () => {
    const run = await startRun({ status: "failed" });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(Date.now() - 1 * HOUR_MS) }).where(eq(environmentLeases.id, run.leaseId));

    const calm = await reaper().sweep({ readDiskUsagePercent: async () => 40 });
    expect(calm).toMatchObject({ removed: 0, diskPressure: false });
    expect(await exists(run.runDir)).toBe(true);

    const pressed = await reaper().sweep({ readDiskUsagePercent: async () => 92 });
    expect(pressed).toMatchObject({ removed: 1, diskPressure: true });
    expect(await exists(run.runDir)).toBe(false);
  });

  it("touches nothing outside runs/<runId>", async () => {
    const run = await startRun({ status: "failed" });
    const sibling = await startRun({ status: "running" });
    const keep = path.join(sshConfig.remoteWorkspacePath, ".paperclip-runtime", "other");
    await mkdir(keep, { recursive: true });
    await writeFile(path.join(keep, "keep.txt"), "keep\n");
    const before = (await readdir(runsDir)).filter((name) => name !== run.runId).sort();

    await runtime.releaseRunLeases(run.runId);
    await vi.waitFor(async () => expect(await exists(run.runDir)).toBe(false), { timeout: 15_000, interval: 100 });

    expect((await readdir(runsDir)).sort()).toEqual(before);
    expect(await exists(sibling.runDir)).toBe(true);
    expect(await readFile(path.join(keep, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
