import { describe, expect, it } from "vitest";
import { isRetryableInteractionContinuationInfrastructureFailure } from "../services/heartbeat.js";

// A failed run stores a fuller error (the short message plus a stderr tail) and
// keeps the short message in resultJson.errorSummary. The retry decision reads
// the short message, so a spawn or sandbox phrase that only the stderr tail
// shows must not make an ordinary failure look like retryable infrastructure.
// A row written before the summary existed has no errorSummary, and its error
// is the short message.
describe("isRetryableInteractionContinuationInfrastructureFailure", () => {
  const SHORT = "Agent exited with code 1: Tool execution failed";
  const SPAWN_LINE = "Error: spawn agent-cli ENOENT";
  const SANDBOX_LINE =
    'Sandbox provider "example" is installed via plugin "acme.example-provider", but its worker is not running.';
  const withTail = (line: string) => `${SHORT}\nLast lines of stderr:\n${line}`;
  const failedRun = (error: string, resultJson: Record<string, unknown> | null) =>
    ({ errorCode: "adapter_failed", error, resultJson }) as Parameters<
      typeof isRetryableInteractionContinuationInfrastructureFailure
    >[0];

  it.each([
    ["a spawn phrase", SPAWN_LINE],
    ["a sandbox worker phrase", SANDBOX_LINE],
  ])("ignores %s that only the stderr tail shows", (_name, line) => {
    expect(
      isRetryableInteractionContinuationInfrastructureFailure(
        failedRun(withTail(line), { errorSummary: SHORT }),
      ),
    ).toBe(false);
  });

  it.each([
    ["a spawn phrase", SPAWN_LINE],
    ["a sandbox worker phrase", SANDBOX_LINE],
  ])("still retries an old row with no errorSummary and %s in its error", (_name, line) => {
    expect(
      isRetryableInteractionContinuationInfrastructureFailure(failedRun(`Agent failed: ${line}`, null)),
    ).toBe(true);
    expect(
      isRetryableInteractionContinuationInfrastructureFailure(failedRun(`Agent failed: ${line}`, {})),
    ).toBe(true);
  });

  it("retries when the short summary itself shows a spawn failure", () => {
    expect(
      isRetryableInteractionContinuationInfrastructureFailure(
        failedRun(withTail("unrelated stderr line"), { errorSummary: `Agent failed: ${SPAWN_LINE}` }),
      ),
    ).toBe(true);
  });
});
