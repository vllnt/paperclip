import { redactDiagnosticText } from "./command-redaction.js";
import { redactSecretShapedText } from "./log-value-redaction.js";

/** The most stderr lines that an exit cause keeps. */
export const EXIT_CAUSE_STDERR_MAX_LINES = 20;
/** The most stderr characters that an exit cause keeps. */
export const EXIT_CAUSE_STDERR_MAX_CHARS = 2048;

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
 * The stderr tail drops blank lines and keeps at most the last {@link EXIT_CAUSE_STDERR_MAX_LINES}
 * lines and {@link EXIT_CAUSE_STDERR_MAX_CHARS} characters. It starts with `…` when it was cut.
 * Stderr and the result error are redacted before the cut, so a secret that spans lines (a PEM
 * block) or the cut is never left half visible. A one-line tail stays on the exit line. A longer
 * tail goes below it, so the first line of the message is never an arbitrary stderr line.
 *
 * @param label - The program name that the message shows, for example `Claude`.
 * @param proc - The finished process.
 * @param extra - The timeout in seconds when Paperclip stopped the process at its timeout, and the
 *   result error when the program reported one in its structured output.
 * @returns The timeout line and the result error when present, then the exit line and the tail.
 * @example
 * describeProcessExit("Agent", { exitCode: 1, signal: null, stderr: "Error: unauthorized\n" });
 * // "Agent exited with code 1: Error: unauthorized"
 */
export function describeProcessExit(
  label: string,
  proc: ProcessExitFacts,
  extra: { timeoutSec?: number | null; resultError?: string | null } = {},
): string {
  const ended = [
    proc.exitCode !== null ? `code ${proc.exitCode}` : null,
    proc.signal ? `signal ${proc.signal}` : null,
  ].filter(Boolean);
  let exitLine = ended.length > 0 ? `${label} exited with ${ended.join(" and ")}` : `${label} exited`;
  if (proc.errorCode) exitLine += ` (${proc.errorCode})`;
  const tail = stderrTail(proc.stderr);
  if (tail) exitLine += tail.includes("\n") ? `. Last lines of stderr:\n${tail}` : `: ${tail}`;

  const lines = [
    extra.timeoutSec != null ? `Timed out after ${extra.timeoutSec}s` : null,
    extra.resultError?.trim() ? redact(extra.resultError.trim()) : null,
  ].filter((line): line is string => Boolean(line));
  // A clean exit with no stderr adds nothing to a reported error.
  const exitSaysMore = proc.exitCode !== 0 || Boolean(proc.signal) || Boolean(proc.errorCode) || Boolean(tail);
  if (exitSaysMore || lines.length === 0) lines.push(exitLine);
  return lines.join("\n");
}

function stderrTail(stderr: string): string {
  const lines = redact(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let tail = lines.slice(-EXIT_CAUSE_STDERR_MAX_LINES).join("\n");
  const cut = lines.length > EXIT_CAUSE_STDERR_MAX_LINES || tail.length > EXIT_CAUSE_STDERR_MAX_CHARS;
  if (tail.length > EXIT_CAUSE_STDERR_MAX_CHARS) {
    // Never start the tail with half of a surrogate pair: JSONB rejects it.
    tail = tail.slice(-EXIT_CAUSE_STDERR_MAX_CHARS).replace(/^[\udc00-\udfff]/, "").trimStart();
  }
  return tail && cut ? `…${tail}` : tail;
}
