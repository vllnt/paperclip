// Text rendering of GET /api/issues/:id/triage for `issue triage`.
import type { IssueTriage } from "@paperclipai/shared";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function topProbabilities(
  probabilities: Record<string, number> | null,
  label: (key: string) => string,
  limit = 3,
): string {
  if (!probabilities) return "n/a";
  const ranked = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${label(key)} ${percent(value)}`);
  return ranked.length > 0 ? ranked.join(", ") : "n/a";
}

/** One readable block per recorded triage, newest first. Agent names come from the record itself. */
export function formatIssueTriage(items: readonly IssueTriage[]): string[] {
  if (items.length === 0) return ["(no triage recorded for this issue)"];
  return items.flatMap((triage, index) => {
    const lines = [
      `${index === 0 ? "" : "\n"}${triage.createdAt}  ${triage.outcome}${triage.reason ? ` (${triage.reason})` : ""}  mode=${triage.mode}`,
      `  model: ${triage.modelId ?? "none"}  calls: ${triage.modelCalls}`,
    ];
    if (triage.priority) {
      const { current, suggested, probabilities } = triage.priority;
      lines.push(
        suggested
          ? `  priority: suggested ${suggested} (now ${current})  [${topProbabilities(probabilities, (key) => key)}]`
          : `  priority: kept ${current}`,
      );
    }
    if (triage.category) {
      lines.push(
        `  category: ${triage.category.suggested ?? "none"}  [${topProbabilities(triage.category.probabilities, (key) => key)}]`,
      );
    }
    if (triage.owner) {
      const { owner } = triage;
      const name = (key: string) => (key === owner.suggestedAgentId ? (owner.suggestedAgentName ?? key) : key);
      lines.push(
        `  owner: ${owner.suggestedAgentName ?? owner.suggestedAgentId ?? "none"}  ` +
          `top ${owner.topProbability === null ? "n/a" : percent(owner.topProbability)}, ` +
          `margin ${owner.margin === null ? "n/a" : percent(owner.margin)}, ` +
          `${owner.candidateCount} candidates`,
        `  owner decision: ${owner.decision}${owner.appliedAgentId ? ` (assigned ${owner.suggestedAgentName ?? owner.appliedAgentId})` : ""}  ` +
          `[${topProbabilities(owner.probabilities, name)}]`,
      );
    }
    lines.push(
      `  thresholds: owner >= ${percent(triage.thresholds.ownerMinProbability)}, margin >= ${percent(triage.thresholds.ownerMinMargin)}`,
    );
    return lines;
  });
}
