import { describe, expect, it } from "vitest";
import { estimateTokens } from "./index.js";
import {
  checkSkillQuality,
  checkSkillSetQuality,
  type SkillQualityCheckId,
  type SkillQualityInput,
  type SkillQualityReport,
} from "./skill-quality.js";

const GOOD_DESCRIPTION =
  "Extracts text and tables from PDF files and fills forms. Use when the user mentions PDFs, forms, or document extraction.";

function buildSkill(options: { name?: string; description?: string; body?: string; extraFrontmatter?: string } = {}): string {
  const { name = "pdf-processing", description = GOOD_DESCRIPTION, body = "# PDF processing\n\nUse pdfplumber for text.\n", extraFrontmatter = "" } = options;
  return `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n${body}`;
}

function ids(report: SkillQualityReport): SkillQualityCheckId[] {
  return report.findings.map((finding) => finding.id);
}

function check(input: SkillQualityInput, options?: Parameters<typeof checkSkillQuality>[1]): SkillQualityReport {
  return checkSkillQuality(input, options);
}

function actionable(report: SkillQualityReport): SkillQualityReport["findings"] {
  return report.findings.filter((finding) => finding.severity !== "info");
}

function distinctWord(n: number): string {
  const letters = [n, Math.floor(n / 26), Math.floor(n / 676)].map((digit) => String.fromCharCode(97 + (digit % 26)));
  return `${letters.join("")}xx`;
}

describe("checkSkillQuality frontmatter", () => {
  it("scores a small well-formed skill at the maximum with no actionable findings", () => {
    const report = check({ skillMd: buildSkill(), directoryName: "pdf-processing" });
    expect(actionable(report)).toEqual([]);
    expect(report.score).toBe(100);
  });

  it("keeps info findings out of the score", () => {
    const report = check({ skillMd: buildSkill() });
    expect(report.findings.map((f) => f.id)).toContain("B15");
    expect(report.findings.find((f) => f.id === "B15")?.penalty).toBe(0);
  });

  it("reports F1 when the file does not start with frontmatter", () => {
    const report = check({ skillMd: "# No frontmatter\n\nBody." });
    expect(ids(report)).toContain("F1");
    expect(report.findings.find((f) => f.id === "F1")?.severity).toBe("error");
  });

  it("reports F2 for an invalid name and for a directory mismatch", () => {
    expect(ids(check({ skillMd: buildSkill({ name: "PDF_Processing" }) }))).toContain("F2");
    expect(ids(check({ skillMd: buildSkill({ name: "a".repeat(65) }) }))).toContain("F2");
    expect(ids(check({ skillMd: buildSkill({ name: "-pdf" }) }))).toContain("F2");
    expect(ids(check({ skillMd: buildSkill(), directoryName: "other-dir" }))).toContain("F2");
  });

  it("reports F3 for reserved words in the name", () => {
    expect(ids(check({ skillMd: buildSkill({ name: "claude-helper" }) }))).toContain("F3");
    expect(ids(check({ skillMd: buildSkill({ name: "anthropic-tools" }) }))).toContain("F3");
  });

  it("reports F4 for an empty, oversized, or tag-bearing description", () => {
    expect(ids(check({ skillMd: "---\nname: pdf-processing\n---\n\nBody" }))).toContain("F4");
    expect(ids(check({ skillMd: buildSkill({ description: `Does things. Use when needed ${"x".repeat(1100)}` }) }))).toContain("F4");
    expect(ids(check({ skillMd: buildSkill({ description: "Handles <b>PDFs</b>. Use when the user mentions PDFs." }) }))).toContain("F4");
  });

  it("reports F5 only past the combined description budget and info past the advisory length", () => {
    const long = `Extracts PDF text. Use when the user mentions PDFs. ${"More detail. ".repeat(60)}`;
    const report = check({ skillMd: buildSkill({ description: long }) });
    const f5 = report.findings.filter((f) => f.id === "F5");
    expect(f5).toHaveLength(1);
    expect(f5[0]?.severity).toBe("info");
  });

  it("reports F6 as an error for first-person descriptions and a warning for loose second person", () => {
    const first = check({ skillMd: buildSkill({ description: "I can help you process PDFs. Use when working with PDFs." }) });
    expect(first.findings.find((f) => f.id === "F6")?.severity).toBe("error");
    const second = check({ skillMd: buildSkill({ description: "Processes PDFs. Use when you need to merge documents." }) });
    expect(second.findings.find((f) => f.id === "F6")?.severity).toBe("warn");
  });

  it("reports F7 when the description never says when to use the skill", () => {
    expect(ids(check({ skillMd: buildSkill({ description: "Extracts text and tables from PDF files." }) }))).toContain("F7");
    expect(ids(check({ skillMd: buildSkill() }))).not.toContain("F7");
  });

  it("reports F8 when the description summarizes a procedure", () => {
    const report = check({ skillMd: buildSkill({ description: "Reads the file, then merges pages, then saves. Use when the user mentions PDFs." }) });
    expect(ids(report)).toContain("F8");
  });

  it("reports F10 for keys unknown to every target and F9 for non-portable keys on the portable target", () => {
    const skillMd = buildSkill({ extraFrontmatter: "mystery-key: 1\nuser-invocable: true\n" });
    expect(ids(check({ skillMd }))).toContain("F10");
    expect(ids(check({ skillMd }, { extraFrontmatterKeys: ["mystery-key"] }))).not.toContain("F10");
    expect(ids(check({ skillMd }, { target: "portable", extraFrontmatterKeys: ["mystery-key"] }))).toContain("F9");
  });

  it("parses folded multi-line descriptions", () => {
    const skillMd = `---\nname: pdf-processing\ndescription: >\n  Extracts text from PDFs.\n  Use when the user mentions PDFs.\n---\n\nBody`;
    const report = check({ skillMd });
    expect(ids(report)).not.toContain("F4");
    expect(report.metrics.descriptionLength).toBeGreaterThan(40);
  });
});

