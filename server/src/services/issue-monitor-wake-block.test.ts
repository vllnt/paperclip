import { describe, expect, it } from "vitest";
import { conflict, forbidden, notFound } from "../errors.js";
import { isRetryableMonitorWakeBlock, monitorWakeRetryDelayMs } from "./issue-monitor-wake-block.js";

describe("monitor wake block", () => {
  it("retries a budget block and a non-invokable agent that can come back", () => {
    expect(isRetryableMonitorWakeBlock(conflict("Agent budget hard stop", { scopeType: "agent", scopeId: "a1" }))).toBe(true);
    for (const status of ["pending_approval", "paused"]) {
      expect(isRetryableMonitorWakeBlock(conflict("Agent is not invokable", { status, reason: "x" }))).toBe(true);
    }
  });

  it("does not retry a terminated agent, other 409s or other statuses", () => {
    expect(isRetryableMonitorWakeBlock(conflict("Agent is not invokable", { status: "terminated", reason: "x" }))).toBe(false);
    expect(isRetryableMonitorWakeBlock(conflict("Issue monitor is not ready to dispatch"))).toBe(false);
    expect(isRetryableMonitorWakeBlock(forbidden("no"))).toBe(false);
    expect(isRetryableMonitorWakeBlock(notFound("gone"))).toBe(false);
    expect(isRetryableMonitorWakeBlock(new Error("boom"))).toBe(false);
  });

  it("backs off 5, 10, 20, 40 then 60 minutes", () => {
    expect([0, 1, 2, 3, 4, 9].map(monitorWakeRetryDelayMs)).toEqual(
      [5, 10, 20, 40, 60, 60].map((minutes) => minutes * 60_000),
    );
  });
});
