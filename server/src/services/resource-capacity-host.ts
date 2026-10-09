import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProcMeminfo } from "@paperclipai/adapter-utils/resource-probe";
import {
  RESOURCE_CAPACITY_DISK_LABELS,
  type ResourceCapacityDisk,
  type ResourceCapacityDiskLabel,
  type ResourceCapacityReading,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// Reads this server host's CPU, load, memory and the free space of the
// instance's disk roots, in-process. Paths stay here; a reading carries only
// numbers and closed-set labels.

export interface InstanceDiskRoot {
  label: ResourceCapacityDiskLabel;
  path: string;
}

/** The instance roots measured for free space, in label order. */
export function resolveInstanceDiskRoots(env: NodeJS.ProcessEnv = process.env): InstanceDiskRoot[] {
  const root = resolvePaperclipInstanceRoot();
  return [
    { label: "data", path: root },
    { label: "runLogs", path: env.RUN_LOG_BASE_PATH ?? path.resolve(root, "data", "run-logs") },
    { label: "workspaces", path: path.resolve(root, "workspaces") },
  ];
}

/**
 * The target key of this host. The hostname is hashed so the key can never
 * leak it; the hostname itself is kept only in the admin-only `host_label`.
 */
export function instanceTargetKey(hostname: string = os.hostname()): string {
  return `instance:${createHash("sha256").update(hostname).digest("hex").slice(0, 16)}`;
}

async function nearestExistingPath(target: string): Promise<string | null> {
  let current = path.resolve(target);
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function readDisks(roots: InstanceDiskRoot[]): Promise<ResourceCapacityDisk[]> {
  const byDevice = new Map<string, ResourceCapacityDisk>();
  for (const root of roots) {
    try {
      const existing = await nearestExistingPath(root.path);
      if (!existing) continue;
      const [stat, statfs] = await Promise.all([fs.stat(existing), fs.statfs(existing)]);
      const device = String(stat.dev);
      const known = byDevice.get(device);
      if (known) {
        if (!known.labels.includes(root.label)) known.labels.push(root.label);
        continue;
      }
      const totalBytes = Number(statfs.blocks) * Number(statfs.bsize);
      const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
      if (!(totalBytes > 0) || !(freeBytes >= 0) || freeBytes > totalBytes) continue;
      byDevice.set(device, { labels: [root.label], totalBytes, freeBytes });
    } catch {
      continue;
    }
  }
  const order = (label: ResourceCapacityDiskLabel) => RESOURCE_CAPACITY_DISK_LABELS.indexOf(label);
  return [...byDevice.values()]
    .map((disk) => ({ ...disk, labels: [...disk.labels].sort((a, b) => order(a) - order(b)) }))
    .sort((a, b) => order(a.labels[0]!) - order(b.labels[0]!));
}

async function readCgroupMemoryHeadroom(): Promise<number | null> {
  try {
    const [max, current] = await Promise.all([
      fs.readFile("/sys/fs/cgroup/memory.max", "utf8"),
      fs.readFile("/sys/fs/cgroup/memory.current", "utf8"),
    ]);
    if (max.trim() === "max") return null;
    const limit = Number(max.trim());
    const used = Number(current.trim());
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(used) || limit <= 0) return null;
    return Math.max(0, limit - used);
  } catch {
    return null;
  }
}

async function readMemory(): Promise<{ memTotalBytes: number | null; memAvailableBytes: number | null }> {
  if (process.platform === "linux") {
    try {
      const memory = parseProcMeminfo(await fs.readFile("/proc/meminfo", "utf8"));
      const headroom = await readCgroupMemoryHeadroom();
      if (memory.memAvailableBytes !== null && headroom !== null) {
        return { ...memory, memAvailableBytes: Math.min(memory.memAvailableBytes, headroom) };
      }
      return memory;
    } catch {
      return { memTotalBytes: null, memAvailableBytes: null };
    }
  }
  // Development hosts only: `freemem` undercounts reclaimable memory on macOS.
  return { memTotalBytes: os.totalmem(), memAvailableBytes: os.freemem() };
}

/**
 * Reads this host. Never throws: a metric that cannot be read is null or
 * absent, which makes the reading `partial` or `failed`.
 */
export async function sampleInstanceResources(
  roots: InstanceDiskRoot[] = resolveInstanceDiskRoots(),
): Promise<ResourceCapacityReading> {
  const [disks, memory] = await Promise.all([readDisks(roots), readMemory()]);
  const [load1, load5, load15] = os.loadavg();
  const hasLoad = process.platform !== "win32";
  return {
    cpuCount: os.availableParallelism(),
    load1: hasLoad ? load1 ?? null : null,
    load5: hasLoad ? load5 ?? null : null,
    load15: hasLoad ? load15 ?? null : null,
    ...memory,
    disks,
  };
}
