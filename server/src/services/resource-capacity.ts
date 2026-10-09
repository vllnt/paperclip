import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  agents,
  environmentLeases,
  resourceCapacitySamples,
  resourceCapacityTargets,
  type Db,
} from "@paperclipai/db";
import {
  appendResourceProbe,
  parseResourceProbeOutput,
  splitResourceProbeOutput,
  type ResourceProbeReading,
} from "@paperclipai/adapter-utils/resource-probe";
import { runSshCommand, shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  DEFAULT_RESOURCE_CAPACITY_THRESHOLDS,
  classifyResourceCapacityReading,
  freshResourceCapacityMetricLevels,
  measuredResourceCapacityMetrics,
  resolveCompanyEnvironmentDefault,
  resourceCapacityReadingStatus,
  worstResourceCapacityLevel,
  type CompanyResourceCapacity,
  type Environment,
  type EnvironmentResourceCapacity,
  type EnvironmentResourceCapacityDetail,
  type InstanceResourceCapacity,
  type ResourceCapacityErrorClass,
  type ResourceCapacityMetricKey,
  type ResourceCapacityMetricLevel,
  type ResourceCapacityMetricLevels,
  type ResourceCapacityMetricSampledAt,
  type ResourceCapacityReading,
  type ResourceCapacityReadingStatus,
  type ResourceCapacitySnapshot,
  type ResourceCapacitySource,
  type ResourceCapacityThresholds,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";
import { isExecutionForcedToKubernetes } from "./execution-allowlist.js";
import { resolveExecutionWorkspaceEnvironmentId } from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { instanceTargetKey } from "./resource-capacity-host.js";

/** History keeps at most one row per target per this interval, plus level changes. */
export const RESOURCE_CAPACITY_HISTORY_INTERVAL_MS = 5 * 60 * 1000;
/** SSH sweep interval per environment, and while a level is `critical`. */
export const RESOURCE_CAPACITY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const RESOURCE_CAPACITY_CRITICAL_SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_COMMAND_TIMEOUT_MS = 10_000;
const RETENTION_BATCH_SIZE = 5_000;
const RETENTION_LOCK_KEY = "resource-capacity-retention";

type TargetRow = typeof resourceCapacityTargets.$inferSelect;

export interface ResourceCapacityTransition {
  metric: ResourceCapacityMetricKey;
  from: ResourceCapacityMetricLevel | null;
  to: ResourceCapacityMetricLevel;
}

export interface RecordResourceCapacityInput {
  targetKey: string;
  targetKind: "instance" | "environment";
  environmentId?: string | null;
  hostLabel?: string | null;
  source: ResourceCapacitySource;
  /** Null when the probe could not run; recorded as `failed` with `errorClass`. */
  reading: ResourceCapacityReading | null;
  errorClass?: ResourceCapacityErrorClass | null;
  /** When the reading was taken; defaults to now. */
  now?: Date;
}

export interface RecordResourceCapacityResult {
  /** False when a newer reading of the target was already recorded; nothing changed. */
  applied: boolean;
  status: ResourceCapacityReadingStatus;
  metricLevels: ResourceCapacityMetricLevels;
  /** Level changes this call wrote. */
  transitions: ResourceCapacityTransition[];
  historyAppended: boolean;
}

/**
 * Converts an SSH probe reading into a capacity reading. The probe measures
 * the environment's workspace root.
 */
export function readingFromProbe(probe: ResourceProbeReading): ResourceCapacityReading {
  return {
    cpuCount: probe.cpuCount,
    load1: probe.load?.load1 ?? null,
    load5: probe.load?.load5 ?? null,
    load15: probe.load?.load15 ?? null,
    memTotalBytes: probe.memTotalBytes,
    memAvailableBytes: probe.memAvailableBytes,
    disks: probe.disk ? [{ labels: ["workspaces"], ...probe.disk }] : [],
  };
}

export function environmentTargetKey(environmentId: string): string {
  return `environment:${environmentId}`;
}

function sweepIntervalMs(level: string): number {
  return level === "critical" ? RESOURCE_CAPACITY_CRITICAL_SWEEP_INTERVAL_MS : RESOURCE_CAPACITY_SWEEP_INTERVAL_MS;
}

function transitionsBetween(
  previous: ResourceCapacityMetricLevels,
  next: ResourceCapacityMetricLevels,
): ResourceCapacityTransition[] {
  const transitions: ResourceCapacityTransition[] = [];
  for (const [metric, to] of Object.entries(next) as Array<[ResourceCapacityMetricKey, ResourceCapacityMetricLevel]>) {
    const from = previous[metric] ?? null;
    if (from !== to) transitions.push({ metric, from, to });
  }
  return transitions.sort((a, b) => a.metric.localeCompare(b.metric));
}

function classifySshError(error: unknown): ResourceCapacityErrorClass {
  const failure = error as { killed?: boolean; signal?: string | null; code?: unknown; stderr?: unknown };
  if (failure?.killed || failure?.signal) return "timeout";
  if (typeof failure?.stderr === "string" && failure.stderr.includes("Permission denied")) return "auth";
  if (failure?.code === 255) return "unavailable";
  if (typeof failure?.code === "number") return "exit_nonzero";
  return "unavailable";
}

function metricSampledAtOf(row: TargetRow | null): ResourceCapacityMetricSampledAt {
  return (row?.metricSampledAt ?? {}) as ResourceCapacityMetricSampledAt;
}

function lastMeasuredAt(metricSampledAt: ResourceCapacityMetricSampledAt): string | null {
  const times = Object.values(metricSampledAt).filter((value): value is string => typeof value === "string");
  return times.length > 0 ? times.reduce((latest, value) => (value > latest ? value : latest)) : null;
}

function toSnapshot(row: TargetRow | null, now: Date): ResourceCapacitySnapshot {
  const reading = (row?.latestReading ?? null) as ResourceCapacityReading | null;
  const metricSampledAt = metricSampledAtOf(row);
  const metricLevels = freshResourceCapacityMetricLevels({
    metricLevels: (row?.metricLevels ?? {}) as ResourceCapacityMetricLevels,
    metricSampledAt,
    now,
  });
  const cpuCount = reading?.cpuCount ?? null;
  const load5 = reading?.load5 ?? null;
  return {
    level: worstResourceCapacityLevel(metricLevels),
    metricLevels,
    sampledAt: row?.latestSampledAt?.toISOString() ?? null,
    lastSuccessAt: lastMeasuredAt(metricSampledAt),
    readingStatus: (row?.latestStatus ?? null) as ResourceCapacityReadingStatus | null,
    cpuCount,
    load1: reading?.load1 ?? null,
    load5,
    load15: reading?.load15 ?? null,
    loadPerCore: cpuCount && load5 !== null ? Math.round((load5 / cpuCount) * 100) / 100 : null,
    memTotalBytes: reading?.memTotalBytes ?? null,
    memAvailableBytes: reading?.memAvailableBytes ?? null,
    disks: (reading?.disks ?? []).map((disk) => ({
      ...disk,
      freePercent: Math.round((disk.freeBytes / disk.totalBytes) * 1000) / 10,
    })),
  };
}

/**
 * A local environment runs on this host, so it shows the instance reading,
 * restricted to the workspace disk: the other instance roots are reported
 * to instance admins only.
 */
function localEnvironmentSnapshot(instance: TargetRow | null, now: Date): ResourceCapacitySnapshot {
  const snapshot = toSnapshot(instance, now);
  const metricLevels: ResourceCapacityMetricLevels = {};
  for (const key of ["disk:workspaces", "memory", "load"] as const) {
    const level = snapshot.metricLevels[key];
    if (level) metricLevels[key] = level;
  }
  return {
    ...snapshot,
    level: worstResourceCapacityLevel(metricLevels),
    metricLevels,
    disks: snapshot.disks
      .filter((disk) => disk.labels.includes("workspaces"))
      .map((disk) => ({ ...disk, labels: ["workspaces"] })),
  };
}

/**
 * The reading's measured values, for merging into the stored latest
 * reading: a metric a partial reading lacks keeps its last value.
 */
function measuredValues(reading: ResourceCapacityReading): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reading)) {
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    values[key] = value;
  }
  return values;
}

