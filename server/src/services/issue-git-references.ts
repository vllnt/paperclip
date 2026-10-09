/** Where a task reference was found, strongest first. */
export type IssueGitReferenceVia = "head_ref" | "keyword" | "bracket" | "refs" | "mention";

export interface IssueGitReference {
  /** Canonical identifier, for example `PAP-123`. */
  identifier: string;
  issueNumber: number;
  /** True when a merge should be allowed to complete the task. */
  closes: boolean;
  via: IssueGitReferenceVia;
}

export interface ExtractIssueGitReferencesInput {
  /** The company's own issue prefix. Only identifiers with this prefix can match. */
  prefix: string;
  headRef?: string | null;
  title?: string | null;
  body?: string | null;
}

const MAX_TEXT_LENGTH = 24_000;
const MAX_REFERENCES = 10;
const VIA_RANK: Record<IssueGitReferenceVia, number> = { head_ref: 0, keyword: 1, bracket: 2, refs: 3, mention: 4 };
const SOURCE_STRIDE = MAX_TEXT_LENGTH + 1;

const CLOSING_WORDS =
  "(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|implement(?:s|ed|ing)?)";
const REFS_WORDS = "(?:refs?|references?|part\\s+of|related\\s+to|relates\\s+to|contributes?\\s+to|towards?)";
const SKIP_WORDS = "(?:skip|ignore)";

interface Candidate {
  issueNumber: number;
  closes: boolean;
  via: IssueGitReferenceVia;
  order: number;
}

function cleanPrefix(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9]/g, "");
}

function bounded(value: string | null | undefined): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : "";
}

function wordRun(words: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${words}(?![A-Za-z0-9_])[\\s:]+`, "gi");
}

/**
 * Reads the run of identifiers that follows a keyword: `PAP-1`, `[PAP-1]`,
 * `PAP-1, PAP-2`, `PAP-1 and PAP-2`. Each step consumes input, so the scan is linear.
 */
function readIdentifierRun(text: string, from: number, step: RegExp): Array<{ issueNumber: number; offset: number }> {
  const found: Array<{ issueNumber: number; offset: number }> = [];
  let cursor = from;
  for (;;) {
    step.lastIndex = cursor;
    const match = step.exec(text);
    if (!match) return found;
    found.push({ issueNumber: Number(match[1]), offset: match.index });
    cursor = step.lastIndex;
  }
}

function collectKeywordRuns(
  text: string,
  words: string,
  idStep: RegExp,
): Array<{ issueNumber: number; offset: number }> {
  const results: Array<{ issueNumber: number; offset: number }> = [];
  const keyword = wordRun(words);
  for (let match = keyword.exec(text); match; match = keyword.exec(text)) {
    results.push(...readIdentifierRun(text, keyword.lastIndex, idStep));
  }
  return results;
}

/**
 * Finds the company's own task identifiers in a pull request's branch, title and body.
 *
 * Pure and linear-time. The identifier pattern is built from `prefix`, so another
 * company's identifiers can never match here.
 */
export function extractIssueGitReferences(input: ExtractIssueGitReferencesInput): IssueGitReference[] {
  const prefix = cleanPrefix(input.prefix);
  if (!prefix) return [];
  const digits = "([1-9]\\d{0,8})";
  const notWordAfter = "(?![A-Za-z0-9_])";
  const anyId = new RegExp(`(?<![A-Za-z0-9_])${prefix}-${digits}${notWordAfter}`, "gi");
  const bracketId = new RegExp(`\\[${prefix}-${digits}\\]`, "gi");
  const idStep = new RegExp(`\\s*(?:,|&|\\band\\b)?\\s*\\[?${prefix}-${digits}${notWordAfter}\\]?`, "iy");

  const headRef = bounded(input.headRef);
  const title = bounded(input.title);
  const body = bounded(input.body);

  const skipped = new Set<number>();
  for (const text of [title, body]) {
    for (const hit of collectKeywordRuns(text, SKIP_WORDS, idStep)) skipped.add(hit.issueNumber);
  }

  const candidates: Candidate[] = [];
  const add = (issueNumber: number, closes: boolean, via: IssueGitReferenceVia, order: number) => {
    if (!skipped.has(issueNumber)) candidates.push({ issueNumber, closes, via, order });
  };

  for (const match of headRef.matchAll(anyId)) add(Number(match[1]), true, "head_ref", match.index);

  [title, body].forEach((text, index) => {
    const base = (index + 1) * SOURCE_STRIDE;
    for (const hit of collectKeywordRuns(text, CLOSING_WORDS, idStep)) add(hit.issueNumber, true, "keyword", base + hit.offset);
    for (const hit of collectKeywordRuns(text, REFS_WORDS, idStep)) add(hit.issueNumber, false, "refs", base + hit.offset);
    if (index === 0) {
      for (const match of text.matchAll(bracketId)) add(Number(match[1]), true, "bracket", base + match.index);
    }
    for (const match of text.matchAll(anyId)) add(Number(match[1]), false, "mention", base + match.index);
  });

  candidates.sort((a, b) => a.order - b.order);
  const merged = new Map<number, IssueGitReference>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.issueNumber);
    if (!existing) {
      if (merged.size >= MAX_REFERENCES) continue;
      merged.set(candidate.issueNumber, {
        identifier: `${prefix.toUpperCase()}-${candidate.issueNumber}`,
        issueNumber: candidate.issueNumber,
        closes: candidate.closes,
        via: candidate.via,
      });
      continue;
    }
    existing.closes = existing.closes || candidate.closes;
    if (VIA_RANK[candidate.via] < VIA_RANK[existing.via]) existing.via = candidate.via;
  }
  return [...merged.values()];
}
