import { describe, expect, it } from "vitest";
import { MAX_INPUT_DEPTH, isInputTooDeep, isJsonObject, redactJsonStrings } from "./input.js";

function tokenShaped(): string {
  return `${["gh", "p_"].join("")}A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8`;
}

/** A stand-in for the real redactor: masks every run of the fake token. */
function maskToken(text: string): string {
  return text.replaceAll(tokenShaped(), "***MASKED***");
}

describe("redactJsonStrings", () => {
  it("masks a string value and counts it", () => {
    const result = redactJsonStrings({ title: `deploy with ${tokenShaped()}` }, maskToken);
    expect(result.value).toEqual({ title: "deploy with ***MASKED***" });
    expect(result.redactionCount).toBe(1);
  });

  it("masks the items of a string array and counts each changed item", () => {
    const result = redactJsonStrings({ labels: ["ok", tokenShaped(), `x ${tokenShaped()}`] }, maskToken);
    expect(result.value).toEqual({ labels: ["ok", "***MASKED***", "x ***MASKED***"] });
    expect(result.redactionCount).toBe(2);
  });

  it("counts changed values, not matches", () => {
    const result = redactJsonStrings({ title: `${tokenShaped()} and ${tokenShaped()}` }, maskToken);
    expect(result.value).toEqual({ title: "***MASKED*** and ***MASKED***" });
    expect(result.redactionCount).toBe(1);
  });

  it("walks any JSON shape to any depth", () => {
    const input = {
      a: { b: { c: [{ d: tokenShaped() }, [tokenShaped(), "plain"]] } },
      e: [[[tokenShaped()]]],
    };
    const result = redactJsonStrings(input, maskToken);
    expect(result.value).toEqual({
      a: { b: { c: [{ d: "***MASKED***" }, ["***MASKED***", "plain"]] } },
      e: [[["***MASKED***"]]],
    });
    expect(result.redactionCount).toBe(3);
  });

  it("masks a top-level string and a top-level array", () => {
    expect(redactJsonStrings(tokenShaped(), maskToken)).toEqual({ value: "***MASKED***", redactionCount: 1 });
    expect(redactJsonStrings([tokenShaped(), 1], maskToken)).toEqual({ value: ["***MASKED***", 1], redactionCount: 1 });
  });

  it("leaves numbers, booleans and null as they are", () => {
    const input = { n: 1.5, b: true, z: null, list: [1, false, null] };
    expect(redactJsonStrings(input, maskToken)).toEqual({ value: input, redactionCount: 0 });
  });

  it("leaves object keys as they are", () => {
    const result = redactJsonStrings({ [tokenShaped()]: "plain" }, maskToken);
    expect(Object.keys(result.value as object)).toEqual([tokenShaped()]);
    expect(result.redactionCount).toBe(0);
  });

  it("counts nothing when no value changes", () => {
    const input = { title: "Fix the login page", labels: ["bug", "ui"] };
    expect(redactJsonStrings(input, maskToken)).toEqual({ value: input, redactionCount: 0 });
  });

  it("does not change its input", () => {
    const input = { title: tokenShaped(), nested: { labels: [tokenShaped()] } };
    const before = JSON.stringify(input);
    redactJsonStrings(input, maskToken);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns no matched text", () => {
    const result = redactJsonStrings({ a: tokenShaped(), b: [tokenShaped()], c: { d: tokenShaped() } }, maskToken);
    expect(JSON.stringify(result)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
  });

  it("calls the redactor once for each string value and item", () => {
    const seen: string[] = [];
    redactJsonStrings({ a: "one", b: ["two", "three"], c: { d: "four" }, e: 5 }, (text) => {
      seen.push(text);
      return text;
    });
    expect(seen.sort()).toEqual(["four", "one", "three", "two"]);
  });
});

describe("isInputTooDeep", () => {
  function nest(levels: number): unknown {
    let value: unknown = "leaf";
    for (let level = 0; level < levels; level += 1) value = { v: value };
    return value;
  }

  it("allows an input as deep as the limit", () => {
    expect(MAX_INPUT_DEPTH).toBe(8);
    expect(isInputTooDeep({ title: "x", labels: ["a"] })).toBe(false);
    expect(isInputTooDeep(nest(MAX_INPUT_DEPTH))).toBe(false);
  });

  it("rejects an input one level past the limit", () => {
    expect(isInputTooDeep(nest(MAX_INPUT_DEPTH + 1))).toBe(true);
  });

  it("rejects a very deep input without overflowing the stack", () => {
    expect(isInputTooDeep(nest(200_000))).toBe(true);
  });

  it("treats a scalar as shallow", () => {
    expect(isInputTooDeep("x")).toBe(false);
    expect(isInputTooDeep(null)).toBe(false);
  });
});

describe("isJsonObject", () => {
  it("accepts a plain JSON object", () => {
    expect(isJsonObject({ a: 1, b: ["x", null, { c: true }] })).toBe(true);
    expect(isJsonObject({})).toBe(true);
  });

  it("rejects arrays, scalars and null", () => {
    for (const value of [[], [1], "x", 1, true, null, undefined]) expect(isJsonObject(value)).toBe(false);
  });

  it("rejects values that JSON cannot carry", () => {
    expect(isJsonObject({ a: undefined })).toBe(false);
    expect(isJsonObject({ a: Number.NaN })).toBe(false);
    expect(isJsonObject({ a: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isJsonObject({ a: () => 1 })).toBe(false);
  });
});
