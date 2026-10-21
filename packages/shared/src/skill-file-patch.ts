// A hunk patch changes part of a skill file without restating the rest. Each
// hunk names the exact text it replaces (`old`) and its replacement (`new`).
// Every `old` is matched against the file as it is now, never against the
// result of an earlier hunk, so the order of hunks does not matter. A patch
// written against an older copy of the file therefore keeps every newer edit
// outside its hunks, and fails instead of reverting one inside them.

export interface SkillFileHunk {
  old: string;
  new: string;
}

export type SkillFileHunkFailure =
  | { code: "hunk_not_found"; hunkIndex: number }
  | { code: "hunk_ambiguous"; hunkIndex: number; matchCount: number }
  | { code: "hunks_overlap"; hunkIndex: number; otherHunkIndex: number };

export type SkillFileHunkResult =
  | { ok: true; content: string }
  | ({ ok: false } & SkillFileHunkFailure);

/** Counts occurrences of `needle` in `text`, overlapping ones included. */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) count += 1;
  return count;
}

/**
 * Applies hunks to `content`. Each hunk's `old` must occur exactly once in
 * `content` and no two matched spans may overlap; otherwise the result names
 * the first failing hunk and nothing is applied.
 *
 * @example applySkillFileHunks("a\nb\n", [{ old: "b\n", new: "c\n" }]) // { ok: true, content: "a\nc\n" }
 */
export function applySkillFileHunks(content: string, hunks: readonly SkillFileHunk[]): SkillFileHunkResult {
  const spans: Array<{ hunkIndex: number; start: number; end: number }> = [];
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const start = hunk.old ? content.indexOf(hunk.old) : -1;
    if (start < 0) return { ok: false, code: "hunk_not_found", hunkIndex };
    const matchCount = countOccurrences(content, hunk.old);
    if (matchCount > 1) return { ok: false, code: "hunk_ambiguous", hunkIndex, matchCount };
    spans.push({ hunkIndex, start, end: start + hunk.old.length });
  }
  spans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]!;
    const current = spans[index]!;
    if (current.start < previous.end) {
      return {
        ok: false,
        code: "hunks_overlap",
        hunkIndex: Math.max(previous.hunkIndex, current.hunkIndex),
        otherHunkIndex: Math.min(previous.hunkIndex, current.hunkIndex),
      };
    }
  }
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += content.slice(cursor, span.start) + hunks[span.hunkIndex]!.new;
    cursor = span.end;
  }
  return { ok: true, content: result + content.slice(cursor) };
}

function lineStart(text: string, index: number): number {
  return index <= 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

/**
 * Returns one hunk that turns `base` into `next`: the changed span widened to
 * whole lines, then by one more line on each side until its `old` occurs
 * exactly once in `base`. Returns null when nothing changed or when `base` is
 * empty, because an empty file has no text to anchor a hunk to.
 *
 * @example diffSkillFileHunk("a\nb\nc\n", "a\nB\nc\n") // { old: "b\n", new: "B\n" }
 */
export function diffSkillFileHunk(base: string, next: string): SkillFileHunk | null {
  if (base === next || base === "") return null;
  const shorter = Math.min(base.length, next.length);
  let prefix = 0;
  while (prefix < shorter && base[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && base[base.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  let start = lineStart(base, prefix);
  let end = lineEnd(base, base.length - suffix);
  while (true) {
    const old = base.slice(start, end);
    if (old && countOccurrences(base, old) === 1) break;
    if (start === 0 && end === base.length) break;
    start = lineStart(base, start - 1);
    end = end < base.length ? lineEnd(base, end) : end;
  }
  return { old: base.slice(start, end), new: next.slice(start, next.length - (base.length - end)) };
}
