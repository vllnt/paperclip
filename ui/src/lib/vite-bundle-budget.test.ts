import { describe, expect, it } from "vitest";
import { checkBundleBudget, measureInitialBundle, type BudgetChunk } from "./vite-bundle-budget";

const body = (size: number): string => "const value = 1;\n".repeat(Math.ceil(size / 17));

function chunk(fileName: string, imports: string[], isEntry = false, size = 2_000): BudgetChunk {
  return { fileName, isEntry, imports, code: body(size) };
}

describe("measureInitialBundle", () => {
  it("counts the entry chunk and everything it imports statically", () => {
    const size = measureInitialBundle([
      chunk("assets/index.js", ["assets/vendor.js"], true),
      chunk("assets/vendor.js", ["assets/shared.js"]),
      chunk("assets/shared.js", []),
      chunk("assets/page.js", ["assets/shared.js"]),
    ]);

    expect(size.chunkCount).toBe(3);
  });

  it("does not count chunks that only a lazy route imports", () => {
    const lazyOnly = chunk("assets/lazy-only.js", [], false, 100_000);
    const withLazy = measureInitialBundle([chunk("assets/index.js", [], true), lazyOnly]);
    const withoutLazy = measureInitialBundle([chunk("assets/index.js", [], true)]);

    expect(withLazy.rawBytes).toBe(withoutLazy.rawBytes);
    expect(withLazy.gzipBytes).toBe(withoutLazy.gzipBytes);
  });

  it("counts a shared chunk once", () => {
    const size = measureInitialBundle([
      chunk("assets/index.js", ["assets/a.js", "assets/b.js"], true),
      chunk("assets/a.js", ["assets/shared.js"]),
      chunk("assets/b.js", ["assets/shared.js"]),
      chunk("assets/shared.js", []),
    ]);

    expect(size.chunkCount).toBe(4);
  });

  it("reports gzip smaller than raw for repetitive code", () => {
    const size = measureInitialBundle([chunk("assets/index.js", [], true, 50_000)]);

    expect(size.gzipBytes).toBeLessThan(size.rawBytes);
  });

  it("returns zero when there is no entry chunk", () => {
    expect(measureInitialBundle([chunk("assets/a.js", [])])).toEqual({ chunkCount: 0, rawBytes: 0, gzipBytes: 0 });
  });

  it("survives an import cycle", () => {
    const size = measureInitialBundle([
      chunk("assets/index.js", ["assets/a.js"], true),
      chunk("assets/a.js", ["assets/index.js"]),
    ]);

    expect(size.chunkCount).toBe(2);
  });
});

describe("checkBundleBudget", () => {
  const budget = { initialJsRawBytes: 1_000, initialJsGzipBytes: 400 };

  it("passes at exactly the limit", () => {
    expect(checkBundleBudget({ chunkCount: 1, rawBytes: 1_000, gzipBytes: 400 }, budget)).toEqual([]);
  });

  it("reports the raw limit", () => {
    const violations = checkBundleBudget({ chunkCount: 1, rawBytes: 1_001, gzipBytes: 100 }, budget);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("raw");
  });

  it("reports the gzip limit", () => {
    const violations = checkBundleBudget({ chunkCount: 1, rawBytes: 500, gzipBytes: 401 }, budget);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("gzip");
  });

  it("reports both limits", () => {
    expect(checkBundleBudget({ chunkCount: 1, rawBytes: 5_000, gzipBytes: 5_000 }, budget)).toHaveLength(2);
  });
});
