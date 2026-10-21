import {
  ISSUE_PRIORITIES,
  ISSUE_TRIAGE_CATEGORIES,
  type IssuePriority,
  type IssueTriageCategory,
  type IssueTriageOwnerOption,
} from "@paperclipai/shared";
import {
  TRIAGE_NO_OWNER_KEY,
  TRIAGE_OWNER_MIN_MARGIN,
  TRIAGE_OWNER_MIN_PROBABILITY,
  TRIAGE_PROBABILITY_EPSILON,
} from "./constants.js";
import type { TriageChoiceAnswer, TriageOwnerDecision, TriageOwnerPage } from "./types.js";

/**
 * Keeps the probabilities of known options only, as finite numbers in [0, 1].
 * @returns Null when the model gave none for any known option.
 */
export function readProbabilities(
  allowed: readonly string[],
  raw: Readonly<Record<string, number>> | null,
): Record<string, number> | null {
  if (!raw) return null;
  const result: Record<string, number> = {};
  for (const key of allowed) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.min(1, Math.max(0, value));
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** The most probable key; the first one wins a tie, so the order of `allowed` is the tie-break. */
function argmax(allowed: readonly string[], probabilities: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  for (const key of allowed) {
    const value = probabilities[key];
    if (value === undefined) continue;
    if (best === null || value > (probabilities[best] ?? -1)) best = key;
  }
  return best;
}

export interface ReadChoice<T extends string> {
  value: T | null;
  probabilities: Partial<Record<T, number>> | undefined;
}

/**
 * Reads a closed-set answer. The model's own pick wins when it is a known option; otherwise the most
 * probable option does. An answer with neither gives null.
 */
export function readClosedChoice<T extends string>(
  allowed: readonly T[],
  answer: TriageChoiceAnswer | undefined,
): ReadChoice<T> {
  if (!answer) return { value: null, probabilities: undefined };
  const probabilities = readProbabilities(allowed, answer.probabilities);
  const picked = allowed.find((key) => key === answer.choice) ?? null;
  const value = picked ?? (probabilities ? (argmax(allowed, probabilities) as T | null) : null);
  return { value, probabilities: probabilities ? (probabilities as Partial<Record<T, number>>) : undefined };
}

export function readPriority(answer: TriageChoiceAnswer | undefined): ReadChoice<IssuePriority> {
  return readClosedChoice<IssuePriority>(ISSUE_PRIORITIES, answer);
}

export function readCategory(answer: TriageChoiceAnswer | undefined): ReadChoice<IssueTriageCategory> {
  return readClosedChoice<IssueTriageCategory>(ISSUE_TRIAGE_CATEGORIES, answer);
}

/**
 * Turns the answers for all owner pages into one suggestion and says whether it may be applied.
 *
 * A page is one model call over up to ten groups plus a "none" option, so its probabilities sum to
 * about one within the page only. The best group over all pages is the top. The next option is the
 * best other group on any page, or the "none" option of the top's own page: another page's "none"
 * only says that page had no fit. The suggestion may be applied only when the top is not out-ranked
 * by its own "none", reaches `TRIAGE_OWNER_MIN_PROBABILITY` and leads the next option by at least
 * `TRIAGE_OWNER_MIN_MARGIN`. Without probabilities nothing is ever applied.
 */
export function decideOwner(pages: readonly TriageOwnerPage[]): TriageOwnerDecision {
  const options: IssueTriageOwnerOption[] = [];
  const scored: Array<{ page: number; agentId: string; probability: number }> = [];
  const noneByPage: Array<number | null> = [];
  let complete = true;

  pages.forEach((page, pageIndex) => {
    const keys = [...page.groups.map((group) => group.key), TRIAGE_NO_OWNER_KEY];
    const probabilities = readProbabilities(keys, page.answer.probabilities);
    if (!probabilities) complete = false;
    noneByPage.push(probabilities?.[TRIAGE_NO_OWNER_KEY] ?? null);
    for (const group of page.groups) {
      const probability = probabilities?.[group.key] ?? null;
      options.push({
        agentId: group.agentId,
        role: group.role,
        title: group.title,
        probability,
        groupSize: group.size,
      });
      if (probability !== null) scored.push({ page: pageIndex, agentId: group.agentId, probability });
    }
    options.push({
      agentId: null,
      role: TRIAGE_NO_OWNER_KEY,
      title: null,
      probability: probabilities?.[TRIAGE_NO_OWNER_KEY] ?? null,
      groupSize: 0,
    });
  });

  if (!complete) {
    const only = pages.length === 1 ? pages[0] : undefined;
    const picked = only?.groups.find((group) => group.key === only.answer.choice);
    return { suggestedAgentId: picked?.agentId ?? null, options, blockedBy: "no_probabilities" };
  }

  let top: (typeof scored)[number] | undefined;
  for (const entry of scored) if (!top || entry.probability > top.probability) top = entry;
  if (!top) return { suggestedAgentId: null, options, blockedBy: "no_suggestion" };

  const noneOwn = noneByPage[top.page] ?? 0;
  if (top.probability <= noneOwn) return { suggestedAgentId: null, options, blockedBy: "none_preferred" };

  let next = noneOwn;
  for (const entry of scored) {
    if (entry !== top && entry.probability > next) next = entry.probability;
  }
  const blockedBy =
    top.probability < TRIAGE_OWNER_MIN_PROBABILITY - TRIAGE_PROBABILITY_EPSILON
      ? "below_threshold"
      : top.probability - next < TRIAGE_OWNER_MIN_MARGIN - TRIAGE_PROBABILITY_EPSILON
        ? "narrow_margin"
        : null;
  return { suggestedAgentId: top.agentId, options, blockedBy };
}
