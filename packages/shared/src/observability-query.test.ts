import { describe, expect, it } from "vitest";
import {
  OBSERVABILITY_FAILURE_GROUPS,
  OBSERVABILITY_USAGE_GROUPS,
  observabilityFailuresQuerySchema,
  observabilityFailuresResponseSchema,
  observabilityUsageQuerySchema,
  observabilityUsageResponseSchema,
} from "./observability-query.js";

const COMPANY_AGENT = "11111111-1111-4111-8111-111111111111";

describe("observabilityUsageQuerySchema", () => {
  it("defaults to grouping by agent with no window and no filters", () => {
    expect(observabilityUsageQuerySchema.parse({})).toEqual({ groupBy: "agent" });
  });

  it("accepts every usage group and rejects the failure-only cause group", () => {
    for (const groupBy of OBSERVABILITY_USAGE_GROUPS) {
      expect(observabilityUsageQuerySchema.safeParse({ groupBy }).success).toBe(true);
    }
    expect(observabilityUsageQuerySchema.safeParse({ groupBy: "cause" }).success).toBe(false);
  });

  it("accepts a full instant or a plain date, and rejects other text", () => {
    expect(observabilityUsageQuerySchema.safeParse({ since: "2026-10-01T00:00:00Z", until: "2026-10-02" }).success).toBe(true);
    expect(observabilityUsageQuerySchema.safeParse({ since: "yesterday" }).success).toBe(false);
    expect(observabilityUsageQuerySchema.safeParse({ until: "2026-13-45" }).success).toBe(false);
  });

  it("reads limit as a number from a query string and bounds it", () => {
    expect(observabilityUsageQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(observabilityUsageQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(observabilityUsageQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
  });

  it("requires uuids for the id filters and a closed value for status", () => {
    expect(observabilityUsageQuerySchema.parse({ agentId: COMPANY_AGENT }).agentId).toBe(COMPANY_AGENT);
    expect(observabilityUsageQuerySchema.safeParse({ agentId: "not-a-uuid" }).success).toBe(false);
    expect(observabilityUsageQuerySchema.safeParse({ status: "succeeded" }).success).toBe(true);
    expect(observabilityUsageQuerySchema.safeParse({ status: "running" }).success).toBe(false);
  });

  it("rejects unknown keys so a misspelled filter does not silently widen the result", () => {
    expect(observabilityUsageQuerySchema.safeParse({ agentID: COMPANY_AGENT }).success).toBe(false);
  });
});

describe("observabilityFailuresQuerySchema", () => {
  it("defaults to grouping by cause and accepts cause as a filter", () => {
    expect(observabilityFailuresQuerySchema.parse({})).toEqual({ groupBy: "cause" });
    expect(observabilityFailuresQuerySchema.parse({ cause: "timeout" }).cause).toBe("timeout");
    expect(observabilityFailuresQuerySchema.safeParse({ cause: "made_up" }).success).toBe(false);
  });

  it("accepts the failure groups and rejects the status group", () => {
    for (const groupBy of OBSERVABILITY_FAILURE_GROUPS) {
      expect(observabilityFailuresQuerySchema.safeParse({ groupBy }).success).toBe(true);
    }
    expect(observabilityFailuresQuerySchema.safeParse({ groupBy: "status" }).success).toBe(false);
  });
});

describe("response schemas", () => {
  const row = {
    key: COMPANY_AGENT,
    label: "Agent",
    runs: 3,
    inputTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: 5,
    reasoningTokens: null,
    costMicros: 1200,
    apiEquivalentMicros: null,
    durationMs: 4000,
    quality: { measured: 2, declared: 1, derived: 0, missing: 0 },
  };
  const totals = { ...row, key: null, label: null };

  it("accepts a usage response", () => {
    const body = {
      groupBy: "agent",
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-08T00:00:00.000Z",
      rows: [row],
      totals,
      truncated: false,
    };
    expect(observabilityUsageResponseSchema.safeParse(body).success).toBe(true);
  });

  it("requires allRuns on failure rows", () => {
    const body = {
      groupBy: "cause",
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-08T00:00:00.000Z",
      rows: [{ ...row, allRuns: null }],
      totals: { ...totals, allRuns: 9 },
      truncated: false,
    };
    expect(observabilityFailuresResponseSchema.safeParse(body).success).toBe(true);
    expect(observabilityFailuresResponseSchema.safeParse({ ...body, rows: [row] }).success).toBe(false);
  });
});
