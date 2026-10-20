import { describe, expect, it } from "vitest";
import {
  EXIT_CAUSE_LAST_LINE_MAX_CHARS,
  EXIT_CAUSE_RESULT_ERROR_MAX_CHARS,
  EXIT_CAUSE_SCAN_WINDOW_CHARS,
  EXIT_CAUSE_STDERR_MAX_CHARS,
  EXIT_CAUSE_STDERR_MAX_LINES,
  describeProcessExit,
} from "./process-exit-cause.js";

const failed = { exitCode: 1, signal: null } as const;
// Built at runtime so the source holds no secret-shaped literal.
const FAKE_KEY = ["fixture", "Key", "Value", "0123"].join("");
const pemMarker = (edge: "BEGIN" | "END") => `${"-".repeat(5)}${edge} PRIVATE KEY${"-".repeat(5)}`;
// Built at runtime so the source holds no secret-shaped literal.
const FAKE_HEADER_VALUE = ["opaque", "Header", "Value", "8f3k2m9q7z"].join("");
const TAIL_HEADER = "\nLast lines of stderr:\n";
// Far above a normal run (tens of milliseconds) and far below the unbounded cost (minutes).
const SCAN_BUDGET_MS = 2000;
const pemBody = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${String(i).padStart(3, "0")}`);
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

  it("cuts a long last line on the first line at a word end and keeps it whole in the tail", () => {
    const longLine = `Error: ${"lost connection ".repeat(20).trim()}`;

    const [first, header, tail] = describeProcessExit("Agent", { ...failed, stderr: longLine }).split("\n");

    expect(first!.startsWith("Agent exited with code 1: Error: lost connection lost")).toBe(true);
    expect(first!.endsWith(" connection…")).toBe(true);
    expect(first!.length).toBeLessThanOrEqual("Agent exited with code 1: ".length + EXIT_CAUSE_LAST_LINE_MAX_CHARS);
    expect(header).toBe("Last lines of stderr:");
    expect(tail).toBe(longLine);
  });

  // The server masks a run's registered env values after this message is built, and only where a
  // value is whole. A cut inside an opaque value would keep its start, which no rule recognizes.
  it("drops the partial word at the exit line cut, so no start of an opaque value stays visible", () => {
    const opaque = ["opaque", "Bound", "Value", "x7Qm2Lp9Zr4Kt8Wn3Vb6Hy1Jc5Fd0"].join("");
    const lead = `request to the service failed ${"while reading the response ".repeat(6)}`.slice(0, 180);
    const line = `${lead} ${opaque} please check the service`;

    const message = describeProcessExit("Agent", { ...failed, stderr: `Warning: something\n${line}\n` });
    const [first] = message.split("\n");

    expect(first!.endsWith("…")).toBe(true);
    expect(first).not.toContain(opaque.slice(0, 6));
    // The tail keeps the line whole, so the server can mask the whole value there.
    expect(message.slice(message.indexOf(TAIL_HEADER) + TAIL_HEADER.length)).toContain(opaque);
  });

  it("drops the partial word at the stderr tail cut, so no start of an opaque value stays visible", () => {
    const opaque = ["opaque", "Tail", "Value", "x7Qm2Lp9Zr4Kt8Wn3Vb6Hy1Jc5Fd0"].join("");
    const lead = "while reading the response ".repeat(100).slice(0, EXIT_CAUSE_STDERR_MAX_CHARS - 20);
    const line = `${lead} ${opaque} please check the service`;

    const message = describeProcessExit("Agent", { ...failed, stderr: `Error: older\n${line}\n` });
    const tail = message.slice(message.indexOf(TAIL_HEADER) + TAIL_HEADER.length);

    expect(tail.endsWith("…")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(EXIT_CAUSE_STDERR_MAX_CHARS + 1);
    expect(message).not.toContain(opaque.slice(0, 6));
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

  it("keeps the start of an over-long line and whole characters when the cut lands inside a surrogate pair", () => {
    const [first, , tail] = describeProcessExit("Agent", { ...failed, stderr: `${"😀😀😀 ".repeat(600)}x` }).split("\n");

    expect(first!.endsWith("😀…")).toBe(true);
    expect(first).not.toMatch(LONE_SURROGATE_RE);
    expect(tail!.startsWith("😀")).toBe(true);
    expect(tail!.endsWith("😀…")).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(EXIT_CAUSE_STDERR_MAX_CHARS);
    expect(tail).not.toMatch(LONE_SURROGATE_RE);
  });

  it("starts the tail at the start of a line, so a cut never drops half of a line", () => {
    const older = `older ${"a".repeat(1500)}`;
    const newer = `newer ${"b".repeat(1500)}`;

    const message = describeProcessExit("Agent", { ...failed, stderr: `${older}\n${newer}\n` });
    const tail = message.slice(message.indexOf(TAIL_HEADER) + TAIL_HEADER.length);

    expect(tail).toBe(`…${newer}`);
  });

  it("keeps the first line of the tail whole while the lines before it fit", () => {
    const a = `a ${"x".repeat(1000)}`;
    const b = `b ${"y".repeat(1000)}`;

    const message = describeProcessExit("Agent", { ...failed, stderr: `${a}\n${b}\n` });

    expect(message.endsWith(`${TAIL_HEADER}${a}\n${b}`)).toBe(true);
  });

  it("keeps the whole multi-line secret redacted when it is longer than the tail but inside the window", () => {
    const stderr = [pemMarker("BEGIN"), ...pemBody(120), pemMarker("END"), "Error: bad key"].join("\n");

    const message = describeProcessExit("Agent", { ...failed, stderr });

    expect(stderr.length).toBeGreaterThan(EXIT_CAUSE_STDERR_MAX_CHARS);
    expect(stderr.length).toBeLessThan(EXIT_CAUSE_SCAN_WINDOW_CHARS);
    expect(message).toBe(`Agent exited with code 1: Error: bad key${TAIL_HEADER}***REDACTED***\nError: bad key`);
  });

  it("never shows the body of a multi-line secret, whatever its size next to the window edge", () => {
    for (let lines = 200; lines <= 280; lines += 1) {
      const stderr = [pemMarker("BEGIN"), ...pemBody(lines), pemMarker("END"), "Error: bad key"].join("\n");

      const message = describeProcessExit("Agent", { ...failed, stderr });

      expect(message, `body of ${lines} lines`).not.toContain("MIIEvQ");
      expect(message, `body of ${lines} lines`).toMatch(/^Agent exited with code 1: Error: bad key\n/);
      expect(message, `body of ${lines} lines`).toMatch(/Error: bad key$/);
    }
  });

  it("leaves out the body of a multi-line secret that starts before the window", () => {
    const stderr = ["Error: before", pemMarker("BEGIN"), ...pemBody(400), pemMarker("END"), "Error: bad key"].join("\n");

    const message = describeProcessExit("Agent", { ...failed, stderr });

    expect(stderr.length).toBeGreaterThan(EXIT_CAUSE_SCAN_WINDOW_CHARS);
    expect(message).toBe(`Agent exited with code 1: Error: bad key${TAIL_HEADER}…Error: bad key`);
  });

  it("marks the lines that the window left out, even when the kept line is short", () => {
    const stderr = `${"x".repeat(EXIT_CAUSE_SCAN_WINDOW_CHARS + 1)}\nError: boom\n`;

    expect(describeProcessExit("Agent", { ...failed, stderr })).toBe(
      `Agent exited with code 1: Error: boom${TAIL_HEADER}…Error: boom`,
    );
  });

  it("keeps the start of a last line that is over the window, and marks the lines before it", () => {
    const stderr = `Error: older\nError: ${"yyyy ".repeat(EXIT_CAUSE_SCAN_WINDOW_CHARS / 2)}`;

    const [first, header, tail] = describeProcessExit("Agent", { ...failed, stderr }).split("\n");

    expect(first!.startsWith("Agent exited with code 1: Error: yyyy yyyy")).toBe(true);
    expect(header).toBe("Last lines of stderr:");
    expect(tail!.startsWith("…Error: yyyy yyyy")).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(EXIT_CAUSE_STDERR_MAX_CHARS + 1);
  });

  // The redaction rules are not linear on a long unbroken run, and stderr can hold megabytes
  // (the capture cap is 4 MiB). The cost must follow the window, not the size of stderr.
  describe.each([
    ["hyphen-joined words", "abc-def-ghi_jkl-"],
    ["a keyword and hyphens", "token-"],
    ["a header name and hyphens", "x-api-key-"],
    ["a single-letter pattern", "a-b-"],
  ])("with a 256 KiB run of %s", (_name, unit) => {
    it("finishes within the budget and still shows the end of stderr", () => {
      const run = unit.repeat(Math.ceil((256 * 1024) / unit.length));
      const started = performance.now();

      const message = describeProcessExit("Agent", { ...failed, stderr: `Error: first.\n${run}\nError: last` });
      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(SCAN_BUDGET_MS);
      expect(message.startsWith("Agent exited with code 1: Error: last\n")).toBe(true);
    });

    it("finishes within the budget when the run is the last line", () => {
      const run = unit.repeat(Math.ceil((256 * 1024) / unit.length));
      const started = performance.now();

      const message = describeProcessExit("Agent", { ...failed, stderr: `Error: first.\n${run}` }, { resultError: `Run failed. ${run}` });
      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(SCAN_BUDGET_MS);
      // The run is one word, so the cut drops it whole.
      expect(message.startsWith("Run failed.…")).toBe(true);
      expect(message.length).toBeLessThan(EXIT_CAUSE_RESULT_ERROR_MAX_CHARS + 2 * EXIT_CAUSE_STDERR_MAX_CHARS + 500);
    });
  });

  it("cuts the result error and keeps its start", () => {
    const resultError = `Run failed: ${"error ".repeat(2_000)}`;

    const [first, ...rest] = describeProcessExit("Agent", { exitCode: 0, signal: null, stderr: "" }, { resultError }).split("\n");

    expect(rest).toEqual([]);
    expect(first!.length).toBeLessThanOrEqual(EXIT_CAUSE_RESULT_ERROR_MAX_CHARS);
    expect(first!.startsWith("Run failed: error error")).toBe(true);
    expect(first!.endsWith("…")).toBe(true);
  });

  // The tail cut must never separate the name of a credential header from its value. A header
  // line sits before a filler line, and the filler line grows one character at a time so the cut
  // lands on every offset of the header line.
  describe.each([
    ["an x-…-key header", `x-api-key: ${FAKE_HEADER_VALUE}`],
    ["an x-…-key assignment", `x-auth-key=${FAKE_HEADER_VALUE}`],
    ["a Basic authorization header", `Authorization: Basic ${FAKE_HEADER_VALUE}`],
    ["a cookie header", `Cookie: sid=${FAKE_HEADER_VALUE}; theme=dark`],
  ])("with %s next to the stderr cut", (_name, header) => {
    it("redacts the value at the start of a last line that is over the window", () => {
      const stderr = `Error: older\n${header} ${"f".repeat(EXIT_CAUSE_SCAN_WINDOW_CHARS * 2)}`;

      const message = describeProcessExit("Agent", { ...failed, stderr });

      expect(message).toContain("***REDACTED***");
      for (let at = 0; at + 6 <= FAKE_HEADER_VALUE.length; at += 1) {
        expect(message).not.toContain(FAKE_HEADER_VALUE.slice(at, at + 6));
      }
    });

    it("never keeps any part of the value", () => {
      for (let fill = EXIT_CAUSE_STDERR_MAX_CHARS - 150; fill <= EXIT_CAUSE_STDERR_MAX_CHARS + 50; fill += 1) {
        const message = describeProcessExit("Agent", { ...failed, stderr: `${header}\n${"f".repeat(fill)}\n` });

        // Any run of the value that is long enough to be a credential on its own.
        for (let at = 0; at + 6 <= FAKE_HEADER_VALUE.length; at += 1) {
          expect(message, `fill ${fill}`).not.toContain(FAKE_HEADER_VALUE.slice(at, at + 6));
        }
      }
    });
  });
});
