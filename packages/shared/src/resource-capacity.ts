// Host resource capacity ("resource capacity"): disk, memory and load of the
// Paperclip host and its workers. Not provider capacity (model quota) and not
// agent run slots.

export const RESOURCE_CAPACITY_LEVELS = ["ok", "low", "critical", "unknown"] as const;
export type ResourceCapacityLevel = (typeof RESOURCE_CAPACITY_LEVELS)[number];
/** Levels a metric can hold; `unknown` is derived on read from staleness. */
export type ResourceCapacityMetricLevel = Exclude<ResourceCapacityLevel, "unknown">;

export const RESOURCE_CAPACITY_TARGET_KINDS = ["instance", "environment"] as const;
export type ResourceCapacityTargetKind = (typeof RESOURCE_CAPACITY_TARGET_KINDS)[number];

/** Closed set of disk-root labels; paths are never part of a reading. */
export const RESOURCE_CAPACITY_DISK_LABELS = ["data", "runLogs", "workspaces"] as const;
export type ResourceCapacityDiskLabel = (typeof RESOURCE_CAPACITY_DISK_LABELS)[number];

export const RESOURCE_CAPACITY_READING_STATUSES = ["ok", "partial", "failed"] as const;
export type ResourceCapacityReadingStatus = (typeof RESOURCE_CAPACITY_READING_STATUSES)[number];

export const RESOURCE_CAPACITY_SOURCES = ["interval", "lease_acquire", "sweep"] as const;
export type ResourceCapacitySource = (typeof RESOURCE_CAPACITY_SOURCES)[number];

export const RESOURCE_CAPACITY_ERROR_CLASSES = ["timeout", "auth", "exit_nonzero", "unparseable", "unavailable"] as const;
export type ResourceCapacityErrorClass = (typeof RESOURCE_CAPACITY_ERROR_CLASSES)[number];

/** A reading older than this, or no reading at all, makes a target `unknown`. */
export const RESOURCE_CAPACITY_STALE_AFTER_MS = 15 * 60 * 1000;

export interface ResourceCapacityDisk {
  labels: ResourceCapacityDiskLabel[];
  totalBytes: number;
  freeBytes: number;
}

export interface ResourceCapacityReading {
  cpuCount: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  disks: ResourceCapacityDisk[];
}

export interface ResourceCapacityThresholds {
  diskLowPercent: number;
  diskLowBytes: number;
  diskCriticalPercent: number;
  diskCriticalBytes: number;
  memoryLowPercent: number;
  memoryLowBytes: number;
  memoryCriticalPercent: number;
  memoryCriticalBytes: number;
  /** Load average over five minutes per CPU at or above which load is `low`. */
  loadLowPerCore: number;
}

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

export const DEFAULT_RESOURCE_CAPACITY_THRESHOLDS: ResourceCapacityThresholds = {
  diskLowPercent: 15,
  diskLowBytes: 20 * GIB,
  diskCriticalPercent: 5,
  diskCriticalBytes: 5 * GIB,
  memoryLowPercent: 15,
  memoryLowBytes: 2 * GIB,
  memoryCriticalPercent: 5,
  memoryCriticalBytes: 512 * MIB,
  loadLowPerCore: 1.5,
};

/** A metric leaves `critical` only above this multiple of its critical threshold. */
export const RESOURCE_CAPACITY_CRITICAL_EXIT_FACTOR = 1.25;
/** A metric leaves `low` only above this multiple of its low threshold. */
export const RESOURCE_CAPACITY_LOW_EXIT_FACTOR = 1.1;

/** Metric keys: `disk:<label>` per disk root (first label), `memory`, `load`. */
export type ResourceCapacityMetricKey = `disk:${ResourceCapacityDiskLabel}` | "memory" | "load";
export type ResourceCapacityMetricLevels = Partial<Record<ResourceCapacityMetricKey, ResourceCapacityMetricLevel>>;

const LEVEL_RANK: Record<ResourceCapacityMetricLevel, number> = { ok: 0, low: 1, critical: 2 };

/**
 * A free-space threshold: the smaller of a share of the total and an absolute
 * size, so large volumes are not flagged with hundreds of GB free and small
 * ones are not allowed to reach zero.
 *
 * @example thresholdBytes(460 * GIB, 5, 5 * GIB) === 5 * GIB
 */
export function resourceCapacityThresholdBytes(totalBytes: number, percent: number, bytes: number): number {
  return Math.min((totalBytes * percent) / 100, bytes);
}

/** `ok` with disk and memory, `partial` with some metric, `failed` with none. */
export function resourceCapacityReadingStatus(reading: ResourceCapacityReading): ResourceCapacityReadingStatus {
  const hasDisk = reading.disks.length > 0;
  const hasMemory = reading.memTotalBytes !== null && reading.memAvailableBytes !== null;
  const hasLoad = reading.load5 !== null && reading.cpuCount !== null;
  if (hasDisk && hasMemory) return "ok";
  return hasDisk || hasMemory || hasLoad ? "partial" : "failed";
}

