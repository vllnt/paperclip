import { describe, expect, it } from "vitest";
import { CODEOWNERS_PATHS, CONTROL_PROTECTED_PATHS, MINIMUM_PROTECTED_PATHS, isCodeownersPath, isControlRepository, matchesProtectedPath, parseAgentMergeablePaths, parseJsonWithoutDuplicateKeys, parseProtectedPaths, protectedFiles, protectedPatterns, releasedByOptIn, splitReleased, type AgentMergeableRule } from "../src/protected-paths.js";

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

describe("the opt-in that releases some protected paths for agent merges", () => {
  const rule = (extra: Partial<AgentMergeableRule> = {}): AgentMergeableRule => ({ repository: "owner/repo", allow: [".github/**"], exclude: [], ...extra });

  it("keeps the minimum list as it was: .github/** and the three CODEOWNERS paths", () => {
    expect([...MINIMUM_PROTECTED_PATHS]).toEqual([".github/**", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);
    expect([...CODEOWNERS_PATHS]).toEqual(["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);
  });

  it("knows a CODEOWNERS path at any depth and in any case, and nothing near it", () => {
    for (const path of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", "a/b/CODEOWNERS", ".github/codeowners", "Docs/CodeOwners"]) expect(isCodeownersPath(path), path).toBe(true);
    // A directory named like the file covers what is below it, as it does in the protected list (the cautious reading).
    expect(isCodeownersPath(".github/codeowners/readme.md")).toBe(true);
    for (const path of [".github/workflows/ci.yml", "CODEOWNERS.md", "docs/CODEOWNERS-guide.md", ".github/OWNERS"]) expect(isCodeownersPath(path), path).toBe(false);
  });

  it("knows a control repository by the code's list or by a tiers file, in any case", () => {
    expect(isControlRepository("Anthm-FR/Anthm-FR", null)).toBe(true);
    expect(isControlRepository("owner/repo", [])).toBe(true);
    expect(isControlRepository("owner/repo", ["a/**"])).toBe(true);
    expect(isControlRepository("owner/repo", null)).toBe(false);
    // The protected patterns are decided by the same check.
    expect(protectedPatterns("owner/repo", null)).not.toContain("paperclip/**");
    expect(protectedPatterns("owner/repo", [])).toContain("paperclip/**");
  });

  it("reads a valid config: lower-cases the repository, defaults exclude to none, keeps the order", () => {
    expect(parseAgentMergeablePaths([{ repository: "Owner/Repo", allow: [".github/workflows/**"] }, { repository: "o/b", allow: [".github/**"], exclude: ["x"] }]))
      .toEqual({ rules: [{ repository: "owner/repo", allow: [".github/workflows/**"], exclude: [] }, { repository: "o/b", allow: [".github/**"], exclude: ["x"] }], problems: [] });
    for (const none of [undefined, null, []]) expect(parseAgentMergeablePaths(none)).toEqual({ rules: [], problems: [] });
  });

  it("drops an invalid entry whole, keeps the valid ones, and says why", () => {
    const parsed = parseAgentMergeablePaths([
      { repository: "owner/one", allow: [".github/**"] },
      { repository: "owner/two", allow: ["CODEOWNERS"] },
      { repository: "owner/three", allow: [".github/**", ".github/CODEOWNERS"] },
      { repository: "owner/four", allow: ["scripts/**"] },
      { repository: "owner/five", allow: [".github/**"], exclude: ["../x"] },
      { repository: "owner/six", allow: [".github/**"], extra: 1 },
      "text", null, [],
    ]);
    expect(parsed.rules.map(entry => entry.repository)).toEqual(["owner/one"]);
    expect(parsed.problems).toHaveLength(8);
    expect(parsed.problems.join("\n")).toMatch(/cannot name CODEOWNERS/);
    expect(parsed.problems.join("\n")).toMatch(/only release paths under \.github\//);
  });

  it("releases nothing for a repository that is listed twice, and for a list that is too long or not a list", () => {
    expect(parseAgentMergeablePaths([{ repository: "o/r", allow: [".github/**"] }, { repository: "O/R", allow: [".github/workflows/**"] }, { repository: "o/other", allow: [".github/**"] }]).rules.map(entry => entry.repository)).toEqual(["o/other"]);
    expect(parseAgentMergeablePaths(Array.from({ length: 51 }, (_, n) => ({ repository: `o/r${n}`, allow: [".github/**"] }))).rules).toEqual([]);
    for (const bad of ["yes", 7, true, { repository: "o/r", allow: [".github/**"] }]) expect(parseAgentMergeablePaths(bad).rules, JSON.stringify(bad)).toEqual([]);
  });

  it("releases a path only when allow covers it, no exclusion does, and it is not a CODEOWNERS, control or tiers path", () => {
    const r = rule({ exclude: [".github/workflows/release.yml", "**/deploy.*"] });
    expect(releasedByOptIn(r, ".github/workflows/ci.yml", null)).toBe(true);
    expect(releasedByOptIn(r, ".github/workflows/release.yml", null)).toBe(false);
    expect(releasedByOptIn(r, ".GitHub/Workflows/Release.yml", null)).toBe(false);
    expect(releasedByOptIn(r, ".github/actions/x/deploy.sh", null)).toBe(false);
    expect(releasedByOptIn(rule({ allow: [".github/workflows/**"] }), ".github/dependabot.yml", null)).toBe(false);
    for (const path of CODEOWNERS_PATHS) expect(releasedByOptIn(rule({ allow: [".github/**", path] }), path, null), path).toBe(false);
    for (const path of CONTROL_PROTECTED_PATHS.filter(path => !path.includes("*"))) expect(releasedByOptIn(rule({ allow: [".github/**"] }), `.github/${path}`, null), path).toBe(false);
    expect(releasedByOptIn(r, ".github/workflows/ci.yml", [".github/workflows/ci.yml"])).toBe(false);
    expect(releasedByOptIn(r, "src/ok.ts", null)).toBe(false);
  });

  it("splits the protected files of a pull request, and releases nothing for a control repository", () => {
    const r = rule({ exclude: [".github/workflows/release.yml"] });
    const touched = [".github/CODEOWNERS", ".github/dependabot.yml", ".github/workflows/ci.yml", ".github/workflows/release.yml"];
    expect(splitReleased(touched, r, "owner/repo", null)).toEqual({ released: [".github/dependabot.yml", ".github/workflows/ci.yml"], kept: [".github/CODEOWNERS", ".github/workflows/release.yml"] });
    expect(splitReleased(touched, null, "owner/repo", null)).toEqual({ released: [], kept: touched });
    expect(splitReleased(touched, r, "anthm-fr/anthm-fr", null)).toEqual({ released: [], kept: touched });
    expect(splitReleased(touched, r, "owner/repo", ["paperclip/**"])).toEqual({ released: [], kept: touched });
    expect(splitReleased([], r, "owner/repo", null)).toEqual({ released: [], kept: [] });
  });

  it("covers a rename by both of its names", () => {
    const files = [{ filename: ".github/workflows/ci.yml", previousFilename: ".github/workflows/release.yml" }];
    const touched = protectedFiles(files, protectedPatterns("owner/repo", null));
    expect(splitReleased(touched, rule({ exclude: [".github/workflows/release.yml"] }), "owner/repo", null).kept).toEqual([".github/workflows/release.yml"]);
  });
});
