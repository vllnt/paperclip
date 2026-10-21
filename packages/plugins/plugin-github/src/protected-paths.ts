/**
 * The protected-path merge guard (P4b). Agents write as the company's App
 * user, and GitHub does not let that person approve their own pull requests,
 * so CODEOWNERS cannot keep agent changes away from protected paths. Paperclip
 * refuses every agent merge whose diff touches one; a human merges it in the
 * GitHub web UI.
 *
 * The protected list comes from the base branch only (never the PR head): a
 * minimum list hard-coded here, plus `protectedPaths` of `paperclip/tiers.yaml`
 * read at the base commit, plus the paths of the instance admin's
 * `protectedPathPolicy` rules for the repository (plugin config, read at merge time).
 *
 * By default every protected path refuses an agent merge. A `protectedPathPolicy` rule
 * can instead `require` approvals from named reviewer lenses at the exact head commit.
 */

/** The CODEOWNERS paths decide who may approve a change: no opt-in ever releases them. */
export const CODEOWNERS_PATHS: readonly string[] = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
/** Protected in every repository. */
export const MINIMUM_PROTECTED_PATHS: readonly string[] = [".github/**", ...CODEOWNERS_PATHS];
export const TIERS_FILE = "paperclip/tiers.yaml";
export const SKILLS_LOCK_FILE = "paperclip/skills.lock";
const SKILL_PATH = /^plugins\/anthm\/skills\/[A-Za-z0-9._-]+$/;

/**
 * Reads the top-level `protectedPaths:` list of a tiers file: a block of
 * `- path` items (plain or quoted, `#` comments allowed). Anything else in that
 * block (flow lists, nested maps, anchors, multi-line scalars) or a second
 * `protectedPaths` key throws: Paperclip refuses rather than guess.
 */
