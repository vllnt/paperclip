import { redactDiagnosticText } from "./command-redaction.js";
import { redactSecretShapedText } from "./log-value-redaction.js";

/** The most stderr lines that an exit cause keeps. */
export const EXIT_CAUSE_STDERR_MAX_LINES = 20;
/** The most stderr characters that an exit cause keeps. */
export const EXIT_CAUSE_STDERR_MAX_CHARS = 2048;
/** The most characters of the last stderr line that the exit line shows. */
export const EXIT_CAUSE_LAST_LINE_MAX_CHARS = 200;

/** The fields of a finished process that an exit cause reads. */
export interface ProcessExitFacts {
  exitCode: number | null;
  signal: string | null;
  /** The transport error code from the process runner, when it set one. */
  errorCode?: string | null;
  stderr: string;
}

function redact(text: string): string {
  return redactDiagnosticText(redactSecretShapedText(text));
}

/**
 * Describes why a local agent process ended, for the error message of a failed run. The message
 * reads only structural facts: the timeout, the result error that the program reported, the exit
 * code, the signal, the transport error code, and the end of stderr. It never matches the text of
 * one program's messages.
 *
 * The first line carries the cause, because single-line views show only that line: the timeout,
 * else the result error, else the exit line. The exit line ends with the last non-empty stderr
 * line, cut to {@link EXIT_CAUSE_LAST_LINE_MAX_CHARS} characters. When stderr holds more than that
 * line, the message ends with the stderr tail: blank lines dropped, at most the last
 * {@link EXIT_CAUSE_STDERR_MAX_LINES} lines and {@link EXIT_CAUSE_STDERR_MAX_CHARS} characters, and
 * a leading `…` when it was cut. Stderr and the result error are redacted before any cut, so a
 * secret that spans lines (a PEM block) or a cut is never left half visible.
 *
 * @param label - The program name that the message shows, for example `Claude`.
 * @param proc - The finished process.
 * @param extra - The timeout in seconds when Paperclip stopped the process at its timeout, and the
 *   result error when the program reported one in its structured output.
 * @returns The message, one fact per line.
 * @example
 * describeProcessExit("Agent", { exitCode: 1, signal: null, stderr: "Warning: slow\nError: unauthorized\n" });
 * // "Agent exited with code 1: Error: unauthorized\nLast lines of stderr:\nWarning: slow\nError: unauthorized"
 */
export function describeProcessExit(
  label: string,
  proc: ProcessExitFacts,
  extra: { timeoutSec?: number | null; resultError?: string | null } = {},
): string {
  const stderrLines = redact(proc.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = stderrLines.at(-1) ?? "";

  const ended = [
    proc.exitCode !== null ? `code ${proc.exitCode}` : null,
    proc.signal ? `signal ${proc.signal}` : null,
  ].filter(Boolean);
  let exitLine = ended.length > 0 ? `${label} exited with ${ended.join(" and ")}` : `${label} exited`;
  if (proc.errorCode) exitLine += ` (${proc.errorCode})`;
  if (lastLine) exitLine += `: ${cutEnd(lastLine, EXIT_CAUSE_LAST_LINE_MAX_CHARS)}`;

  const lines = [
    extra.timeoutSec != null ? `Timed out after ${extra.timeoutSec}s` : null,
    extra.resultError?.trim() ? redact(extra.resultError.trim()) : null,
  ].filter((line): line is string => Boolean(line));
  // A clean exit with no stderr adds nothing to a reported error.
  const exitSaysMore = proc.exitCode !== 0 || Boolean(proc.signal) || Boolean(proc.errorCode) || Boolean(lastLine);
  if (exitSaysMore || lines.length === 0) lines.push(exitLine);
  if (stderrLines.length > 1 || lastLine.length > EXIT_CAUSE_LAST_LINE_MAX_CHARS) {
    lines.push("Last lines of stderr:", stderrTail(stderrLines));
  }
  return lines.join("\n");
}

function stderrTail(lines: string[]): string {
  let tail = lines.slice(-EXIT_CAUSE_STDERR_MAX_LINES).join("\n");
  const cut = lines.length > EXIT_CAUSE_STDERR_MAX_LINES || tail.length > EXIT_CAUSE_STDERR_MAX_CHARS;
  if (tail.length > EXIT_CAUSE_STDERR_MAX_CHARS) {
    // Never start the tail with half of a surrogate pair: JSONB rejects it.
    tail = tail.slice(-EXIT_CAUSE_STDERR_MAX_CHARS).replace(/^[\udc00-\udfff]/, "").trimStart();
  }
  return cut ? `…${tail}` : tail;
}

function cutEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  // Never end on half of a surrogate pair: JSONB rejects it.
  return `${text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "")}…`;
}
