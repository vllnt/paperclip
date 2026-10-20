import { describe, expect, it } from "vitest";
import {
  EXIT_CAUSE_LAST_LINE_MAX_CHARS,
  EXIT_CAUSE_STDERR_MAX_CHARS,
  EXIT_CAUSE_STDERR_MAX_LINES,
  describeProcessExit,
} from "./process-exit-cause.js";

const failed = { exitCode: 1, signal: null } as const;
// Built at runtime so the source holds no secret-shaped literal.
const FAKE_KEY = ["fixture", "Key", "Value", "0123"].join("");
const pemMarker = (edge: "BEGIN" | "END") => `${"-".repeat(5)}${edge} PRIVATE KEY${"-".repeat(5)}`;
const TAIL_HEADER = "\nLast lines of stderr:\n";
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("describeProcessExit", () => {
  it("puts a one-line stderr on the exit line, with no tail below", () => {
    expect(describeProcessExit("Agent", { ...failed, stderr: "\nError: 401 Unauthorized\n\n" })).toBe(
      "Agent exited with code 1: Error: 401 Unauthorized",
    );
  });

  it("puts the last stderr line on the first line and the tail below it", () => {
    const stderr = "Warning: no input received on stdin\n\n  Error: 401 Unauthorized  \n";

    expect(describeProcessExit("Agent", { ...failed, stderr })).toBe(
      `Agent exited with code 1: Error: 401 Unauthorized${TAIL_HEADER}Warning: no input received on stdin\nError: 401 Unauthorized`,
    );
  });

  it("cuts a long last line on the first line and keeps it whole in the tail", () => {
    const longLine = `Error: ${"x".repeat(300)}`;

    const [first, header, tail] = describeProcessExit("Agent", { ...failed, stderr: longLine }).split("\n");

    expect(first).toBe(`Agent exited with code 1: ${longLine.slice(0, EXIT_CAUSE_LAST_LINE_MAX_CHARS - 1)}…`);
    expect(header).toBe("Last lines of stderr:");
    expect(tail).toBe(longLine);
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
    expect(message).toBe(`Agent exited with code 1: Error: bad key${TAIL_HEADER}***REDACTED***\nError: bad key`);
  });

  it("keeps at most the line bound and marks the cut", () => {
    const stderr = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

    const message = describeProcessExit("Agent", { ...failed, stderr });
    const tail = message.slice(message.indexOf(TAIL_HEADER) + TAIL_HEADER.length);

    expect(message.startsWith("Agent exited with code 1: line 50\n")).toBe(true);
    expect(tail.split("\n")).toHaveLength(EXIT_CAUSE_STDERR_MAX_LINES);
    expect(tail.startsWith("…line 31\n")).toBe(true);
    expect(tail.endsWith("line 50")).toBe(true);
  });

  it("keeps whole characters when a cut lands inside a surrogate pair", () => {
    const [first, , tail] = describeProcessExit("Agent", { ...failed, stderr: `${"😀".repeat(1500)}x` }).split("\n");

    expect(first!.endsWith("😀…")).toBe(true);
    expect(first).not.toMatch(LONE_SURROGATE_RE);
    expect(tail!.startsWith("…😀")).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(EXIT_CAUSE_STDERR_MAX_CHARS + 1);
    expect(tail).not.toMatch(LONE_SURROGATE_RE);
    expect(tail!.endsWith("x")).toBe(true);
  });
});
