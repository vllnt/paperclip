/**
 * The longest goal title or success criteria, in UTF-16 code units. Agents read goal text in
 * their run context, so it stays short; a goal's description holds anything longer.
 */
export const GOAL_TEXT_MAX_LENGTH = 280;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts `value` to at most `maxLength` UTF-16 code units, ending with "…" when it cuts. It cuts
 * only between graphemes, so the result is always well formed: no lone surrogate from a split
 * emoji, and no letter separated from its accents.
 *
 * @example truncateAtGrapheme("😀".repeat(141), 280) // 139 emoji then "…", 279 code units
 */
export function truncateAtGrapheme(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const budget = maxLength - 1;
  let end = 0;
  for (const { segment } of graphemes.segment(value)) {
    if (end + segment.length > budget) break;
    end += segment.length;
  }
  return `${value.slice(0, end)}…`;
}
