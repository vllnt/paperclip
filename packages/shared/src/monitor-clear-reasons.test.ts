import { describe, expect, it } from "vitest";
import { ISSUE_EXECUTION_MONITOR_CLEAR_REASONS } from "./constants.js";

/**
 * The clear reasons the previous production image accepts. Its execution-state
 * schema validates `monitor.clearReason` with a strict enum, and one unknown
 * value makes it drop the whole execution state (stage history included).
 * After a rollback the old image would read every value we persisted, so a new
 * reason must first ship as a reader-tolerant release. Only then may a later
 * change add it here and write it.
 */
const PREVIOUS_IMAGE_CLEAR_REASONS = [
  "manual",
  "triggered",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_assignee",
  "dispatch_skipped",
  "timeout_exceeded",
  "max_attempts_exhausted",
] as const;

describe("monitor clear reasons", () => {
  it("only persists values the previous image can read, so a rollback keeps execution state", () => {
    expect([...ISSUE_EXECUTION_MONITOR_CLEAR_REASONS].sort()).toEqual([...PREVIOUS_IMAGE_CLEAR_REASONS].sort());
  });
});
