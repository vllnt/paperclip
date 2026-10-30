import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildPolicyMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractPolicyMentionKeys,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractSkillMentionIds,
  extractUserMentionIds,
  parseAgentMentionHref,
  parsePolicyMentionHref,
  parseProjectMentionHref,
  parseRoutineMentionHref,
  parseSkillMentionHref,
  parseUserMentionHref,
} from "./project-mentions.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Paperclip App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
  });

  it("round-trips user mentions", () => {
    const href = buildUserMentionHref("user-123");
    expect(parseUserMentionHref(href)).toEqual({
      userId: "user-123",
    });
    expect(extractUserMentionIds(`[@Taylor](${href})`)).toEqual(["user-123"]);
  });

  it("round-trips skill mentions with slug metadata", () => {
    const href = buildSkillMentionHref("skill-123", "release-changelog");
    expect(parseSkillMentionHref(href)).toEqual({
      skillId: "skill-123",
      slug: "release-changelog",
    });
    expect(extractSkillMentionIds(`[/release-changelog](${href})`)).toEqual(["skill-123"]);
  });

  it("round-trips routine mentions", () => {
    const href = buildRoutineMentionHref("routine-123");
    expect(parseRoutineMentionHref(href)).toEqual({
      routineId: "routine-123",
    });
    expect(extractRoutineMentionIds(`[/routine:Weekly review](${href})`)).toEqual(["routine-123"]);
  });

  it("round-trips policy mentions", () => {
    const href = buildPolicyMentionHref("code-review");
    expect(href).toBe("policy://code-review");
    expect(parsePolicyMentionHref(href)).toEqual({ key: "code-review" });
    expect(extractPolicyMentionKeys(`[/policy:Code review](${href})`)).toEqual(["code-review"]);
  });

  it("lowercases a policy key and rejects a malformed one", () => {
    expect(parsePolicyMentionHref("policy://Code-Review")).toEqual({ key: "code-review" });
    expect(parsePolicyMentionHref("policy://a1")).toEqual({ key: "a1" });
    for (const href of [
      "policy://",
      "policy://-leading-dash",
      "policy://has space",
      "policy://under_score",
      "policy://a/b",
      "policy://dotted.key",
      "policy://%20",
      `policy://${"a".repeat(65)}`,
      "skill://code-review",
      "code-review",
    ]) {
      expect(parsePolicyMentionHref(href), href).toBeNull();
    }
    expect(parsePolicyMentionHref(`policy://${"a".repeat(64)}`)).toEqual({ key: "a".repeat(64) });
  });

  it("extracts each policy key once, in order, and skips invalid ones", () => {
    const markdown = [
      "[a](policy://first)",
      "[b](policy://second) and [again](policy://first)",
      "[bad](policy://-nope) [also bad](policy://has_underscore)",
      "[skill](skill://not-a-policy) policy://bare-text-is-not-a-link",
      "[Upper](policy://FIRST)",
    ].join("\n");
    expect(extractPolicyMentionKeys(markdown)).toEqual(["first", "second"]);
    expect(extractPolicyMentionKeys("")).toEqual([]);
  });
});
