/**
 * Offline token estimate: UTF-8 bytes divided by 4, rounded. It is an estimate, not a
 * tokenizer, so callers must label what they derive from it as estimated. Real counts differ by
 * model: on one skill document it came out close to a Haiku 4.5 tokenizer's count and about
 * 30% under a Sonnet 5 tokenizer's. This is the single estimate used for skill size checks and
 * context-composition reporting; do not write a second one.
 *
 * @param text - Any text.
 * @returns The rounded token estimate (0 for an empty string).
 * @example
 * estimateTokens("abcd"); // 1
 */
export function estimateTokens(text: string): number {
  return Math.round(new TextEncoder().encode(text).length / 4);
}
