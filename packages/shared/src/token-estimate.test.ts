import { describe, expect, it } from "vitest";
import { estimateTokens } from "./token-estimate.js";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts four UTF-8 bytes as one token", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("rounds half up", () => {
    expect(estimateTokens("abcdefghij")).toBe(3);
  });

  it("counts bytes, not characters", () => {
    expect(estimateTokens("éééé")).toBe(2);
  });
});
