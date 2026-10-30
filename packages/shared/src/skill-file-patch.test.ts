import { describe, expect, it } from "vitest";
import { applySkillFileHunks, diffSkillFileHunk } from "./skill-file-patch.js";

describe("applySkillFileHunks", () => {
  const file = "# Title\n\nalpha\nbeta\ngamma\n";

  it("replaces each hunk that matches exactly once, in any order", () => {
    expect(applySkillFileHunks(file, [
      { old: "gamma\n", new: "GAMMA\n" },
      { old: "alpha\n", new: "" },
    ])).toEqual({ ok: true, content: "# Title\n\nbeta\nGAMMA\n" });
  });

  it("matches every hunk against the current file, not against earlier results", () => {
    expect(applySkillFileHunks("one two", [
      { old: "one", new: "two" },
      { old: "two", new: "three" },
    ])).toEqual({ ok: true, content: "two three" });
  });

  it("refuses a hunk whose old text is missing", () => {
    expect(applySkillFileHunks(file, [{ old: "alpha\n", new: "a\n" }, { old: "delta\n", new: "d\n" }]))
      .toEqual({ ok: false, code: "hunk_not_found", hunkIndex: 1 });
  });

  it("refuses an empty old text as not found", () => {
    expect(applySkillFileHunks(file, [{ old: "", new: "x" }])).toEqual({ ok: false, code: "hunk_not_found", hunkIndex: 0 });
  });

  it("refuses a hunk whose old text matches more than once, overlapping matches included", () => {
    expect(applySkillFileHunks("aaa", [{ old: "aa", new: "b" }]))
      .toEqual({ ok: false, code: "hunk_ambiguous", hunkIndex: 0, matchCount: 2 });
    expect(applySkillFileHunks("x\nx\n", [{ old: "x\n", new: "y\n" }]))
      .toEqual({ ok: false, code: "hunk_ambiguous", hunkIndex: 0, matchCount: 2 });
  });

  it("refuses overlapping hunks and names both", () => {
    expect(applySkillFileHunks(file, [{ old: "alpha\nbeta", new: "x" }, { old: "beta\ngamma", new: "y" }]))
      .toEqual({ ok: false, code: "hunks_overlap", hunkIndex: 1, otherHunkIndex: 0 });
    expect(applySkillFileHunks(file, [{ old: "beta", new: "x" }, { old: "beta", new: "y" }]))
      .toEqual({ ok: false, code: "hunks_overlap", hunkIndex: 1, otherHunkIndex: 0 });
  });

  it("accepts hunks that touch without overlapping", () => {
    expect(applySkillFileHunks("ab", [{ old: "b", new: "B" }, { old: "a", new: "A" }])).toEqual({ ok: true, content: "AB" });
  });

  it("matches line endings exactly", () => {
    expect(applySkillFileHunks("a\r\nb\r\n", [{ old: "a\n", new: "x\n" }]))
      .toEqual({ ok: false, code: "hunk_not_found", hunkIndex: 0 });
  });
});

describe("diffSkillFileHunk", () => {
  it("returns null when nothing changed or the base is empty", () => {
    expect(diffSkillFileHunk("a\n", "a\n")).toBeNull();
    expect(diffSkillFileHunk("", "a\n")).toBeNull();
  });

  it("widens a changed span to whole lines", () => {
    expect(diffSkillFileHunk("a\nbeta\nc\n", "a\nbesta\nc\n")).toEqual({ old: "beta\n", new: "besta\n" });
  });

  it("anchors an insertion and an append to a neighbouring line", () => {
    expect(diffSkillFileHunk("a\nb\n", "a\nX\nb\n")).toEqual({ old: "b\n", new: "X\nb\n" });
    expect(diffSkillFileHunk("a\n", "a\nb\n")).toEqual({ old: "a\n", new: "a\nb\n" });
  });

  it("adds lines of context until the old text is unique", () => {
    expect(diffSkillFileHunk("x\n-\ny\n-\n", "x\n-\ny\n+\n")).toEqual({ old: "y\n-\n", new: "y\n+\n" });
  });

  it("keeps an edit made elsewhere since the base was read", () => {
    const base = "# Skill\n\nStep one.\nStep two.\nStep three.\n";
    const mine = base.replace("Step two.", "Step two, revised.");
    const theirs = base.replace("Step three.", "Step three, newer.");
    const hunk = diffSkillFileHunk(base, mine)!;
    expect(applySkillFileHunks(theirs, [hunk])).toEqual({
      ok: true,
      content: "# Skill\n\nStep one.\nStep two, revised.\nStep three, newer.\n",
    });
  });

  it("fails instead of reverting a newer edit to the same lines", () => {
    const base = "a\nb\nc\n";
    const hunk = diffSkillFileHunk(base, "a\nB\nc\n")!;
    expect(applySkillFileHunks("a\nb2\nc\n", [hunk])).toMatchObject({ ok: false, code: "hunk_not_found" });
  });

  it("always produces a hunk that turns base into next", () => {
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const alphabet = ["a", "b", "\n", "x", "\r\n"];
    const text = (length: number) => Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");
    for (let round = 0; round < 500; round += 1) {
      const base = text(1 + random(30));
      const start = random(base.length + 1);
      const end = start + random(base.length - start + 1);
      const next = base.slice(0, start) + text(random(6)) + base.slice(end);
      const hunk = diffSkillFileHunk(base, next);
      if (base === next) {
        expect(hunk).toBeNull();
        continue;
      }
      expect(applySkillFileHunks(base, [hunk!])).toEqual({ ok: true, content: next });
    }
  });
});
