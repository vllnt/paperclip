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
/**
 * The most characters of stderr, or of the result error, that an exit cause redacts. It is four
 * times the stderr tail, so the redaction sees whole multi-line secrets (a PEM block) next to the
 * tail, and it bounds the cost: the redaction rules are not linear on a long unbroken run.
 */
export const EXIT_CAUSE_SCAN_WINDOW_CHARS = 8192;

/** The fields of a finished process that an exit cause reads. */
export interface ProcessExitFacts {
  exitCode: number | null;
  signal: string | null;
  /** The transport error code from the process runner, when it set one. */
  errorCode?: string | null;
  stderr: string;
}

const PEM_BEGIN_MARKER = "-----BEGIN ";
const PEM_END_MARKER = "-----END ";

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
 * {@link EXIT_CAUSE_RESULT_ERROR_MAX_CHARS} characters. Every cut ends at the end of a word and
 * drops the partial word: the server masks a run's registered secret values only where they are
 * whole, so a cut inside one would leave its start visible.
 *
 * Stderr and the result error are redacted with the full diagnostic rules
 * (`redactDiagnosticText`), but only the end of stderr: the last whole lines that fit in
 * {@link EXIT_CAUSE_SCAN_WINDOW_CHARS} characters, and the start of the result error. Stderr can
 * hold megabytes, and the redaction rules cost much more than linear time on a long unbroken run,
 * so the text is bounded before the redaction. The window starts at the start of a line, and an
 * over-long last line loses its end, never its start, so a cut never separates a secret's name from
 * its value, and a multi-line secret (a PEM block) inside the window is never left half visible.
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
  const scanned = scanWindow(proc.stderr);
  const stderrLines = redact(scanned.text)
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
      ? cutEnd(redact(cutEnd(extra.resultError.trim(), EXIT_CAUSE_SCAN_WINDOW_CHARS)), EXIT_CAUSE_RESULT_ERROR_MAX_CHARS)
      : null,
  ].filter((line): line is string => Boolean(line));
  // A clean exit with no stderr adds nothing to a reported error.
  const exitSaysMore = proc.exitCode !== 0 || Boolean(proc.signal) || Boolean(proc.errorCode) || Boolean(lastLine);
  if (exitSaysMore || lines.length === 0) lines.push(exitLine);
  if (stderrLines.length > 1 || (scanned.cutEarlier && lastLine) || lastLine.length > EXIT_CAUSE_LAST_LINE_MAX_CHARS) {
    lines.push("Last lines of stderr:", stderrTail(stderrLines, scanned.cutEarlier));
  }
  return lines.join("\n");
}

/**
 * The end of stderr that the redaction reads: its non-empty lines, trimmed, newest first, while
 * they fit in {@link EXIT_CAUSE_SCAN_WINDOW_CHARS}. A line that does not fit is left out whole, so
 * the window starts at a line start. Only the last line is kept when it alone is over the window:
 * its start, never its end. Walks back from the end, so it reads only what it keeps.
 */
function scanWindow(stderr: string): { text: string; cutEarlier: boolean } {
  const kept: string[] = [];
  let size = 0;
  let end = stderr.length;
  let cutEarlier = false;
  while (end > 0) {
    const lineStart = stderr.lastIndexOf("\n", end - 1) + 1;
    const line = stderr.slice(lineStart, end).trim();
    end = lineStart - 1;
    if (!line) continue;
    const next = size + line.length + (kept.length > 0 ? 1 : 0);
    if (next > EXIT_CAUSE_SCAN_WINDOW_CHARS) {
      cutEarlier = true;
      if (kept.length === 0) {
        kept.push(cutEnd(line, EXIT_CAUSE_SCAN_WINDOW_CHARS));
        // Blank lines before the over-long line are not a cut.
        cutEarlier = /\S/.test(stderr.slice(0, lineStart));
      }
      break;
    }
    kept.unshift(line);
    size = next;
  }
  const text = kept.join("\n");
  if (!cutEarlier) return { text, cutEarlier };
  return { text: afterOrphanPemEnd(text), cutEarlier };
}

/**
 * A PEM block that starts before the window leaves its body and its END marker in the window with
 * no BEGIN marker for the redaction to match, and the body would show as plain base64. Those lines
 * are all secret, so the text starts after the line of the first END marker that has no BEGIN
 * marker before it.
 */
function afterOrphanPemEnd(text: string): string {
  const end = text.indexOf(PEM_END_MARKER);
  if (end === -1) return text;
  const begin = text.indexOf(PEM_BEGIN_MARKER);
  if (begin !== -1 && begin < end) return text;
  const lineEnd = text.indexOf("\n", end);
  return lineEnd === -1 ? "" : text.slice(lineEnd + 1);
}

function stderrTail(lines: string[], cutEarlier: boolean): string {
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
  return kept.length < lines.length || cutEarlier ? `…${tail}` : tail;
}

function cutEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  // Never end on half of a surrogate pair: JSONB rejects it.
  if (/[\ud800-\udbff]/.test(text.charAt(end - 1))) end -= 1;
  // Never end inside a word. The server masks a run's registered secret values only where they
  // are whole, so a cut inside one would leave its start visible. The cut drops the partial word.
  if (/\S/.test(text.charAt(end))) {
    while (end > 0 && /\S/.test(text.charAt(end - 1))) end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}
