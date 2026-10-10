// Small unified line diff for showing what changed between two text files,
// for example two company skill versions. It is a display aid, not a patch
// generator: hunks use 3 lines of context and a longest-common-subsequence
// edit script.

const CONTEXT_LINES = 3;
// Above this many cells the LCS table is skipped and the changed middle is
// shown as one remove-then-add block.
const MAX_LCS_CELLS = 4_000_000;
const NO_EOL_MARKER = "\\ No newline at end of file";

interface Line {
  text: string;
  noEol: boolean;
}

interface Op extends Line {
  tag: " " | "-" | "+";
  /** Lines of the old text consumed before this op. */
  aPos: number;
  /** Lines of the new text consumed before this op. */
  bPos: number;
}

function splitLines(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const endsWithNewline = parts[parts.length - 1] === "";
  if (endsWithNewline) parts.pop();
  return parts.map((part, index) => ({
    text: part,
    noEol: !endsWithNewline && index === parts.length - 1,
  }));
}

function sameLine(left: Line, right: Line): boolean {
  return left.text === right.text && left.noEol === right.noEol;
}

function editScript(a: Line[], b: Line[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && sameLine(a[prefix]!, b[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    sameLine(a[a.length - 1 - suffix]!, b[b.length - 1 - suffix]!)
  ) {
    suffix++;
  }

  const tags: Array<" " | "-" | "+"> = [];
  for (let i = 0; i < prefix; i++) tags.push(" ");

  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n * m > MAX_LCS_CELLS) {
    for (let i = 0; i < n; i++) tags.push("-");
    for (let j = 0; j < m; j++) tags.push("+");
  } else {
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = sameLine(a[prefix + i]!, b[prefix + j]!)
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && sameLine(a[prefix + i]!, b[prefix + j]!)) {
        tags.push(" ");
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
        tags.push("-");
        i++;
      } else {
        tags.push("+");
        j++;
      }
    }
  }
  for (let i = 0; i < suffix; i++) tags.push(" ");

  const ops: Op[] = [];
  let aPos = 0;
  let bPos = 0;
  for (const tag of tags) {
    const line = tag === "+" ? b[bPos]! : a[aPos]!;
    ops.push({ ...line, tag, aPos, bPos });
    if (tag !== "+") aPos++;
    if (tag !== "-") bPos++;
  }
  return ops;
}

function hunkHeader(ops: Op[]): string {
  const first = ops[0]!;
  const aLen = ops.filter((op) => op.tag !== "+").length;
  const bLen = ops.filter((op) => op.tag !== "-").length;
  const aStart = aLen > 0 ? first.aPos + 1 : first.aPos;
  const bStart = bLen > 0 ? first.bPos + 1 : first.bPos;
  return `@@ -${aStart},${aLen} +${bStart},${bLen} @@`;
}

/** Unified diff hunks (no file header lines); `[]` when the texts are equal. */
export function unifiedLineDiff(before: string, after: string): string[] {
  const ops = editScript(splitLines(before), splitLines(after));
  const out: string[] = [];
  let index = 0;
  let previousStop = 0;
  while (index < ops.length) {
    if (ops[index]!.tag === " ") {
      index++;
      continue;
    }
    const start = Math.max(previousStop, index - CONTEXT_LINES);
    let lastChange = index;
    let cursor = index + 1;
    while (cursor < ops.length) {
      if (ops[cursor]!.tag !== " ") {
        lastChange = cursor;
        cursor++;
        continue;
      }
      let runEnd = cursor;
      while (runEnd < ops.length && ops[runEnd]!.tag === " ") runEnd++;
      if (runEnd < ops.length && runEnd - cursor <= 2 * CONTEXT_LINES) {
        cursor = runEnd;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, lastChange + 1 + CONTEXT_LINES);
    const hunk = ops.slice(start, stop);
    out.push(hunkHeader(hunk));
    for (const op of hunk) {
      out.push(`${op.tag}${op.text}`);
      if (op.noEol) out.push(NO_EOL_MARKER);
    }
    previousStop = stop;
    index = stop;
  }
  return out;
}

export interface DiffableFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  executable?: boolean;
}

export interface FileSetDiffEntry {
  path: string;
  change: "added" | "removed" | "modified";
  binary: boolean;
  diff: string[];
}

/** Per-file diff between two file sets, sorted by path; unchanged files are omitted. */
export function diffFileSets(from: DiffableFile[], to: DiffableFile[]): FileSetDiffEntry[] {
  const fromByPath = new Map(from.map((file) => [file.path, file]));
  const toByPath = new Map(to.map((file) => [file.path, file]));
  const paths = [...new Set([...fromByPath.keys(), ...toByPath.keys()])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const entries: FileSetDiffEntry[] = [];

  for (const path of paths) {
    const before = fromByPath.get(path);
    const after = toByPath.get(path);
    const binary = before?.encoding === "base64" || after?.encoding === "base64";

    if (!after) {
      entries.push({
        path,
        change: "removed",
        binary,
        diff: binary
          ? [`Binary file ${path} removed`]
          : [`--- a/${path}`, "+++ /dev/null", ...unifiedLineDiff(before!.content, "")],
      });
      continue;
    }
    if (!before) {
      entries.push({
        path,
        change: "added",
        binary,
        diff: binary
          ? [`Binary file ${path} added`]
          : ["--- /dev/null", `+++ b/${path}`, ...unifiedLineDiff("", after.content)],
      });
      continue;
    }

    const executableChanged = Boolean(before.executable) !== Boolean(after.executable);
    const contentChanged =
      before.content !== after.content || (before.encoding ?? "utf8") !== (after.encoding ?? "utf8");
    if (!executableChanged && !contentChanged) continue;

    const modeLine = executableChanged
      ? [`executable: ${Boolean(before.executable)} -> ${Boolean(after.executable)}`]
      : [];
    entries.push({
      path,
      change: "modified",
      binary,
      diff: binary
        ? [...(contentChanged ? [`Binary file ${path} differs`] : []), ...modeLine]
        : [`--- a/${path}`, `+++ b/${path}`, ...modeLine, ...unifiedLineDiff(before.content, after.content)],
    });
  }
  return entries;
}
