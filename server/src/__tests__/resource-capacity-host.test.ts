import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { instanceTargetKey, sampleInstanceResources } from "../services/resource-capacity-host.ts";
import { resolveResourceCapacitySamplerConfig } from "../services/resource-capacity-sampler.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("instance resource sampling", () => {
  it("reports roots on one filesystem once, with all their labels, and no paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-resource-host-"));
    roots.push(root);
    const reading = await sampleInstanceResources([
      { label: "workspaces", path: path.join(root, "not", "created", "yet") },
      { label: "data", path: root },
    ]);

    expect(reading.cpuCount).toBeGreaterThan(0);
    expect(reading.memTotalBytes).toBeGreaterThan(0);
    expect(reading.memAvailableBytes).not.toBeNull();
    expect(reading.disks).toHaveLength(1);
    expect(reading.disks[0]!.labels).toEqual(["data", "workspaces"]);
    expect(reading.disks[0]!.freeBytes).toBeLessThanOrEqual(reading.disks[0]!.totalBytes);
    expect(JSON.stringify(reading)).not.toContain(root);
  });

  it("keys the instance by a hash, never the hostname", () => {
    const key = instanceTargetKey("build-host.internal.example");
    expect(key).toMatch(/^instance:[0-9a-f]{16}$/);
    expect(key).toBe(instanceTargetKey("build-host.internal.example"));
    expect(key).not.toBe(instanceTargetKey("other-host"));
  });

  it("applies floors to the sampler settings", () => {
    expect(resolveResourceCapacitySamplerConfig({})).toEqual({ intervalMs: 60_000, retentionDays: 30 });
    expect(
      resolveResourceCapacitySamplerConfig({
        PAPERCLIP_RESOURCE_CAPACITY_SAMPLE_INTERVAL_MS: "1000",
        PAPERCLIP_RESOURCE_CAPACITY_RETENTION_DAYS: "0.5",
      }),
    ).toEqual({ intervalMs: 15_000, retentionDays: 1 });
    expect(
      resolveResourceCapacitySamplerConfig({ PAPERCLIP_RESOURCE_CAPACITY_SAMPLE_INTERVAL_MS: "nope" }).intervalMs,
    ).toBe(60_000);
  });
});
