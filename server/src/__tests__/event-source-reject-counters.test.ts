import { describe, expect, it } from "vitest";
import { createRejectCounters } from "../services/event-sources/reject-counters.js";

const MINUTE_MS = 60_000;
/** An exact minute boundary, so offsets inside the minute are easy to reason about. */
const MINUTE_START = 28_333_334 * MINUTE_MS;

const SOURCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function setup() {
  let clock = MINUTE_START;
  const counters = createRejectCounters({ now: () => clock });
  return {
    counters,
    at(offsetMs: number) {
      clock = MINUTE_START + offsetMs;
    },
  };
}

describe("createRejectCounters", () => {
  describe("record", () => {
    it("aggregates outcomes per source per minute", () => {
      const { counters, at } = setup();
      for (let i = 0; i < 3; i += 1) {
        counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.1" });
      }
      at(30_000);
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "duplicate", ip: "203.0.113.1" });
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "duplicate", ip: "203.0.113.1" });
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "rate_limited", ip: "203.0.113.1" });

      const drained = counters.drain({ all: true });
      expect(drained).toHaveLength(1);
      expect(drained[0]).toEqual({
        sourceId: SOURCE_A,
        companyId: COMPANY,
        minuteStart: MINUTE_START,
        counts: { unauthorized: 3, duplicate: 2, rate_limited: 1 },
        firstIp: "203.0.113.1",
        lastIp: "203.0.113.1",
      });
    });

    it("only reports outcomes that occurred", () => {
      const { counters } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "not_found", ip: null });
      expect(counters.drain({ all: true })[0]?.counts).toEqual({ not_found: 1 });
    });

    it("keeps a separate bucket for each source", () => {
      const { counters } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "198.51.100.1" });
      counters.record({ sourceId: SOURCE_B, companyId: COMPANY, outcome: "unauthorized", ip: "198.51.100.2" });
      counters.record({ sourceId: SOURCE_B, companyId: COMPANY, outcome: "unauthorized", ip: "198.51.100.2" });

      const drained = counters.drain({ all: true });
      const bySource = new Map(drained.map((bucket) => [bucket.sourceId, bucket]));
      expect(drained).toHaveLength(2);
      expect(bySource.get(SOURCE_A)?.counts).toEqual({ unauthorized: 1 });
      expect(bySource.get(SOURCE_B)?.counts).toEqual({ unauthorized: 2 });
    });

    it("keeps a separate bucket for each minute and aligns it to the minute start", () => {
      const { counters, at } = setup();
      at(59_999);
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      at(60_000);
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      at(125_000);
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });

      const minutes = counters.drain({ all: true }).map((bucket) => bucket.minuteStart).sort((x, y) => x - y);
      expect(minutes).toEqual([MINUTE_START, MINUTE_START + MINUTE_MS, MINUTE_START + 2 * MINUTE_MS]);
    });
  });

  describe("client IPs", () => {
    it("tracks the first and the most recent IP of the minute", () => {
      const { counters } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.1" });
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.2" });
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "duplicate", ip: "203.0.113.3" });

      const [bucket] = counters.drain({ all: true });
      expect(bucket?.firstIp).toBe("203.0.113.1");
      expect(bucket?.lastIp).toBe("203.0.113.3");
    });

    it("reports the same IP for both when only one request was seen", () => {
      const { counters } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.9" });
      const [bucket] = counters.drain({ all: true });
      expect(bucket).toMatchObject({ firstIp: "203.0.113.9", lastIp: "203.0.113.9" });
    });

    it("tolerates requests without a known IP", () => {
      const { counters } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      expect(counters.drain({ all: true })[0]).toMatchObject({ firstIp: null, lastIp: null, counts: { unauthorized: 1 } });
    });

    it("starts fresh IP tracking in each minute", () => {
      const { counters, at } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.1" });
      at(MINUTE_MS);
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.2" });

      const drained = counters.drain({ all: true }).sort((x, y) => x.minuteStart - y.minuteStart);
      expect(drained.map((bucket) => [bucket.firstIp, bucket.lastIp])).toEqual([
        ["203.0.113.1", "203.0.113.1"],
        ["203.0.113.2", "203.0.113.2"],
      ]);
    });
  });

  describe("requests that matched no source", () => {
    it("share one bucket with null source and company ids", () => {
      const { counters } = setup();
      counters.record({ sourceId: null, companyId: null, outcome: "not_found", ip: "192.0.2.1" });
      counters.record({ sourceId: null, companyId: null, outcome: "not_found", ip: "192.0.2.2" });
      counters.record({ sourceId: null, companyId: null, outcome: "auth_failure_rate_limited", ip: "192.0.2.3" });

      const drained = counters.drain({ all: true });
      expect(drained).toEqual([
        {
          sourceId: null,
          companyId: null,
          minuteStart: MINUTE_START,
          counts: { not_found: 2, auth_failure_rate_limited: 1 },
          firstIp: "192.0.2.1",
          lastIp: "192.0.2.3",
        },
      ]);
    });

    it("do not mix with the buckets of real sources", () => {
      const { counters } = setup();
      counters.record({ sourceId: null, companyId: null, outcome: "not_found", ip: null });
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });

      const drained = counters.drain({ all: true });
      expect(drained).toHaveLength(2);
      expect(drained.find((bucket) => bucket.sourceId === null)?.counts).toEqual({ not_found: 1 });
      expect(drained.find((bucket) => bucket.sourceId === SOURCE_A)?.counts).toEqual({ unauthorized: 1 });
    });
  });

  describe("drain", () => {
    it("returns nothing while the only buckets belong to the current minute", () => {
      const { counters, at } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      expect(counters.drain()).toEqual([]);
      at(59_999);
      expect(counters.drain()).toEqual([]);
    });

    it("returns a bucket once its minute has finished", () => {
      const { counters, at } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      at(MINUTE_MS);
      const drained = counters.drain();
      expect(drained).toHaveLength(1);
      expect(drained[0]).toMatchObject({ sourceId: SOURCE_A, minuteStart: MINUTE_START, counts: { unauthorized: 1 } });
    });

    it("returns finished minutes and keeps the current one", () => {
      const { counters, at } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      at(MINUTE_MS + 5_000);
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "duplicate", ip: null });

      const finished = counters.drain();
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ minuteStart: MINUTE_START, counts: { unauthorized: 1 } });

      expect(counters.drain()).toEqual([]);
      const rest = counters.drain({ all: true });
      expect(rest).toHaveLength(1);
      expect(rest[0]).toMatchObject({ minuteStart: MINUTE_START + MINUTE_MS, counts: { duplicate: 1 } });
    });

    it("returns every bucket, including the current minute, with { all: true }", () => {
      const { counters, at } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      at(MINUTE_MS);
      counters.record({ sourceId: SOURCE_B, companyId: COMPANY, outcome: "unauthorized", ip: null });
      counters.record({ sourceId: null, companyId: null, outcome: "not_found", ip: null });

      expect(counters.drain({ all: true })).toHaveLength(3);
    });

    it("removes what it returns", () => {
      const { counters } = setup();
      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: null });
      expect(counters.drain({ all: true })).toHaveLength(1);
      expect(counters.drain({ all: true })).toEqual([]);
    });

    it("starts counting from zero after a drain", () => {
      const { counters } = setup();
      for (let i = 0; i < 5; i += 1) {
        counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.1" });
      }
      counters.drain({ all: true });

      counters.record({ sourceId: SOURCE_A, companyId: COMPANY, outcome: "unauthorized", ip: "203.0.113.2" });
      const [bucket] = counters.drain({ all: true });
      expect(bucket?.counts).toEqual({ unauthorized: 1 });
      expect(bucket?.firstIp).toBe("203.0.113.2");
    });

    it("returns an empty list when nothing was recorded", () => {
      const { counters } = setup();
      expect(counters.drain()).toEqual([]);
      expect(counters.drain({ all: true })).toEqual([]);
    });
  });

  describe("bounded memory", () => {
    it("stops opening buckets beyond 2,000 per process but keeps counting the ones it has", () => {
      const { counters } = setup();
      for (let i = 0; i < 2_000; i += 1) {
        counters.record({ sourceId: `source-${i}`, companyId: COMPANY, outcome: "unauthorized", ip: null });
      }
      counters.record({ sourceId: "one-too-many", companyId: COMPANY, outcome: "unauthorized", ip: null });
      counters.record({ sourceId: "source-0", companyId: COMPANY, outcome: "unauthorized", ip: null });

      const drained = counters.drain({ all: true });
      expect(drained).toHaveLength(2_000);
      expect(drained.find((bucket) => bucket.sourceId === "one-too-many")).toBeUndefined();
      expect(drained.find((bucket) => bucket.sourceId === "source-0")?.counts).toEqual({ unauthorized: 2 });
    });

    it("accepts new buckets again after a drain frees room", () => {
      const { counters } = setup();
      for (let i = 0; i < 2_000; i += 1) {
        counters.record({ sourceId: `source-${i}`, companyId: COMPANY, outcome: "unauthorized", ip: null });
      }
      counters.drain({ all: true });
      counters.record({ sourceId: "later", companyId: COMPANY, outcome: "unauthorized", ip: null });
      expect(counters.drain({ all: true }).map((bucket) => bucket.sourceId)).toEqual(["later"]);
    });
  });
});
