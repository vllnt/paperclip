import { redactDiagnosticText } from "./command-redaction.js";
import { redactSecretShapedText } from "./log-value-redaction.js";

/** The most stderr lines that an exit cause keeps. */
export const EXIT_CAUSE_STDERR_MAX_LINES = 20;
/** The most stderr characters that an exit cause keeps. */
export const EXIT_CAUSE_STDERR_MAX_CHARS = 2048;
/** The most characters of the last stderr line that the exit line shows. */
export const EXIT_CAUSE_LAST_LINE_MAX_CHARS = 200;
/** The most characters of the result error that an exit cause keeps. */
export const EXIT_CAUSE_RESULT_ERROR_MAX_CHARS = 2048;

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
 * a leading `…` when earlier lines were left out. The result error is cut to
 * {@link EXIT_CAUSE_RESULT_ERROR_MAX_CHARS} characters.
 *
 * Stderr and the result error are redacted before any cut, with the full diagnostic rules
 * (`redactDiagnosticText`), so a secret that spans lines (a PEM block) is never left half visible.
 * A cut never separates a secret's name from its value: the tail starts at the start of a line, and
 * an over-long line loses its end, never its start.
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
    extra.resultError?.trim()
      ? cutEnd(redact(extra.resultError.trim()), EXIT_CAUSE_RESULT_ERROR_MAX_CHARS)
      : null,
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
  // Whole lines from the end, newest first. The tail never starts inside a line: a cut that
  // starts inside `x-api-key: <value>` would leave the value with no name to recognize.
  const kept: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < EXIT_CAUSE_STDERR_MAX_LINES; index -= 1) {
    const next = size + lines[index].length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && next > EXIT_CAUSE_STDERR_MAX_CHARS) break;
    kept.unshift(lines[index]);
    size = next;
  }
  // One line over the budget keeps its start and loses its end.
  const tail = cutEnd(kept.join("\n"), EXIT_CAUSE_STDERR_MAX_CHARS);
  return kept.length < lines.length ? `…${tail}` : tail;
}

function cutEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  // Never end on half of a surrogate pair: JSONB rejects it.
  return `${text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "")}…`;
}
