import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ATTENTION_SOURCE_KINDS, type AttentionItem, type AttentionSourceKind } from "@paperclipai/shared";
import { belongsOnAttentionTab, DecisionBundleHeader } from "./InboxAttentionTab";

function itemOfKind(sourceKind: AttentionSourceKind): AttentionItem {
  return { id: sourceKind, sourceKind } as AttentionItem;
}

describe("Inbox attention tabs", () => {
  it("puts every source kind on exactly one of Decide and Alerts", () => {
    for (const kind of ATTENTION_SOURCE_KINDS) {
      const onDecide = belongsOnAttentionTab(itemOfKind(kind), "decide", null);
      const onAlerts = belongsOnAttentionTab(itemOfKind(kind), "alerts", null);
      expect(onDecide !== onAlerts).toBe(true);
    }
  });

  it("lists verdicts on Decide and stuck work on Alerts", () => {
    for (const kind of ["approval", "decision", "issue_thread_interaction", "join_request", "review"] as const) {
      expect(belongsOnAttentionTab(itemOfKind(kind), "decide", null)).toBe(true);
    }
    for (const kind of ["failed_run", "agent_error_alert", "blocker_attention", "recovery_action", "budget_alert"] as const) {
      expect(belongsOnAttentionTab(itemOfKind(kind), "alerts", null)).toBe(true);
    }
  });

  it("keeps every item of a queue on its Decide view", () => {
    expect(belongsOnAttentionTab(itemOfKind("failed_run"), "decide", "triage")).toBe(true);
  });

  it("labels general bundles as decisions instead of cleanups", () => {
    const single = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose a route" originIssue={null} count={1} />,
    );
    const multiple = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose routes" originIssue={null} count={2} />,
    );

    expect(single).toContain("Planner proposed 1 decision");
    expect(multiple).toContain("Planner proposed 2 decisions");
    expect(single).not.toContain("cleanup");
    expect(multiple).not.toContain("cleanup");
  });
});
