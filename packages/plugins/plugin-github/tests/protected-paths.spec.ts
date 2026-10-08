import { describe, expect, it } from "vitest";
import { matchesProtectedPath, parseJsonWithoutDuplicateKeys, parseProtectedPaths, protectedFiles, protectedPatterns } from "../src/protected-paths.js";

describe("protected paths (P4b, round 4)", () => {
  it("reads protectedPaths from a tiers file and nothing else", () => {
    const tiers = "version: 1\ntiers:\n  - id: T0\n    covers:\n      - wording\nprotectedPaths:\n  - paperclip/**\n  # a comment\n  - \"scripts/**\"\n  - 'ROADMAP.md' # trailing\n\n  - data/company/monetisation/**/*goals*\nrules:\n  - x\n";
    expect(parseProtectedPaths(tiers)).toEqual(["paperclip/**", "scripts/**", "ROADMAP.md", "data/company/monetisation/**/*goals*"]);
    for (const bad of ["protectedPaths: [a]\n", "protectedPaths:\n  - &a b\n", "protectedPaths:\n  - path: b\n", "protectedPaths:\n\t- b\n", "x: 1\n", "protectedPaths:\n  - /etc\n", "protectedPaths:\n  - a\n---\nprotectedPaths:\n  - b\n"]) {
      expect(() => parseProtectedPaths(bad), bad).toThrow();
    }
  });

  it("matches gitignore-like globs, parents and any case", () => {
    expect(matchesProtectedPath("paperclip/**", "paperclip/a/b.yaml")).toBe(true);
    expect(matchesProtectedPath("paperclip/**", "PaperClip/a")).toBe(true);
    expect(matchesProtectedPath("paperclip/**", "paperclipx/a")).toBe(false);
    expect(matchesProtectedPath("CODEOWNERS", "docs/CODEOWNERS")).toBe(true);
    expect(matchesProtectedPath(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(matchesProtectedPath("data/company/monetisation/**/*goals*", "data/company/monetisation/q4-goals.md")).toBe(true);
    expect(matchesProtectedPath("data/products/*/knowledge/wiki-history/**", "data/products/linkzic/knowledge/wiki-history/x.md")).toBe(true);
    expect(matchesProtectedPath("data/products/*/knowledge/wiki-history/**", "data/products/linkzic/knowledge/other/x.md")).toBe(false);
    expect(matchesProtectedPath("scripts", "scripts/deploy.sh")).toBe(true);
    expect(matchesProtectedPath("ROADMAP.md", "README.md")).toBe(false);
  });

  it("protects .github and CODEOWNERS everywhere, and the control list in the control repository or with a tiers file", () => {
    expect(protectedPatterns("anthm-fr/songtrivia", null)).toEqual([".github/**", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);
    expect(protectedPatterns("Anthm-FR/anthm-fr", null)).toEqual(expect.arrayContaining(["paperclip/**", "scripts/**", "ROADMAP.md", "data/company/strategy/**", ".github/**", "CODEOWNERS"]));
    expect(protectedPatterns("anthm-fr/songtrivia", ["x/**"])).toEqual(expect.arrayContaining(["paperclip/**", "x/**"]));
    expect(protectedFiles([{ filename: "b.ts", previousFilename: "scripts/a.ts" }, { filename: "ok.ts" }], ["scripts/**"])).toEqual(["scripts/a.ts"]);
  });
});

describe("protected paths (round 5)", () => {
  it("m5: x/** covers x itself", () => {
    expect(matchesProtectedPath("paperclip/**", "paperclip")).toBe(true);
    expect(matchesProtectedPath(".github/**", ".github")).toBe(true);
    expect(matchesProtectedPath("data/company/strategy/**", "data/company/strategy")).toBe(true);
    expect(matchesProtectedPath("paperclip/**", "paperclips")).toBe(false);
  });

  it("m3: reads JSON strictly, refusing a duplicate key", () => {
    expect(parseJsonWithoutDuplicateKeys('{"a":[1,{"b":"x\\"y"}],"c":null}')).toEqual({ a: [1, { b: 'x"y' }], c: null });
    for (const bad of ['{"owner":"evil","owner":"anthm"}', '{"a":{"b":1,"b":2}}', '{"a":1,}', '{"a":1} x', "{'a':1}"]) expect(() => parseJsonWithoutDuplicateKeys(bad), bad).toThrow();
    expect(Object.getPrototypeOf(parseJsonWithoutDuplicateKeys('{"__proto__":{"x":1}}'))).toBe(Object.prototype);
  });
});
