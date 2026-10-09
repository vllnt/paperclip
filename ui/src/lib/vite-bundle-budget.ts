import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Size limits for the JavaScript that the browser must load before the first route renders. */
export interface BundleBudget {
  initialJsRawBytes: number;
  initialJsGzipBytes: number;
}

/** The part of a Rollup chunk that the budget needs. */
export interface BudgetChunk {
  fileName: string;
  isEntry: boolean;
  imports: readonly string[];
  code: string;
}

/** Measured size of the initial JavaScript. */
export interface InitialBundleSize {
  chunkCount: number;
  rawBytes: number;
  gzipBytes: number;
}

/** Set to `off` to skip the budget, for example while investigating a size change. */
export const BUNDLE_BUDGET_ENV = "PAPERCLIP_UI_BUNDLE_BUDGET";

/**
 * Measures the entry chunk and every chunk it imports statically, which is the
 * JavaScript the browser fetches before the first route can render.
 *
 * @param chunks - The emitted chunks.
 * @returns Chunk count, raw bytes and gzip bytes of the initial set.
 */
export function measureInitialBundle(chunks: readonly BudgetChunk[]): InitialBundleSize {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks.find((chunk) => chunk.isEntry);
  const initial = new Set<string>();
  const visit = (fileName: string): void => {
    if (initial.has(fileName)) return;
    initial.add(fileName);
    for (const dependency of byFile.get(fileName)?.imports ?? []) visit(dependency);
  };
  if (entry) visit(entry.fileName);

  let rawBytes = 0;
  let gzipBytes = 0;
  for (const fileName of initial) {
    const code = byFile.get(fileName)?.code ?? "";
    rawBytes += Buffer.byteLength(code);
    gzipBytes += gzipSync(code, { level: 9 }).length;
  }
  return { chunkCount: initial.size, rawBytes, gzipBytes };
}

/**
 * Compares a measurement with the budget.
 *
 * @param size - The measured initial bundle.
 * @param budget - The limits.
 * @returns One message per exceeded limit. Empty when the bundle fits.
 */
export function checkBundleBudget(size: InitialBundleSize, budget: BundleBudget): string[] {
  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;
  const violations: string[] = [];
  if (size.rawBytes > budget.initialJsRawBytes) {
    violations.push(`initial JS is ${kb(size.rawBytes)} raw; the budget is ${kb(budget.initialJsRawBytes)}`);
  }
  if (size.gzipBytes > budget.initialJsGzipBytes) {
    violations.push(`initial JS is ${kb(size.gzipBytes)} gzip; the budget is ${kb(budget.initialJsGzipBytes)}`);
  }
  return violations;
}

/**
 * Vite plugin that fails the production build when the initial JavaScript grows
 * past the budget in `budgetFile`. A page that is imported eagerly instead of
 * with `lazy()` shows up here.
 *
 * @param budgetFile - Path to a JSON file with `initialJsRawBytes` and `initialJsGzipBytes`.
 * @returns A build-only plugin.
 */
export function bundleBudgetPlugin(budgetFile: string): Plugin {
  return {
    name: "paperclip-bundle-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      if (process.env[BUNDLE_BUDGET_ENV] === "off") return;
      const chunks: BudgetChunk[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          chunks.push({ fileName: item.fileName, isEntry: item.isEntry, imports: item.imports, code: item.code });
        }
      }
      const budget: BundleBudget = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
      const violations = checkBundleBudget(measureInitialBundle(chunks), budget);
      if (violations.length > 0) {
        this.error(
          `Initial JavaScript is over budget (${path.basename(budgetFile)}):\n  ${violations.join("\n  ")}\n` +
            "Load the new code with lazy() or raise the budget on purpose. " +
            `Set ${BUNDLE_BUDGET_ENV}=off to skip the check.`,
        );
      }
    },
  };
}
