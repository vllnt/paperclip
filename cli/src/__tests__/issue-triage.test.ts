import { describe, expect, it } from "vitest";
import type { IssueTriage } from "@paperclipai/shared";
import { formatIssueTriage } from "../commands/client/issue-triage.js";

function triage(overrides: Partial<IssueTriage> = {}): IssueTriage {
  return {
    id: "t1",
    issueId: "i1",
    companyId: "c1",
    createdAt: "2026-10-21T10:00:00.000Z",
    version: 1,
    mode: "apply",
    outcome: "applied",
    reason: null,
    modelId: "typesafe-ai/jev",
    modelCalls: 1,
    inputHashes: ["h"],
    thresholds: { ownerMinProbability: 0.8, ownerMinMargin: 0.2 },
    priority: { current: "medium", suggested: "high", probabilities: { high: 0.7, medium: 0.3 } },
    category: { suggested: "bug", probabilities: { bug: 0.9, feature: 0.1 } },
    owner: {
      suggestedAgentId: "agent-1",
      suggestedAgentName: "Amy",
      probabilities: { "agent-1": 0.9, "agent-2": 0.06, none: 0.04 },
      topProbability: 0.9,
      margin: 0.84,
      decision: "applied",
      appliedAgentId: "agent-1",
      candidateCount: 2,
    },
    ...overrides,
  };
}

describe("formatIssueTriage", () => {
  it("says so when nothing is recorded", () => {
    expect(formatIssueTriage([])).toEqual(["(no triage recorded for this issue)"]);
  });

  it("shows the model, probabilities, suggested owner and the apply decision", () => {
    const text = formatIssueTriage([triage()]).join("\n");
    expect(text).toContain("applied  mode=apply");
    expect(text).toContain("model: typesafe-ai/jev  calls: 1");
    expect(text).toContain("priority: suggested high (now medium)  [high 70%, medium 30%]");
    expect(text).toContain("category: bug  [bug 90%, feature 10%]");
    expect(text).toContain("owner: Amy  top 90%, margin 84%, 2 candidates");
    expect(text).toContain("owner decision: applied (assigned Amy)  [Amy 90%, agent-2 6%, none 4%]");
    expect(text).toContain("thresholds: owner >= 80%, margin >= 20%");
  });

  it("shows why a triage was skipped or degraded", () => {
    const skipped = formatIssueTriage([
      triage({ outcome: "skipped", reason: "short_title", modelId: null, modelCalls: 0, priority: null, category: null, owner: null }),
    ]).join("\n");
    expect(skipped).toContain("skipped (short_title)");
    expect(skipped).toContain("model: none  calls: 0");
    const degraded = formatIssueTriage([
      triage({ outcome: "degraded", reason: "cap_exceeded", priority: null, category: null, owner: null }),
    ]).join("\n");
    expect(degraded).toContain("degraded (cap_exceeded)");
  });

  it("keeps an explicit priority and an unknown owner readable", () => {
    const text = formatIssueTriage([
      triage({
        outcome: "suggested",
        priority: { current: "high", suggested: null, probabilities: null },
        owner: {
          suggestedAgentId: null,
          suggestedAgentName: null,
          probabilities: null,
          topProbability: null,
          margin: null,
          decision: "no_owner_suggested",
          appliedAgentId: null,
          candidateCount: 3,
        },
      }),
    ]).join("\n");
    expect(text).toContain("priority: kept high");
    expect(text).toContain("owner: none  top n/a, margin n/a, 3 candidates");
    expect(text).toContain("owner decision: no_owner_suggested  [n/a]");
  });

  it("separates several records with a blank line, newest first", () => {
    const lines = formatIssueTriage([triage(), triage({ createdAt: "2026-10-20T10:00:00.000Z" })]);
    expect(lines.some((line) => line.startsWith("\n2026-10-20"))).toBe(true);
  });
});
