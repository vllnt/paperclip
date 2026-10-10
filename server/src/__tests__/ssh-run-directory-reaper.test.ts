import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
import { reapSshRunDirectory, sshRunDirectory } from "@paperclipai/adapter-utils/remote-managed-runtime";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { recordSshWorkspaceSeed, sshRunDirectoryReaperService } from "../services/ssh-run-directory-reaper.ts";
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
  async function startRun(options: { status?: string; git?: boolean; restored?: boolean; recordSeed?: boolean; pushed?: boolean } = {}) {
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
      // What realizeWorkspace records on the lease before the upload.
      if (options.pushed) {
        const origin = path.join(fixtureRoot, `origin-${randomUUID()}.git`);
        await git(fixtureRoot, ["init", "-q", "--bare", origin]);
        await git(workspace, ["remote", "add", "origin", origin]);
        await git(workspace, ["push", "-q", "origin", "main"]);
      }
      if (options.recordSeed !== false) await recordSshWorkspaceSeed(db, acquired.lease.id, await git(workspace, ["rev-parse", "HEAD"]));
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
    // A workspace that is not a git repository has no seed record, so its run must
    // have been finished for the long threshold before the worker is asked.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 25 * HOUR_MS) }).where(eq(heartbeatRuns.id, run.runId));

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
  // A lease the way the release leaves it: released, its run finished.
  async function releasedRun(status = "failed") {
    const run = await startRun({ status });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(Date.now() - 10 * HOUR_MS) }).where(eq(environmentLeases.id, run.leaseId));
    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, run.leaseId));
    return { ...run, lease: row as unknown as Parameters<ReturnType<typeof sshRunDirectoryReaperService>["reapReleasedLease"]>[1] };
  }

  it("keeps a directory whose recorded root is not the environment's configured root", async () => {
    const run = await startRun({ status: "failed" });
    const otherRoot = path.join(fixtureRoot, "other-root");
    const otherRunDir = sshRunDirectory(otherRoot, run.runId);
    await mkdir(path.join(otherRunDir, "workspace"), { recursive: true });
    await writeFile(path.join(otherRunDir, "workspace", "theirs.txt"), "not ours\n");
    await writeFile(path.join(otherRunDir, ".paperclip-restored"), "");
    // A stale or corrupted lease names a root the environment does not own.
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ remoteCwd: otherRoot })}::jsonb` }).where(eq(environmentLeases.id, run.leaseId));

    await runtime.releaseRunLeases(run.runId);

    await vi.waitFor(async () => expect(await activityFor(run.runId, "environment.ssh_run_directory_kept")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    expect((await activityFor(run.runId, "environment.ssh_run_directory_kept"))[0]!.details).toMatchObject({ reason: "root_mismatch" });
    expect(await readFile(path.join(otherRunDir, "workspace", "theirs.txt"), "utf8")).toBe("not ours\n");
    expect(await exists(run.runDir)).toBe(true);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(0);
  });

  it.each(["/tmp", "/var"])("keeps a directory whose recorded root is the shallow path %s", async (shallow) => {
    const run = await startRun({ status: "failed" });
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ remoteCwd: shallow })}::jsonb` }).where(eq(environmentLeases.id, run.leaseId));

    await runtime.releaseRunLeases(run.runId);

    await vi.waitFor(async () => expect(await activityFor(run.runId, "environment.ssh_run_directory_kept")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    expect((await activityFor(run.runId, "environment.ssh_run_directory_kept"))[0]!.details).toMatchObject({ reason: "root_mismatch" });
    expect(await exists(run.runDir)).toBe(true);
  });

  it("rechecks for a live lease after claiming the directory and before it deletes", async () => {
    const run = await releasedRun("failed");
    const service = sshRunDirectoryReaperService(db, {
      hooks: {
        // The decision to delete has been made. Now a lease for the run appears.
        beforeRemoteDelete: async () => {
          await db.insert(environmentLeases).values({
            companyId, environmentId: environment.id, heartbeatRunId: run.runId, status: "pending_cleanup", leasePolicy: "ephemeral",
            provider: "ssh", providerLeaseId: `ssh://late/${randomUUID()}`, metadata: { remoteCwd: sshConfig.remoteWorkspacePath },
          });
        },
      },
    });

    await service.reapReleasedLease(environment, run.lease);

    expect(await exists(run.runDir)).toBe(true);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(0);
    // The claim is given back, so a later pass can decide again.
    expect(await leaseMetadata(run.leaseId)).not.toHaveProperty("sshRunDirectory");
  });

  it("refuses a new lease for a run whose directory is being removed", async () => {
    const run = await releasedRun("failed");
    await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ sshRunDirectory: { state: "reaping", claimedAt: new Date().toISOString(), trigger: "sweep" } })}::jsonb`,
    }).where(eq(environmentLeases.id, run.leaseId));

    await expect(runtime.acquireRunLease({ companyId, environment, issueId: null, heartbeatRunId: run.runId, persistedExecutionWorkspace: null }))
      .rejects.toThrow(/being removed/);

    const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, run.runId), eq(environmentLeases.status, "active")));
    expect(leases).toHaveLength(0);
    expect(await exists(run.runDir)).toBe(true);
  });

  it("reclaims a directory whose earlier claim went stale", async () => {
    const run = await releasedRun("failed");
    await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ sshRunDirectory: { state: "reaping", claimedAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(), trigger: "sweep" } })}::jsonb`,
    }).where(eq(environmentLeases.id, run.leaseId));

    const summary = await reaper().sweep({ readDiskUsagePercent: async () => 10 });

    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(await exists(run.runDir)).toBe(false);
  });

  it("does not reclaim a claim that is still fresh", async () => {
    const run = await releasedRun("failed");
    await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ sshRunDirectory: { state: "reaping", claimedAt: new Date().toISOString(), trigger: "lease_release" } })}::jsonb`,
    }).where(eq(environmentLeases.id, run.leaseId));

    await reaper().sweep({ readDiskUsagePercent: async () => 10 });

    expect(await exists(run.runDir)).toBe(true);
  });
  // A second released lease for the same run, host and root: two replicas, or two
  // sweeps, reach the same directory through different lease rows.
  async function siblingReleasedLease(run: Awaited<ReturnType<typeof releasedRun>>) {
    const [first] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, run.leaseId));
    const [second] = await db.insert(environmentLeases).values({
      companyId, environmentId: environment.id, heartbeatRunId: run.runId, status: "released", leasePolicy: "ephemeral",
      provider: "ssh", providerLeaseId: first!.providerLeaseId, releasedAt: new Date(Date.now() - 10 * HOUR_MS),
      metadata: first!.metadata,
    }).returning();
    return second as unknown as typeof run.lease;
  }

  it("lets exactly one of two released leases of the same directory delete it", async () => {
    const run = await releasedRun("failed");
    const other = await siblingReleasedLease(run);
    let calls = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const hooks = { beforeRemoteDelete: async () => { calls += 1; if (calls === 1) await gate; } };
    const firstReplica = sshRunDirectoryReaperService(db, { hooks });
    const secondReplica = sshRunDirectoryReaperService(db, { hooks });

    const first = firstReplica.reapReleasedLease(environment, run.lease);
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 10_000, interval: 20 });
    // The first owner is mid-removal. The other replica reaches the same directory through its own lease row.
    await secondReplica.reapReleasedLease(environment, other);
    expect(calls).toBe(1);
    openGate();
    await first;

    expect(await exists(run.runDir)).toBe(false);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(1);
    expect(await leaseMetadata(other.id)).not.toHaveProperty("sshRunDirectory");
  });

  it("lets exactly one claim win when two replicas start on the same directory at the same instant", async () => {
    for (let round = 0; round < 8; round += 1) {
      const run = await releasedRun("failed");
      const other = await siblingReleasedLease(run);
      let active = 0;
      let mostAtOnce = 0;
      const hooks = {
        beforeRemoteDelete: async () => {
          active += 1;
          mostAtOnce = Math.max(mostAtOnce, active);
          await new Promise((resolve) => setTimeout(resolve, 150));
          active -= 1;
        },
      };

      await Promise.all([
        sshRunDirectoryReaperService(db, { hooks }).reapReleasedLease(environment, run.lease),
        sshRunDirectoryReaperService(db, { hooks }).reapReleasedLease(environment, other),
      ]);

      // The second claim may arrive after the first removal finished, and then
      // finds nothing to remove; it must never overlap the first.
      expect(mostAtOnce).toBe(1);
      expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(1);
      expect(await exists(run.runDir)).toBe(false);
    }
  }, 60_000);

  it("refuses a lease that starts while the directory it would use is being removed, and keeps it for the reaper", async () => {
    const run = await releasedRun("failed");
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let atDelete!: () => void;
    const reachedDelete = new Promise<void>((resolve) => { atDelete = resolve; });
    const service = sshRunDirectoryReaperService(db, { hooks: { beforeRemoteDelete: async () => { atDelete(); await gate; } } });

    const reaping = service.reapReleasedLease(environment, run.lease);
    await reachedDelete;
    await expect(runtime.acquireRunLease({ companyId, environment, issueId: null, heartbeatRunId: run.runId, persistedExecutionWorkspace: null }))
      .rejects.toThrow(/being removed/);
    expect(await exists(run.runDir)).toBe(true);
    openGate();
    await reaping;

    expect(await exists(run.runDir)).toBe(false);
    const active = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, run.runId), eq(environmentLeases.status, "active")));
    expect(active).toHaveLength(0);
  });

  // The claim looks only at the leases of the directory's own run. That is sound
  // because a run directory is named by one run id and a run prepares only its
  // own (the builder is pinned in remote-managed-runtime.test.ts, its callers in
  // ssh-run-directory-callers.test.ts). This test shows the scenario a reviewer
  // can worry about: a live lease of ANOTHER run that names the very same host
  // and root, down to the same `providerLeaseId`. It is not the same directory.
  it("does not let a live lease of another run on the same host and root keep this run's directory, and leaves that run's directory alone", async () => {
    const run = await releasedRun("failed");
    const live = await startRun({ status: "running" });
    const [liveLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, live.leaseId));

    // Same host, port, user, root and provider reference; only the run differs.
    expect(liveLease!.providerLeaseId).toBe(run.lease.providerLeaseId);
    expect(liveLease!.metadata).toMatchObject({ remoteCwd: run.lease.metadata?.remoteCwd, host: run.lease.metadata?.host });
    expect(liveLease!.heartbeatRunId).toBe(live.runId);
    expect(live.runDir).not.toBe(run.runDir);

    await sshRunDirectoryReaperService(db).reapReleasedLease(environment, run.lease);

    expect(await exists(run.runDir)).toBe(false);
    expect(await exists(live.runDir)).toBe(true);
    expect(await leaseMetadata(live.leaseId)).not.toHaveProperty("sshRunDirectory");
  });

  it("names a run's directory by the run id its lease was acquired for", async () => {
    const run = await startRun({ status: "running" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, run.leaseId));

    // The reaper decides a directory by `heartbeatRunId` and the recorded root.
    // Both must name the directory the run's own prepare would create.
    expect(lease!.heartbeatRunId).toBe(run.runId);
    expect(sshRunDirectory(String(lease!.metadata?.remoteCwd), lease!.heartbeatRunId!)).toBe(run.runDir);
  });

  // Claim fencing. A claim is held by an owner token that the owner renews while
  // it works. Judged by its last renewal, it outlives the stale window as long as
  // its owner lives, and expires when the owner dies or stalls.
  function steppedClock() {
    let at = Date.now();
    return { now: () => new Date(at), advance: (ms: number) => { at += ms; } };
  }
  const BEYOND_STALE_WINDOW_MS = 20 * 60 * 1000;
  const renewedAtOf = async (leaseId: string) =>
    new Date(String(((await leaseMetadata(leaseId)).sshRunDirectory as { renewedAt?: string } | undefined)?.renewedAt ?? 0)).getTime();

  function gated() {
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    return { open, arrived, hook: async () => { reached(); await gate; } };
  }

  it("keeps its claim past the stale window while its owner is still deleting, so no second reaper can take it", async () => {
    const run = await releasedRun("failed");
    const other = await siblingReleasedLease(run);
    const clock = steppedClock();
    const first = gated();
    const owner = sshRunDirectoryReaperService(db, { clock: clock.now, claimRenewMs: 20, hooks: { beforeRemoteDelete: first.hook } });
    const rival = sshRunDirectoryReaperService(db, { clock: clock.now });

    const reaping = owner.reapReleasedLease(environment, run.lease);
    await first.arrived;
    clock.advance(BEYOND_STALE_WINDOW_MS);
    await vi.waitFor(async () => expect(await renewedAtOf(run.leaseId)).toBeGreaterThanOrEqual(clock.now().getTime()), { timeout: 10_000, interval: 20 });

    // Another reaper, well past the window, reaches the directory by a sibling lease row and by the sweep.
    await rival.reapReleasedLease(environment, other);
    await rival.sweep({ readDiskUsagePercent: async () => 10 });

    expect(await exists(run.runDir)).toBe(true);
    expect(await leaseMetadata(other.id)).not.toHaveProperty("sshRunDirectory");
    first.open();
    await reaping;
    expect(await exists(run.runDir)).toBe(false);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(1);
  }, 60_000);

  it("lets a second reaper take over a claim that its owner stopped renewing (the failure the renewal prevents)", async () => {
    const run = await releasedRun("failed");
    const other = await siblingReleasedLease(run);
    const clock = steppedClock();
    const first = gated();
    const owner = sshRunDirectoryReaperService(db, { clock: clock.now, claimRenewMs: 0, hooks: { beforeRemoteDelete: first.hook } });

    const reaping = owner.reapReleasedLease(environment, run.lease);
    await first.arrived;
    clock.advance(BEYOND_STALE_WINDOW_MS);
    await sshRunDirectoryReaperService(db, { clock: clock.now }).reapReleasedLease(environment, other);

    // Without renewal the first claim is stale, so the second reaper deletes while the first still waits to.
    expect(await exists(run.runDir)).toBe(false);
    first.open();
    await reaping;
  }, 60_000);

  it("stops a reaper whose claim was taken over: it neither deletes nor records", async () => {
    const run = await releasedRun("failed");
    const other = await siblingReleasedLease(run);
    const clock = steppedClock();
    const first = gated();
    const second = gated();
    const stalled = sshRunDirectoryReaperService(db, { clock: clock.now, claimRenewMs: 0, hooks: { beforeRemoteDelete: first.hook } });
    const takeover = sshRunDirectoryReaperService(db, { clock: clock.now, claimRenewMs: 0, hooks: { beforeRemoteDelete: second.hook } });

    const stalledRun = stalled.reapReleasedLease(environment, run.lease);
    await first.arrived;
    // The first owner stalls past the window. The second takes over through the sibling lease row and is about to delete.
    clock.advance(BEYOND_STALE_WINDOW_MS);
    const takeoverRun = takeover.reapReleasedLease(environment, other);
    await second.arrived;

    // The stalled owner wakes. Its own row still carries its token, but the directory has a live claim of another.
    first.open();
    await stalledRun;
    expect(await exists(run.runDir)).toBe(true);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(0);
    expect(await leaseMetadata(run.leaseId)).not.toMatchObject({ sshRunDirectory: { state: "removed" } });

    second.open();
    await takeoverRun;
    expect(await exists(run.runDir)).toBe(false);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_reaped")).toHaveLength(1);
    expect(await leaseMetadata(other.id)).toMatchObject({ sshRunDirectory: { state: "removed" } });
  }, 60_000);

  it("keeps the claim when the remote command fails after it was sent, and lets it expire before anyone else deletes", async () => {
    const run = await releasedRun("failed");
    const other = await siblingReleasedLease(run);
    const clock = steppedClock();
    const failing = sshRunDirectoryReaperService(db, {
      clock: clock.now,
      hooks: { reapRemote: async () => { throw new Error("ssh timed out"); } },
    });

    await failing.reapReleasedLease(environment, run.lease);

    // The command may still run on the worker, so the claim is not given back.
    expect(await leaseMetadata(run.leaseId)).toMatchObject({ sshRunDirectory: { state: "reaping" } });
    await sshRunDirectoryReaperService(db, { clock: clock.now }).reapReleasedLease(environment, other);
    expect(await exists(run.runDir)).toBe(true);
    await expect(runtime.acquireRunLease({ companyId, environment, issueId: null, heartbeatRunId: run.runId, persistedExecutionWorkspace: null }))
      .rejects.toThrow(/being removed/);

    // Once nobody renewed it for the whole window, the sweep finishes the job.
    clock.advance(BEYOND_STALE_WINDOW_MS);
    await sshRunDirectoryReaperService(db, { clock: clock.now }).sweep({ readDiskUsagePercent: async () => 10 });
    expect(await exists(run.runDir)).toBe(false);
  }, 60_000);

  describe("a run folder with no seed record", () => {
    const OLD_ENOUGH = 25 * HOUR_MS;

    // A dead run whose lease was released long ago, with a pushed, clean workspace.
    async function legacyRun(options: { status?: string; finishedAgoMs?: number | null; releasedAgoMs?: number } = {}) {
      const run = await startRun({ status: options.status ?? "failed", recordSeed: false, pushed: true });
      const finishedAgoMs = options.finishedAgoMs === undefined ? OLD_ENOUGH : options.finishedAgoMs;
      await db.update(heartbeatRuns)
        .set({ finishedAt: finishedAgoMs === null ? null : new Date(Date.now() - finishedAgoMs) })
        .where(eq(heartbeatRuns.id, run.runId));
      await db.update(environmentLeases)
        .set({ status: "released", releasedAt: new Date(Date.now() - (options.releasedAgoMs ?? 100 * HOUR_MS)) })
        .where(eq(environmentLeases.id, run.leaseId));
      const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, run.leaseId));
      return { ...run, lease: row as never };
    }
    const decisionOf = async (leaseId: string) => (await leaseMetadata(leaseId)).sshRunDirectory;

    it("removes a clean, pushed folder of a run that finished more than a day ago, on the sweep", async () => {
      const run = await legacyRun();

      const summary = await reaper().sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(false);
      expect(summary.legacyRemoved).toBeGreaterThanOrEqual(1);
      expect(await decisionOf(run.leaseId)).toMatchObject({ state: "removed", unseeded: true });
      const [entry] = await activityFor(run.runId, "environment.ssh_run_directory_reaped");
      expect(entry?.details).toMatchObject({ outcome: "removed", unseeded: true, preserved: [] });
    }, 60_000);

    it("still removes at once a folder the restore marked, whatever its run's age or finish time", async () => {
      const marked = await startRun({ status: "succeeded", git: false, restored: true });
      await runtime.releaseRunLeases(marked.runId);

      await vi.waitFor(async () => expect(await exists(marked.runDir)).toBe(false), { timeout: 15_000, interval: 100 });
      await vi.waitFor(async () => expect(await decisionOf(marked.leaseId)).toMatchObject({ state: "removed" }), { timeout: 15_000, interval: 100 });
    }, 60_000);

    it("leaves the folder of a run that finished less than a day ago, and records nothing", async () => {
      const run = await legacyRun({ finishedAgoMs: 23 * HOUR_MS });

      await reaper().sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toBeUndefined();
    }, 60_000);

    it("leaves the folder of a run that is not terminal", async () => {
      const run = await legacyRun({ status: "running" });

      await reaper().sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toBeUndefined();
    }, 60_000);

    it("leaves the folder while the run holds another active lease", async () => {
      const run = await legacyRun();
      await db.insert(environmentLeases).values({
        companyId, environmentId: environment.id, heartbeatRunId: run.runId, status: "active", leasePolicy: "ephemeral",
        provider: "ssh", providerLeaseId: `ssh://other/${randomUUID()}`, metadata: { remoteCwd: sshConfig.remoteWorkspacePath },
      });

      await reaper().sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toBeUndefined();
    }, 60_000);

    it("keeps the folder as finish_unknown on the sweep when the run has no finish time, and waits on the release", async () => {
      const run = await legacyRun({ finishedAgoMs: null });

      await reaper().reapReleasedLease(environment, run.lease);
      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toBeUndefined();

      const summary = await reaper().sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toMatchObject({ state: "kept", reason: "finish_unknown" });
      expect(summary.keptByReason.finish_unknown).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it.each([
      {
        reason: "dirty",
        prepare: async (run: { workspace: string }) => { await writeFile(path.join(run.workspace, "only-copy.txt"), "work\n"); },
      },
      {
        reason: "unpushed",
        prepare: async (run: { workspace: string }) => {
          await writeFile(path.join(run.workspace, "local.txt"), "local\n");
          await git(run.workspace, ["add", "local.txt"]);
          await git(run.workspace, ["commit", "-q", "-m", "local only"]);
        },
      },
      {
        reason: "stash",
        prepare: async (run: { workspace: string }) => {
          await writeFile(path.join(run.workspace, "tracked.txt"), "stashed\n");
          await git(run.workspace, ["stash", "push", "-q", "-m", "parked"]);
        },
      },
      {
        reason: "linked_worktree",
        prepare: async (run: { workspace: string }) => {
          await git(run.workspace, ["worktree", "add", "-q", "--detach", path.join(fixtureRoot, `agent-tree-${randomUUID()}`)]);
        },
      },
    ])("keeps the folder as $reason, counts it, and records the reason", async ({ reason, prepare }) => {
      const run = await legacyRun();
      await prepare(run);

      const summary = await reaper().sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(path.join(run.workspace, ".git"))).toBe(true);
      expect(await decisionOf(run.leaseId)).toMatchObject({ state: "kept", reason });
      expect(summary.keptByReason[reason]).toBeGreaterThanOrEqual(1);
      const [entry] = await activityFor(run.runId, "environment.ssh_run_directory_kept");
      expect(entry?.details).toMatchObject({ reason });
    }, 60_000);

    it("keeps the folder as git_unreadable when a git read fails", async () => {
      const run = await legacyRun();
      const failingGit = `git() { case " $* " in *"-C workspace status --porcelain"*) return 42;; esac; command git "$@"; }`;
      const service = sshRunDirectoryReaperService(db, {
        hooks: { reapRemote: (input) => reapSshRunDirectory({ ...input, testHooks: { afterConfine: failingGit } }) },
      });

      const summary = await service.sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toMatchObject({ state: "kept", reason: "git_unreadable", detail: "git status" });
      expect(summary.keptByReason.git_unreadable).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it("sends no more folders than the cap in one sweep, and does the rest on the next", async () => {
      // The oldest first, so these three come before any other folder the suite left behind.
      const runs = [];
      for (let i = 0; i < 3; i += 1) runs.push(await legacyRun({ releasedAgoMs: (300 + i) * HOUR_MS }));
      const capped = sshRunDirectoryReaperService(db, { legacyPassCap: 2 });

      await capped.sweep({ readDiskUsagePercent: async () => 10 });
      const afterFirst = await Promise.all(runs.map((run) => exists(run.runDir)));
      await capped.sweep({ readDiskUsagePercent: async () => 10 });
      const afterSecond = await Promise.all(runs.map((run) => exists(run.runDir)));

      expect(afterFirst.filter(Boolean)).toHaveLength(1);
      expect(afterSecond.filter(Boolean)).toHaveLength(0);
    }, 120_000);

    it("sends none when its time budget is already spent", async () => {
      const run = await legacyRun({ releasedAgoMs: 310 * HOUR_MS });

      await sshRunDirectoryReaperService(db, { legacyPassBudgetMs: 0 }).sweep({ readDiskUsagePercent: async () => 10 });

      expect(await exists(run.runDir)).toBe(true);
      expect(await decisionOf(run.leaseId)).toBeUndefined();
    }, 60_000);
  });

  it("records the commit a git workspace is uploaded from when the SSH driver realizes it, and nothing for a plain directory", async () => {
    const gitRun = await startRun({ status: "running", recordSeed: false });
    const plainRun = await startRun({ status: "running", recordSeed: false });
    const localRepo = await mkdtemp(path.join(os.tmpdir(), "paperclip-seed-local-"));
    const plainDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-seed-plain-"));
    try {
      await git(localRepo, ["init", "-q", "-b", "main"]);
      await git(localRepo, ["config", "user.name", "Paperclip Test"]);
      await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
      await writeFile(path.join(localRepo, "a.txt"), "a\n");
      await git(localRepo, ["add", "a.txt"]);
      await git(localRepo, ["commit", "-q", "-m", "first"]);
      const head = await git(localRepo, ["rev-parse", "HEAD"]);
      const leaseOf = async (leaseId: string) =>
        (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]! as never;

      await runtime.realizeWorkspace({ environment, lease: await leaseOf(gitRun.leaseId), workspace: { localPath: localRepo } });
      await runtime.realizeWorkspace({ environment, lease: await leaseOf(plainRun.leaseId), workspace: { localPath: plainDir } });

      expect(await leaseMetadata(gitRun.leaseId)).toMatchObject({ sshWorkspaceSeed: { head } });
      expect(await leaseMetadata(plainRun.leaseId)).not.toHaveProperty("sshWorkspaceSeed");
    } finally {
      await rm(localRepo, { recursive: true, force: true });
      await rm(plainDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("records the git command that failed when the worker keeps a directory as preserve_failed", async () => {
    const run = await releasedRun("failed");
    const service = sshRunDirectoryReaperService(db, {
      hooks: { reapRemote: async () => ({ outcome: "kept", reason: "preserve_failed", bytes: 1024, detail: "git status" }) },
    });

    await service.reapReleasedLease(environment, run.lease);

    expect(await leaseMetadata(run.leaseId)).toMatchObject({
      sshRunDirectory: { state: "kept", reason: "preserve_failed", detail: "git status" },
    });
    const [entry] = await activityFor(run.runId, "environment.ssh_run_directory_kept");
    expect(entry?.details).toMatchObject({ reason: "preserve_failed", detail: "git status" });
    expect(await exists(run.runDir)).toBe(true);
  }, 60_000);

  it("gives the claim back and records nothing when the worker has no timeout command, so a later pass can remove the directory", async () => {
    const run = await releasedRun("failed");
    const withoutTimeout = sshRunDirectoryReaperService(db, {
      hooks: { reapRemote: async () => ({ outcome: "unbounded" }) },
    });

    await withoutTimeout.reapReleasedLease(environment, run.lease);

    expect((await leaseMetadata(run.leaseId))?.sshRunDirectory).toBeUndefined();
    expect(await exists(run.runDir)).toBe(true);
    expect(await activityFor(run.runId, "environment.ssh_run_directory_kept")).toHaveLength(0);

    await sshRunDirectoryReaperService(db).reapReleasedLease(environment, run.lease);
    expect(await exists(run.runDir)).toBe(false);
  }, 60_000);
});
