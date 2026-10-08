/**
 * The protected-path merge guard (P4b). Agents write as the company's App
 * user, and GitHub does not let that person approve their own pull requests,
 * so CODEOWNERS cannot keep agent changes away from protected paths. Paperclip
 * refuses every agent merge whose diff touches one; a human merges it in the
 * GitHub web UI.
 *
 * The protected list comes from the base branch only (never the PR head): a
 * minimum list hard-coded here, plus `protectedPaths` of `paperclip/tiers.yaml`
 * read at the base commit.
 */

/** Protected in every repository. */
export const MINIMUM_PROTECTED_PATHS: readonly string[] = [".github/**", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
/** Also protected in a company's control repository (and in any repository with a `paperclip/tiers.yaml`). */
export const CONTROL_PROTECTED_PATHS: readonly string[] = ["paperclip/**", "scripts/**", "ROADMAP.md", "data/company/strategy/**"];
/** Control repositories (lowercase `owner/name`): the full minimum list applies even without a tiers file. */
export const CONTROL_REPOSITORIES: readonly string[] = ["anthm-fr/anthm-fr"];
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

/** The protected patterns of a repository, from the minimum list and its base branch's tiers file (null when it has none). */
export function protectedPatterns(repository: string, tiers: string[] | null): string[] {
  const control = tiers !== null || CONTROL_REPOSITORIES.includes(repository.toLowerCase());
  return [...new Set([...MINIMUM_PROTECTED_PATHS, ...(control ? CONTROL_PROTECTED_PATHS : []), ...(tiers ?? [])])];
}

export interface ChangedFile { filename: string; previousFilename?: string | null }

/** Every path a change touches (a rename touches both names) that a protected pattern covers. */
export function protectedFiles(files: readonly ChangedFile[], patterns: readonly string[]): string[] {
  const touched = files.flatMap(file => [file.filename, ...(file.previousFilename ? [file.previousFilename] : [])]);
  return [...new Set(touched.filter(path => patterns.some(pattern => matchesProtectedPath(pattern, path))))].sort();
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