function freeSpaceLevel(input: {
  freeBytes: number;
  previous: ResourceCapacityMetricLevel | undefined;
  low: number;
  critical: number;
}): ResourceCapacityMetricLevel {
  if (input.freeBytes < input.critical) return "critical";
  if (input.previous === "critical" && input.freeBytes < input.critical * RESOURCE_CAPACITY_CRITICAL_EXIT_FACTOR) {
    return "critical";
  }
  if (input.freeBytes < input.low) return "low";
  if (
    (input.previous === "low" || input.previous === "critical")
    && input.freeBytes < input.low * RESOURCE_CAPACITY_LOW_EXIT_FACTOR
  ) {
    return "low";
  }
  return "ok";
}

/**
 * Classifies each metric in a reading, with hysteresis against the previous
 * levels. Metrics absent from the reading keep their previous level, so a
 * partial reading never fakes a recovery.
 *
 * @returns The new per-metric levels.
 */
export function classifyResourceCapacityReading(
  reading: ResourceCapacityReading,
  previous: ResourceCapacityMetricLevels,
  thresholds: ResourceCapacityThresholds = DEFAULT_RESOURCE_CAPACITY_THRESHOLDS,
): ResourceCapacityMetricLevels {
  const next: ResourceCapacityMetricLevels = { ...previous };
  for (const disk of reading.disks) {
    const label = disk.labels[0];
    if (!label || disk.totalBytes <= 0) continue;
    const key: ResourceCapacityMetricKey = `disk:${label}`;
    next[key] = freeSpaceLevel({
      freeBytes: disk.freeBytes,
      previous: previous[key],
      low: resourceCapacityThresholdBytes(disk.totalBytes, thresholds.diskLowPercent, thresholds.diskLowBytes),
      critical: resourceCapacityThresholdBytes(
        disk.totalBytes,
        thresholds.diskCriticalPercent,
        thresholds.diskCriticalBytes,
      ),
    });
  }
  if (reading.memTotalBytes !== null && reading.memAvailableBytes !== null && reading.memTotalBytes > 0) {
    next.memory = freeSpaceLevel({
      freeBytes: reading.memAvailableBytes,
      previous: previous.memory,
      low: resourceCapacityThresholdBytes(reading.memTotalBytes, thresholds.memoryLowPercent, thresholds.memoryLowBytes),
      critical: resourceCapacityThresholdBytes(
        reading.memTotalBytes,
        thresholds.memoryCriticalPercent,
        thresholds.memoryCriticalBytes,
      ),
    });
  }
  if (reading.load5 !== null && reading.cpuCount !== null && reading.cpuCount > 0) {
    const perCore = reading.load5 / reading.cpuCount;
    const stillLow = previous.load === "low" && perCore >= thresholds.loadLowPerCore / RESOURCE_CAPACITY_LOW_EXIT_FACTOR;
    next.load = perCore >= thresholds.loadLowPerCore || stillLow ? "low" : "ok";
  }
  return next;
}

/** The worst metric level, or `unknown` when no metric has been classified. */
export function worstResourceCapacityLevel(levels: ResourceCapacityMetricLevels): ResourceCapacityLevel {
  let worst: ResourceCapacityMetricLevel | null = null;
  for (const level of Object.values(levels)) {
    if (level && (worst === null || LEVEL_RANK[level] > LEVEL_RANK[worst])) worst = level;
  }
  return worst ?? "unknown";
}

/** The metric keys currently at `critical`, in a stable order. */
export function criticalResourceCapacityMetrics(levels: ResourceCapacityMetricLevels): ResourceCapacityMetricKey[] {
  return (Object.entries(levels) as Array<[ResourceCapacityMetricKey, ResourceCapacityMetricLevel | undefined]>)
    .filter(([, level]) => level === "critical")
    .map(([key]) => key)
    .sort();
}

/** When each metric was last measured, as ISO-8601 strings. */
export type ResourceCapacityMetricSampledAt = Partial<Record<ResourceCapacityMetricKey, string>>;

/**
 * The metric levels measured within {@link RESOURCE_CAPACITY_STALE_AFTER_MS}.
 * A metric not measured recently is dropped, so a stale `critical` never
 * holds work (fail-open).
 */
export function freshResourceCapacityMetricLevels(input: {
  metricLevels: ResourceCapacityMetricLevels;
  metricSampledAt: ResourceCapacityMetricSampledAt;
  now: Date;
}): ResourceCapacityMetricLevels {
  const fresh: ResourceCapacityMetricLevels = {};
  for (const [metric, level] of Object.entries(input.metricLevels) as Array<
    [ResourceCapacityMetricKey, ResourceCapacityMetricLevel | undefined]
  >) {
    const sampledAt = input.metricSampledAt[metric];
    const age = sampledAt ? input.now.getTime() - Date.parse(sampledAt) : Number.NaN;
    if (level && age <= RESOURCE_CAPACITY_STALE_AFTER_MS) fresh[metric] = level;
  }
  return fresh;
}