export function parseProtectedPaths(text: string): string[] {
  if (text.includes("\t") || /^(---|\.\.\.)\s*$/m.test(text.replace(/^---\s*\n/, ""))) throw new Error("the tiers file uses tabs or several YAML documents.");
  const lines = text.split(/\r?\n/);
  const starts = lines.map((line, index) => /^protectedPaths\s*:/.test(line) ? index : -1).filter(index => index >= 0);
  if (starts.length !== 1) throw new Error(starts.length ? "the tiers file has more than one protectedPaths key." : "the tiers file has no protectedPaths key.");
  const header = lines[starts[0]!]!.replace(/\s+#.*$/, "");
  if (!/^protectedPaths\s*:\s*$/.test(header)) throw new Error("protectedPaths must be a block list (- path).");
  const paths: string[] = [];
  for (let index = starts[0]! + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const item = /^\s+-\s+(.*?)\s*$/.exec(line.replace(/\s+#.*$/, ""));
    if (!item) throw new Error(`protectedPaths has an entry Paperclip cannot read: ${line.trim().slice(0, 80)}`);
    let value = item[1]!;
    const quoted = /^"([^"\\]*)"$|^'([^']*)'$/.exec(value);
    if (quoted) value = quoted[1] ?? quoted[2]!;
    else if (/^["'&*!|>{[%@`]/.test(value)) throw new Error(`protectedPaths has an entry Paperclip cannot read: ${value.slice(0, 80)}`);
    if (!/^[A-Za-z0-9._\-\/*?]+$/.test(value) || value.includes("..") || value.startsWith("/")) throw new Error(`protectedPaths has an invalid path: ${value.slice(0, 80)}`);
    paths.push(value);
  }
  return paths;
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` matches any number of directories (none included); a trailing `**` matches everything below.
      if (pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2; } else { source += ".*"; index += 1; }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * Whether `path` is under `pattern`: gitignore-like globs (`*`, `?`, `**`),
 * anchored at the repository root when the pattern has a slash, any depth
 * otherwise; a match on a parent directory covers everything below it.
 * Case-insensitive, so a case change never escapes a pattern.
 */
export function matchesProtectedPath(pattern: string, path: string): boolean {
  let end = pattern.length;
  while (end > 0 && pattern.charCodeAt(end - 1) === 47) end -= 1;
  const trimmed = pattern.slice(0, end);
  const anchored = trimmed.includes("/");
  // `x/**` covers `x` itself too: a file, symlink or submodule named like the directory.
  const clean = trimmed.replace(/\/\*\*$/, "");
  const regex = globRegex(anchored ? clean : `**/${clean}`);
  const segments = path.split("/");
  for (let end = segments.length; end > 0; end -= 1) {
    if (regex.test(segments.slice(0, end).join("/"))) return true;
  }
  return false;
}

/**
 * The protected patterns of a repository: the minimum list, its base branch's tiers file (null when it has none) and the
 * paths of the admin's policy rules for it (a `refuse` rule is how an admin protects a path that the other two do not name).
 */
export function protectedPatterns(tiers: string[] | null, policy: RepositoryPathPolicy | null = null): string[] {
  return [...new Set([...MINIMUM_PROTECTED_PATHS, ...policyPaths(policy), ...(tiers ?? [])])];
}

export interface ChangedFile { filename: string; previousFilename?: string | null }

/** Every path a change touches (a rename touches both names) that a protected pattern covers. */
export function protectedFiles(files: readonly ChangedFile[], patterns: readonly string[]): string[] {
  const touched = files.flatMap(file => [file.filename, ...(file.previousFilename ? [file.previousFilename] : [])]);
  return [...new Set(touched.filter(path => patterns.some(pattern => matchesProtectedPath(pattern, path))))].sort();
}

/**
 * An instance admin's opt-in for one repository (the `agentMergeablePaths` plugin config): agents may merge a pull request
 * whose protected files `allow` covers, minus `exclude`. Never read from a pull request head or a repository file.
 */
export interface AgentMergeableRule { repository: string; allow: string[]; exclude: string[] }

/** The only paths an opt-in may release: under `.github/`. */
const RELEASABLE_PREFIX = ".github/";
const MAX_RULES = 50, MAX_PATTERNS = 50, MAX_EXCLUDES = 100, MAX_PATTERN_LENGTH = 200;
const GLOB_TEXT = /^[A-Za-z0-9._\-/*?]+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** A pattern the admin may write: plain path characters and globs, inside the repository, short. */
function patternProblem(pattern: unknown): string | null {
  if (typeof pattern !== "string" || !pattern.length || pattern.length > MAX_PATTERN_LENGTH || !GLOB_TEXT.test(pattern)) return "a path pattern must be plain text of letters, digits and . _ - / * ?";
  if (pattern.startsWith("/") || pattern.includes("..") || pattern.includes("//")) return `the path pattern ${pattern} leaves the repository`;
  return null;
}

/**
 * Reads the `agentMergeablePaths` config. An entry that is not valid is dropped whole (it releases nothing), and so is a
 * repository listed twice: a doubt never releases a path. Whatever the config holds, a CODEOWNERS path is never released
 * (see `releasedByOptIn`); an `allow` entry that names one, or reaches outside `.github/`, makes its entry invalid.
 * (`protectedPathPolicy` is the way to let reviewed merges through CODEOWNERS, control and tiers paths.)
 */
export function parseAgentMergeablePaths(value: unknown): { rules: AgentMergeableRule[]; problems: string[] } {
  if (value === undefined || value === null) return { rules: [], problems: [] };
  if (!Array.isArray(value)) return { rules: [], problems: ["agentMergeablePaths must be a list"] };
  // A list longer than the host accepts was not saved through the host: release nothing rather than read part of it.
  if (value.length > MAX_RULES) return { rules: [], problems: [`agentMergeablePaths lists more than ${MAX_RULES} repositories`] };
  const problems: string[] = [];
  const seen = new Map<string, AgentMergeableRule | null>();
  value.forEach((entry, index) => {
    const at = `agentMergeablePaths[${index}]`;
    const fail = (reason: string) => { problems.push(`${at}: ${reason}`); };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("must be an object");
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter(key => !["repository", "allow", "exclude"].includes(key));
    if (unknown.length) return fail(`unknown key ${unknown[0]}`);
    if (typeof record.repository !== "string" || !REPOSITORY_NAME.test(record.repository)) return fail("repository must be owner/name");
    const repository = record.repository.toLowerCase();
    const allow = record.allow, exclude = record.exclude ?? [];
    if (!Array.isArray(allow) || !allow.length || allow.length > MAX_PATTERNS) return fail(`allow must list 1 to ${MAX_PATTERNS} paths`);
    if (!Array.isArray(exclude) || exclude.length > MAX_EXCLUDES) return fail(`exclude must list at most ${MAX_EXCLUDES} paths`);
    for (const pattern of allow) {
      const problem = patternProblem(pattern);
      if (problem) return fail(problem);
      if (!(pattern as string).startsWith(RELEASABLE_PREFIX) || (pattern as string).length === RELEASABLE_PREFIX.length) return fail(`allow can only release paths under ${RELEASABLE_PREFIX}`);
      if ((pattern as string).toLowerCase().includes("codeowners")) return fail("allow cannot name CODEOWNERS: CODEOWNERS paths are never released");
    }
    for (const pattern of exclude) { const problem = patternProblem(pattern); if (problem) return fail(problem); }
    // A repository listed twice is ambiguous: neither entry releases anything.
    if (seen.has(repository)) { problems.push(`${at}: ${repository} is listed more than once`); seen.set(repository, null); return; }
    seen.set(repository, { repository, allow: allow as string[], exclude: exclude as string[] });
  });
  return { rules: [...seen.values()].filter((rule): rule is AgentMergeableRule => rule !== null), problems };
}

/** Whether a path is one of the three CODEOWNERS paths (at any depth, as the protected list reads them). */
export function isCodeownersPath(path: string): boolean {
  return CODEOWNERS_PATHS.some(pattern => matchesProtectedPath(pattern, path));
}

/**
 * Whether the opt-in releases one protected file: `allow` covers it, no `exclude` does, and it is not a CODEOWNERS path, a
 * path of the repository's `protectedPathPolicy` rules or a tiers path. Those last three win over any config, so no change
 * of this config can release them. A path that is not in its normal form (a `.`, `..` or empty segment, as in
 * `.github/../scripts/x`) is never released: it could match `allow` by its first segments and name a control path.
 */
export function releasedByOptIn(rule: AgentMergeableRule, path: string, tiers: string[] | null, policy: RepositoryPathPolicy | null = null): boolean {
  if (path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) return false;
  if (!rule.allow.some(pattern => matchesProtectedPath(pattern, path))) return false;
  if (rule.exclude.some(pattern => matchesProtectedPath(pattern, path))) return false;
  if (isCodeownersPath(path)) return false;
  return ![...policyPaths(policy), ...(tiers ?? [])].some(pattern => matchesProtectedPath(pattern, path));
}

/**
 * Splits the protected files of a pull request into those the opt-in releases and those it does not. Nothing is released
 * without a rule for the repository, nor for a repository with a tiers file. The paths of the repository's policy rules stay
 * refused or reviewed (see `releasedByOptIn`). One unreleased file keeps the refusal for the whole pull request.
 */
export function splitReleased(touched: readonly string[], rule: AgentMergeableRule | null, tiers: string[] | null, policy: RepositoryPathPolicy | null = null): { released: string[]; kept: string[] } {
  // `!== null`, not a truthiness test: a tiers value that is not exactly null (even `undefined`) releases nothing.
  if (!rule || tiers !== null) return { released: [], kept: [...touched] };
  const released = touched.filter(path => releasedByOptIn(rule, path, tiers, policy));
  return { released, kept: touched.filter(path => !released.includes(path)) };
}

/**
 * A reviewer lens an instance admin defines for one repository: a name (the scope a reviewer writes in a verdict), optional
 * other spellings of it, and the Paperclip agents whose verdicts count for it. Only these agents can approve the lens.
 */
export interface LensDefinition { name: string; aliases: string[]; agents: string[] }

/**
 * What a protected path needs before an agent may merge a pull request that touches it. `refuse` is the default for every
 * protected path. `require` lets the merge go ahead when every named lens has an approval at the exact head commit.
 */
export type PathRuleAction =
  | { action: "refuse" }
  | {
    action: "require";
    /** Lens names (each defined in the entry's `lenses`). */
    lenses: string[];
    /** Whether an `--admin` merge may go ahead for the paths of this rule (the admin merge checks of the plugin still apply). */
    allowAdmin: boolean;
    /** Whether the rule also governs CODEOWNERS paths. Without it, a CODEOWNERS file the rule's paths cover stays refused. */
    codeowners: boolean;
  };
export type PathRule = { paths: string[] } & PathRuleAction;

/** The admin's protected-path policy for one repository (the `protectedPathPolicy` plugin config). Never read from a pull request. */
export interface RepositoryPathPolicy { repository: string; rules: PathRule[]; lenses: LensDefinition[] }

/** Every path pattern the policy's rules name: they are protected whatever the minimum list and the tiers file say. */
export function policyPaths(policy: RepositoryPathPolicy | null): string[] {
  return policy ? policy.rules.flatMap(rule => rule.paths) : [];
}

const MAX_POLICY_REPOSITORIES = 50, MAX_POLICY_RULES = 50, MAX_RULE_PATHS = 50, MAX_RULE_LENSES = 10, MAX_LENSES = 10, MAX_LENS_ALIASES = 5, MAX_LENS_AGENTS = 20;
const LENS_TEXT = /^[A-Za-z0-9][A-Za-z0-9 &._-]{0,39}$/;
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How a lens is compared: case, outer and repeated spaces do not matter. */
export const lensKey = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

export interface PolicyProblem {
  /** The repository (lowercase) the problem belongs to, or null when it cannot be told. */
  repository: string | null;
  message: string;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(record).find(key => !allowed.includes(key));
  return extra === undefined ? null : `unknown key ${extra}`;
}

function parseLens(value: unknown): LensDefinition | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a lens must be an object";
  const record = value as Record<string, unknown>;
  const extra = onlyKeys(record, ["name", "aliases", "agents"]);
  if (extra) return `a lens has ${extra}`;
  if (typeof record.name !== "string" || !LENS_TEXT.test(record.name)) return "a lens name must be 1 to 40 letters, digits, spaces and & . _ -";
  const aliases = record.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > MAX_LENS_ALIASES || aliases.some(alias => typeof alias !== "string" || !LENS_TEXT.test(alias))) return `lens ${record.name}: aliases must list at most ${MAX_LENS_ALIASES} names`;
  const agents = record.agents;
  if (!Array.isArray(agents) || !agents.length || agents.length > MAX_LENS_AGENTS || agents.some(agent => typeof agent !== "string" || !AGENT_ID.test(agent))) return `lens ${record.name}: agents must list 1 to ${MAX_LENS_AGENTS} agent IDs`;
  return { name: record.name, aliases: aliases as string[], agents: [...new Set((agents as string[]).map(agent => agent.toLowerCase()))] };
}

function parseRule(value: unknown): PathRule | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a rule must be an object";
  const record = value as Record<string, unknown>;
  const extra = onlyKeys(record, ["paths", "action", "lenses", "allowAdmin", "codeowners"]);
  if (extra) return `a rule has ${extra}`;
  const paths = record.paths;
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_RULE_PATHS) return `a rule's paths must list 1 to ${MAX_RULE_PATHS} paths`;
  for (const path of paths) { const problem = patternProblem(path); if (problem) return problem; }
  if (record.action === undefined || record.action === "refuse") {
    if (record.lenses !== undefined || record.allowAdmin !== undefined || record.codeowners !== undefined) return "a refuse rule takes no lenses, allowAdmin or codeowners";
    return { paths: paths as string[], action: "refuse" };
  }
  if (record.action !== "require") return "a rule's action must be refuse or require";
  const lenses = record.lenses;
  if (!Array.isArray(lenses) || !lenses.length || lenses.length > MAX_RULE_LENSES || lenses.some(lens => typeof lens !== "string" || !LENS_TEXT.test(lens))) return `a require rule must name 1 to ${MAX_RULE_LENSES} lenses`;
  for (const flag of ["allowAdmin", "codeowners"] as const) if (record[flag] !== undefined && typeof record[flag] !== "boolean") return `${flag} must be true or false`;
  return { paths: paths as string[], action: "require", lenses: lenses as string[], allowAdmin: record.allowAdmin === true, codeowners: record.codeowners === true };
}

/**
 * Reads the `protectedPathPolicy` config: per repository, ordered rules (the first rule that covers a path decides) and the
 * reviewer lenses the rules may require. Nothing in a rule can widen what an agent may merge unless it names lenses that
 * the admin defined with the agents that may approve them. The reader is strict: an entry that is not valid, or a repository
 * listed twice, comes back in `problems` and has no policy. The merge guard then refuses every merge in that repository
 * (a policy it cannot read must not turn into an unprotected path).
 */
export function parseProtectedPathPolicy(value: unknown): { policies: RepositoryPathPolicy[]; problems: PolicyProblem[] } {
  if (value === undefined || value === null) return { policies: [], problems: [] };
  const problems: PolicyProblem[] = [];
  if (!Array.isArray(value)) return { policies: [], problems: [{ repository: null, message: "protectedPathPolicy must be a list" }] };
  if (value.length > MAX_POLICY_REPOSITORIES) return { policies: [], problems: [{ repository: null, message: `protectedPathPolicy lists more than ${MAX_POLICY_REPOSITORIES} repositories` }] };
  const seen = new Map<string, RepositoryPathPolicy | null>();
  value.forEach((entry, index) => {
    const at = `protectedPathPolicy[${index}]`;
    let repository: string | null = null;
    const fail = (message: string) => { problems.push({ repository, message: `${at}: ${message}` }); };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("must be an object");
    const record = entry as Record<string, unknown>;
    if (typeof record.repository === "string" && REPOSITORY_NAME.test(record.repository)) repository = record.repository.toLowerCase();
    const extra = onlyKeys(record, ["repository", "rules", "lenses"]);
    if (extra) return fail(extra);
    if (repository === null) return fail("repository must be owner/name");
    const rules = record.rules;
    if (!Array.isArray(rules) || !rules.length || rules.length > MAX_POLICY_RULES) return fail(`rules must list 1 to ${MAX_POLICY_RULES} rules`);
    const parsedRules: PathRule[] = [];
    for (const rule of rules) { const parsed = parseRule(rule); if (typeof parsed === "string") return fail(parsed); parsedRules.push(parsed); }
    const lenses = record.lenses ?? [];
    if (!Array.isArray(lenses) || lenses.length > MAX_LENSES) return fail(`lenses must list at most ${MAX_LENSES} lenses`);
    const parsedLenses: LensDefinition[] = [];
    const names = new Set<string>();
    for (const lens of lenses) {
      const parsed = parseLens(lens);
      if (typeof parsed === "string") return fail(parsed);
      // A name or alias two lenses share would let one lens's verdict count for the other.
      for (const key of new Set([parsed.name, ...parsed.aliases].map(lensKey))) {
        if (names.has(key)) return fail(`the lens name ${key} is used more than once`);
        names.add(key);
      }
      parsedLenses.push(parsed);
    }
    const defined = new Set(parsedLenses.map(lens => lensKey(lens.name)));
    for (const rule of parsedRules) {
      if (rule.action !== "require") continue;
      const unknown = rule.lenses.find(lens => !defined.has(lensKey(lens)));
      if (unknown !== undefined) return fail(`a rule requires the lens ${unknown}, which this repository does not define`);
    }
    // A repository listed twice is ambiguous: neither entry counts, and the guard refuses the repository.
    if (seen.has(repository)) { problems.push({ repository, message: `${at}: ${repository} is listed more than once` }); seen.set(repository, null); return; }
    seen.set(repository, { repository, rules: parsedRules, lenses: parsedLenses });
  });
  return { policies: [...seen.values()].filter((policy): policy is RepositoryPathPolicy => policy !== null), problems };
}

export interface GovernedFile { path: string; ruleIndex: number }

/**
 * Sorts the protected files that are still refused after the `agentMergeablePaths` release: those a `require` rule governs
 * (with the rule), and those that stay refused (no rule covers them, a `refuse` rule does, or the path is not in its
 * normal form). The first rule that covers a path decides, so an earlier `refuse` rule keeps a path out of a later `require`
 * rule. A CODEOWNERS file is governed only by a rule with `codeowners: true`; the other rules skip it.
 */
export function classifyKeptFiles(kept: readonly string[], policy: RepositoryPathPolicy | null): { refused: string[]; governed: GovernedFile[] } {
  const refused: string[] = [], governed: GovernedFile[] = [];
  for (const path of kept) {
    const normal = !path.split("/").some(segment => segment === "" || segment === "." || segment === "..");
    const codeowners = isCodeownersPath(path);
    const index = !normal || !policy ? -1 : policy.rules.findIndex(rule => rule.paths.some(pattern => matchesProtectedPath(pattern, path)) && (!codeowners || (rule.action === "require" && rule.codeowners) || rule.action === "refuse"));
    const rule = index >= 0 ? policy!.rules[index]! : null;
    if (rule && rule.action === "require") governed.push({ path, ruleIndex: index });
    else refused.push(path);
  }
  return { refused, governed };
}

/** What the governed files of a pull request ask for: the lenses (each once, in the order the rules name them), and the rules used. */
export function requirementsOf(governed: readonly GovernedFile[], policy: RepositoryPathPolicy): { lenses: string[]; rules: Array<{ index: number; paths: string[]; lenses: string[]; allowAdmin: boolean; files: string[] }>; withoutAdmin: number[] } {
  const rules = [...new Set(governed.map(entry => entry.ruleIndex))].sort((a, b) => a - b).map(index => {
    const rule = policy.rules[index]!;
    if (rule.action !== "require") throw new Error("a governed file belongs to a require rule");
    return { index, paths: rule.paths, lenses: rule.lenses, allowAdmin: rule.allowAdmin, files: governed.filter(entry => entry.ruleIndex === index).map(entry => entry.path) };
  });
  const lenses: string[] = [];
  for (const rule of rules) for (const lens of rule.lenses) if (!lenses.some(known => lensKey(known) === lensKey(lens))) lenses.push(lens);
  return { lenses, rules, withoutAdmin: rules.filter(rule => !rule.allowAdmin).map(rule => rule.index) };
}

/**
 * The one exception: a pull request whose only protected change is
 * `paperclip/skills.lock`, where every changed lock entry changes only its
 * `snapshotHash`, belongs to a skill under `plugins/anthm/skills/<name>` that
 * this pull request also changes, and that skill is not itself protected.
 * Returns null when the exception applies, or the reason it does not.
 */
/**
 * Strict JSON: what JSON.parse accepts, except that an object with the same key
 * twice throws (JSON.parse keeps the last one, which could hide a change).
 */
export function parseJsonWithoutDuplicateKeys(text: string): unknown {
  let at = 0;
  const fail = (): never => { throw new SyntaxError(`invalid JSON or a duplicate key at ${at}`); };
  const space = () => { while (at < text.length && " \t\n\r".includes(text[at]!)) at += 1; };
  const string = (): string => {
    const start = at;
    if (text[at] !== '"') fail();
    at += 1;
    while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    if (text[at] !== '"') fail();
    at += 1;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (): unknown => {
    space();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const object: Record<string, unknown> = {};
      const keys = new Set<string>();
      space();
      if (text[at] === "}") { at += 1; return object; }
      for (;;) {
        space();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        space();
        if (text[at] !== ":") fail();
        at += 1;
        Object.defineProperty(object, key, { value: value(), enumerable: true, configurable: true, writable: true });
        space();
        if (text[at] === ",") { at += 1; continue; }
        if (text[at] === "}") { at += 1; return object; }
        fail();
      }
    }
    if (char === "[") {
      at += 1;
      const array: unknown[] = [];
      space();
      if (text[at] === "]") { at += 1; return array; }
      for (;;) {
        array.push(value());
        space();
        if (text[at] === ",") { at += 1; continue; }
        if (text[at] === "]") { at += 1; return array; }
        fail();
      }
    }
    if (char === '"') return string();
    const literal = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(at));
    if (!literal) fail();
    at += literal![0].length;
    return JSON.parse(literal![0]);
  };
  const result = value();
  space();
  if (at !== text.length) fail();
  return result;
}

export function skillsLockException(input: { baseLock: string; headLock: string; files: readonly ChangedFile[]; patterns: readonly string[] }): string | null {
  const parse = (text: string) => {
    const value = parseJsonWithoutDuplicateKeys(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { skills?: unknown }).skills)) throw new Error("not a skills lock");
    return value as { skills: unknown[] } & Record<string, unknown>;
  };
  let base: ReturnType<typeof parse>, head: ReturnType<typeof parse>;
  try { base = parse(input.baseLock); head = parse(input.headLock); } catch { return `${SKILLS_LOCK_FILE} is not a lock file Paperclip can read.`; }
  const { skills: baseSkills, ...baseRest } = base, { skills: headSkills, ...headRest } = head;
  if (JSON.stringify(baseRest) !== JSON.stringify(headRest)) return `${SKILLS_LOCK_FILE} changes more than skill snapshot hashes.`;
  const entries = (skills: unknown[]) => {
    const map = new Map<string, Record<string, unknown>>();
    for (const entry of skills) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const skillPath = (entry as { skillPath?: unknown }).skillPath;
      if (typeof skillPath !== "string" || map.has(skillPath)) return null;
      map.set(skillPath, entry as Record<string, unknown>);
    }
    return map;
  };
  const before = entries(baseSkills), after = entries(headSkills);
  if (!before || !after) return `${SKILLS_LOCK_FILE} has an entry Paperclip cannot read.`;
  if (before.size !== after.size || [...before.keys()].some(path => !after.has(path))) return `${SKILLS_LOCK_FILE} adds or removes skills.`;
  const changedPaths = input.files.flatMap(file => [file.filename, ...(file.previousFilename ? [file.previousFilename] : [])]);
  for (const [skillPath, old] of before) {
    const next = after.get(skillPath)!;
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    const { snapshotHash: _a, ...oldRest } = old, { snapshotHash: _b, ...nextRest } = next;
    const keys = [...new Set([...Object.keys(oldRest), ...Object.keys(nextRest)])];
    if (keys.some(key => JSON.stringify(oldRest[key]) !== JSON.stringify(nextRest[key]))) return `${SKILLS_LOCK_FILE} changes more than the snapshot hash of ${skillPath}.`;
    if (!SKILL_PATH.test(skillPath)) return `${skillPath} is not a skill under plugins/anthm/skills/.`;
    const skillFiles = changedPaths.filter(path => path.startsWith(`${skillPath}/`));
    if (!skillFiles.length) return `${SKILLS_LOCK_FILE} changes ${skillPath}, which this pull request does not change.`;
    if ([`${skillPath}/`, ...skillFiles].some(path => input.patterns.some(pattern => matchesProtectedPath(pattern, path)))) return `${skillPath} is itself protected.`;
  }
  return null;
}