describe("checkSkillQuality body size and style", () => {
  it("reports B1 as an error past the line limit and a warning near it", () => {
    const over = check({ skillMd: buildSkill({ body: "line\n".repeat(501) }) });
    expect(over.findings.find((f) => f.id === "B1")?.severity).toBe("error");
    const near = check({ skillMd: buildSkill({ body: "line\n".repeat(420) }) });
    expect(near.findings.find((f) => f.id === "B1")?.severity).toBe("warn");
    const custom = check({ skillMd: buildSkill({ body: "line\n".repeat(120) }) }, { thresholds: { warnBodyLines: 100 } });
    expect(ids(custom)).toContain("B1");
  });

  it("reports B2 when the body is past the token budget", () => {
    const report = check({ skillMd: buildSkill({ body: "word ".repeat(5200) }) });
    expect(ids(report)).toContain("B2");
    expect(report.metrics.estimatedTokens).toBeGreaterThan(5000);
  });

  it("uses a caller-supplied token counter instead of the bytes/4 estimate", () => {
    const report = check({ skillMd: buildSkill() }, { countTokens: () => 9000 });
    expect(report.metrics.estimatedTokens).toBe(9000);
    expect(ids(report)).toContain("B2");
  });

  it("counts shouting words outside code and reports B6 past the threshold", () => {
    const body = "You MUST do this. NEVER do that. ALWAYS check. CRITICAL: stop.\n\n```\nMUST NEVER ALWAYS\n```\n\nUse `MUST` literally.";
    const report = check({ skillMd: buildSkill({ body }) });
    expect(report.metrics.shoutingWords).toBe(4);
    expect(ids(report)).toContain("B6");
    expect(ids(check({ skillMd: buildSkill({ body: "Be careful. MUST sign." }) }))).not.toContain("B6");
  });

  it("reports B7 for dated statements but not inside an Old patterns section", () => {
    expect(ids(check({ skillMd: buildSkill({ body: "Use the old API before August 2025." }) }))).toContain("B7");
    const archived = "Current method.\n\n## Old patterns\n\nUse the v1 API until 2025.\n";
    expect(ids(check({ skillMd: buildSkill({ body: archived }) }))).not.toContain("B7");
  });

  it("reports B8 and B9 as errors for reasoning-in-reply and do-not-think instructions", () => {
    const report = check({ skillMd: buildSkill({ body: "Write out your reasoning in the reply. Do not think about it." }) });
    expect(report.findings.find((f) => f.id === "B8")?.severity).toBe("error");
    expect(report.findings.find((f) => f.id === "B9")?.severity).toBe("error");
  });

  it("reports B10 only for verification lines that give no concrete command", () => {
    expect(ids(check({ skillMd: buildSkill({ body: "Double-check your work before replying." }) }))).toContain("B10");
    expect(ids(check({ skillMd: buildSkill({ body: "Double-check the write by running `curl -w '%{http_code}'`." }) }))).not.toContain("B10");
  });

  it("reports B11, B12 and B13 for outdated prompting scaffolds", () => {
    const report = check({
      skillMd: buildSkill({ body: "Think carefully first.\n\nMinimize tool calls.\n\nOnly report high severity issues." }),
    });
    expect(ids(report)).toEqual(expect.arrayContaining(["B11", "B12", "B13"]));
  });

  it("reports B15 as info when there is no Gotchas section", () => {
    const missing = check({ skillMd: buildSkill() });
    expect(missing.findings.find((f) => f.id === "B15")?.severity).toBe("info");
    const present = check({ skillMd: buildSkill({ body: "Intro.\n\n## Gotchas\n\n- A thing." }) });
    expect(ids(present)).not.toContain("B15");
  });

  it("measures rules, rules without a reason, and flags B17 when most lack one", () => {
    const body = [
      "Never retry a 409 because the task belongs to someone else.",
      "Do not skip checkout.",
      "Always send the run id header.",
      "You must not close the issue.",
      "Never paste secrets.",
      "Do not guess ids.",
    ].join("\n\n");
    const report = check({ skillMd: buildSkill({ body }) });
    expect(report.metrics.ruleCount).toBe(6);
    expect(report.metrics.rulesWithoutReason).toBe(5);
    expect(ids(report)).toContain("B17");
  });

  it("recognizes common reason phrasings and not filler uses of so", () => {
    const body = [
      "Use a deterministic key so retries do not stack cards.",
      "Never rely on the default, which never wakes you.",
      "Do not skip so many steps.",
    ].join("\n\n");
    const report = check({ skillMd: buildSkill({ body }) });
    expect(report.metrics.ruleCount).toBe(3);
    expect(report.metrics.rulesWithoutReason).toBe(1);
  });

  it("reports B18 when the rule count exceeds the threshold", () => {
    const body = Array.from({ length: 12 }, (_, i) => `Never touch item ${i} because it is shared.`).join("\n\n");
    expect(ids(check({ skillMd: buildSkill({ body }) }, { thresholds: { maxRules: 10 } }))).toContain("B18");
  });

  it("ranks a noisy skill below a clean one and never goes below zero", () => {
    const clean = check({ skillMd: buildSkill() });
    const noisy = check({
      skillMd: buildSkill({
        name: "Bad_Name",
        description: "I can help.",
        body: `${"MUST NEVER ALWAYS CRITICAL. ".repeat(10)}\n${"line\n".repeat(600)}Double-check your work. Think carefully.`,
      }),
    });
    expect(noisy.score).toBeLessThan(clean.score);
    expect(noisy.score).toBeGreaterThanOrEqual(0);
  });

  it("lets callers turn a check off or change its severity", () => {
    const skillMd = buildSkill({ description: "Extracts text and tables from PDF files." });
    expect(ids(check({ skillMd }, { severity: { F7: "off" } }))).not.toContain("F7");
    expect(check({ skillMd }, { severity: { F7: "error" } }).findings.find((f) => f.id === "F7")?.severity).toBe("error");
  });
});

