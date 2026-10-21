import { TRIAGE_MAX_MODEL_CALLS, TRIAGE_OWNER_PAGE_SIZE } from "./constants.js";
import type { TriageCandidateAgent, TriageCandidateGroup } from "./types.js";

const MIN_TOKEN_CHARS = 3;

function tokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length >= MIN_TOKEN_CHARS) result.add(word);
  }
  return result;
}

function groupId(agent: TriageCandidateAgent): string {
  return `${agent.role.trim().toLowerCase()}\u0000${(agent.title ?? "").trim().toLowerCase()}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Groups look-alike agents and orders the groups for the model.
 *
 * Agents with the same role and title are one option, because the model sees only role and title and
 * could not tell them apart. The group resolves to its least loaded agent (then the lowest id). Groups
 * rank by how many words of the issue text appear in their role and title, then by label, so the most
 * relevant groups land on the first page. Beyond the page budget the tail is dropped: the number of
 * model calls stays bounded.
 *
 * @param agents - Active candidates of one company; the caller has already excluded paused and terminated ones.
 * @param issueText - The prepared issue text.
 * @returns Groups in ranked order, each with a stable option key (`a1`, `a2`, ...).
 */
export function groupCandidates(
  agents: readonly TriageCandidateAgent[],
  issueText: { title: string; description: string },
): TriageCandidateGroup[] {
  const issueTokens = tokens(`${issueText.title} ${issueText.description}`);
  const byId = new Map<string, TriageCandidateAgent[]>();
  for (const agent of agents) {
    const id = groupId(agent);
    const members = byId.get(id);
    if (members) members.push(agent);
    else byId.set(id, [agent]);
  }

  const ranked = [...byId.values()].map((members) => {
    const representative = [...members].sort(
      (a, b) => a.openIssues - b.openIssues || compareText(a.id, b.id),
    )[0] as TriageCandidateAgent;
    let overlap = 0;
    for (const token of tokens(`${representative.role} ${representative.title ?? ""}`)) {
      if (issueTokens.has(token)) overlap += 1;
    }
    return { representative, size: members.length, overlap };
  });
  ranked.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      compareText(a.representative.role, b.representative.role) ||
      compareText(a.representative.title ?? "", b.representative.title ?? "") ||
      compareText(a.representative.id, b.representative.id),
  );

  return ranked.slice(0, TRIAGE_OWNER_PAGE_SIZE * TRIAGE_MAX_MODEL_CALLS).map((entry, index) => ({
    key: `a${index + 1}`,
    role: entry.representative.role,
    title: entry.representative.title,
    agentId: entry.representative.id,
    size: entry.size,
  }));
}

/** Splits ranked groups into the pages that each become one model call. */
export function pageGroups(groups: readonly TriageCandidateGroup[]): TriageCandidateGroup[][] {
  const pages: TriageCandidateGroup[][] = [];
  for (let start = 0; start < groups.length; start += TRIAGE_OWNER_PAGE_SIZE) {
    pages.push(groups.slice(start, start + TRIAGE_OWNER_PAGE_SIZE));
  }
  return pages;
}
