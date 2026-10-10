#!/usr/bin/env node
/**
 * check-grey-gate.mjs
 *
 * Guard for the black-and-white theme (doc/plans/2026-10-09-bw-theme.md).
 * Fails when UI source reintroduces a grey instead of a token:
 *
 *   - Tailwind grey-family palette classes: gray / zinc / neutral / slate /
 *     stone with a numeric shade (`bg-zinc-900`, `text-neutral-400`).
 *   - Grey colour literals: hex, rgb()/rgba(), hsl()/hsla() and oklch() whose
 *     saturation (chroma) is near zero and whose lightness is not pure black or
 *     pure white. Black and white at any alpha are fine: they are overlays.
 *
 * Neutrals come from tokens in `ui/src/index.css` (`bg-muted`,
 * `text-muted-foreground`, `border-border`, `bg-status-neutral`, ...).
 *
 * Suppress a deliberate exception with `grey-gate: allow <reason>` on the same
 * line or the line directly above. In `index.css`, brand artwork is exempt by
 * custom-property prefix (see BRAND_ART_PREFIXES).
 *
 * Usage: node scripts/check-grey-gate.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "__tests__"]);
const TEST_OR_STORY_FILE = /\.(test|spec|stories)\.[cm]?[jt]sx?$/;
const SCANNED_FILE = /\.(tsx?|jsx?|css|html)$/;
const ALLOW_MARKER = /grey-gate:\s*allow/;

/** Custom properties in `index.css` that hold brand artwork or user-chosen colours. */
const BRAND_ART_PREFIXES = [
  "--agent-",
  "--pill-guy-",
  "--app-logo-",
  "--folder-color-",
  "--project-seed",
  "--paperclip-doc-annotation-highlight-source",
];

const MAX_GREY_SATURATION = 0.2;
const MAX_GREY_CHROMA = 0.02;
const NEAR_BLACK = 0.02;
const NEAR_WHITE = 0.98;

const PALETTE_CLASS_RE = /(?<![A-Za-z0-9])(?:gray|zinc|neutral|slate|stone)-\d{2,3}(?![\w-])/g;
const HEX_RE = /(?<![\w/&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const RGB_RE = /\brgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g;
const HSL_RE = /\bhsla?\(\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/g;
const OKLCH_RE = /\boklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+[\d.]+/g;

function saturation([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 510;
  const delta = (max - min) / 255;
  if (delta === 0) return { lightness, saturation: 0 };
  return { lightness, saturation: delta / (1 - Math.abs(2 * lightness - 1)) };
}

function isGreyRgb(channels) {
  const { lightness, saturation: s } = saturation(channels);
  return lightness > NEAR_BLACK && lightness < NEAR_WHITE && s < MAX_GREY_SATURATION;
}

function hexToChannels(token) {
  let digits = token.slice(1);
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16));
}

function blankOutCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function lineStartOffsets(content) {
  const offsets = [0];
  for (let i = 0; i < content.length; i += 1) if (content[i] === "\n") offsets.push(i + 1);
  return offsets;
}

function lineAt(offsets, index) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function customPropertyAt(lines, lineNumber) {
  const match = /^\s*(--[\w-]+)\s*:/.exec(lines[lineNumber - 1] ?? "");
  return match ? match[1] : null;
}

/**
 * Finds grey usages in one file's text.
 * @param {string} content File contents.
 * @param {{ css?: boolean }} [options] `css: true` blanks comments and honours brand-art prefixes.
 * @returns {{ line: number, snippet: string, kind: string }[]} Findings sorted by position.
 */
export function findGreyIssues(content, { css = false } = {}) {
  const original = content.split("\n");
  const scanned = css ? blankOutCssComments(content) : content;
  const lines = scanned.split("\n");
  const offsets = lineStartOffsets(scanned);
  const found = [];

  const add = (match, kind) => found.push({ index: match.index, snippet: match[0], kind });

  for (const match of scanned.matchAll(PALETTE_CLASS_RE)) add(match, "palette-class");
  for (const match of scanned.matchAll(HEX_RE)) {
    if (isGreyRgb(hexToChannels(match[0]))) add(match, "hex");
  }
  for (const match of scanned.matchAll(RGB_RE)) {
    if (isGreyRgb([Number(match[1]), Number(match[2]), Number(match[3])])) add(match, "rgb");
  }
  for (const match of scanned.matchAll(HSL_RE)) {
    const saturationPercent = Number(match[1]);
    const lightnessPercent = Number(match[2]);
    if (saturationPercent < MAX_GREY_SATURATION * 100 && lightnessPercent > NEAR_BLACK * 100 && lightnessPercent < NEAR_WHITE * 100) {
      add(match, "hsl");
    }
  }
  for (const match of scanned.matchAll(OKLCH_RE)) {
    const lightness = match[2] === "%" ? Number(match[1]) / 100 : Number(match[1]);
    if (Number(match[3]) < MAX_GREY_CHROMA && lightness > NEAR_BLACK && lightness < NEAR_WHITE) add(match, "oklch");
  }

  return found
    .map((item) => ({ line: lineAt(offsets, item.index), snippet: item.snippet, kind: item.kind, index: item.index }))
    .filter((item) => {
      const sameLine = original[item.line - 1] ?? "";
      const lineAbove = original[item.line - 2] ?? "";
      if (ALLOW_MARKER.test(sameLine) || ALLOW_MARKER.test(lineAbove)) return false;
      if (css && item.kind !== "palette-class") {
        const property = customPropertyAt(lines, item.line);
        if (property && BRAND_ART_PREFIXES.some((prefix) => property.startsWith(prefix))) return false;
      }
      return true;
    })
    .sort((a, b) => a.index - b.index)
    .map(({ line, snippet, kind }) => ({ line, snippet, kind }));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SCANNED_FILE.test(entry.name) && !TEST_OR_STORY_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * Scans every source file under a directory.
 * @param {string} root Directory to walk.
 * @returns {{ file: string, line: number, snippet: string, kind: string }[]} Findings with root-relative POSIX paths.
 */
export function scanGreys(root) {
  const files = [];
  walk(root, files);
  files.sort();
  return files.flatMap((filePath) =>
    findGreyIssues(readFileSync(filePath, "utf8"), { css: filePath.endsWith(".css") }).map((issue) => ({
      file: relative(root, filePath).split("\\").join("/"),
      ...issue,
    })),
  );
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const uiSrc = resolve(repoRoot, "ui/src");
  const indexHtml = resolve(repoRoot, "ui/index.html");
  const findings = [
    ...scanGreys(uiSrc).map((issue) => ({ ...issue, file: `ui/src/${issue.file}` })),
    ...findGreyIssues(readFileSync(indexHtml, "utf8")).map((issue) => ({ ...issue, file: "ui/index.html" })),
  ];

  console.log("check-grey-gate summary");
  console.log(`  Grey usages: ${findings.length === 0 ? "CLEAN" : `${findings.length} violation(s)`}`);
  if (findings.length === 0) return;

  console.log("\nUse a token instead (bg-muted, text-muted-foreground, border-border, bg-status-neutral),");
  console.log("or mark a deliberate exception with `grey-gate: allow <reason>`.\n");
  for (const issue of findings) console.log(`  ${issue.file}:${issue.line}  ${issue.snippet}  (${issue.kind})`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
