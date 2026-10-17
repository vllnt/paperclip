import path from "node:path";
import { asString, parseFrontmatterMarkdown } from "./frontmatter.js";
import {
  countBodyLines,
  estimateTokens,
  findRuleSentences,
  findShoutingWords,
  jaccard,
  scanLines,
  splitDocument,
  wordSet,
  type ProseLine,
} from "./skill-quality-text.js";

/** Every check the skill-quality function can report. F = frontmatter, B = body and links, S = scripts, E = evals, C = skill set. */
export const SKILL_QUALITY_CHECK_IDS = [
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10",
  "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13", "B14", "B15", "B16", "B17", "B18",
  "S1", "S2", "E1", "E2", "C1", "C2",
] as const;

export type SkillQualityCheckId = (typeof SKILL_QUALITY_CHECK_IDS)[number];
export type SkillQualitySeverity = "error" | "warn" | "info";

/** One problem found in a skill. Info findings are advisory and carry no penalty. */
export interface SkillQualityFinding {
  id: SkillQualityCheckId;
  severity: SkillQualitySeverity;
  message: string;
  file: string;
  lines: number[];
  penalty: number;
}

/** Size and style measurements, reported even when no check fails. */
export interface SkillQualityMetrics {
  bodyLines: number;
  estimatedTokens: number;
  descriptionLength: number;
  shoutingWords: number;
  ruleCount: number;
  rulesWithoutReason: number;
  referenceFileCount: number;
  maxReferenceDepth: number;
}

/** The result of checking one skill: a 0-100 score, the findings behind it, and the raw metrics. */
export interface SkillQualityReport {
  score: number;
  findings: SkillQualityFinding[];
  metrics: SkillQualityMetrics;
}

/** A file bundled with the skill. `path` is relative to the skill directory, with forward slashes. */
export interface SkillQualityFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface SkillQualityInput {
  /** Full SKILL.md text including the frontmatter block. */
  skillMd: string;
  /** Skill directory name, compared with `name` when given. */
  directoryName?: string;
  /** Other files in the skill directory. Link and script checks that need the file list run only when this is given. */
  files?: readonly SkillQualityFile[];
  /** Number of eval cases covering the skill, when known. */
  evalCaseCount?: number;
  /** Trigger-eval queries for the skill, when known. */
  triggerQueries?: readonly { query: string; shouldTrigger: boolean }[];
}

/** Thresholds marked (H) in the research note are heuristics; every threshold can be overridden. */
export interface SkillQualityThresholds {
  maxBodyLines: number;
  warnBodyLines: number;
  maxBodyTokens: number;
  maxDescriptionChars: number;
  descriptionBudgetChars: number;
  descriptionAdvisoryChars: number;
  referenceTocLines: number;
  tocScanLines: number;
  maxShoutingWords: number;
  maxRulesWithoutReasonRatio: number;
  minRulesForReasonCheck: number;
  maxRules: number;
  minEvalCases: number;
  minTriggerQueries: number;
  minNegativeRatio: number;
  similarDescriptionJaccard: number;
  listingBudgetChars: number;
  maxSkillsPerRequest: number;
}

export interface SkillQualityOptions {
  /** `portable` rejects Claude Code-only frontmatter keys (claude.ai and API uploads). Defaults to `claude-code`. */
  target?: "claude-code" | "portable";
  /** Extra frontmatter keys the host accepts, such as Paperclip catalog keys. */
  extraFrontmatterKeys?: readonly string[];
  /** Words counted as shouting. */
  shoutingWords?: readonly string[];
  /** Replaces the bytes/4 token estimate, for example with a real tokenizer or a gateway count. */
  countTokens?: (text: string) => number;
  thresholds?: Partial<SkillQualityThresholds>;
  /** Change a check's severity, or switch it off. */
  severity?: Partial<Record<SkillQualityCheckId, SkillQualitySeverity | "off">>;
}

