import { describe, expect, it } from "vitest";
import {
  ISSUE_WAIT_MAX_DELAY_MS,
  ISSUE_WAIT_MIN_DELAY_MS,
  issueWaitRequestSchema,
  parseIssueWaitDurationMs,
} from "./issue-wait.js";

describe("issue wait duration", () => {
  it.each([
    ["90s", 90_000],
    ["10m", 600_000],
    ["2h", 7_200_000],
    ["1h30m", 5_400_000],
    [" 15M ", 900_000],
    [600, 600_000],
  ])("parses %j", (input, expected) => {
    expect(parseIssueWaitDurationMs(input)).toBe(expected);
  });

  it.each(["", "soon", "10", "-5m", "1.5h", "10m extra", 0, -1, Number.NaN])(
    "rejects %j",
    (input) => {
      expect(parseIssueWaitDurationMs(input)).toBeNull();
    },
  );
});

describe("issue wait request", () => {
  it("accepts a bounded delay and a reason", () => {
    expect(issueWaitRequestSchema.parse({ in: "10m", reason: "CI on PR #4320 head abc123" })).toEqual({
      in: "10m",
      reason: "CI on PR #4320 head abc123",
    });
  });

  it("rejects delays outside the wait bounds", () => {
    expect(ISSUE_WAIT_MIN_DELAY_MS).toBe(60_000);
    expect(ISSUE_WAIT_MAX_DELAY_MS).toBe(24 * 60 * 60_000);
    expect(issueWaitRequestSchema.safeParse({ in: "30s", reason: "CI" }).success).toBe(false);
    expect(issueWaitRequestSchema.safeParse({ in: "25h", reason: "CI" }).success).toBe(false);
    expect(issueWaitRequestSchema.safeParse({ in: "soon", reason: "CI" }).success).toBe(false);
  });

  it("requires a short reason", () => {
    expect(issueWaitRequestSchema.safeParse({ in: "10m" }).success).toBe(false);
    expect(issueWaitRequestSchema.safeParse({ in: "10m", reason: "  " }).success).toBe(false);
    expect(issueWaitRequestSchema.safeParse({ in: "10m", reason: "x".repeat(401) }).success).toBe(false);
  });
});
