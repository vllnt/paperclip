/** A line of markdown prose with its 1-based position in the file it came from. */
export interface ProseLine {
  line: number;
  text: string;
  heading: string;
}

/** A rule-like sentence found in prose and whether it states a reason. */
export interface RuleSentence {
  line: number;
  text: string;
  hasReason: boolean;
}

const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(\S.*)?$/;
const RULE_PATTERN =
  /\b(must|never|always|do not|don't|should not|shouldn't|cannot|can't|avoid|required|forbidden|mandatory)\b/i;
const REASON_PATTERN =
  /\b(because|since|so that|so (?!far\b|many\b|much\b|long\b|on\b)\w+|otherwise|in order to|to (?:avoid|prevent|keep|let|stop|ensure|preserve|protect|limit|reduce|save)|which (?:means|lets|keeps|allows|prevents|is why|never|always|will|does|doesn't|cannot|can)|that way|this (?:keeps|lets|prevents|avoids|ensures|means|is why))\b|[:—–]\s+\S+(?:\s+\S+){3,}/i;

/**
 * Splits a document into its frontmatter block and body, keeping the 1-based line where the body starts.
 *
 * @param text - Full file text.
 * @returns The frontmatter source (empty when absent), the body lines, and the first body line number.
 */
export function splitDocument(text: string): { frontmatter: string; bodyLines: string[]; bodyStartLine: number } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return { frontmatter: "", bodyLines: lines, bodyStartLine: 1 };
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return { frontmatter: "", bodyLines: lines, bodyStartLine: 1 };
  return { frontmatter: lines.slice(1, closing).join("\n"), bodyLines: lines.slice(closing + 1), bodyStartLine: closing + 2 };
}

/**
 * Counts body lines the way the 500-line guidance does: leading and trailing blank lines do not count.
 *
 * @param bodyLines - Lines after the frontmatter block.
 * @returns The number of lines between the first and last non-blank line.
 */
export function countBodyLines(bodyLines: readonly string[]): number {
  const first = bodyLines.findIndex((line) => line.trim() !== "");
  if (first < 0) return 0;
  let last = bodyLines.length - 1;
  while (last > first && bodyLines[last]?.trim() === "") last -= 1;
  return last - first + 1;
}

/**
 * Estimates tokens as UTF-8 bytes divided by four. The estimate is stable and offline; it is not a tokenizer.
 *
 * @param text - Any text.
 * @returns The rounded token estimate.
 */
export function estimateTokens(text: string): number {
  return Math.round(new TextEncoder().encode(text).length / 4);
}

/**
 * Returns the non-code lines of a markdown body, tagged with the heading they sit under.
 * Fenced code blocks are dropped; with `stripInlineCode` the inline code spans are removed too.
 *
 * @param bodyLines - Lines to scan.
 * @param bodyStartLine - 1-based line number of the first entry in `bodyLines`.
 * @param stripInlineCode - Remove `inline code` spans from each line.
 * @returns The scanned lines.
 */
export function scanLines(bodyLines: readonly string[], bodyStartLine: number, stripInlineCode: boolean): ProseLine[] {
  const result: ProseLine[] = [];
  let inFence = false;
  let heading = "";
  bodyLines.forEach((raw, index) => {
    if (FENCE_PATTERN.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const headingMatch = HEADING_PATTERN.exec(raw);
    if (headingMatch) heading = headingMatch[1] ?? "";
    const text = stripInlineCode ? raw.replace(/`[^`]*`/g, " ") : raw;
    if (text.trim() !== "") result.push({ line: bodyStartLine + index, text, heading });
  });
  return result;
}

/**
 * Finds whole-word uses of the given emphasis words, outside code.
 *
 * @param lines - Lines from `scanLines` with inline code stripped.
 * @param words - Emphasis words, matched case-sensitively as written.
 * @returns The 1-based line of every match.
 */
export function findShoutingWords(lines: readonly ProseLine[], words: readonly string[]): number[] {
  const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "g");
  return lines.flatMap(({ line, text }) => Array.from(text.matchAll(pattern), () => line));
}

/**
 * Finds directive sentences ("never", "must", "do not", ...) and whether each states a reason.
 * This is a heuristic: it reads sentences in prose and bullets, and skips headings and table rows.
 *
 * @param lines - Lines from `scanLines` with inline code stripped.
 * @returns One entry per directive sentence.
 */
export function findRuleSentences(lines: readonly ProseLine[]): RuleSentence[] {
  return lines.flatMap(({ line, text }) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("|") || trimmed.startsWith("#")) return [];
    const content = trimmed.replace(/^([-*+]|\d+[.)])\s+/, "");
    return content
      .split(/(?<=[.!?])\s+(?=[A-Z`*\[(])/)
      .filter((sentence) => RULE_PATTERN.test(sentence))
      .map((sentence) => ({ line, text: sentence, hasReason: REASON_PATTERN.test(sentence) }));
  });
}

/**
 * Tokenizes a description into lowercase words of three or more letters for similarity checks.
 *
 * @param text - Description text.
 * @returns The set of distinct words.
 */
export function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
}

/**
 * Computes the Jaccard similarity of two word sets.
 *
 * @param left - First set.
 * @param right - Second set.
 * @returns A value from 0 (disjoint) to 1 (identical).
 */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  left.forEach((word) => {
    if (right.has(word)) shared += 1;
  });
  return shared / (left.size + right.size - shared);
}
