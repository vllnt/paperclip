import { describe, expect, it } from "vitest";
import {
  EXIT_CAUSE_STDERR_MAX_CHARS,
  EXIT_CAUSE_STDERR_MAX_LINES,
  describeProcessExit,
} from "./process-exit-cause.js";

const failed = { exitCode: 1, signal: null } as const;
// Built at runtime so the source holds no secret-shaped literal.
const FAKE_KEY = ["fixture", "Key", "Value", "0123"].join("");
const pemMarker = (edge: "BEGIN" | "END") => `${"-".repeat(5)}${edge} PRIVATE KEY${"-".repeat(5)}`;
const TAIL_HEADER = "Agent exited with code 1. Last lines of stderr:\n";

describe("describeProcessExit", () => {
  it("keeps a one-line stderr on the exit line", () => {
    expect(describeProcessExit("Agent", { ...failed, stderr: "\nError: 401 Unauthorized\n\n" })).toBe(
      "Agent exited with code 1: Error: 401 Unauthorized",
    );
  });

  it("puts a longer stderr below the exit line, without blank lines", () => {
    const stderr = "Warning: no input received on stdin\n\n  Error: 401 Unauthorized  \n";

    expect(describeProcessExit("Agent", { ...failed, stderr })).toBe(
      `${TAIL_HEADER}Warning: no input received on stdin\nError: 401 Unauthorized`,
    );
  });

  it("names the signal and the transport error code when there is no exit code", () => {
    expect(
      describeProcessExit("Agent", { exitCode: null, signal: "SIGTERM", errorCode: "duplex_channel_lost", stderr: "" }),
    ).toBe("Agent exited with signal SIGTERM (duplex_channel_lost)");
  });

  it("puts the timeout and the result error before the exit line", () => {
    expect(
      describeProcessExit("Agent", { ...failed, stderr: "Error: boom\n" }, { timeoutSec: 30, resultError: " Run failed: tool error " }),
    ).toBe("Timed out after 30s\nRun failed: tool error\nAgent exited with code 1: Error: boom");
  });

  it("leaves out a clean exit line that adds nothing to the result error", () => {
    expect(describeProcessExit("Agent", { exitCode: 0, signal: null, stderr: "" }, { resultError: "Run failed: tool error" })).toBe(
      "Run failed: tool error",
    );
    expect(describeProcessExit("Agent", { exitCode: 0, signal: null, stderr: "" })).toBe("Agent exited with code 0");
  });

  it("redacts secrets in stderr and in the result error", () => {
    const message = describeProcessExit(
      "Agent",
      { ...failed, stderr: "Authorization: Bearer opaqueBearerValue8f3k2m9q7z\n" },
      { resultError: `request failed with api_key=${FAKE_KEY}` },
    );

    expect(message).not.toContain("opaqueBearerValue8f3k2m9q7z");
    expect(message).not.toContain(FAKE_KEY);
    expect(message).toContain("***REDACTED***");
  });

  it("redacts a multi-line secret before it cuts the tail", () => {
    const body = Array.from({ length: 25 }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${String(i).padStart(2, "0")}`);
    const stderr = [pemMarker("BEGIN"), ...body, pemMarker("END"), "Error: bad key"].join("\n");

    const message = describeProcessExit("Agent", { ...failed, stderr });

    expect(message).not.toContain("MIIEvQ");
    expect(message).toBe(`${TAIL_HEADER}***REDACTED***\nError: bad key`);
  });

  it("keeps at most the line bound and marks the cut", () => {
    const stderr = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

    const tail = describeProcessExit("Agent", { ...failed, stderr }).slice(TAIL_HEADER.length);

    expect(tail.split("\n")).toHaveLength(EXIT_CAUSE_STDERR_MAX_LINES);
    expect(tail.startsWith("…line 31\n")).toBe(true);
    expect(tail.endsWith("line 50")).toBe(true);
  });

  it("keeps whole characters when the character cut lands inside a surrogate pair", () => {
    const message = describeProcessExit("Agent", { ...failed, stderr: `${"😀".repeat(1500)}x` });

    const tail = message.slice("Agent exited with code 1: …".length);
    expect(tail.length).toBeLessThanOrEqual(EXIT_CAUSE_STDERR_MAX_CHARS);
    expect(tail).toMatch(/^😀/u);
    expect(tail.endsWith("x")).toBe(true);
  });
});