export function resourceCapacityService(
  db: Db,
  options: { thresholds?: ResourceCapacityThresholds; hostname?: string } = {},
) {
  const thresholds = options.thresholds ?? DEFAULT_RESOURCE_CAPACITY_THRESHOLDS;
  const currentInstanceKey = instanceTargetKey(options.hostname);
  const instanceSettings = instanceSettingsService(db);
  const environmentsSvc = environmentService(db);

  /**
   * Records one reading: latest state on every call, level changes by
   * compare-and-set on `state_version`, and a history row at most every
   * five minutes or on a level change. Safe to call from several server
   * processes at once.
   */
  async function recordReading(input: RecordResourceCapacityInput): Promise<RecordResourceCapacityResult> {
    const sampledAt = input.now ?? new Date();
    const status: ResourceCapacityReadingStatus = input.reading
      ? resourceCapacityReadingStatus(input.reading)
      : "failed";
    const measured = input.reading && status !== "failed" ? measuredResourceCapacityMetrics(input.reading) : [];
    const measuredAt = Object.fromEntries(measured.map((metric) => [metric, sampledAt.toISOString()]));
    return db.transaction(async (tx) => {
      await tx
        .insert(resourceCapacityTargets)
        .values({
          targetKey: input.targetKey,
          targetKind: input.targetKind,
          environmentId: input.environmentId ?? null,
          hostLabel: input.hostLabel ?? null,
        })
        .onConflictDoNothing();

      // Latest state first, and only from a reading newer than the stored
      // one, so a delayed reading never replaces a newer one. The update
      // locks the row until commit, so recordings of one target apply one
      // at a time and the classification below sees committed levels.
      const row = await tx
        .update(resourceCapacityTargets)
        .set({
          latestSampledAt: sampledAt,
          latestStatus: status,
          ...(measured.length > 0 && input.reading
            ? {
                latestReading: sql`coalesce(${resourceCapacityTargets.latestReading}, '{}'::jsonb) || ${JSON.stringify(measuredValues(input.reading))}::jsonb`,
                metricSampledAt: sql`${resourceCapacityTargets.metricSampledAt} || ${JSON.stringify(measuredAt)}::jsonb`,
              }
            : {}),
          ...(input.hostLabel !== undefined ? { hostLabel: input.hostLabel } : {}),
          updatedAt: sampledAt,
        })
        .where(
          and(
            eq(resourceCapacityTargets.targetKey, input.targetKey),
            or(isNull(resourceCapacityTargets.latestSampledAt), lt(resourceCapacityTargets.latestSampledAt, sampledAt)),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return { applied: false, status, metricLevels: {}, transitions: [], historyAppended: false };

      const previous = row.metricLevels as ResourceCapacityMetricLevels;
      let metricLevels = measured.length > 0 && input.reading
        ? classifyResourceCapacityReading(input.reading, previous, thresholds)
        : previous;
      let transitions = transitionsBetween(previous, metricLevels);
      if (transitions.length > 0) {
        const won = await tx
          .update(resourceCapacityTargets)
          .set({
            metricLevels,
            level: worstResourceCapacityLevel(metricLevels),
            stateVersion: sql`${resourceCapacityTargets.stateVersion} + 1`,
            levelChangedAt: sampledAt,
            lastHistoryAt: sampledAt,
          })
          .where(
            and(
              eq(resourceCapacityTargets.targetKey, input.targetKey),
              eq(resourceCapacityTargets.stateVersion, row.stateVersion),
            ),
          )
          .returning({ targetKey: resourceCapacityTargets.targetKey });
        if (won.length === 0) {
          metricLevels = previous;
          transitions = [];
        }
      }
      if (input.targetKind === "environment") {
        await tx
          .update(resourceCapacityTargets)
          .set({
            nextSweepAt: new Date(sampledAt.getTime() + sweepIntervalMs(worstResourceCapacityLevel(metricLevels))),
          })
          .where(eq(resourceCapacityTargets.targetKey, input.targetKey));
      }

      let historyAppended = transitions.length > 0;
      if (!historyAppended) {
        const cutoff = new Date(sampledAt.getTime() - RESOURCE_CAPACITY_HISTORY_INTERVAL_MS);
        const claimed = await tx
          .update(resourceCapacityTargets)
          .set({ lastHistoryAt: sampledAt })
          .where(
            and(
              eq(resourceCapacityTargets.targetKey, input.targetKey),
              or(isNull(resourceCapacityTargets.lastHistoryAt), lte(resourceCapacityTargets.lastHistoryAt, cutoff)),
            ),
          )
          .returning({ targetKey: resourceCapacityTargets.targetKey });
        historyAppended = claimed.length > 0;
      }
      if (historyAppended) {
        await tx.insert(resourceCapacitySamples).values({
          targetKey: input.targetKey,
          environmentId: input.environmentId ?? null,
          sampledAt,
          source: input.source,
          status,
          errorClass: status === "failed" ? input.errorClass ?? "unparseable" : null,
          cpuCount: input.reading?.cpuCount ?? null,
          load1: input.reading?.load1 ?? null,
          load5: input.reading?.load5 ?? null,
          load15: input.reading?.load15 ?? null,
          memTotalBytes: input.reading?.memTotalBytes ?? null,
          memAvailableBytes: input.reading?.memAvailableBytes ?? null,
          disks: input.reading?.disks ?? [],
          level: worstResourceCapacityLevel(metricLevels),
        });
      }
      return { applied: true, status, metricLevels, transitions, historyAppended };
    });
  }

  /** Records an SSH reading taken by lease acquire. Never throws. */
  async function recordLeaseAcquireProbe(
    environmentId: string,
    probe: ResourceProbeReading | null,
    sampledAt: Date,
  ): Promise<void> {
    try {
      await recordReading({
        targetKey: environmentTargetKey(environmentId),
        targetKind: "environment",
        environmentId,
        source: "lease_acquire",
        reading: probe ? readingFromProbe(probe) : null,
        errorClass: probe ? null : "unparseable",
        now: sampledAt,
      });
    } catch (error) {
      logger.warn({ err: error, environmentId }, "resource capacity: failed to record lease-acquire reading");
    }
  }

  async function companyForSweep(environmentId: string): Promise<string | null> {
    const lease = await db
      .select({ companyId: environmentLeases.companyId })
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environmentId))
      .orderBy(sql`${environmentLeases.status} = 'active' desc`, desc(environmentLeases.lastUsedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return lease?.companyId ?? null;
  }

  async function probeSshEnvironment(environment: Environment, companyId: string, now: Date): Promise<void> {
    let reading: ResourceCapacityReading | null = null;
    let errorClass: ResourceCapacityErrorClass | null = null;
    try {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
      if (parsed.driver !== "ssh") return;
      const result = await runSshCommand(
        parsed.config,
        appendResourceProbe(`cd ${shellQuote(parsed.config.remoteWorkspacePath)}`),
        { timeoutMs: SWEEP_COMMAND_TIMEOUT_MS },
      );
      const { probe } = splitResourceProbeOutput(result.stdout);
      if (probe === null) errorClass = "unparseable";
      else reading = readingFromProbe(parseResourceProbeOutput(probe));
    } catch (error) {
      errorClass = classifySshError(error);
    }
    await recordReading({
      targetKey: environmentTargetKey(environment.id),
      targetKind: "environment",
      environmentId: environment.id,
      source: "sweep",
      reading,
      errorClass,
      now: new Date(Math.max(Date.now(), now.getTime())),
    });
  }

  /**
   * Probes SSH environments that have an active lease or whose effective
   * level is not `ok` (a stale `ok` reads as `unknown`), one at a time. Each
   * environment is claimed by compare-and-set on `next_sweep_at`, so several
   * processes never probe it in one interval. The probe resolves secrets
   * under the company of the environment's latest lease, so an environment
   * that was never leased is claimed but not probed: it stays `unknown`
   * until its first run's lease-acquire probe.
   *
   * @returns The number of environments probed.
   */
  async function sweepSshEnvironments(now: Date = new Date()): Promise<number> {
    const sshEnvironments = await environmentsSvc.list({ driver: "ssh", status: "active" });
    if (sshEnvironments.length === 0) return 0;
    const ids = sshEnvironments.map((environment) => environment.id);
    const [targets, leased] = await Promise.all([
      targetRows(ids.map(environmentTargetKey)),
      db
        .selectDistinct({ environmentId: environmentLeases.environmentId })
        .from(environmentLeases)
        .where(and(inArray(environmentLeases.environmentId, ids), eq(environmentLeases.status, "active"))),
    ]);
    const leasedIds = new Set(leased.map((row) => row.environmentId));
    const candidates = sshEnvironments
      .map((environment) => ({
        environment,
        level: toSnapshot(targets.get(environmentTargetKey(environment.id)) ?? null, now).level,
      }))
      .filter(({ environment, level }) => leasedIds.has(environment.id) || level !== "ok");
    let probed = 0;
    for (const { environment, level } of candidates) {
      try {
        const targetKey = environmentTargetKey(environment.id);
        await db
          .insert(resourceCapacityTargets)
          .values({ targetKey, targetKind: "environment", environmentId: environment.id })
          .onConflictDoNothing();
        const claimed = await db
          .update(resourceCapacityTargets)
          .set({ nextSweepAt: new Date(now.getTime() + sweepIntervalMs(level)) })
          .where(
            and(
              eq(resourceCapacityTargets.targetKey, targetKey),
              or(isNull(resourceCapacityTargets.nextSweepAt), lte(resourceCapacityTargets.nextSweepAt, now)),
            ),
          )
          .returning({ targetKey: resourceCapacityTargets.targetKey });
        if (claimed.length === 0) continue;
        const companyId = await companyForSweep(environment.id);
        if (!companyId) continue;
        await probeSshEnvironment(environment, companyId, now);
        probed += 1;
      } catch (error) {
        logger.warn({ err: error, environmentId: environment.id }, "resource capacity: SSH sweep failed");
      }
    }
    return probed;
  }

  /**
   * Deletes history older than the retention window in batches. Only the
   * process holding the advisory lock deletes.
   *
   * @returns The number of rows deleted, or null when another process holds the lock.
   */
  async function pruneHistory(retentionDays: number, now: Date = new Date()): Promise<number | null> {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    return db.transaction(async (tx) => {
      const locks = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${RETENTION_LOCK_KEY}, 0)) as acquired`,
      );
      if (!locks[0]?.acquired) return null;
      let deleted = 0;
      for (;;) {
        const batch = await tx
          .delete(resourceCapacitySamples)
          .where(
            inArray(
              resourceCapacitySamples.id,
              tx
                .select({ id: resourceCapacitySamples.id })
                .from(resourceCapacitySamples)
                .where(sql`${resourceCapacitySamples.sampledAt} < ${cutoff.toISOString()}`)
                .orderBy(resourceCapacitySamples.sampledAt)
                .limit(RETENTION_BATCH_SIZE),
            ),
          )
          .returning({ id: resourceCapacitySamples.id });
        deleted += batch.length;
        if (batch.length < RETENTION_BATCH_SIZE) return deleted;
      }
    });
  }

  async function targetRows(keys: string[]): Promise<Map<string, TargetRow>> {
    if (keys.length === 0) return new Map();
    const rows = await db.select().from(resourceCapacityTargets).where(inArray(resourceCapacityTargets.targetKey, keys));
    return new Map(rows.map((row) => [row.targetKey, row]));
  }

  function environmentCapacity(
    environment: Environment,
    targets: Map<string, TargetRow>,
    now: Date,
  ): EnvironmentResourceCapacity {
    const base = { environmentId: environment.id, environmentName: environment.name, driver: environment.driver };
    if (environment.driver === "local") {
      return {
        ...base,
        sampling: "sampled",
        ...localEnvironmentSnapshot(targets.get(currentInstanceKey) ?? null, now),
      };
    }
    if (environment.driver === "ssh") {
      return {
        ...base,
        sampling: "sampled",
        ...toSnapshot(targets.get(environmentTargetKey(environment.id)) ?? null, now),
      };
    }
    return { ...base, sampling: "unsupported", ...toSnapshot(null, now) };
  }

  /**
   * The environment each non-terminated agent of a company runs on, resolved
   * with the same rules as a run: agent default, company or instance default,
   * the local environment; the managed-sandbox redirect; forced Kubernetes.
   * Read-only: it never creates an environment.
   */
  async function companyEnvironmentIds(companyId: string): Promise<Set<string>> {
    const companyAgents = await db
      .select({ defaultEnvironmentId: agents.defaultEnvironmentId })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    if (companyAgents.length === 0) return new Set();
    const [settings, experimental] = await Promise.all([instanceSettings.get(), instanceSettings.getExperimental()]);
    const managedSandboxOnly = experimental.enableManagedSandboxOnly === true;
    if (isExecutionForcedToKubernetes({ executionMode: settings.general.executionMode, managedSandboxOnly })) {
      const kubernetes = await environmentsSvc.findKubernetesEnvironment(companyId);
      return new Set(kubernetes ? [kubernetes.id] : []);
    }
    const [local] = await environmentsSvc.list({ driver: "local" });
    const managedSandbox = managedSandboxOnly ? await environmentsSvc.findManagedSandboxEnvironment(companyId) : null;
    const companyDefault = resolveCompanyEnvironmentDefault(settings, companyId);
    const ids = new Set<string>();
    for (const agent of companyAgents) {
      if (!local) {
        const id = agent.defaultEnvironmentId ?? companyDefault;
        if (id) ids.add(id);
        continue;
      }
      try {
        ids.add(
          resolveExecutionWorkspaceEnvironmentId({
            agentDefaultEnvironmentId: agent.defaultEnvironmentId,
            instanceDefaultEnvironmentId: companyDefault,
            localDefaultEnvironmentId: local.id,
            managedSandboxOnly,
            managedSandboxEnvironmentId: managedSandbox?.id ?? null,
          }).environmentId,
        );
      } catch {
        // Managed-sandbox-only with no managed environment: such runs fail
        // closed, so the agent runs nowhere.
        continue;
      }
    }
    return ids;
  }

  async function getInstanceView(now: Date = new Date()): Promise<InstanceResourceCapacity> {
    const [hosts, allEnvironments] = await Promise.all([
      db.select().from(resourceCapacityTargets).where(eq(resourceCapacityTargets.targetKind, "instance")),
      environmentsSvc.list({ status: "active" }),
    ]);
    const targets = await targetRows([
      currentInstanceKey,
      ...allEnvironments.map((environment) => environmentTargetKey(environment.id)),
    ]);
    return {
      generatedAt: now.toISOString(),
      hosts: hosts
        .map((row) => ({
          targetKey: row.targetKey,
          hostLabel: row.hostLabel,
          current: row.targetKey === currentInstanceKey,
          ...toSnapshot(row, now),
        }))
        .sort((a, b) => Number(b.current) - Number(a.current) || a.targetKey.localeCompare(b.targetKey)),
      environments: allEnvironments
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((environment) => environmentCapacity(environment, targets, now)),
    };
  }

  async function getCompanyView(companyId: string, now: Date = new Date()): Promise<CompanyResourceCapacity> {
    const ids = [...(await companyEnvironmentIds(companyId))];
    const rows = (await Promise.all(ids.map((id) => environmentsSvc.getById(id))))
      .filter((environment): environment is Environment => environment !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    const targets = await targetRows([currentInstanceKey, ...ids.map(environmentTargetKey)]);
    return {
      generatedAt: now.toISOString(),
      companyId,
      environments: rows.map((environment) => environmentCapacity(environment, targets, now)),
    };
  }

  /**
   * One environment's capacity, or null when it does not exist or none of
   * `access.companyIds` can use it (`null` means any: instance admins).
   */
  async function getEnvironmentDetail(
    environmentId: string,
    access: { companyIds: string[] | null },
    now: Date = new Date(),
  ): Promise<EnvironmentResourceCapacityDetail | null> {
    const environment = await environmentsSvc.getById(environmentId);
    if (!environment) return null;
    if (access.companyIds !== null) {
      let usable = false;
      for (const companyId of access.companyIds) {
        if ((await companyEnvironmentIds(companyId)).has(environmentId)) {
          usable = true;
          break;
        }
      }
      if (!usable) return null;
    }
    const targets = await targetRows([currentInstanceKey, environmentTargetKey(environmentId)]);
    return { generatedAt: now.toISOString(), environment: environmentCapacity(environment, targets, now) };
  }

  /** This host's effective level, for the admin health field. */
  async function getCurrentInstanceLevel(now: Date = new Date()) {
    const row = (await targetRows([currentInstanceKey])).get(currentInstanceKey) ?? null;
    const snapshot = toSnapshot(row, now);
    return { level: snapshot.level, sampledAt: snapshot.sampledAt };
  }

  return {
    currentInstanceKey,
    recordReading,
    recordLeaseAcquireProbe,
    sweepSshEnvironments,
    pruneHistory,
    companyEnvironmentIds,
    getInstanceView,
    getCompanyView,
    getEnvironmentDetail,
    getCurrentInstanceLevel,
  };
}

export type ResourceCapacityService = ReturnType<typeof resourceCapacityService>;
