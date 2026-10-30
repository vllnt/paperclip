import {
  POLICY_INDEX_MAX_MENTIONS,
  capPolicyIndexEntries,
  type PolicyIndexEntry,
} from "@paperclipai/shared";

/** One policy as the index query returns it. The title comes from the policy's document. */
export interface PolicyIndexRow {
  key: string;
  title: string;
  summary: string | null;
  /** Null for a company policy. */
  projectId: string | null;
  status: "draft" | "active" | "archived";
}

export interface PolicyIndexRows {
  rows: PolicyIndexRow[];
  /** Every row the query matched, including those past its limit. */
  totalMatching: number;
}

/**
 * Merges the `policy://` keys found in each source, in source order, without duplicates. Mentions come
 * from low-trust text, so the merge stops at the mention cap.
 */
export function mergeMentionedKeys(
  keyLists: ReadonlyArray<readonly string[]>,
  max = POLICY_INDEX_MAX_MENTIONS,
): string[] {
  const merged = new Set<string>();
  for (const keys of keyLists) {
    for (const key of keys) {
      if (merged.size >= max) return [...merged];
      merged.add(key);
    }
  }
  return [...merged];
}

function isBaseline(row: PolicyIndexRow, projectId: string | null): boolean {
  return row.status === "active" && (row.projectId === null || row.projectId === projectId);
}

function activeEntry(row: PolicyIndexRow, via: "scope" | "mention"): PolicyIndexEntry {
  return {
    state: "active",
    key: row.key,
    title: row.title,
    summary: row.summary,
    scope: row.projectId === null ? "company" : "project",
    via,
  };
}

/**
 * The policies that apply to a task, in display order:
 * 1. the company's active policies, then the task project's active policies, each list starting with
 *    the policies the task text mentions;
 * 2. active policies only the task text mentions, in mention order;
 * 3. mentioned keys that are a draft, archived or unknown, in mention order. A mention is never
 *    dropped silently, and a draft or archived policy shows no title.
 * The result is capped by entries and characters; the cap counts what it leaves out.
 */
export function buildPolicyIndexEntries(input: {
  result: PolicyIndexRows;
  projectId: string | null;
  mentionedKeys: readonly string[];
}): { entries: PolicyIndexEntry[]; moreCount: number } {
  const { result, projectId, mentionedKeys } = input;
  const byKey = new Map(result.rows.map((row) => [row.key, row]));

  const mentioned = new Set(mentionedKeys);
  // A mentioned policy that also applies by scope still leads its list, so the cap cannot cut what the task points at.
  const baseline = result.rows
    .filter((row) => isBaseline(row, projectId))
    .sort(
      (a, b) =>
        Number(!mentioned.has(a.key)) - Number(!mentioned.has(b.key)) ||
        Number(a.projectId !== null) - Number(b.projectId !== null) ||
        a.title.localeCompare(b.title) ||
        a.key.localeCompare(b.key),
    );
  const baselineKeys = new Set(baseline.map((row) => row.key));

  const entries: PolicyIndexEntry[] = baseline.map((row) => activeEntry(row, "scope"));
  const notActive: PolicyIndexEntry[] = [];
  for (const key of mentionedKeys) {
    if (baselineKeys.has(key)) continue;
    const row = byKey.get(key);
    if (row && row.status === "active") entries.push(activeEntry(row, "mention"));
    else notActive.push({ state: "not_active", key });
  }

  // Rows past the query limit were all baseline policies: the query reads mentioned rows first.
  const omitted = Math.max(0, result.totalMatching - result.rows.length);
  return capPolicyIndexEntries([...entries, ...notActive], omitted);
}

/** The exact text the digest covers: what the agent is shown, and nothing else. */
export function policyIndexDigestInput(entries: readonly PolicyIndexEntry[], moreCount: number): string {
  return JSON.stringify({ entries, moreCount });
}
