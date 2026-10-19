import { describe, expect, it } from "vitest";
import { extractIssueGitReferences } from "../services/issue-git-references.js";

const prefix = "PAP";

describe("extractIssueGitReferences", () => {
  it("links the identifier in a branch name case-insensitively and closes it", () => {
    for (const headRef of ["PAP-123-fix-login", "pap-123-fix-login", "feat/pap-123-fix-login", "alex/PAP-123"]) {
      expect(extractIssueGitReferences({ prefix, headRef })).toEqual([
        { identifier: "PAP-123", issueNumber: 123, closes: true, via: "head_ref" },
      ]);
    }
  });

  it("does not match identifiers glued to other letters, digits or another prefix", () => {
    for (const headRef of ["rpap-123-x", "pap-123abc", "pap-1234567890", "xpap-12", "papa-12", "map-12-fix"]) {
      expect(extractIssueGitReferences({ prefix, headRef })).toEqual([]);
    }
  });

  it("only ever matches the given company prefix", () => {
    expect(extractIssueGitReferences({ prefix: "ANT", headRef: "pap-5-fix", title: "Fixes PAP-5" })).toEqual([]);
  });

  it("treats closing words in the title or body as closing links", () => {
    const refs = extractIssueGitReferences({
      prefix,
      title: "Stop the retry loop",
      body: "Fixes PAP-7\nCloses: PAP-8, PAP-9\nresolved [PAP-10]",
    });
    expect(refs.map((r) => [r.identifier, r.closes, r.via])).toEqual([
      ["PAP-7", true, "keyword"],
      ["PAP-8", true, "keyword"],
      ["PAP-9", true, "keyword"],
      ["PAP-10", true, "keyword"],
    ]);
  });

  it("treats refs-style words and bare mentions as link-only", () => {
    const refs = extractIssueGitReferences({
      prefix,
      title: "Retry tweak, follow-up to PAP-3",
      body: "Part of PAP-4\nrefs PAP-5\nrelated to PAP-6\ncontributes to PAP-11",
    });
    expect(refs.map((r) => [r.identifier, r.closes])).toEqual([
      ["PAP-3", false],
      ["PAP-4", false],
      ["PAP-5", false],
      ["PAP-6", false],
      ["PAP-11", false],
    ]);
    expect(refs.find((r) => r.identifier === "PAP-3")?.via).toBe("mention");
    expect(refs.find((r) => r.identifier === "PAP-4")?.via).toBe("refs");
  });

  it("closes from a bracketed identifier in the title only", () => {
    expect(extractIssueGitReferences({ prefix, title: "[PAP-21] Add retries" })).toEqual([
      { identifier: "PAP-21", issueNumber: 21, closes: true, via: "bracket" },
    ]);
    expect(extractIssueGitReferences({ prefix, title: "Add retries", body: "see [PAP-21]" })).toEqual([
      { identifier: "PAP-21", issueNumber: 21, closes: false, via: "mention" },
    ]);
  });

  it("lets skip and ignore tokens remove an identifier even when the branch names it", () => {
    expect(
      extractIssueGitReferences({ prefix, headRef: "pap-30-spike", body: "skip PAP-30\nignore: [PAP-31]\nFixes PAP-32" }),
    ).toEqual([{ identifier: "PAP-32", issueNumber: 32, closes: true, via: "keyword" }]);
  });

  it("merges signals for one identifier: closing and the strongest source win", () => {
    expect(
      extractIssueGitReferences({ prefix, headRef: "pap-40-x", title: "see PAP-40", body: "refs PAP-40" }),
    ).toEqual([{ identifier: "PAP-40", issueNumber: 40, closes: true, via: "head_ref" }]);
  });

  it("caps the result at 10 identifiers and ignores zero or absurd numbers", () => {
    const body = Array.from({ length: 30 }, (_, i) => `Fixes PAP-${i + 1}`).join("\n");
    expect(extractIssueGitReferences({ prefix, body })).toHaveLength(10);
    expect(extractIssueGitReferences({ prefix, body: "Fixes PAP-0 and PAP-000" })).toEqual([]);
  });

  it("stays fast on hostile input", () => {
    const hostile = `${"Fixes ".repeat(4000)}${"PAP-".repeat(4000)}`;
    const started = performance.now();
    extractIssueGitReferences({ prefix, title: hostile, body: hostile, headRef: hostile });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("returns nothing for empty input", () => {
    expect(extractIssueGitReferences({ prefix })).toEqual([]);
    expect(extractIssueGitReferences({ prefix, headRef: null, title: null, body: null })).toEqual([]);
  });
});
