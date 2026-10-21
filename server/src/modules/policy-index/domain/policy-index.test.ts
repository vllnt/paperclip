import { describe, expect, it } from "vitest";
import { POLICY_INDEX_MAX_ACTIVE_ENTRIES, POLICY_INDEX_MAX_MENTIONS } from "@paperclipai/shared";
import { buildPolicyIndexEntries, mergeMentionedKeys, policyIndexDigestInput, type PolicyIndexRow } from "./policy-index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

function row(key: string, overrides: Partial<PolicyIndexRow> = {}): PolicyIndexRow {
  return { key, title: `Title ${key}`, summary: `Summary ${key}`, projectId: null, status: "active", ...overrides };
}

describe("mergeMentionedKeys", () => {
  it("keeps source order and drops duplicates", () => {
    expect(mergeMentionedKeys([["b", "a"], ["a", "c"], []])).toEqual(["b", "a", "c"]);
  });

  it("stops at the mention cap", () => {
    const many = Array.from({ length: 50 }, (_, index) => `key-${index}`);
    const merged = mergeMentionedKeys([many.slice(0, 5), many.slice(5)]);
    expect(merged).toHaveLength(POLICY_INDEX_MAX_MENTIONS);
    expect(merged.slice(0, 5)).toEqual(many.slice(0, 5));
  });
});

describe("buildPolicyIndexEntries", () => {
  it("lists company policies, then the task project's, and skips other projects' policies", () => {
    const { entries, moreCount } = buildPolicyIndexEntries({
      result: {
        rows: [
          row("project-rule", { projectId: PROJECT, title: "A project rule" }),
          row("company-b", { title: "B company" }),
          row("company-a", { title: "A company" }),
          row("elsewhere", { projectId: OTHER_PROJECT }),
          row("a-draft", { status: "draft" }),
          row("an-archive", { status: "archived" }),
        ],
        totalMatching: 6,
      },
      projectId: PROJECT,
      mentionedKeys: [],
    });
    expect(entries.map((entry) => entry.key)).toEqual(["company-a", "company-b", "project-rule"]);
    expect(entries.map((entry) => entry.state === "active" && entry.scope)).toEqual(["company", "company", "project"]);
    expect(entries.every((entry) => entry.state === "active" && entry.via === "scope")).toBe(true);
    expect(moreCount).toBe(0);
  });

  it("applies only company policies to a task with no project", () => {
    const { entries } = buildPolicyIndexEntries({
      result: { rows: [row("company-a"), row("project-rule", { projectId: PROJECT })], totalMatching: 2 },
      projectId: null,
      mentionedKeys: [],
    });
    expect(entries.map((entry) => entry.key)).toEqual(["company-a"]);
  });

  it("adds a mentioned active policy of another project once, marked as mentioned", () => {
    const { entries } = buildPolicyIndexEntries({
      result: { rows: [row("elsewhere", { projectId: OTHER_PROJECT }), row("company-a")], totalMatching: 2 },
      projectId: PROJECT,
      mentionedKeys: ["elsewhere", "company-a"],
    });
    expect(entries).toEqual([
      expect.objectContaining({ key: "company-a", via: "scope" }),
      expect.objectContaining({ key: "elsewhere", via: "mention", scope: "project" }),
    ]);
  });

  it("keeps a mentioned policy that applies by scope inside the cap, labelled by its scope", () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(`policy-${String(index).padStart(2, "0")}`));
    const { entries, moreCount } = buildPolicyIndexEntries({ result: { rows, totalMatching: 50 }, projectId: null, mentionedKeys: ["policy-49"] });
    expect(entries).toHaveLength(POLICY_INDEX_MAX_ACTIVE_ENTRIES);
    expect(entries[0]).toEqual(expect.objectContaining({ key: "policy-49", via: "scope", scope: "company" }));
    expect(moreCount).toBe(50 - POLICY_INDEX_MAX_ACTIVE_ENTRIES);
  });

  it("shows a mentioned draft, archived or unknown key as not active, without a title", () => {
    const { entries } = buildPolicyIndexEntries({
      result: { rows: [row("a-draft", { status: "draft", title: "Secret draft title" }), row("an-archive", { status: "archived" })], totalMatching: 2 },
      projectId: PROJECT,
      mentionedKeys: ["a-draft", "an-archive", "never-existed"],
    });
    expect(entries).toEqual([
      { state: "not_active", key: "a-draft" },
      { state: "not_active", key: "an-archive" },
      { state: "not_active", key: "never-existed" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("Secret draft title");
  });

  it("caps 50 policies and reports the rest, and counts rows past the query limit", () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(`policy-${String(index).padStart(2, "0")}`));
    const capped = buildPolicyIndexEntries({ result: { rows, totalMatching: 50 }, projectId: null, mentionedKeys: [] });
    expect(capped.entries).toHaveLength(POLICY_INDEX_MAX_ACTIVE_ENTRIES);
    expect(capped.moreCount).toBe(50 - POLICY_INDEX_MAX_ACTIVE_ENTRIES);

    const past = buildPolicyIndexEntries({ result: { rows: rows.slice(0, 5), totalMatching: 305 }, projectId: null, mentionedKeys: [] });
    expect(past.entries).toHaveLength(5);
    expect(past.moreCount).toBe(300);
  });

  it("is deterministic, so an unchanged set gives the same digest input", () => {
    const rows = [row("b"), row("a")];
    const first = buildPolicyIndexEntries({ result: { rows, totalMatching: 2 }, projectId: null, mentionedKeys: [] });
    const second = buildPolicyIndexEntries({ result: { rows: [...rows].reverse(), totalMatching: 2 }, projectId: null, mentionedKeys: [] });
    expect(policyIndexDigestInput(first.entries, first.moreCount)).toBe(policyIndexDigestInput(second.entries, second.moreCount));
  });

  it("changes the digest input when a title, summary or status changes", () => {
    const build = (overrides: Partial<PolicyIndexRow>) => {
      const result = buildPolicyIndexEntries({ result: { rows: [row("a", overrides)], totalMatching: 1 }, projectId: null, mentionedKeys: [] });
      return policyIndexDigestInput(result.entries, result.moreCount);
    };
    const base = build({});
    expect(build({ title: "New title" })).not.toBe(base);
    expect(build({ summary: "New summary" })).not.toBe(base);
    expect(build({ status: "archived" })).not.toBe(base);
  });
});
