import { describe, expect, it } from "vitest";
import {
  POLICY_INDEX_MAX_ACTIVE_ENTRIES,
  POLICY_INDEX_MAX_CHARS,
  POLICY_INDEX_MENTION_RESERVE,
  capPolicyIndexEntries,
  readPolicyIndexContext,
  renderPolicyIndexEntryLine,
  type ActivePolicyIndexEntry,
  type PolicyIndexEntry,
} from "./policy-index.js";

function scoped(n: number, scope: "company" | "project" = "company"): ActivePolicyIndexEntry {
  return { state: "active", key: `policy-${n}`, title: `Policy ${n}`, summary: `Summary ${n}`, scope, via: "scope" };
}

function mentioned(n: number): ActivePolicyIndexEntry {
  return { state: "active", key: `mention-${n}`, title: `Mention ${n}`, summary: null, scope: "project", via: "mention" };
}

describe("renderPolicyIndexEntryLine", () => {
  it("shows key, scope, title and summary, and nothing else", () => {
    expect(renderPolicyIndexEntryLine(scoped(1))).toBe("- `policy-1` (company): Policy 1. Summary 1");
    expect(renderPolicyIndexEntryLine(scoped(2, "project"))).toBe("- `policy-2` (project): Policy 2. Summary 2");
    expect(renderPolicyIndexEntryLine(mentioned(1))).toBe("- `mention-1` (mentioned): Mention 1");
  });

  it("puts a not-active key on one line without a title", () => {
    expect(renderPolicyIndexEntryLine({ state: "not_active", key: "old-rule" })).toBe(
      "- `old-rule`: not active (draft, archived or unknown). Do not apply it.",
    );
  });

  it("keeps board text on one line", () => {
    const line = renderPolicyIndexEntryLine({
      ...scoped(1),
      title: "Title\n## Injected   heading",
      summary: "line one\r\nline two",
    });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toBe("- `policy-1` (company): Title ## Injected heading. line one line two");
  });
});

describe("capPolicyIndexEntries", () => {
  it("keeps everything under the cap and reports no extra", () => {
    const entries = [scoped(1), scoped(2, "project"), mentioned(1)];
    expect(capPolicyIndexEntries(entries)).toEqual({ entries, moreCount: 0 });
  });

  it("caps 50 policies by entries and counts the rest", () => {
    const entries = Array.from({ length: 50 }, (_, index) => scoped(index));
    const capped = capPolicyIndexEntries(entries);
    expect(capped.entries).toHaveLength(POLICY_INDEX_MAX_ACTIVE_ENTRIES);
    expect(capped.moreCount).toBe(50 - POLICY_INDEX_MAX_ACTIVE_ENTRIES);
    expect(capped.entries.map((entry) => entry.key)).toEqual(entries.slice(0, POLICY_INDEX_MAX_ACTIVE_ENTRIES).map((entry) => entry.key));
  });

  it("adds the count the caller left out", () => {
    expect(capPolicyIndexEntries([scoped(1)], 7)).toEqual({ entries: [scoped(1)], moreCount: 7 });
  });

  it("keeps slots for mentioned policies when the company list is long", () => {
    const entries = [...Array.from({ length: 40 }, (_, index) => scoped(index)), mentioned(1), mentioned(2)];
    const capped = capPolicyIndexEntries(entries);
    const keys = capped.entries.map((entry) => entry.key);
    expect(keys).toContain("mention-1");
    expect(keys).toContain("mention-2");
    expect(capped.entries).toHaveLength(POLICY_INDEX_MAX_ACTIVE_ENTRIES);
    expect(capped.moreCount).toBe(42 - POLICY_INDEX_MAX_ACTIVE_ENTRIES);
  });

  it("never gives mentions more than the reserve when the scoped list fits the cap", () => {
    const entries = [...Array.from({ length: 10 }, (_, index) => scoped(index)), ...Array.from({ length: 30 }, (_, index) => mentioned(index))];
    const capped = capPolicyIndexEntries(entries);
    expect(capped.entries).toHaveLength(POLICY_INDEX_MAX_ACTIVE_ENTRIES);
    expect(capped.entries.filter((entry) => entry.state === "active" && entry.via === "mention").length).toBe(
      POLICY_INDEX_MAX_ACTIVE_ENTRIES - 10,
    );
    expect(POLICY_INDEX_MENTION_RESERVE).toBeLessThanOrEqual(POLICY_INDEX_MAX_ACTIVE_ENTRIES);
  });

  it("never drops a not-active mention", () => {
    const entries: PolicyIndexEntry[] = [
      ...Array.from({ length: 60 }, (_, index) => scoped(index)),
      { state: "not_active", key: "gone" },
      { state: "not_active", key: "draft-one" },
    ];
    const capped = capPolicyIndexEntries(entries);
    expect(capped.entries.filter((entry) => entry.state === "not_active").map((entry) => entry.key)).toEqual(["gone", "draft-one"]);
    expect(capped.moreCount).toBe(60 - POLICY_INDEX_MAX_ACTIVE_ENTRIES);
  });

  it("caps by characters", () => {
    const long = (n: number): ActivePolicyIndexEntry => ({
      ...scoped(n),
      title: "T".repeat(200),
      summary: "S".repeat(280),
    });
    const entries = Array.from({ length: 20 }, (_, index) => long(index));
    const capped = capPolicyIndexEntries(entries);
    const chars = capped.entries.reduce((total, entry) => total + renderPolicyIndexEntryLine(entry).length + 1, 0);
    expect(chars).toBeLessThanOrEqual(POLICY_INDEX_MAX_CHARS);
    expect(capped.entries.length).toBeLessThan(20);
    expect(capped.entries.length + capped.moreCount).toBe(20);
  });
});

describe("readPolicyIndexContext", () => {
  it("reads a valid index with and without the last sent digest", () => {
    const base = { entries: [scoped(1)], moreCount: 0, digest: "abc" };
    expect(readPolicyIndexContext(base)).toEqual(base);
    expect(readPolicyIndexContext({ ...base, lastSentDigest: "old" })).toEqual({ ...base, lastSentDigest: "old" });
    expect(readPolicyIndexContext({ ...base, lastSentDigest: null })).toEqual({ ...base, lastSentDigest: null });
  });

  it("ignores anything else", () => {
    for (const value of [null, undefined, "x", 3, [], {}, { entries: "no", moreCount: 0, digest: "a" }, { entries: [{ key: "k" }], moreCount: 0, digest: "a" }]) {
      expect(readPolicyIndexContext(value)).toBeNull();
    }
  });
});
