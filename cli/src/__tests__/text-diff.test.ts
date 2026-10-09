import { describe, expect, it } from "vitest";
import { diffFileSets, unifiedLineDiff } from "../commands/client/text-diff.js";

describe("unifiedLineDiff", () => {
  it("returns no hunks for equal text", () => {
    expect(unifiedLineDiff("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("emits one hunk with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n") + "\n";
    expect(unifiedLineDiff(before, after)).toEqual([
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+five",
      " 6",
      " 7",
      " 8",
    ]);
  });

  it("splits distant changes into separate hunks and handles inserts and deletes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    lines.splice(1, 1);
    lines.splice(17, 0, "inserted");
    const after = lines.join("\n");
    expect(unifiedLineDiff(before, after)).toEqual([
      "@@ -1,5 +1,4 @@",
      " line1",
      "-line2",
      " line3",
      " line4",
      " line5",
      "@@ -16,5 +15,6 @@",
      " line16",
      " line17",
      " line18",
      "+inserted",
      " line19",
      " line20",
      "\\ No newline at end of file",
    ]);
  });

  it("uses a zero start for a hunk that adds to an empty file", () => {
    expect(unifiedLineDiff("", "a\nb\n")).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
  });

  it("reports a change that is only the trailing newline", () => {
    expect(unifiedLineDiff("a\n", "a")).toEqual(["@@ -1,1 +1,1 @@", "-a", "+a", "\\ No newline at end of file"]);
  });
});

describe("diffFileSets", () => {
  it("lists added, removed, modified, and binary files sorted by path", () => {
    const result = diffFileSets(
      [
        { path: "SKILL.md", content: "# Skill\nold\n" },
        { path: "scripts/run.sh", content: "echo hi\n" },
        { path: "assets/logo.png", content: "AAAA", encoding: "base64" },
        { path: "same.md", content: "same\n" },
      ],
      [
        { path: "SKILL.md", content: "# Skill\nnew\n" },
        { path: "references/api.md", content: "api\n" },
        { path: "assets/logo.png", content: "BBBB", encoding: "base64" },
        { path: "same.md", content: "same\n" },
      ],
    );

    expect(result.map((file) => [file.path, file.change, file.binary])).toEqual([
      ["SKILL.md", "modified", false],
      ["assets/logo.png", "modified", true],
      ["references/api.md", "added", false],
      ["scripts/run.sh", "removed", false],
    ]);
    expect(result[0]?.diff).toEqual([
      "--- a/SKILL.md",
      "+++ b/SKILL.md",
      "@@ -1,2 +1,2 @@",
      " # Skill",
      "-old",
      "+new",
    ]);
    expect(result[1]?.diff).toEqual(["Binary file assets/logo.png differs"]);
    expect(result[2]?.diff).toEqual(["--- /dev/null", "+++ b/references/api.md", "@@ -0,0 +1,1 @@", "+api"]);
    expect(result[3]?.diff).toEqual(["--- a/scripts/run.sh", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-echo hi"]);
  });

  it("reports an executable-bit change on otherwise equal content", () => {
    const result = diffFileSets(
      [{ path: "run.sh", content: "x\n" }],
      [{ path: "run.sh", content: "x\n", executable: true }],
    );
    expect(result).toEqual([
      {
        path: "run.sh",
        change: "modified",
        binary: false,
        diff: ["--- a/run.sh", "+++ b/run.sh", "executable: false -> true"],
      },
    ]);
  });
});
