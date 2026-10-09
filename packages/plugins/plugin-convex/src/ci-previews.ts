/**
 * Preview identifiers made by CI carry the pull request and often the run, shard and attempt (for example `pr4320-run101-s2-a1`).
 * The company supplies a regular expression with a named group `pr` and optional `run`, `shard` and `attempt` groups.
 */
export interface CiPreview { pr: number; run: number | null; attempt: number }

const compiled = new Map<string, RegExp>();
export function compilePattern(source: string): RegExp {
  let pattern = compiled.get(source);
  if (!pattern) { pattern = new RegExp(source); compiled.set(source, pattern); }
  return pattern;
}

/** The pull request (and run) a preview identifier belongs to, or null when no pattern is set or the identifier does not match. */
export function parseCiPreview(source: string | null, identifier: string | null): CiPreview | null {
  if (!source || !identifier || identifier.length > 200) return null;
  const groups = compilePattern(source).exec(identifier)?.groups;
  const number = (value: string | undefined) => (value !== undefined && /^[0-9]{1,15}$/.test(value) ? Number(value) : null);
  const pr = number(groups?.pr);
  return pr === null ? null : { pr, run: number(groups?.run), attempt: number(groups?.attempt) ?? 0 };
}
