import { describe, expect, it } from "vitest";
import {
  ISSUE_WAIT_MAX_DELAY_MS,
  ISSUE_WAIT_MIN_DELAY_MS,
  issueWaitRequestSchema,
  parseIssueWaitDurationMs,
  parseIssueWaitPullRequestUrl,
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

  it("accepts an optional GitHub pull request target and leaves it out when absent", () => {
    expect(issueWaitRequestSchema.parse({ in: "10m", reason: "CI", pullRequest: " https://github.com/acme/app/pull/7 " }))
      .toEqual({ in: "10m", reason: "CI", pullRequest: "https://github.com/acme/app/pull/7" });
    expect(issueWaitRequestSchema.parse({ in: "10m", reason: "CI" })).not.toHaveProperty("pullRequest");
  });

  it.each([
    "acme/app#7",
    "https://github.example.com/acme/app/pull/7",
    "https://gitlab.com/acme/app/pull/7",
    "http://github.com/acme/app/pull/7",
    "https://github.com/acme/app/issues/7",
    "https://github.com/acme/../pull/7",
    "https://github.com/./app/pull/7",
    "https://github.com/acme/app/pull/0",
    "https://github.com/acme/app/pull/7?x=https://github.com/a/b/pull/1",
    "https://github.com.evil.test/acme/app/pull/7",
  ])("rejects the pull request target %j", (pullRequest) => {
    expect(issueWaitRequestSchema.safeParse({ in: "10m", reason: "CI", pullRequest }).success).toBe(false);
  });

  it("canonicalizes a pull request URL", () => {
    expect(parseIssueWaitPullRequestUrl("https://www.github.com/acme/app.js/pull/42/files")).toEqual({
      owner: "acme",
      repo: "app.js",
      number: 42,
      url: "https://github.com/acme/app.js/pull/42",
    });
  });

  it("requires a short reason", () => {
    expect(issueWaitRequestSchema.safeParse({ in: "10m" }).success).toBe(false);
    expect(issueWaitRequestSchema.safeParse({ in: "10m", reason: "  " }).success).toBe(false);
    expect(issueWaitRequestSchema.safeParse({ in: "10m", reason: "x".repeat(401) }).success).toBe(false);
  });
});
