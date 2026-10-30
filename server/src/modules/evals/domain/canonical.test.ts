import { describe, expect, it } from "vitest";
import { canonicalJson, jsonDepth, utf8ByteLength } from "./canonical.js";

describe("canonicalJson", () => {
  it("gives the same text whatever the key order, at every level", () => {
    const one = { title: "x", meta: { b: 2, a: [{ y: 1, x: 2 }], c: null }, count: 3 };
    const other = { count: 3, meta: { c: null, a: [{ x: 2, y: 1 }], b: 2 }, title: "x" };
    expect(canonicalJson(one)).toBe(canonicalJson(other));
  });

  it("sorts keys and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
  });

  it("keeps the order of array items", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  it("tells different values apart", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ b: 1 }));
  });

  it("escapes keys and strings like JSON", () => {
    expect(canonicalJson({ 'k"ey': 'va"l\n' })).toBe('{"k\\"ey":"va\\"l\\n"}');
  });

  it("writes scalars and undefined", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("utf8ByteLength", () => {
  it("counts bytes, not characters", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("\u{1F600}")).toBe(4);
  });
});

describe("jsonDepth", () => {
  it("is 0 for a scalar and 1 for a flat container", () => {
    expect(jsonDepth("x", 8)).toBe(0);
    expect(jsonDepth(null, 8)).toBe(0);
    expect(jsonDepth({}, 8)).toBe(1);
    expect(jsonDepth([], 8)).toBe(1);
    expect(jsonDepth({ a: 1, b: "x" }, 8)).toBe(1);
  });

  it("counts nested objects and arrays", () => {
    expect(jsonDepth({ a: [1] }, 8)).toBe(2);
    expect(jsonDepth({ a: { b: [{ c: 1 }] } }, 8)).toBe(4);
  });

  it("reports limit + 1 when the value is deeper than the limit", () => {
    expect(jsonDepth([[[[]]]], 3)).toBe(4);
    expect(jsonDepth([[[[]]]], 4)).toBe(4);
    expect(jsonDepth([[[[[]]]]], 4)).toBe(5);
  });

  it("walks a hostile value without a recursion overflow", () => {
    let nested: unknown = 1;
    for (let level = 0; level < 200_000; level += 1) nested = [nested];
    expect(jsonDepth(nested, 8)).toBe(9);
  });
});