export const DEFAULT_SKILL_QUALITY_THRESHOLDS: SkillQualityThresholds = {
  maxBodyLines: 500,
  warnBodyLines: 400,
  maxBodyTokens: 5000,
  maxDescriptionChars: 1024,
  descriptionBudgetChars: 1536,
  descriptionAdvisoryChars: 500,
  referenceTocLines: 100,
  tocScanLines: 15,
  maxShoutingWords: 3,
  maxRulesWithoutReasonRatio: 0.5,
  minRulesForReasonCheck: 5,
  maxRules: 60,
  minEvalCases: 3,
  minTriggerQueries: 16,
  minNegativeRatio: 0.4,
  similarDescriptionJaccard: 0.6,
  listingBudgetChars: 8000,
  maxSkillsPerRequest: 20,
};

const DEFAULT_SHOUTING_WORDS = ["MUST", "NEVER", "ALWAYS", "CRITICAL", "IMPORTANT", "REQUIRED", "EXACTLY", "FORBIDDEN", "MANDATORY", "DO NOT"];
const PORTABLE_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const CLAUDE_CODE_KEYS = new Set([
  "when_to_use", "paths", "context", "agent", "model", "effort", "hooks",
  "disable-model-invocation", "user-invocable", "disallowed-tools", "arguments",
]);
const SEVERITY_PENALTY: Record<SkillQualitySeverity, number> = { error: 15, warn: 4, info: 0 };
const SCRIPT_PATTERN = /^scripts\/.+\.(sh|bash|py|js|mjs|cjs|rb)$/;
const SECRET_PATTERNS = [/AKIA[0-9A-Z]{16}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const NETWORK_PATTERN = /\bcurl\b|\brequests\.|\bfetch\(/;
const TRIGGER_PATTERN =
  /\buse (?:this skill |it |this )?(?:when|for|before|after|to)\b|\bwhen (?:the user|a user|users?|someone|an? |asked|asking|you|working|doing|writing|reviewing|creating)|\btrigger|\bwhenever\b|\bif the user\b/i;
const FIRST_PERSON_ERROR = /\b(I can|I will|I'll|I'm|I am|you can|you will|you'll|we can|we will)\b/i;
const LOOSE_PERSON_WARN = /\b(you|your|we|our|my)\b|\bI\b/i;
const PROCEDURE_PATTERN = /\bthen\b|first,|step \d|→/i;
const XML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/;
const LEGACY_HEADING = /old patterns|legacy|deprecated/i;

interface LinePattern {
  id: SkillQualityCheckId;
  severity: SkillQualitySeverity;
  pattern: RegExp;
  message: string;
  source: "prose" | "raw";
  skip?: (line: ProseLine) => boolean;
}

const LINE_PATTERNS: readonly LinePattern[] = [
  { id: "B7", severity: "warn", pattern: /\b(before|after|until|as of)\s+(?:\w+\s+)?20\d\d\b/i, message: "date-dependent statement; keep legacy notes in an Old patterns section", source: "prose", skip: (line) => LEGACY_HEADING.test(line.heading) },
  { id: "B8", severity: "error", pattern: /\b(show|write out|explain|state)\s+(your\s+)?(reasoning|thinking|chain of thought)\b/i, message: "asks for reasoning in the reply; current models refuse or leak it. Ask for a short explanation instead", source: "prose" },
  { id: "B9", severity: "error", pattern: /\b(do not|don't)\s+(think|reason)\b/i, message: "tells the model not to think, which leaks internal tags into the output", source: "prose" },
  { id: "B10", severity: "warn", pattern: /\bdouble[- ]check|\bre-?verify\b|\bverify your (answer|work)\b/i, message: "generic verification line with no concrete check; name the command or delete it", source: "raw", skip: (line) => line.text.includes("`") },
  { id: "B11", severity: "warn", pattern: /\bthink (carefully|step by step|hard)\b/i, message: "thinking-depth phrase; set effort instead", source: "prose" },
  { id: "B12", severity: "warn", pattern: /\bminimi[sz]e tool calls\b|\bonly use tools when strictly\b|\bhold all findings\b/i, message: "discourages tools or narration, which causes stale answers", source: "prose" },
  { id: "B13", severity: "warn", pattern: /\bonly report high\b|\bbe conservative\b|\bdon'?t nitpick\b|\bdo not nitpick\b/i, message: "severity filter at the finding stage cuts recall", source: "prose" },
  { id: "B14", severity: "warn", pattern: /`([A-Za-z][\w-]*)`\s+MCP tool\b|\bMCP tool\s+`([A-Za-z][\w-]*)`/, message: "MCP tool named without its Server:tool prefix", source: "raw" },
  { id: "B16", severity: "info", pattern: /\b(delve|leverag(?:e|es|ed|ing)|foster(?:s|ed|ing)?|it's worth noting)\b/i, message: "filler word from the slop list", source: "prose" },
];

interface Context {
  thresholds: SkillQualityThresholds;
  options: SkillQualityOptions;
  findings: SkillQualityFinding[];
}

function emit(
  context: Context,
  id: SkillQualityCheckId,
  severity: SkillQualitySeverity,
  file: string,
  message: string,
  lines: number[] = [],
  extraPenalty = 0,
): void {
  const override = context.options.severity?.[id];
  if (override === "off") return;
  const effective = override ?? severity;
  const penalty = effective === "info" ? 0 : SEVERITY_PENALTY[effective] + extraPenalty;
  context.findings.push({ id, severity: effective, message, file, lines, penalty });
}

function createContext(options: SkillQualityOptions): Context {
  return { thresholds: { ...DEFAULT_SKILL_QUALITY_THRESHOLDS, ...options.thresholds }, options, findings: [] };
}

const MAX_PENALTY_PER_CHECK = 30;

function scoreOf(findings: readonly SkillQualityFinding[]): number {
  const byCheck = new Map<SkillQualityCheckId, number>();
  for (const finding of findings) byCheck.set(finding.id, (byCheck.get(finding.id) ?? 0) + finding.penalty);
  const total = [...byCheck.values()].reduce((sum, penalty) => sum + Math.min(MAX_PENALTY_PER_CHECK, penalty), 0);
  return Math.max(0, Math.round(100 - total));
}

function readFrontmatter(skillMd: string): { present: boolean; record: Record<string, unknown> } {
  if (!skillMd.startsWith("---")) return { present: false, record: {} };
  try {
    const doc = parseFrontmatterMarkdown(skillMd);
    return { present: doc.hasFrontmatter, record: doc.frontmatter };
  } catch {
    return { present: false, record: {} };
  }
}

function checkFrontmatter(context: Context, input: SkillQualityInput, record: Record<string, unknown>): string {
  const { thresholds, options } = context;
  const name = asString(record.name) ?? "";
  if (name === "" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    emit(context, "F2", "error", "SKILL.md", `name "${name}" must be 1-64 characters of lowercase letters, digits and single hyphens`);
  } else if (input.directoryName !== undefined && input.directoryName !== name) {
    emit(context, "F2", "error", "SKILL.md", `name "${name}" must match its directory "${input.directoryName}"`);
  }
  if (/anthropic|claude/.test(name)) {
    emit(context, "F3", "error", "SKILL.md", `name "${name}" contains a reserved word`);
  }

  const description = asString(record.description) ?? "";
  if (description.trim() === "") {
    emit(context, "F4", "error", "SKILL.md", "description is missing or empty");
    return description;
  }
  if (description.length > thresholds.maxDescriptionChars) {
    emit(context, "F4", "error", "SKILL.md", `description is ${description.length} characters; the limit is ${thresholds.maxDescriptionChars}`);
  }
  if (XML_TAG_PATTERN.test(description)) {
    emit(context, "F4", "error", "SKILL.md", "description contains an XML tag");
  }
  const combined = description.length + (asString(record.when_to_use)?.length ?? 0);
  if (combined > thresholds.descriptionBudgetChars) {
    emit(context, "F5", "warn", "SKILL.md", `description and when_to_use total ${combined} characters; listings truncate at ${thresholds.descriptionBudgetChars}`);
  } else if (combined > thresholds.descriptionAdvisoryChars) {
    emit(context, "F5", "info", "SKILL.md", `description is ${combined} characters; shorter descriptions leave room in the skill listing`);
  }
  if (FIRST_PERSON_ERROR.test(description)) {
    emit(context, "F6", "error", "SKILL.md", "description is written in first or second person; use third person");
  } else if (LOOSE_PERSON_WARN.test(description)) {
    emit(context, "F6", "warn", "SKILL.md", "description addresses a person; prefer third person");
  }
  if (!TRIGGER_PATTERN.test(description)) {
    emit(context, "F7", "warn", "SKILL.md", "description does not say when to use the skill");
  }
  if (PROCEDURE_PATTERN.test(description)) {
    emit(context, "F8", "warn", "SKILL.md", "description summarizes a procedure; list triggers instead so the body still gets read");
  }

  const known = new Set([...PORTABLE_KEYS, ...CLAUDE_CODE_KEYS, ...(options.extraFrontmatterKeys ?? [])]);
  const keys = Object.keys(record);
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) emit(context, "F10", "warn", "SKILL.md", `unknown frontmatter keys: ${unknown.join(", ")}`);
  if (options.target === "portable") {
    const hostOnly = keys.filter((key) => CLAUDE_CODE_KEYS.has(key) && !PORTABLE_KEYS.has(key));
    if (hostOnly.length > 0) emit(context, "F9", "error", "SKILL.md", `Claude Code-only keys on a portable target: ${hostOnly.join(", ")}`);
  }
  return description;
}

function checkLinePatterns(context: Context, file: string, prose: readonly ProseLine[], raw: readonly ProseLine[], description = ""): void {
  for (const check of LINE_PATTERNS) {
    const source = check.source === "prose" ? prose : raw;
    const hits = source.filter((line) => check.pattern.test(line.text) && !check.skip?.(line)).map((line) => line.line);
    const inDescription = (check.id === "B8" || check.id === "B9") && check.pattern.test(description);
    if (hits.length > 0 || inDescription) emit(context, check.id, check.severity, file, check.message, hits);
  }
}

function checkShouting(context: Context, file: string, prose: readonly ProseLine[]): number {
  const words = context.options.shoutingWords ?? DEFAULT_SHOUTING_WORDS;
  const hits = findShoutingWords(prose, words);
  const limit = context.thresholds.maxShoutingWords;
  if (hits.length > limit) {
    emit(context, "B6", "warn", file, `${hits.length} emphasis words (limit ${limit}); state the reason instead`, hits, Math.min(6, hits.length - limit));
  }
  return hits.length;
}

function resolveTarget(fromFile: string, target: string, kind: "link" | "code"): string | null {
  const clean = target.split("#")[0]?.split("?")[0] ?? "";
  if (clean === "" || /[*{}<>$]/.test(clean) || clean.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(clean)) return null;
  if (clean.startsWith("/")) return null;
  const baseDir = kind === "link" ? path.posix.dirname(fromFile) : ".";
  const resolved = path.posix.normalize(path.posix.join(baseDir, clean));
  return resolved.startsWith("..") ? null : resolved;
}

interface Mention {
  target: string;
  line: number;
  kind: "link" | "code";
}

function collectMentions(fromFile: string, raw: readonly ProseLine[]): { mentions: Mention[]; windowsLines: number[] } {
  const mentions: Mention[] = [];
  const windowsLines: number[] = [];
  for (const { line, text } of raw) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1] ?? "";
      if (/^([a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
      const target = resolveTarget(fromFile, href, "link");
      if (target) mentions.push({ target, line, kind: "link" });
    }
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const span = match[1] ?? "";
      if (/^[\w.-]+(\\[\w.-]+)+\.[A-Za-z0-9]+$/.test(span)) windowsLines.push(line);
      else if (/^(\.{1,2}\/)?(references|scripts|assets|templates|skills)\//.test(span)) {
        const target = resolveTarget(fromFile, span, "code");
        if (target) mentions.push({ target, line, kind: "code" });
      }
    }
  }
  return { mentions, windowsLines };
}

function checkReferences(
  context: Context,
  skillRaw: readonly ProseLine[],
  files: readonly SkillQualityFile[],
  haveFileList: boolean,
): { depth: number; referenceCount: number } {
  const known = new Set(files.map((file) => file.path));
  const markdown = files.filter((file) => file.path.endsWith(".md"));
  const sources = [
    { file: "SKILL.md", raw: skillRaw },
    ...markdown.map((file) => ({ file: file.path, raw: scanLines(file.content.split("\n"), 1, false) })),
  ];
  const edges = new Map<string, Set<string>>();
  for (const { file, raw } of sources) {
    const { mentions, windowsLines } = collectMentions(file, raw);
    if (windowsLines.length > 0) emit(context, "B4", "error", file, "Windows-style path; use forward slashes", windowsLines);
    const rooted = mentions.filter((mention) => mention.target.startsWith("skills/"));
    if (rooted.length > 0) {
      emit(context, "B4", "error", file, "repo-rooted path does not resolve from an installed skill; use a path relative to SKILL.md", rooted.map((m) => m.line));
    }
    const missing = haveFileList ? mentions.filter((m) => !m.target.startsWith("skills/") && !known.has(m.target) && m.target !== "SKILL.md") : [];
    if (missing.length > 0) {
      emit(context, "B4", "error", file, `missing file: ${[...new Set(missing.map((m) => m.target))].join(", ")}`, missing.map((m) => m.line));
    }
    const reachable = mentions.map((m) => m.target.replace(/^skills\/[^/]+\//, "")).filter((target) => known.has(target));
    edges.set(file, new Set(reachable));
  }

  const depth = new Map<string, number>([["SKILL.md", 0]]);
  const queue = ["SKILL.md"];
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    for (const next of edges.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, (depth.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  const deep = markdown.filter((file) => (depth.get(file.path) ?? 0) > 1);
  if (deep.length > 0) {
    emit(context, "B5", "warn", "SKILL.md", `reachable only through another reference: ${deep.map((f) => f.path).join(", ")}; link them from SKILL.md`);
  }
  const orphans = markdown.filter((file) => !depth.has(file.path));
  if (orphans.length > 0) {
    emit(context, "B5", "info", "SKILL.md", `never linked, so never loaded: ${orphans.map((f) => f.path).join(", ")}`);
  }
  const deepest = markdown.reduce((max, file) => Math.max(max, depth.get(file.path) ?? 0), 0);
  return { depth: deepest, referenceCount: markdown.length };
}

function checkBundledFiles(context: Context, files: readonly SkillQualityFile[]): void {
  const { thresholds } = context;
  for (const file of files) {
    const lines = file.content.split("\n");
    if (file.path.endsWith(".md") && lines.length > thresholds.referenceTocLines) {
      const head = lines.slice(0, thresholds.tocScanLines).join("\n");
      if (!/^#{1,6}\s*(table of contents|contents)\b/im.test(head)) {
        emit(context, "B3", "warn", file.path, `${lines.length} lines with no Contents heading in the first ${thresholds.tocScanLines} lines`);
      }
    }
    if (SCRIPT_PATTERN.test(file.path)) {
      if (!file.content.startsWith("#!")) emit(context, "S1", "error", file.path, "script has no shebang line");
      if (file.executable === false) emit(context, "S1", "error", file.path, "script is not executable");
      if (NETWORK_PATTERN.test(file.content)) emit(context, "S2", "info", file.path, "script makes network calls; sandboxed runtimes may block them");
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(file.content))) {
      emit(context, "S2", "error", file.path, "looks like a committed secret");
    }
  }
}

function checkEvals(context: Context, input: SkillQualityInput): void {
  const { thresholds } = context;
  if (input.evalCaseCount !== undefined && input.evalCaseCount < thresholds.minEvalCases) {
    emit(context, "E1", "warn", "evals", `${input.evalCaseCount} eval cases; at least ${thresholds.minEvalCases} cover trigger, no-trigger and ambiguous cases`);
  }
  if (input.triggerQueries) {
    const negatives = input.triggerQueries.filter((query) => !query.shouldTrigger).length;
    const total = input.triggerQueries.length;
    if (total < thresholds.minTriggerQueries || (total > 0 ? negatives / total : 0) < thresholds.minNegativeRatio) {
      emit(context, "E2", "info", "evals", `trigger set has ${total} queries, ${negatives} negative; aim for ${thresholds.minTriggerQueries}+ with ${Math.round(thresholds.minNegativeRatio * 100)}% near-misses`);
    }
  }
}

/**
 * Checks one skill against Anthropic's Agent Skills guidance and Claude 5 prompting notes.
 * Pure: no file or network access. Findings explain what to change; the score is 100 minus the penalties
 * (error 15, warning 4, plus a small scale for large overages), and info findings never lower it.
 *
 * @param input - SKILL.md text plus any bundled files, paths relative to the skill directory.
 * @param options - Target host, extra frontmatter keys, thresholds, and per-check severity overrides.
 * @returns The score, the findings, and the measurements behind them.
 * @example
 * const report = checkSkillQuality({ skillMd, directoryName: "paperclip", files });
 * const blocking = report.findings.filter((finding) => finding.severity === "error");
 */
export function checkSkillQuality(input: SkillQualityInput, options: SkillQualityOptions = {}): SkillQualityReport {
  const context = createContext(options);
  const { thresholds } = context;
  const files = input.files ?? [];
  const { present, record } = readFrontmatter(input.skillMd);
  const document = splitDocument(input.skillMd);

  let description = "";
  if (present) description = checkFrontmatter(context, input, record);
  else emit(context, "F1", "error", "SKILL.md", "line 1 must be --- and the frontmatter must be valid YAML");

  const prose = scanLines(document.bodyLines, document.bodyStartLine, true);
  const raw = scanLines(document.bodyLines, document.bodyStartLine, false);
  const bodyLines = countBodyLines(document.bodyLines);
  const estimatedTokens = (options.countTokens ?? estimateTokens)(input.skillMd);

  if (bodyLines > thresholds.maxBodyLines) {
    emit(context, "B1", "error", "SKILL.md", `${bodyLines} body lines; the limit is ${thresholds.maxBodyLines}`, [], Math.min(15, Math.round((bodyLines - thresholds.maxBodyLines) / 20)));
  } else if (bodyLines >= thresholds.warnBodyLines) {
    emit(context, "B1", "warn", "SKILL.md", `${bodyLines} body lines; consider moving detail into references (warns from ${thresholds.warnBodyLines})`);
  }
  if (estimatedTokens > thresholds.maxBodyTokens) {
    emit(context, "B2", "warn", "SKILL.md", `about ${estimatedTokens} tokens; keep the always-loaded file under ${thresholds.maxBodyTokens}`, [], Math.min(10, Math.round((estimatedTokens - thresholds.maxBodyTokens) / 1000)));
  }

  const shouting = checkShouting(context, "SKILL.md", prose);
  checkLinePatterns(context, "SKILL.md", prose, raw, description);
  if (!/^#{1,3}\s*gotchas?\b/im.test(document.bodyLines.join("\n"))) {
    emit(context, "B15", "info", "SKILL.md", "no Gotchas section; record the failures agents actually hit");
  }

  const rules = findRuleSentences(prose);
  const withoutReason = rules.filter((rule) => !rule.hasReason);
  const ratio = rules.length > 0 ? withoutReason.length / rules.length : 0;
  if (rules.length >= thresholds.minRulesForReasonCheck && ratio > thresholds.maxRulesWithoutReasonRatio) {
    emit(context, "B17", "warn", "SKILL.md", `${withoutReason.length} of ${rules.length} rules give no reason; a rule with its reason generalizes better`, withoutReason.map((rule) => rule.line), Math.round(ratio * 6));
  }
  if (rules.length > thresholds.maxRules) {
    emit(context, "B18", "warn", "SKILL.md", `${rules.length} rules (limit ${thresholds.maxRules}); keep the ones the model would not follow by default`);
  }

  let shoutingTotal = shouting;
  for (const file of files.filter((candidate) => candidate.path.endsWith(".md"))) {
    const lines = file.content.split("\n");
    const filePros = scanLines(lines, 1, true);
    shoutingTotal += checkShouting(context, file.path, filePros);
    checkLinePatterns(context, file.path, filePros, scanLines(lines, 1, false));
  }
  const references = checkReferences(context, raw, files, input.files !== undefined);
  checkBundledFiles(context, files);
  checkEvals(context, input);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(input.skillMd))) {
    emit(context, "S2", "error", "SKILL.md", "looks like a committed secret");
  }

  return {
    score: scoreOf(context.findings),
    findings: context.findings,
    metrics: {
      bodyLines,
      estimatedTokens,
      descriptionLength: description.length,
      shoutingWords: shoutingTotal,
      ruleCount: rules.length,
      rulesWithoutReason: withoutReason.length,
      referenceFileCount: references.referenceCount,
      maxReferenceDepth: references.depth,
    },
  };
}

/** Name and description of one skill in a set. */
export interface SkillSetEntry {
  name: string;
  description: string;
}

/**
 * Checks a set of skills together: near-duplicate descriptions steal each other's triggers, and the combined
 * listing has to fit the host's budget.
 *
 * @param skills - Every skill the agent can see.
 * @param options - Threshold and severity overrides.
 * @returns The score and the set-level findings.
 */
export function checkSkillSetQuality(
  skills: readonly SkillSetEntry[],
  options: Pick<SkillQualityOptions, "thresholds" | "severity"> = {},
): Pick<SkillQualityReport, "score" | "findings"> {
  const context = createContext(options);
  const { thresholds } = context;
  const words = skills.map((skill) => wordSet(skill.description));
  skills.forEach((left, i) => {
    skills.slice(i + 1).forEach((right, offset) => {
      const similarity = jaccard(words[i] ?? new Set<string>(), words[i + 1 + offset] ?? new Set<string>());
      if (similarity > thresholds.similarDescriptionJaccard) {
        emit(context, "C1", "warn", "(set)", `${left.name} and ${right.name} have near-duplicate descriptions (${similarity.toFixed(2)}); the broader one steals triggers`);
      }
    });
  });
  const listingChars = skills.reduce((total, skill) => total + skill.name.length + skill.description.length, 0);
  if (listingChars > thresholds.listingBudgetChars) {
    emit(context, "C2", "warn", "(set)", `listing is ${listingChars} characters; hosts shorten or drop descriptions past ${thresholds.listingBudgetChars}`);
  }
  if (skills.length > thresholds.maxSkillsPerRequest) {
    emit(context, "C2", "warn", "(set)", `${skills.length} skills; API requests accept at most ${thresholds.maxSkillsPerRequest}`);
  }
  return { score: scoreOf(context.findings), findings: context.findings };
}
