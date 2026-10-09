import { randomUUID } from "node:crypto";
import net from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  instanceSettings,
  resourceCapacitySamples,
  resourceCapacityTargets,
} from "@paperclipai/db";
import {
  RESOURCE_CAPACITY_STALE_AFTER_MS,
  type EnvironmentLeaseStatus,
  type ResourceCapacityReading,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentTargetKey, resourceCapacityService } from "../services/resource-capacity.ts";
import { runResourceCapacityTick } from "../services/resource-capacity-sampler.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource capacity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const GIB = 1024 ** 3;
const T0 = new Date("2026-10-09T12:00:00Z");

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

function reading(freeGib: number, overrides: Partial<ResourceCapacityReading> = {}): ResourceCapacityReading {
  return {
    cpuCount: 4,
    load1: 1,
    load5: 1,
    load15: 1,
    memTotalBytes: 16 * GIB,
    memAvailableBytes: 8 * GIB,
    disks: [{ labels: ["workspaces"], totalBytes: 400 * GIB, freeBytes: freeGib * GIB }],
    ...overrides,
  };
}

async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

describeEmbeddedPostgres("resource capacity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-capacity-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(resourceCapacitySamples);
    await db.delete(resourceCapacityTargets);
    await db.delete(environmentLeases);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createEnvironment(driver: "local" | "ssh", name: string, port = 22) {
    const [row] = await db
      .insert(environments)
      .values({
        name,
        driver,
        config: driver === "ssh"
          ? { host: "127.0.0.1", port, username: "paperclip", remoteWorkspacePath: "/srv/paperclip/ws" }
          : {},
      })
      .returning();
    return row!;
  }

  async function createCompany(name: string, agentEnvironmentIds: Array<string | null>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const [index, environmentId] of agentEnvironmentIds.entries()) {
      await db.insert(agents).values({
        companyId,
        name: `${name} agent ${index}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        defaultEnvironmentId: environmentId,
      });
    }
    return companyId;
  }

  async function samples(targetKey: string) {
    return db
      .select()
      .from(resourceCapacitySamples)
      .where(eq(resourceCapacitySamples.targetKey, targetKey))
      .orderBy(resourceCapacitySamples.sampledAt);
  }

  it("appends history at most every five minutes, plus each level change", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    const environment = await createEnvironment("ssh", "worker-a");
    const targetKey = environmentTargetKey(environment.id);
    const base = { targetKey, targetKind: "environment" as const, environmentId: environment.id, source: "lease_acquire" as const };

    for (const minute of [0, 1, 2, 3, 4]) {
      await svc.recordReading({ ...base, reading: reading(100), now: at(minute) });
    }
    expect(await samples(targetKey)).toHaveLength(1);

    const critical = await svc.recordReading({ ...base, reading: reading(2), now: at(4.5) });
    expect(critical.transitions).toEqual([{ metric: "disk:workspaces", from: "ok", to: "critical" }]);
    await svc.recordReading({ ...base, reading: reading(2), now: at(5) });
    await svc.recordReading({ ...base, reading: reading(2), now: at(9.6) });

    const rows = await samples(targetKey);
    expect(rows.map((row) => [row.sampledAt.toISOString(), row.level])).toEqual([
      [at(0).toISOString(), "ok"],
      [at(4.5).toISOString(), "critical"],
      [at(9.6).toISOString(), "critical"],
    ]);
    const [target] = await db.select().from(resourceCapacityTargets).where(eq(resourceCapacityTargets.targetKey, targetKey));
    expect(target).toMatchObject({ level: "critical", stateVersion: 2, latestSampledAt: at(9.6) });
  });

  it("ignores a reading older than the one already recorded", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    const environment = await createEnvironment("ssh", "worker-a");
    const targetKey = environmentTargetKey(environment.id);
    const base = { targetKey, targetKind: "environment" as const, environmentId: environment.id, source: "sweep" as const };

    await svc.recordReading({ ...base, reading: reading(100), now: at(10) });
    const late = await svc.recordReading({ ...base, reading: reading(1), now: at(9) });

    expect(late).toMatchObject({ applied: false, transitions: [] });
    const [target] = await db.select().from(resourceCapacityTargets).where(eq(resourceCapacityTargets.targetKey, targetKey));
    expect(target).toMatchObject({ level: "ok", latestSampledAt: at(10) });
    expect(target!.metricLevels).toEqual({ "disk:workspaces": "ok", memory: "ok", load: "ok" });
  });

  it("classifies a disk-only reading and keeps the level a failed reading cannot see, until it goes stale", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    const environment = await createEnvironment("ssh", "worker-a");
    const companyId = await createCompany("Shared", [environment.id]);
    const targetKey = environmentTargetKey(environment.id);
    const base = { targetKey, targetKind: "environment" as const, environmentId: environment.id, source: "sweep" as const };

    const diskOnly = await svc.recordReading({
      ...base,
      reading: reading(2, { memTotalBytes: null, memAvailableBytes: null, load5: null }),
      now: at(0),
    });
    expect(diskOnly.status).toBe("partial");
    expect(diskOnly.metricLevels).toEqual({ "disk:workspaces": "critical" });

    const failed = await svc.recordReading({ ...base, reading: null, errorClass: "timeout", now: at(1) });
    expect(failed).toMatchObject({ applied: true, status: "failed", transitions: [] });

    const detail = await svc.getEnvironmentDetail(environment.id, { companyIds: [companyId] }, at(2));
    expect(detail?.environment).toMatchObject({
      level: "critical",
      readingStatus: "failed",
      sampledAt: at(1).toISOString(),
      lastSuccessAt: at(0).toISOString(),
    });
    expect(detail?.environment.disks).toEqual([
      { labels: ["workspaces"], totalBytes: 400 * GIB, freeBytes: 2 * GIB, freePercent: 0.5 },
    ]);

    const stale = new Date(at(0).getTime() + RESOURCE_CAPACITY_STALE_AFTER_MS + 1);
    const staleDetail = await svc.getEnvironmentDetail(environment.id, { companyIds: [companyId] }, stale);
    expect(staleDetail?.environment).toMatchObject({ level: "unknown", metricLevels: {} });
  });

  it("writes one level change when two processes record the same transition", async () => {
    const first = resourceCapacityService(db, { hostname: "test-host" });
    const second = resourceCapacityService(db, { hostname: "test-host" });
    const environment = await createEnvironment("ssh", "worker-a");
    const targetKey = environmentTargetKey(environment.id);
    const base = { targetKey, targetKind: "environment" as const, environmentId: environment.id, source: "sweep" as const };
    await first.recordReading({ ...base, reading: reading(100), now: at(0) });

    const results = await Promise.all([
      first.recordReading({ ...base, reading: reading(1), now: at(1) }),
      second.recordReading({ ...base, reading: reading(1), now: at(1.001) }),
    ]);

    expect(results.flatMap((result) => result.transitions)).toEqual([
      { metric: "disk:workspaces", from: "ok", to: "critical" },
    ]);
    const [target] = await db.select().from(resourceCapacityTargets).where(eq(resourceCapacityTargets.targetKey, targetKey));
    expect(target).toMatchObject({ level: "critical", stateVersion: 2 });
    expect((await samples(targetKey)).map((row) => row.level)).toEqual(["ok", "critical"]);
  });

  it("deletes history older than the retention window", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    const now = at(0);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(resourceCapacitySamples).values(
      [40, 31, 29, 1].map((daysAgo) => ({
        targetKey: "instance:test",
        sampledAt: new Date(now.getTime() - daysAgo * day),
        source: "interval",
        status: "ok",
        level: "ok",
      })),
    );

    expect(await svc.pruneHistory(30, now)).toBe(2);
    expect((await db.select().from(resourceCapacitySamples)).length).toBe(2);
  });

  it("sweeps SSH environments that are leased or not ok, once per interval, and records a failed probe", async () => {
    const port = await closedLoopbackPort();
    const leased = await createEnvironment("ssh", "leased", port);
    const releasedUnread = await createEnvironment("ssh", "released-unread", port);
    const releasedOk = await createEnvironment("ssh", "released-ok", port);
    const neverLeased = await createEnvironment("ssh", "never-leased", port);
    const companyId = await createCompany("Sweep", [leased.id]);
    const active = "active" satisfies EnvironmentLeaseStatus;
    const released = "released" satisfies EnvironmentLeaseStatus;
    await db.insert(environmentLeases).values([
      { companyId, environmentId: leased.id, provider: "ssh", status: active },
      { companyId, environmentId: releasedUnread.id, provider: "ssh", status: released },
      { companyId, environmentId: releasedOk.id, provider: "ssh", status: released },
    ]);
    const now = new Date();
    const first = resourceCapacityService(db, { hostname: "test-host" });
    const second = resourceCapacityService(db, { hostname: "test-host" });
    await first.recordReading({
      targetKey: environmentTargetKey(releasedOk.id),
      targetKind: "environment",
      environmentId: releasedOk.id,
      source: "lease_acquire",
      reading: reading(100),
      now,
    });

    const probed = await Promise.all([first.sweepSshEnvironments(now), second.sweepSshEnvironments(now)]);

    expect(probed[0]! + probed[1]!).toBe(2);
    for (const environment of [leased, releasedUnread]) {
      const [target] = await db
        .select()
        .from(resourceCapacityTargets)
        .where(eq(resourceCapacityTargets.environmentId, environment.id));
      expect(target).toMatchObject({ latestStatus: "failed", level: "unknown" });
      expect(target!.nextSweepAt!.getTime()).toBeGreaterThan(now.getTime());
      expect(await samples(environmentTargetKey(environment.id))).toMatchObject([
        { status: "failed", errorClass: "unavailable" },
      ]);
    }
    expect(await samples(environmentTargetKey(releasedOk.id))).toMatchObject([{ source: "lease_acquire", status: "ok" }]);
    const [unresolvable] = await db
      .select()
      .from(resourceCapacityTargets)
      .where(eq(resourceCapacityTargets.environmentId, neverLeased.id));
    expect(unresolvable).toMatchObject({ latestSampledAt: null });
    expect(unresolvable!.nextSweepAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await samples(environmentTargetKey(neverLeased.id))).toEqual([]);
    expect(await first.sweepSshEnvironments(now)).toBe(0);
  }, 30_000);

  it("shows a company only the environments its agents run on", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    const local = await createEnvironment("local", "Local");
    const shared = await createEnvironment("ssh", "shared-worker");
    const privateWorker = await createEnvironment("ssh", "private-worker");
    const alpha = await createCompany("Alpha", [shared.id, null]);
    const beta = await createCompany("Beta", [shared.id, privateWorker.id]);
    const terminatedOnly = await createCompany("Gamma", [privateWorker.id]);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.companyId, terminatedOnly));
    await svc.recordReading({
      targetKey: environmentTargetKey(privateWorker.id),
      targetKind: "environment",
      environmentId: privateWorker.id,
      source: "sweep",
      reading: reading(100),
    });

    expect([...(await svc.companyEnvironmentIds(alpha))].sort()).toEqual([local.id, shared.id].sort());
    expect([...(await svc.companyEnvironmentIds(beta))].sort()).toEqual([shared.id, privateWorker.id].sort());
    expect((await svc.companyEnvironmentIds(terminatedOnly)).size).toBe(0);

    const alphaView = await svc.getCompanyView(alpha);
    expect(alphaView.environments.map((environment) => environment.environmentName)).toEqual(["Local", "shared-worker"]);
    expect(await svc.getEnvironmentDetail(privateWorker.id, { companyIds: [alpha] })).toBeNull();
    expect(await svc.getEnvironmentDetail(privateWorker.id, { companyIds: [terminatedOnly] })).toBeNull();
    expect((await svc.getEnvironmentDetail(privateWorker.id, { companyIds: [beta] }))?.environment).toMatchObject({
      environmentName: "private-worker",
      sampling: "sampled",
      level: "ok",
    });
    expect((await svc.getEnvironmentDetail(privateWorker.id, { companyIds: null }))?.environment.level).toBe("ok");
    expect(await svc.getEnvironmentDetail(randomUUID(), { companyIds: null })).toBeNull();
  });

  it("uses the company default environment for agents without their own", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    await createEnvironment("local", "Local");
    const worker = await createEnvironment("ssh", "default-worker");
    const companyId = await createCompany("Defaults", [null]);
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { companyEnvironmentDefaults: { [companyId]: worker.id } },
    });

    expect([...(await svc.companyEnvironmentIds(companyId))]).toEqual([worker.id]);
  });

  it("follows the managed-sandbox redirect and forced Kubernetes like a run does", async () => {
    const svc = resourceCapacityService(db, { hostname: "test-host" });
    await createEnvironment("local", "Local");
    const worker = await createEnvironment("ssh", "own-worker");
    const [managed] = await db
      .insert(environments)
      .values({
        name: "Managed sandbox",
        driver: "sandbox",
        config: { provider: "kubernetes" },
        metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
      })
      .returning();
    const companyId = await createCompany("Managed", [null, worker.id]);

    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableManagedSandboxOnly: true } });
    expect([...(await svc.companyEnvironmentIds(companyId))].sort()).toEqual([managed!.id, worker.id].sort());
    const view = await svc.getCompanyView(companyId);
    expect(view.environments.find((environment) => environment.environmentId === managed!.id)).toMatchObject({
      sampling: "unsupported",
      level: "unknown",
    });

    await db.update(instanceSettings).set({ general: { executionMode: "kubernetes" } });
    expect([...(await svc.companyEnvironmentIds(companyId))]).toEqual([managed!.id]);
  });

  it("records this host and prunes history once an hour in a sampler tick", async () => {
    const svc = resourceCapacityService(db, { hostname: "sampler-host" });
    const first = await runResourceCapacityTick({ service: svc, retentionDays: 30, lastPrunedAt: null, now: at(0) });
    expect(first.lastPrunedAt).toBe(at(0).getTime());
    const second = await runResourceCapacityTick({ service: svc, retentionDays: 30, lastPrunedAt: first.lastPrunedAt, now: at(30) });
    expect(second.lastPrunedAt).toBe(at(0).getTime());

    const [target] = await db.select().from(resourceCapacityTargets);
    expect(target).toMatchObject({ targetKey: svc.currentInstanceKey, targetKind: "instance", latestSampledAt: at(30) });
    expect(target!.level).not.toBe("unknown");
    const view = await svc.getInstanceView(at(31));
    expect(view.hosts).toHaveLength(1);
    expect(view.hosts[0]).toMatchObject({ current: true, targetKey: svc.currentInstanceKey });
    expect(view.hosts[0]!.disks.length).toBeGreaterThan(0);
  });
});
