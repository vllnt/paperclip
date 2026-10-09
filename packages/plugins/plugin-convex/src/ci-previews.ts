/**
 * Preview names made by CI carry the pull request and often the run, shard and attempt (for example `pr4320-run101-s2-a1`). A company describes that
 * naming with a template, not a regular expression: literal text, `{pr}` (required, once), `{run}`, `{shard}`, `{attempt}` (each at most once), and at most
 * one flat optional part in square brackets, for example `pr{pr}[-run{run}]-s{shard}-a{attempt}`. A template compiles to literals and bounded digit groups
 * only, anchored to the whole name, so matching a long hostile branch name cannot take more than a few steps.
 */
export interface CiPreview { pr: number; run: number | null; shard: number | null; attempt: number | null }

const PLACEHOLDERS = new Set(["pr", "run", "shard", "attempt"]);
const compiled = new Map<string, RegExp>();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Throws an Error whose message names the problem; the config parser shows it to the operator. */
export function compileTemplate(template: string): RegExp {
  const known = compiled.get(template);
  if (known) return known;
  if (!template || template.length > 200) throw new Error("must be 1 to 200 characters");
  let source = "";
  let optional = false;
  let optionalLength = 0;
  const seen = new Set<string>();
  // What can come right before the next element: a number (a placeholder or a digit) or anything else. Two numbers next to each other
  // cannot be told apart ("12345" is pr 1234 and run 5, or pr 12 and run 345), so that is rejected, also across an optional part that may be empty.
  let before = new Set<"number" | "other">(["other"]);
  let beforeOptional = new Set<"number" | "other">(["other"]);
  let letters = false;
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === "{") {
      const end = template.indexOf("}", i);
      const name = end < 0 ? "" : template.slice(i + 1, end);
      if (!PLACEHOLDERS.has(name)) throw new Error("may only use {pr}, {run}, {shard} and {attempt}");
      if (seen.has(name)) throw new Error(`uses {${name}} more than once`);
      if (optional && name === "pr") throw new Error("{pr} cannot be in an optional [ ] part");
      if (before.has("number")) throw new Error("puts two numbers next to each other; put a letter or punctuation between {pr}, {run}, {shard} and {attempt}");
      seen.add(name);
      source += `(?<${name}>\\d{1,15})`;
      if (optional) optionalLength += 1;
      before = new Set(["number"]);
      i = end;
    } else if (char === "[") {
      if (optional) throw new Error("allows only one flat optional [ ] part");
      optional = true;
      optionalLength = 0;
      beforeOptional = new Set(before);
      source += "(?:";
    } else if (char === "]") {
      if (!optional || optionalLength === 0) throw new Error("has a ] without a matching [ or an empty optional part");
      optional = false;
      before = new Set([...before, ...beforeOptional]); // the optional part may be absent
      source += ")?";
    } else if (char === "}") {
      throw new Error("has a } without a matching {");
    } else {
      source += escape(char);
      if (optional) optionalLength += 1;
      before = new Set([/[0-9]/.test(char) ? "number" : "other"]);
      if (/[A-Za-z]/.test(char)) letters = true;
    }
  }
  if (optional) throw new Error("has a [ without a matching ]");
  if (!seen.has("pr")) throw new Error("must contain {pr}");
  // Without a letter in the literal text, every all-digit name would read as a pull request.
  if (!letters) throw new Error("must contain some literal text with a letter, such as pr");
  const pattern = new RegExp(`^${source}$`);
  compiled.set(template, pattern);
  return pattern;
}

/** The pull request (and run, shard, attempt) a preview name belongs to, or null when no template is set or the name does not match it. */
export function parseCiPreview(template: string | null, identifier: string | null): CiPreview | null {
  if (!template || !identifier || identifier.length > 200) return null;
  let groups: Record<string, string | undefined> | undefined;
  try { groups = compileTemplate(template).exec(identifier)?.groups; } catch { return null; }
  const number = (value: string | undefined) => (value !== undefined ? Number(value) : null);
  const pr = number(groups?.pr);
  return pr === null ? null : { pr, run: number(groups?.run), shard: number(groups?.shard), attempt: number(groups?.attempt) };
}

export interface CiEntry extends CiPreview { /** Last deploy (or creation) time in ms. */ at: number }

/**
 * Whether `newer` replaces `older`: same pull request and same shard, and a later run (or a later attempt of the same run). Without run numbers, a later
 * attempt replaces. Previews that cannot be ordered this way (numbered next to unnumbered, no attempt numbers) are never compared, and a shard that was
 * not re-run is never replaced by another shard.
 */
export function supersedes(newer: CiEntry, older: CiEntry): boolean {
  if (newer.pr !== older.pr || newer.shard !== older.shard) return false;
  if (newer.run !== null && older.run !== null) return newer.run > older.run || (newer.run === older.run && (newer.attempt ?? 0) > (older.attempt ?? 0));
  if (newer.run === null && older.run === null && newer.attempt !== null && older.attempt !== null) return newer.attempt > older.attempt;
  return false;
}
