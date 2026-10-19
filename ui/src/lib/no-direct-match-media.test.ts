import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(SRC, "lib", "safe-match-media.ts");

/**
 * Matches a call, an optional call, a bind or a bracket read of `matchMedia`, with or without
 * `window.`. Mentions in prose and `typeof` checks do not match. The scan is best-effort: it reads
 * one line at a time, so an alias (`const mm = window.matchMedia; mm(q)`) split across lines can
 * still slip through; review catches that.
 */
const DIRECT_CALL =
  /(?<![\w$])matchMedia\s*(?:\?\.\s*)?\(|(?<![\w$])matchMedia\.bind\b|\[\s*["'`]matchMedia["'`]\s*\]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name) || /\.(test|stories)\.[jt]sx?$/.test(entry.name)) return [];
    return [path];
  });
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("window.matchMedia", () => {
  it("is only called through lib/safe-match-media, so a browser where it throws cannot stop the app rendering", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file !== HELPER)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            !isComment(line) && DIRECT_CALL.test(line) ? [`${relative(SRC, file)}:${index + 1}: ${line.trim()}`] : [],
          ),
      );
    expect(offenders).toEqual([]);
  });

  it("is still found by the pattern the scan uses", () => {
    for (const line of [
      "window.matchMedia(q)",
      "  matchMedia (q)",
      "window.matchMedia.bind(window)",
      "x = matchMedia(q).matches",
      "window.matchMedia?.(q)",
      "window.matchMedia ?. (q)",
      'window["matchMedia"](q)',
      "window['matchMedia'](q)",
    ]) {
      expect(DIRECT_CALL.test(line), line).toBe(true);
    }
    for (const line of ["typeof window.matchMedia !== 'function'", "const matchMedia: Fn | undefined", "isMatchMedia(q)", "// matchMedia(q)"]) {
      expect(isComment(line) || !DIRECT_CALL.test(line), line).toBe(true);
    }
  });
});
