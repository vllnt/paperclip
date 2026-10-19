import { describe, expect, it } from "vitest";
import { GOAL_TEXT_MAX_LENGTH, truncateAtGrapheme } from "./goal-text.js";

/** True when `text` has no lone UTF-16 surrogate, like `String.prototype.isWellFormed`. */
function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** True when `cut` (without its "…") is a prefix of `value` that ends between two graphemes. */
function endsBetweenGraphemes(value: string, cut: string): boolean {
  const kept = cut.endsWith("…") ? cut.slice(0, -1) : cut;
  if (!value.startsWith(kept)) return false;
  const boundaries = new Set([0]);
  let offset = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    offset += segment.length;
    boundaries.add(offset);
  }
  return boundaries.has(kept.length);
}

describe("truncateAtGrapheme", () => {
  it("leaves text within the limit alone", () => {
    expect(truncateAtGrapheme("Land all open pull requests", GOAL_TEXT_MAX_LENGTH)).toBe("Land all open pull requests");
    expect(truncateAtGrapheme("x".repeat(280), 280)).toBe("x".repeat(280));
  });

  it("cuts plain text to the limit, ending with an ellipsis", () => {
    const cut = truncateAtGrapheme("x".repeat(2000), 280);
    expect(cut).toHaveLength(280);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("never splits an emoji into a lone surrogate", () => {
    const value = "😀".repeat(141);
    const cut = truncateAtGrapheme(value, 280);
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(isWellFormed(cut)).toBe(true);
    expect(isWellFormed(value.slice(0, 279))).toBe(false);
    expect(endsBetweenGraphemes(value, cut)).toBe(true);
  });

  it("never separates a letter from its combining accent", () => {
    const value = "á".repeat(141);
    const cut = truncateAtGrapheme(value, 280);
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut.slice(0, -1).endsWith("á")).toBe(true);
    expect(endsBetweenGraphemes(value, cut)).toBe(true);
  });

  it("keeps a family emoji whole or drops it whole", () => {
    const family = "👨‍👩‍👧‍👦";
    const value = `${"x".repeat(275)}${family}`;
    const cut = truncateAtGrapheme(value, 280);
    expect(cut).toBe(`${"x".repeat(275)}…`);
  });
});
