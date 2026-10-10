import { createHash } from "node:crypto";
import { redactSensitiveText } from "../redaction.js";

/** Description characters sent to the model and compared lexically. Keeps requests small and cheap. */
export const DUPLICATE_DESCRIPTION_MAX_CHARS = 1_500;

/** Ranking weight for candidates that are an ancestor, descendant or sibling of the new issue. */
export const RELATED_ISSUE_WEIGHT = 0.8;

const TITLE_WEIGHT = 0.6;
const DESCRIPTION_WEIGHT = 0.4;
const MIN_TOKENS_FOR_MODEL = 3;

export interface IssueText {
  title: string;
  description: string;
}

/**
 * Lowercases and collapses an issue's text so trivial edits (case, punctuation, spacing) compare equal.
 * @returns Letters and digits separated by single spaces.
 */
export function normalizeIssueText(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Counts normalized word tokens across title and description. */
export function contentTokenCount(issue: IssueText): number {
  const joined = `${normalizeIssueText(issue.title)} ${normalizeIssueText(issue.description)}`.trim();
  return joined ? joined.split(" ").length : 0;
}

/** Titles longer than this are cut before any comparison or request. */
export const DUPLICATE_TITLE_MAX_CHARS = 500;
const TITLE_PRE_REDACTION_CHARS = 2_000;
const DESCRIPTION_PRE_REDACTION_CHARS = 20_000;
/** Pairs need at least this many words before identical text counts as an exact duplicate. */
const MIN_TOKENS_FOR_EXACT = 5;

function foldIssueText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Hash of the case-folded title and description with whitespace collapsed. Symbols still count. */
export function exactContentHash(issue: IssueText): string {
  return createHash("sha256")
    .update(`${foldIssueText(issue.title)}\n${foldIssueText(issue.description)}`)
    .digest("hex");
}

/**
 * True when both issues are textually identical and nothing was cut off. Truncated descriptions
 * never qualify, because templated text can match for 1,500 characters and then differ. Short
 * generic titles ("Review pull request") never qualify either.
 */
export function isExactDuplicate(a: IssueText, b: IssueText): boolean {
  const truncated =
    a.description.length >= DUPLICATE_DESCRIPTION_MAX_CHARS ||
    b.description.length >= DUPLICATE_DESCRIPTION_MAX_CHARS ||
    a.title.length >= DUPLICATE_TITLE_MAX_CHARS ||
    b.title.length >= DUPLICATE_TITLE_MAX_CHARS;
  return !truncated && contentTokenCount(a) >= MIN_TOKENS_FOR_EXACT && exactContentHash(a) === exactContentHash(b);
}

/**
 * Prepares issue text for lexical comparison and for the model: cuts oversized input, redacts
 * secrets, then truncates the description.
 */
export function prepareIssueText(input: { title: string; description?: string | null }): IssueText {
  return {
    title: redactSensitiveText(input.title.trim().slice(0, TITLE_PRE_REDACTION_CHARS)).slice(0, DUPLICATE_TITLE_MAX_CHARS),
    description: redactSensitiveText((input.description ?? "").trim().slice(0, DESCRIPTION_PRE_REDACTION_CHARS)).slice(
      0,
      DUPLICATE_DESCRIPTION_MAX_CHARS,
    ),
  };
}

/**
 * A pair is too thin to judge when either side has fewer than three words in total.
 * Very short titles ("Fix bug") are shared by unrelated work, so only the lexical tier reports them.
 */
export function isTooShortForModel(a: IssueText, b: IssueText): boolean {
  return contentTokenCount(a) < MIN_TOKENS_FOR_MODEL || contentTokenCount(b) < MIN_TOKENS_FOR_MODEL;
}

/**
 * pg_trgm trigram set: each alphanumeric word is lowercased, padded with two leading spaces and one
 * trailing space, then cut into three-character windows.
 */
export function trigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) result.add(padded.slice(index, index + 3));
  }
  return result;
}

/**
 * Mirrors pg_trgm `similarity()` (shared trigrams over the union) so offline evaluation matches the
 * database query.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Combines title and description similarity. The description only counts when both issues have one,
 * so a missing description never drags down a matching title.
 */
export function lexicalScore(input: {
  titleSimilarity: number;
  descriptionSimilarity: number;
  bothHaveDescriptions: boolean;
}): number {
  if (!input.bothHaveDescriptions) return input.titleSimilarity;
  return TITLE_WEIGHT * input.titleSimilarity + DESCRIPTION_WEIGHT * input.descriptionSimilarity;
}

/**
 * Returns the ranking weight for a candidate's tree position relative to the new issue.
 * Ancestors, descendants and siblings look alike by construction, so they rank lower but stay eligible.
 */
export function relationWeight(
  subject: { id: string | null; parentId: string | null },
  candidate: { id: string; parentId: string | null },
): number {
  const isAncestor = subject.parentId !== null && candidate.id === subject.parentId;
  const isDescendant = subject.id !== null && candidate.parentId === subject.id;
  const isSibling = subject.parentId !== null && candidate.parentId === subject.parentId;
  return isAncestor || isDescendant || isSibling ? RELATED_ISSUE_WEIGHT : 1;
}
