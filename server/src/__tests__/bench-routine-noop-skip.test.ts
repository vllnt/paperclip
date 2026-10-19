import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/bench-routine-noop-skip.mjs");

describe("bench-routine-noop-skip", () => {
  it("counts only routine loops as eligible, not other loops such as ops:*", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bench-noop-"));
    try {
      const report = path.join(dir, "report.json");
      writeFileSync(report, JSON.stringify({
        window: { hours: 24 },
        loops: {
          TOTAL: { runs: 102, cost_usd: 102 },
          "routine:one": { runs: 2, cost_usd: 2 },
          "ops:other": { runs: 100, cost_usd: 100 },
        },
      }));
      const out = JSON.parse(execFileSync("node", [script, report, "1"], { encoding: "utf8" }));
      const all = out.results.find((row: { scenario: string }) => row.scenario === "all");
      expect(all.runsPerDayBefore).toBe(2);
      expect(all.routines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
