export interface DiffRow {
  kind: "hunk" | "context" | "added" | "deleted" | "note";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  comment: { line: number; side: "LEFT" | "RIGHT" } | null;
}

/** Only hunk-backed coordinates can be submitted to GitHub. Headers and
 * truncated/unknown lines remain visible but never become comment targets. */
export function parseUnifiedDiff(patch: string): DiffRow[] {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0, inHunk = false;
  return patch.split("\n").map(text => {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
    if (header) {
      oldLine = Number(header[1]); newLine = Number(header[3]);
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      inHunk = Number.isSafeInteger(oldLine) && Number.isSafeInteger(newLine) && Number.isSafeInteger(oldRemaining) && Number.isSafeInteger(newRemaining);
      return { kind: "hunk", text, oldLine: null, newLine: null, comment: null };
    }
    if (!inHunk || text.startsWith("\\")) return { kind: "note", text, oldLine: null, newLine: null, comment: null };
    if (text.startsWith("+") && newRemaining > 0 && newLine > 0) {
      const line = newLine++; newRemaining--;
      return { kind: "added", text: text.slice(1), oldLine: null, newLine: line, comment: { line, side: "RIGHT" } };
    }
    if (text.startsWith("-") && oldRemaining > 0 && oldLine > 0) {
      const line = oldLine++; oldRemaining--;
      return { kind: "deleted", text: text.slice(1), oldLine: line, newLine: null, comment: { line, side: "LEFT" } };
    }
    if (text.startsWith(" ") && oldRemaining > 0 && newRemaining > 0 && oldLine > 0 && newLine > 0) {
      const old = oldLine++, next = newLine++; oldRemaining--; newRemaining--;
      return { kind: "context", text: text.slice(1), oldLine: old, newLine: next, comment: { line: next, side: "RIGHT" } };
    }
    // An unexpected line invalidates subsequent coordinates until a new hunk.
    inHunk = false;
    return { kind: "note", text, oldLine: null, newLine: null, comment: null };
  });
}