describe("checkSkillQuality bundled files", () => {
  const body = "Read [the guide](references/guide.md) for details. Run `scripts/run.sh` to execute.\n";
  const guide = { path: "references/guide.md", content: "# Guide\n\nShort." };
  const script = { path: "scripts/run.sh", content: "#!/usr/bin/env bash\necho ok\n", executable: true };

  it("accepts resolvable one-level references and scripts", () => {
    const report = check({ skillMd: buildSkill({ body }), files: [guide, script] });
    expect(actionable(report)).toEqual([]);
    expect(report.metrics.maxReferenceDepth).toBe(1);
    expect(report.metrics.referenceFileCount).toBe(1);
  });

  it("reports B4 for missing targets, repo-rooted paths and backslash paths", () => {
    const missing = check({ skillMd: buildSkill({ body: "See [x](references/nope.md)." }), files: [guide] });
    expect(ids(missing)).toContain("B4");
    const rooted = check({ skillMd: buildSkill({ body: "Read `skills/pdf/references/guide.md`." }), files: [guide] });
    expect(ids(rooted)).toContain("B4");
    const windows = check({ skillMd: buildSkill({ body: "Run `scripts\\run.sh`." }), files: [script] });
    expect(ids(windows)).toContain("B4");
  });

  it("reports B3 for long references without a contents heading and accepts one with it", () => {
    const longBody = "line\n".repeat(120);
    const withoutToc = { path: "references/guide.md", content: `# Guide\n\n${longBody}` };
    const withToc = { path: "references/guide.md", content: `# Guide\n\n## Contents\n\n- A\n- B\n\n${longBody}` };
    expect(ids(check({ skillMd: buildSkill({ body }), files: [withoutToc, script] }))).toContain("B3");
    expect(ids(check({ skillMd: buildSkill({ body }), files: [withToc, script] }))).not.toContain("B3");
  });

  it("reports B5 for a file reachable only through another reference and for orphans", () => {
    const deep = { path: "references/deep.md", content: "# Deep\n\nDetails." };
    const chained = { path: "references/guide.md", content: "# Guide\n\nSee [deep](deep.md)." };
    const report = check({ skillMd: buildSkill({ body }), files: [chained, deep, script] });
    expect(ids(report)).toContain("B5");
    expect(report.metrics.maxReferenceDepth).toBe(2);
    const orphan = check({ skillMd: buildSkill({ body }), files: [guide, script, { path: "references/unused.md", content: "# Unused" }] });
    expect(orphan.findings.find((f) => f.id === "B5")?.severity).toBe("info");
  });

  it("counts a repo-rooted mention as a link for reachability while still flagging the path", () => {
    const rooted = check({ skillMd: buildSkill({ body: "Read `skills/pdf-processing/references/guide.md`." }), files: [guide] });
    expect(ids(rooted)).toContain("B4");
    expect(rooted.findings.find((f) => f.id === "B5")).toBeUndefined();
    expect(rooted.metrics.maxReferenceDepth).toBe(1);
  });

  it("caps the penalty one repeated check can add", () => {
    const body = Array.from({ length: 40 }, (_, i) => `See [x${i}](references/missing-${i}.md).`).join("\n\n");
    const report = check({ skillMd: buildSkill({ body }), files: [] });
    expect(report.score).toBeGreaterThanOrEqual(70);
  });

  it("does not warn when a cross-link points at a file SKILL.md also links directly", () => {
    const other = { path: "references/other.md", content: "# Other" };
    const linked = { path: "references/guide.md", content: "# Guide\n\nSee [other](other.md)." };
    const direct = "Read [guide](references/guide.md) and [other](references/other.md).\n";
    expect(ids(check({ skillMd: buildSkill({ body: direct }), files: [linked, other] }))).not.toContain("B5");
  });

  it("reports S1 for scripts without a shebang or the executable bit", () => {
    const noShebang = { path: "scripts/run.sh", content: "echo ok\n", executable: true };
    const notExecutable = { path: "scripts/run.sh", content: "#!/usr/bin/env bash\necho ok\n", executable: false };
    expect(ids(check({ skillMd: buildSkill({ body }), files: [guide, noShebang] }))).toContain("S1");
    expect(ids(check({ skillMd: buildSkill({ body }), files: [guide, notExecutable] }))).toContain("S1");
  });

  it("reports S2 for committed secrets in any bundled file", () => {
    const leaked = { path: "references/guide.md", content: "# Guide\n\nkey: ghp_abcdefghijklmnopqrstuvwxyz0123456789" };
    const report = check({ skillMd: buildSkill({ body }), files: [leaked, script] });
    expect(report.findings.find((f) => f.id === "S2")?.severity).toBe("error");
  });

  it("applies B6 to bundled references too", () => {
    const shouty = { path: "references/guide.md", content: "# Guide\n\nMUST. NEVER. ALWAYS. CRITICAL. IMPORTANT." };
    expect(ids(check({ skillMd: buildSkill({ body }), files: [shouty, script] }))).toContain("B6");
  });
});

