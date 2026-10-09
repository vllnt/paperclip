import os from "node:os";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resourceCapacityService, type ResourceCapacityService } from "./resource-capacity.js";
import { sampleInstanceResources } from "./resource-capacity-host.js";

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const MIN_SAMPLE_INTERVAL_MS = 15_000;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface ResourceCapacitySamplerConfig {
  intervalMs: number;
  retentionDays: number;
}

/** Reads the sampler settings from the environment, with safe floors. */
export function resolveResourceCapacitySamplerConfig(env: NodeJS.ProcessEnv = process.env): ResourceCapacitySamplerConfig {
  const interval = Number(env.PAPERCLIP_RESOURCE_CAPACITY_SAMPLE_INTERVAL_MS);
  const retention = Number(env.PAPERCLIP_RESOURCE_CAPACITY_RETENTION_DAYS);
  return {
    intervalMs: Number.isFinite(interval) && interval > 0
      ? Math.max(MIN_SAMPLE_INTERVAL_MS, Math.floor(interval))
      : DEFAULT_SAMPLE_INTERVAL_MS,
    retentionDays: Number.isFinite(retention) && retention > 0 ? Math.max(1, Math.floor(retention)) : DEFAULT_RETENTION_DAYS,
  };
}

/**
 * One sampler pass: record this host, sweep SSH environments, and prune
 * history at most once an hour. Each step fails on its own and never throws.
 *
 * @returns When retention last ran, for the next pass.
 */
export async function runResourceCapacityTick(input: {
  service: ResourceCapacityService;
  retentionDays: number;
  lastPrunedAt: number | null;
  now?: Date;
}): Promise<{ lastPrunedAt: number | null }> {
  const now = input.now ?? new Date();
  try {
    await input.service.recordReading({
      targetKey: input.service.currentInstanceKey,
      targetKind: "instance",
      hostLabel: os.hostname(),
      source: "interval",
      reading: await sampleInstanceResources(),
      now,
    });
  } catch (error) {
    logger.warn({ err: error }, "resource capacity: failed to record the instance reading");
  }
  try {
    await input.service.sweepSshEnvironments(now);
  } catch (error) {
    logger.warn({ err: error }, "resource capacity: SSH sweep failed");
  }
  let lastPrunedAt = input.lastPrunedAt;
  if (lastPrunedAt === null || now.getTime() - lastPrunedAt >= RETENTION_INTERVAL_MS) {
    lastPrunedAt = now.getTime();
    try {
      await input.service.pruneHistory(input.retentionDays, now);
    } catch (error) {
      logger.warn({ err: error }, "resource capacity: history retention failed");
    }
  }
  return { lastPrunedAt };
}

/**
 * Starts the sampler in this process. It runs whether or not the heartbeat
 * scheduler is enabled: reads and recovery need a current reading.
 *
 * @returns A function that stops it.
 */
export function startResourceCapacitySampler(db: Db, config = resolveResourceCapacitySamplerConfig()): () => void {
  const service = resourceCapacityService(db);
  let lastPrunedAt: number | null = null;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runResourceCapacityTick({ service, retentionDays: config.retentionDays, lastPrunedAt })
      .then((result) => {
        lastPrunedAt = result.lastPrunedAt;
      })
      .finally(() => {
        running = false;
      });
  };
  const interval = setInterval(tick, config.intervalMs);
  interval.unref?.();
  tick();
  return () => clearInterval(interval);
}
