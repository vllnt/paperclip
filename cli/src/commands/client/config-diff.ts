// Client-side diff of an agent config revision. The server returns redacted
// `beforeConfig`/`afterConfig` snapshots, so a secret that changed shows the
// same redaction marker on both sides. The server-computed `changedKeys`
// (taken before redaction) stays authoritative; keys it lists with no visible
// leaf change are reported as `redactedOnlyKeys`.

export interface ConfigLeafChange {
  path: string;
  kind: "added" | "removed" | "changed";
  /** `null` when the leaf is absent before (kind "added"). */
  before: unknown;
  /** `null` when the leaf is absent after (kind "removed"). */
  after: unknown;
}

export interface ConfigRevisionDiff {
  changedKeys: string[];
  changes: ConfigLeafChange[];
  redactedOnlyKeys: string[];
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinPath(parent: string, key: string): string {
  if (!IDENTIFIER_RE.test(key)) return `${parent}[${JSON.stringify(key)}]`;
  return parent ? `${parent}.${key}` : key;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]));
  }
  return false;
}

/**
 * Lists changed leaves between two JSON values. Objects are walked key by key;
 * arrays and scalars are compared as whole values. Output is sorted by path.
 */
export function diffConfigLeaves(before: unknown, after: unknown): ConfigLeafChange[] {
  const changes: ConfigLeafChange[] = [];

  function walk(path: string, left: unknown, right: unknown, hasLeft: boolean, hasRight: boolean) {
    if (hasLeft && hasRight && isPlainObject(left) && isPlainObject(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        walk(joinPath(path, key), left[key], right[key], key in left, key in right);
      }
      return;
    }
    if (hasLeft && hasRight && deepEqual(left, right)) return;
    changes.push({
      path,
      kind: !hasLeft ? "added" : !hasRight ? "removed" : "changed",
      before: hasLeft ? left ?? null : null,
      after: hasRight ? right ?? null : null,
    });
  }

  walk("", before, after, true, true);
  return changes
    .filter((change) => change.path !== "")
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function topLevelKey(path: string): string {
  const match = /^[^.[]+/.exec(path);
  if (match) return match[0];
  const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(path);
  return quoted ? (JSON.parse(quoted[1]!) as string) : path;
}

export function diffConfigRevision(revision: {
  changedKeys?: unknown;
  beforeConfig?: unknown;
  afterConfig?: unknown;
}): ConfigRevisionDiff {
  const before = isPlainObject(revision.beforeConfig) ? revision.beforeConfig : {};
  const after = isPlainObject(revision.afterConfig) ? revision.afterConfig : {};
  const changes = diffConfigLeaves(before, after);
  const visibleKeys = [...new Set(changes.map((change) => topLevelKey(change.path)))];
  const recordedKeys = Array.isArray(revision.changedKeys)
    ? revision.changedKeys.filter((key): key is string => typeof key === "string")
    : null;
  const changedKeys = recordedKeys && recordedKeys.length > 0 ? recordedKeys : visibleKeys;
  const visible = new Set(visibleKeys);
  return {
    changedKeys,
    changes,
    redactedOnlyKeys: changedKeys.filter((key) => !visible.has(key)),
  };
}

function formatValue(value: unknown, present: boolean): string {
  if (!present) return "(unset)";
  return JSON.stringify(value) ?? "null";
}

/** Human-readable lines: `path: before -> after`. */
export function formatConfigRevisionDiff(diff: ConfigRevisionDiff): string[] {
  if (diff.changes.length === 0 && diff.redactedOnlyKeys.length === 0) {
    return ["(no changes)"];
  }
  const lines = diff.changes.map(
    (change) =>
      `${change.path}: ${formatValue(change.before, change.kind !== "added")} -> ${formatValue(change.after, change.kind !== "removed")}`,
  );
  for (const key of diff.redactedOnlyKeys) {
    lines.push(`${key}: changed (values redacted)`);
  }
  return lines;
}