/** The metric keys a reading measured. */
export function measuredResourceCapacityMetrics(reading: ResourceCapacityReading): ResourceCapacityMetricKey[] {
  const keys: ResourceCapacityMetricKey[] = [];
  for (const disk of reading.disks) {
    if (disk.labels[0] && disk.totalBytes > 0) keys.push(`disk:${disk.labels[0]}`);
  }
  if (reading.memTotalBytes !== null && reading.memAvailableBytes !== null && reading.memTotalBytes > 0) {
    keys.push("memory");
  }
  if (reading.load5 !== null && reading.cpuCount !== null && reading.cpuCount > 0) keys.push("load");
  return keys;
}

/**
 * A target's effective level: the worst metric measured within
 * {@link RESOURCE_CAPACITY_STALE_AFTER_MS}, or `unknown` when none is.
 */
export function effectiveResourceCapacityLevel(input: {
  metricLevels: ResourceCapacityMetricLevels;
  metricSampledAt: ResourceCapacityMetricSampledAt;
  now: Date;
}): ResourceCapacityLevel {
  return worstResourceCapacityLevel(freshResourceCapacityMetricLevels(input));
}

/** One measured disk in an API response. */
export interface ResourceCapacityDiskView extends ResourceCapacityDisk {
  freePercent: number;
}

/** The latest state of one target, as the read routes return it. Numbers and labels only. */
export interface ResourceCapacitySnapshot {
  /** Effective level: `unknown` when no recent reading. */
  level: ResourceCapacityLevel;
  metricLevels: ResourceCapacityMetricLevels;
  sampledAt: string | null;
  /** The most recent time any metric was measured. */
  lastSuccessAt: string | null;
  readingStatus: ResourceCapacityReadingStatus | null;
  cpuCount: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  /** `load5 / cpuCount`, null when either is unknown. */
  loadPerCore: number | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  disks: ResourceCapacityDiskView[];
}

/** `sampled` for local and SSH environments; sandbox and plugin environments are not measured. */
export type EnvironmentResourceCapacitySampling = "sampled" | "unsupported";

export interface EnvironmentResourceCapacity extends ResourceCapacitySnapshot {
  environmentId: string;
  environmentName: string;
  driver: string;
  sampling: EnvironmentResourceCapacitySampling;
}

export interface InstanceHostResourceCapacity extends ResourceCapacitySnapshot {
  targetKey: string;
  /** The host name; returned to instance admins only. */
  hostLabel: string | null;
  /** True for the host of the server process that answered. */
  current: boolean;
}

/** `GET /api/instance/resource-capacity` (instance admins). */
export interface InstanceResourceCapacity {
  generatedAt: string;
  hosts: InstanceHostResourceCapacity[];
  environments: EnvironmentResourceCapacity[];
}

/** `GET /api/companies/:companyId/resource-capacity`: the environments the company's agents run on. */
export interface CompanyResourceCapacity {
  generatedAt: string;
  companyId: string;
  environments: EnvironmentResourceCapacity[];
}

/** `GET /api/environments/:id/resource-capacity`. */
export interface EnvironmentResourceCapacityDetail {
  generatedAt: string;
  environment: EnvironmentResourceCapacity;
}

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/**
 * One human-readable line of numbers for a snapshot. The web and the CLI
 * both print it, so they show the same text.
 *
 * @param now - Epoch milliseconds used for the sample age.
 * @example "disk workspaces 3.0 GiB free (3%) · memory 8.0 GiB of 16.0 GiB available · load 0.25/core · sampled 2m ago"
 */
export function formatResourceCapacitySnapshot(snapshot: ResourceCapacitySnapshot, now: number = Date.now()): string {
  const parts = snapshot.disks.map(
    (disk) => `disk ${disk.labels.join("+")} ${formatGib(disk.freeBytes)} free (${disk.freePercent}%)`,
  );
  if (snapshot.memAvailableBytes !== null && snapshot.memTotalBytes !== null) {
    parts.push(`memory ${formatGib(snapshot.memAvailableBytes)} of ${formatGib(snapshot.memTotalBytes)} available`);
  }
  if (snapshot.loadPerCore !== null) parts.push(`load ${snapshot.loadPerCore}/core`);
  if (!snapshot.sampledAt) {
    parts.push("never sampled");
  } else {
    const minutes = Math.max(0, Math.round((now - Date.parse(snapshot.sampledAt)) / 60_000));
    parts.push(minutes < 1 ? "sampled just now" : `sampled ${minutes}m ago`);
  }
  return parts.join(" · ");
}
