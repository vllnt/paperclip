import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findGreyIssues, scanGreys } from "./check-grey-gate.mjs";

const snippets = (content, options) => findGreyIssues(content, options).map((issue) => issue.snippet);

test("flags Tailwind grey-family palette classes, with variants and opacity", () => {
  assert.deepEqual(
    snippets('<div className="bg-zinc-950 text-zinc-400 dark:border-neutral-800 hover:bg-slate-100/50 ring-gray-300" />'),
    ["zinc-950", "zinc-400", "neutral-800", "slate-100", "gray-300"],
  );
});

test("allows token classes and accent palettes", () => {
  assert.deepEqual(
    snippets('<div className="bg-muted text-muted-foreground/70 border-border bg-red-50 text-blue-600 bg-status-neutral" />'),
    [],
  );
});

test("flags grey hex literals but not black, white or accents", () => {
  assert.deepEqual(snippets('const a = "#18181b", b = "#A8AEB2", c = "#64748b", d = "#9a958a73";'), [
    "#18181b",
    "#A8AEB2",
    "#64748b",
    "#9a958a73",
  ]);
  assert.deepEqual(snippets('const ok = ["#000", "#ffffff", "#000000", "#2563eb", "#f59e0b", "#7c3aed"];'), []);
});

test("does not mistake issue references for hex colors", () => {
  assert.deepEqual(snippets("see acme/web#241 and PR#123456"), []);
});

test("flags grey rgb, hsl and oklch but not black or white alphas", () => {
  assert.deepEqual(snippets("a: rgb(120, 120, 120); b: rgba(128 128 128 / 0.5); c: hsl(0 0% 50%); d: oklch(0.5 0 0)"), [
    "rgb(120, 120, 120",
    "rgba(128 128 128",
    "hsl(0 0% 50%",
    "oklch(0.5 0 0",
  ]);
  assert.deepEqual(
    snippets("a: rgba(0,0,0,0.5); b: rgb(255 255 255 / 10%); c: oklch(0 0 0 / 18%); d: oklch(1 0 0); e: oklch(0.62 0.21 259)"),
    [],
  );
});

test("an allow marker on the same line or the line above suppresses the finding", () => {
  assert.deepEqual(snippets('const a = "#64748b"; // grey-gate: allow user colour fallback'), []);
  assert.deepEqual(snippets('// grey-gate: allow third-party terminal theme\nconst a = "#64748b";'), []);
  assert.equal(snippets('// grey-gate: allow reason\n\nconst a = "#64748b";').length, 1);
});

test("reports 1-based line numbers", () => {
  const issues = findGreyIssues('const a = 1;\nconst b = "text-zinc-500";\n');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
});

test("css mode ignores comments and brand-art custom properties, and flags other greys", () => {
  const css = [
    "/* old value #1d1d1d and oklch(0.5 0 0) */",
    ":root {",
    "  --agent-cap-v1-muted-dream-a: #a6aaad;",
    "  --pill-guy-eye: #060606;",
    "  --app-logo-tile-2: #24292f;",
    "  --scrollbar-thumb: oklch(0.4 0 0);",
    "  --some-new-grey: #888888;",
    "  --shadow: 0 1px 2px oklch(0 0 0 / 12%);",
    "}",
  ].join("\n");
  const issues = findGreyIssues(css, { css: true });
  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.snippet]),
    [
      [6, "oklch(0.4 0 0"],
      [7, "#888888"],
    ],
  );
});

test("scanGreys walks source files, skips tests and stories, and reports repo-relative paths", () => {
  const root = mkdtempSync(join(tmpdir(), "grey-gate-"));
  try {
    mkdirSync(join(root, "components"), { recursive: true });
    writeFileSync(join(root, "components", "Bad.tsx"), 'export const x = "bg-zinc-900";\n');
    writeFileSync(join(root, "components", "Good.tsx"), 'export const x = "bg-muted";\n');
    writeFileSync(join(root, "components", "Bad.test.tsx"), 'export const x = "bg-zinc-900";\n');
    writeFileSync(join(root, "components", "Bad.stories.tsx"), 'export const x = "bg-zinc-900";\n');
    const found = scanGreys(root);
    assert.deepEqual(
      found.map((issue) => `${issue.file}:${issue.line}`),
      ["components/Bad.tsx:1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