describe("checkSkillQuality eval coverage", () => {
  it("reports E1 and E2 only when eval data is supplied", () => {
    expect(ids(check({ skillMd: buildSkill() }))).not.toContain("E1");
    expect(ids(check({ skillMd: buildSkill(), evalCaseCount: 2 }))).toContain("E1");
    expect(ids(check({ skillMd: buildSkill(), evalCaseCount: 3 }))).not.toContain("E1");
    const few = [{ query: "merge pdfs", shouldTrigger: true }];
    expect(ids(check({ skillMd: buildSkill(), triggerQueries: few }))).toContain("E2");
  });
});

describe("checkSkillSetQuality", () => {
  it("reports C1 for near-duplicate descriptions", () => {
    const report = checkSkillSetQuality([
      { name: "pdf-a", description: "Extracts text and tables from PDF files. Use when the user mentions PDFs." },
      { name: "pdf-b", description: "Extracts text and tables from PDF files. Use when the user mentions PDF forms." },
      { name: "sql-tuning", description: "Optimizes slow database queries. Use when a query plan shows sequential scans." },
    ]);
    expect(report.findings.filter((f) => f.id === "C1")).toHaveLength(1);
  });

  it("reports C2 when the listing exceeds the character or count budget", () => {
    const skills = Array.from({ length: 25 }, (_, i) => ({
      name: `skill-${i}`,
      description: Array.from({ length: 6 }, (_, j) => distinctWord(i * 6 + j)).join(" "),
    }));
    expect(checkSkillSetQuality(skills).findings.map((f) => f.id)).toContain("C2");
    expect(checkSkillSetQuality(skills.slice(0, 3)).findings).toEqual([]);
  });
});

describe("estimateTokens", () => {
  it("is exported from the package index as UTF-8 bytes divided by four, rounded", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(10))).toBe(3);
    expect(estimateTokens("é".repeat(4))).toBe(2);
  });

  it("is the counter behind metrics.estimatedTokens, which counts the whole SKILL.md", () => {
    const skillMd = buildSkill();
    expect(check({ skillMd }).metrics.estimatedTokens).toBe(estimateTokens(skillMd));
  });
});

describe("checkSkillQuality on adversarial lines", () => {
  it("reads a heading line with a long whitespace run and a line separator in linear time", () => {
    const hostile = `#${"\t".repeat(100_000)}x\u2028y`;
    const started = performance.now();
    const report = check({ skillMd: buildSkill({ body: `# Title\n\n${hostile}\n` }) });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(report.metrics.estimatedTokens).toBeGreaterThan(0);
  });
});
