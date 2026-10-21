import { describe, expect, it, vi } from "vitest";
import { buildPolicyMentionHref, buildRoutineMentionHref } from "@paperclipai/shared";
import { mentionChipInlineStyle, parseMentionChipHref } from "./mention-chips";

const getAgentIcon = vi.hoisted(() => vi.fn());
vi.mock("./agent-icons", () => ({ getAgentIcon }));

describe("agent mention icon compatibility", () => {
  const node = [["path", { d: "m16 18 6-6-6-6", key: "code" }]];

  it.each([
    ["static", { iconNode: node }],
    ["legacy", { render: () => ({ props: { iconNode: node } }) }],
    ["icon-data", { render: () => ({ props: { icon: { name: "code", size: 24, node } } }) }],
  ])("renders an agent mention mask from Lucide's %s format", (name, icon) => {
    getAgentIcon.mockReturnValue(icon);
    const style = mentionChipInlineStyle({ kind: "agent", agentId: "agent", icon: name });
    const mask = (style as Record<string, string>)["--paperclip-mention-icon-mask"];
    expect(decodeURIComponent(mask)).toContain('<path d="m16 18 6-6-6-6"></path>');
  });
});

describe("policy and routine mention chips", () => {
  it("parses a policy mention into a policy chip keyed by the policy key", () => {
    expect(parseMentionChipHref(buildPolicyMentionHref("never-ship-on-friday"))).toEqual({
      kind: "policy",
      policyKey: "never-ship-on-friday",
    });
  });

  it("reads a policy key written with capitals as its lowercase form", () => {
    expect(parseMentionChipHref("policy://Never-Ship")).toEqual({ kind: "policy", policyKey: "never-ship" });
  });

  it.each(["policy://", "policy://has space", "policy://a/b", "policy://bad!key"])(
    "does not turn the malformed policy mention %s into a chip",
    (href) => {
      expect(parseMentionChipHref(href)).toBeNull();
    },
  );

  it("keeps routine mentions as routine chips", () => {
    expect(parseMentionChipHref(buildRoutineMentionHref("routine-123"))).toEqual({
      kind: "routine",
      routineId: "routine-123",
    });
  });

  it("adds no inline style for a policy chip", () => {
    expect(mentionChipInlineStyle({ kind: "policy", policyKey: "never-ship" })).toBeUndefined();
  });
});
