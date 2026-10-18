/**
 * Tier-1 ranking for the board's command launcher: local, synchronous and
 * pure, so it can run on every keystroke and be tested without a browser.
 */

/** The fields of a launcher action that ranking reads. */
export interface RankableCommandAction {
  id: string;
  title: string;
  keywords: readonly string[];
}

/** How often and how recently the current user ran an action. */
export interface CommandActionUsage {
  count: number;
  lastUsedAt: number;
}

export interface RankedCommandAction<A extends RankableCommandAction> {
  action: A;
  score: number;
}

export interface RankCommandActionsInput<A extends RankableCommandAction> {
  query: string;
  /** Actions the actor may run, in catalog order (the tie-break order). */
  actions: readonly A[];
  /** Ids of the actions the current page registered (its contextual actions). */
  contextualIds: ReadonlySet<string>;
  usage: Readonly<Record<string, CommandActionUsage>>;
  now: number;
}

/** Boost for an action that the current page registered. */
export const CONTEXTUAL_BOOST = 250;
/** Frecency points per doubling of the use count, before decay. */
export const FRECENCY_WEIGHT = 50;
/**
 * Frecency ceiling. A keyword match (400) plus this stays below the lowest
 * title-prefix score (700), so usage reorders matches of the same strength
 * but never lifts a weak match over a strong one.
 */
export const FRECENCY_MAX = 250;
export const FRECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Most actions kept in a usage record; the least recently used go first. */
export const COMMAND_ACTION_USAGE_LIMIT = 200;

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Scores `primary` (a name or title) and `secondary` (a description or
 * keywords) against `query`, ignoring case. Higher is better; `null` means no
 * match, and an empty query never matches.
 *
 * Bands: exact 1000, prefix 700-900 (shorter names first), substring below
 * 700 (earlier first), secondary text 400, in-order subsequence of the
 * primary text 200.
 *
 * @example scoreTextMatch("Dashboard", "home overview", "dash") // 891
 */
export function scoreTextMatch(primary: string, secondary: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return null;
  const name = primary.toLowerCase();
  if (name === q) return 1000;
  // Clamp the length penalty so a prefix match never sinks into the
  // substring band, which tops out at 699.
  if (name.startsWith(q)) return Math.max(700, 900 - name.length);
  const nameIdx = name.indexOf(q);
  if (nameIdx >= 0) return 700 - nameIdx;
  if (secondary.toLowerCase().includes(q)) return 400;
  if (isSubsequence(q, name)) return 200;
  return null;
}

function frecencyScore(usage: CommandActionUsage | undefined, now: number): number {
  if (!usage || usage.count <= 0) return 0;
  const undecayed = Math.min(FRECENCY_MAX, FRECENCY_WEIGHT * Math.log2(1 + usage.count));
  const ageMs = Math.max(0, now - usage.lastUsedAt);
  return undecayed * 0.5 ** (ageMs / FRECENCY_HALF_LIFE_MS);
}

/**
 * Ranks launcher actions for a query: text match, plus a boost for the
 * current page's contextual actions, plus decayed frecency. With an empty query every action is
 * kept. Ties keep catalog order.
 *
 * @returns the matching actions, best first
 */
export function rankCommandActions<A extends RankableCommandAction>(
  input: RankCommandActionsInput<A>,
): RankedCommandAction<A>[] {
  const hasQuery = input.query.trim().length > 0;
  const ranked: Array<RankedCommandAction<A> & { index: number }> = [];
  input.actions.forEach((action, index) => {
    const match = hasQuery ? scoreTextMatch(action.title, action.keywords.join(" "), input.query) : 0;
    if (match === null) return;
    const contextualBoost = input.contextualIds.has(action.id) ? CONTEXTUAL_BOOST : 0;
    const score = match + contextualBoost + frecencyScore(input.usage[action.id], input.now);
    ranked.push({ action, score, index });
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.map(({ action, score }) => ({ action, score }));
}

/**
 * Returns a new usage record with one more use of `actionId` at `now`,
 * keeping at most `limit` actions (the least recently used are dropped).
 */
export function recordCommandActionUse(
  usage: Readonly<Record<string, CommandActionUsage>>,
  actionId: string,
  now: number,
  limit: number = COMMAND_ACTION_USAGE_LIMIT,
): Record<string, CommandActionUsage> {
  const next: Record<string, CommandActionUsage> = {
    ...usage,
    [actionId]: { count: (usage[actionId]?.count ?? 0) + 1, lastUsedAt: now },
  };
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  return Object.fromEntries(
    entries.sort(([, left], [, right]) => right.lastUsedAt - left.lastUsedAt).slice(0, limit),
  );
}
