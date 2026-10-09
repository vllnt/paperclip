import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSkillQuality, type SkillQualityFile, type SkillQualityReport } from "./skill-quality.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CATALOG_ROOT = path.join(REPO_ROOT, "packages/skills-catalog/catalog");
const RELEASES_ROOT = path.join(REPO_ROOT, "skills-releases/paperclip");
const CATALOG_FRONTMATTER_KEYS = ["key", "tags", "recommendedForRoles", "requires"];
const MAX_DESCRIPTION_CHARS = 300;

/**
 * Error-level findings that already exist in shipped skills. The list may only shrink: a skill that no longer
 * has the finding must be removed here, so a fixed defect cannot come back unnoticed.
 */
const KNOWN_CATALOG_ERRORS: Record<string, string[]> = {
  "bundled/product/paperclip-capsules": ["B4"],
  "optional/content/release-announcement": ["B4"],
};

/**
 * Catalog skills whose description does not yet say when to use the skill (F7). The list may only shrink, so a
 * bundled skill cannot lose its use-when clause and an optional skill that gets one must leave this list.
 */
const KNOWN_CATALOG_WITHOUT_USE_WHEN = [
  "optional/browser/agent-browser",
  "optional/content/release-announcement",
  "optional/content/simplified-english",
  "optional/finance/ramp",
  "optional/product/design-critique",
];

/** Warnings the lean core release accepts on purpose. B2 is the bytes/4 estimate of the always-loaded file. */
const ACCEPTED_RELEASE_WARNINGS: string[] = ["B2"];

function listFiles(dir: string, base: string): SkillQualityFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    if (dir === base && entry.name === "SKILL.md") return [];
    return [
      {
        path: path.relative(base, full).split(path.sep).join("/"),
        content: readFileSync(full, "utf8"),
        executable: (statSync(full).mode & 0o111) !== 0,
      },
    ];
  });
}

function checkSkillDirectory(dir: string, directoryName: string): SkillQualityReport {
  return checkSkillQuality(
    { skillMd: readFileSync(path.join(dir, "SKILL.md"), "utf8"), directoryName, files: listFiles(dir, dir) },
    { extraFrontmatterKeys: CATALOG_FRONTMATTER_KEYS },
  );
}

function catalogSkillDirectories(): string[] {
  return ["bundled", "optional"].flatMap((kind) =>
    readdirSync(path.join(CATALOG_ROOT, kind), { withFileTypes: true })
      .filter((category) => category.isDirectory())
      .flatMap((category) =>
        readdirSync(path.join(CATALOG_ROOT, kind, category.name), { withFileTypes: true })
          .filter((skill) => skill.isDirectory() && existsSync(path.join(CATALOG_ROOT, kind, category.name, skill.name, "SKILL.md")))
          .map((skill) => `${kind}/${category.name}/${skill.name}`),
      ),
  );
}

describe("skill quality of shipped skills", () => {
  it("finds no error-level problems in the catalog beyond the known list", () => {
    const actual: Record<string, string[]> = {};
    for (const relative of catalogSkillDirectories()) {
      const report = checkSkillDirectory(path.join(CATALOG_ROOT, relative), path.basename(relative));
      const errors = [...new Set(report.findings.filter((f) => f.severity === "error").map((f) => f.id))].sort();
      if (errors.length > 0) actual[relative] = errors;
    }
    expect(actual).toEqual(KNOWN_CATALOG_ERRORS);
  });

  it("keeps every catalog description in the third person and within the prompt budget", () => {
    const violations: string[] = [];
    for (const relative of catalogSkillDirectories()) {
      const report = checkSkillDirectory(path.join(CATALOG_ROOT, relative), path.basename(relative));
      if (report.findings.some((f) => f.id === "F6")) violations.push(`${relative}: description is not third person`);
      if (report.metrics.descriptionLength > MAX_DESCRIPTION_CHARS) violations.push(`${relative}: description is too long`);
      if (report.metrics.bodyLines > 500) violations.push(`${relative}: body is ${report.metrics.bodyLines} lines`);
    }
    expect(violations).toEqual([]);
  });

  it("says when to use every bundled catalog skill, beyond the known optional ones", () => {
    const withoutUseWhen = catalogSkillDirectories()
      .filter((relative) => checkSkillDirectory(path.join(CATALOG_ROOT, relative), path.basename(relative)).findings.some((f) => f.id === "F7"))
      .sort();
    expect(withoutUseWhen).toEqual([...KNOWN_CATALOG_WITHOUT_USE_WHEN].sort());
  });
});

describe("skill release registry", () => {
  const manifest: { id: string; dir: string }[] = JSON.parse(readFileSync(path.join(RELEASES_ROOT, "releases.json"), "utf8"));

  it("lists unique releases whose directories hold a core SKILL.md", () => {
    expect(new Set(manifest.map((release) => release.id)).size).toBe(manifest.length);
    for (const release of manifest) {
      expect(existsSync(path.join(RELEASES_ROOT, release.dir, "SKILL.md")), `${release.id} has no SKILL.md`).toBe(true);
    }
  });

  it("holds the lean release to the lean bar: no errors, 250 body lines, no emphasis words", () => {
    expect(manifest.map((release) => release.id)).toContain("v8-lean");
    const report = checkSkillDirectory(path.join(RELEASES_ROOT, "v8-lean"), "paperclip");
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.findings.filter((f) => f.severity === "warn" && !ACCEPTED_RELEASE_WARNINGS.includes(f.id))).toEqual([]);
    expect(report.metrics.bodyLines).toBeLessThanOrEqual(250);
    expect(report.metrics.shoutingWords).toBe(0);
    expect(report.metrics.maxReferenceDepth).toBe(1);
    expect(report.metrics.descriptionLength).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });
});
