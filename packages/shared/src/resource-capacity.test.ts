import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_CAPACITY_THRESHOLDS,
  RESOURCE_CAPACITY_STALE_AFTER_MS,
  classifyResourceCapacityReading,
  criticalResourceCapacityMetrics,
  effectiveResourceCapacityLevel,
  freshResourceCapacityMetricLevels,
  measuredResourceCapacityMetrics,
  resourceCapacityReadingStatus,
  resourceCapacityThresholdBytes,
  worstResourceCapacityLevel,
  type ResourceCapacityReading,
} from "./resource-capacity.js";

const GIB = 1024 ** 3;

function reading(overrides: Partial<ResourceCapacityReading> = {}): ResourceCapacityReading {
  return {
    cpuCount: 8,
    load1: 1,
    load5: 1,
    load15: 1,
    memTotalBytes: 16 * GIB,
    memAvailableBytes: 8 * GIB,
    disks: [{ labels: ["workspaces"], totalBytes: 460 * GIB, freeBytes: 200 * GIB }],
    ...overrides,
  };
}

function disk(freeGib: number, totalGib = 460) {
  return [{ labels: ["workspaces" as const], totalBytes: totalGib * GIB, freeBytes: freeGib * GIB }];
}

describe("resourceCapacityThresholdBytes", () => {
  it("takes the smaller of the share and the absolute size", () => {
    expect(resourceCapacityThresholdBytes(460 * GIB, 5, 5 * GIB)).toBe(5 * GIB);
    expect(resourceCapacityThresholdBytes(50 * GIB, 5, 5 * GIB)).toBe(2.5 * GIB);
  });
});

describe("classifyResourceCapacityReading", () => {
  it("classifies disk on a large volume by the absolute size", () => {
    expect(classifyResourceCapacityReading(reading({ disks: disk(25) }), {})["disk:workspaces"]).toBe("ok");
    expect(classifyResourceCapacityReading(reading({ disks: disk(14) }), {})["disk:workspaces"]).toBe("low");
    expect(classifyResourceCapacityReading(reading({ disks: disk(4) }), {})["disk:workspaces"]).toBe("critical");
  });

  it("classifies disk on a small volume by the share", () => {
    expect(classifyResourceCapacityReading(reading({ disks: disk(3, 50) }), {})["disk:workspaces"]).toBe("low");
    expect(classifyResourceCapacityReading(reading({ disks: disk(2, 50) }), {})["disk:workspaces"]).toBe("critical");
  });

  it("leaves critical only above 1.25 times the critical threshold", () => {
    const previous = { "disk:workspaces": "critical" as const };
    expect(classifyResourceCapacityReading(reading({ disks: disk(6) }), previous)["disk:workspaces"]).toBe("critical");
    expect(classifyResourceCapacityReading(reading({ disks: disk(6.5) }), previous)["disk:workspaces"]).toBe("low");
  });

  it("leaves low only above 1.1 times the low threshold", () => {
    const previous = { "disk:workspaces": "low" as const };
    expect(classifyResourceCapacityReading(reading({ disks: disk(21) }), previous)["disk:workspaces"]).toBe("low");
    expect(classifyResourceCapacityReading(reading({ disks: disk(23) }), previous)["disk:workspaces"]).toBe("ok");
  });

  it("classifies memory available", () => {
    const low = classifyResourceCapacityReading(reading({ memAvailableBytes: 1.5 * GIB }), {});
    const critical = classifyResourceCapacityReading(reading({ memAvailableBytes: 0.25 * GIB }), {});
    expect(low.memory).toBe("low");
    expect(critical.memory).toBe("critical");
  });

  it("marks high load per core as low, never critical", () => {
    const levels = classifyResourceCapacityReading(reading({ load5: 40, cpuCount: 8 }), {});
    expect(levels.load).toBe("low");
    expect(worstResourceCapacityLevel({ ...levels, "disk:workspaces": "ok", memory: "ok" })).toBe("low");
  });

  it("keeps the previous level of metrics a partial reading lacks", () => {
    const previous = { "disk:workspaces": "critical" as const, memory: "critical" as const };
    const next = classifyResourceCapacityReading(
      reading({ memTotalBytes: null, memAvailableBytes: null, disks: disk(200) }),
      previous,
    );
    expect(next.memory).toBe("critical");
    expect(next["disk:workspaces"]).toBe("ok");
  });

  it("keys each disk by its first label", () => {
    const next = classifyResourceCapacityReading(
      reading({
        disks: [
          { labels: ["data", "runLogs"], totalBytes: 100 * GIB, freeBytes: 1 * GIB },
          { labels: ["workspaces"], totalBytes: 100 * GIB, freeBytes: 90 * GIB },
        ],
      }),
      {},
    );
    expect(criticalResourceCapacityMetrics(next)).toEqual(["disk:data"]);
  });

  it("uses configured thresholds", () => {
    const thresholds = { ...DEFAULT_RESOURCE_CAPACITY_THRESHOLDS, diskCriticalBytes: 50 * GIB, diskCriticalPercent: 50 };
    expect(classifyResourceCapacityReading(reading({ disks: disk(40) }), {}, thresholds)["disk:workspaces"]).toBe(
      "critical",
    );
  });
});

describe("reading status and effective level", () => {
  it("needs disk and memory for ok", () => {
    expect(resourceCapacityReadingStatus(reading())).toBe("ok");
    expect(resourceCapacityReadingStatus(reading({ memTotalBytes: null, memAvailableBytes: null }))).toBe("partial");
    expect(
      resourceCapacityReadingStatus(
        reading({ disks: [], memTotalBytes: null, memAvailableBytes: null, load5: null, cpuCount: null }),
      ),
    ).toBe("failed");
  });

  it("drops metrics not measured recently, so a stale critical never holds", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const stale = new Date(now.getTime() - RESOURCE_CAPACITY_STALE_AFTER_MS - 1).toISOString();
    const metricLevels = { "disk:workspaces": "critical" as const, memory: "low" as const };
    expect(effectiveResourceCapacityLevel({ metricLevels, metricSampledAt: {}, now })).toBe("unknown");
    expect(
      effectiveResourceCapacityLevel({
        metricLevels,
        metricSampledAt: { "disk:workspaces": stale, memory: stale },
        now,
      }),
    ).toBe("unknown");
    expect(
      effectiveResourceCapacityLevel({
        metricLevels,
        metricSampledAt: { "disk:workspaces": stale, memory: recent },
        now,
      }),
    ).toBe("low");
    expect(
      freshResourceCapacityMetricLevels({
        metricLevels,
        metricSampledAt: { "disk:workspaces": recent, memory: recent },
        now,
      }),
    ).toEqual(metricLevels);
  });

  it("lists the metrics a reading measured", () => {
    expect(measuredResourceCapacityMetrics(reading())).toEqual(["disk:workspaces", "memory", "load"]);
    expect(measuredResourceCapacityMetrics(reading({ memTotalBytes: null, memAvailableBytes: null, load5: null }))).toEqual([
      "disk:workspaces",
    ]);
  });
});
