import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/ui/unified-diff.js";

describe("GitHub unified diff coordinates", () => {
  it("tracks hunk offsets, deletes, adds and context on the correct side", () => {
    const rows = parseUnifiedDiff("@@ -10,3 +20,3 @@ function\n keep\n-old\n+new\n tail");
    expect(rows.slice(1).map(row => [row.kind,row.oldLine,row.newLine,row.comment])).toEqual([
      ["context",10,20,{ line:20,side:"RIGHT" }],
      ["deleted",11,null,{ line:11,side:"LEFT" }],
      ["added",null,21,{ line:21,side:"RIGHT" }],
      ["context",12,22,{ line:22,side:"RIGHT" }],
    ]);
  });
  it("resets coordinates at multiple hunks and supports omitted one-line counts", () => {
    const rows = parseUnifiedDiff("@@ -1 +4 @@\n-old\n+new\n@@ -9,0 +12,2 @@\n+one\n+two");
    expect(rows.filter(row => row.comment).map(row => row.comment)).toEqual([
      { line:1,side:"LEFT" },{ line:4,side:"RIGHT" },{ line:12,side:"RIGHT" },{ line:13,side:"RIGHT" },
    ]);
  });
  it("does not count the no-newline marker or expose file headers as coordinates", () => {
    const rows = parseUnifiedDiff("--- a/file\n+++ b/file\n@@ -3 +7 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file");
    expect(rows.filter(row => row.comment).map(row => row.comment)).toEqual([{ line:3,side:"LEFT" },{ line:7,side:"RIGHT" }]);
    expect(rows.filter(row => row.kind === "note").every(row => row.comment === null)).toBe(true);
  });
  it("never invents coordinates for truncated or malformed patch content", () => {
    const rows = parseUnifiedDiff("@@ -2,2 +3,2 @@\n ok\n… patch truncated …\n+unknown\n@@ -20 +30 @@\n-old\n+new\n+outside");
    expect(rows[3].comment).toBeNull();
    expect(rows.at(-1)?.comment).toBeNull();
    expect(rows[5].comment).toEqual({ line:20,side:"LEFT" });
    expect(rows[6].comment).toEqual({ line:30,side:"RIGHT" });
  });
});
