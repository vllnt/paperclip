import { describe, expect, it, vi } from "vitest";
import { createResolvePolicyIndex } from "./resolve-policy-index.js";
import type { MentionSources, PolicyIndexDeps, PolicyIndexRowsPort } from "./ports.js";
import type { PolicyIndexRow } from "../domain/policy-index.js";

const COMPANY = "00000000-0000-4000-8000-000000000001";
const ISSUE = { id: "00000000-0000-4000-8000-000000000002", title: "Task", description: null };

function row(key: string, overrides: Partial<PolicyIndexRow> = {}): PolicyIndexRow {
  return { key, title: `Title ${key}`, summary: null, projectId: null, status: "active", ...overrides };
}

function setup(options: { rows?: PolicyIndexRow[]; sources?: Partial<MentionSources>; onSourceError?: PolicyIndexDeps["onSourceError"] } = {}) {
  const load = vi.fn<PolicyIndexRowsPort["load"]>(async () => ({ rows: options.rows ?? [], totalMatching: options.rows?.length ?? 0 }));
  const sources: MentionSources = {
    issue: vi.fn(async () => []),
    instructions: vi.fn(async () => []),
    skills: vi.fn(async () => []),
    ...options.sources,
  };
  const resolve = createResolvePolicyIndex({
    rows: { load },
    sources,
    digest: (text) => `digest:${text.length}`,
    onSourceError: options.onSourceError,
  });
  return { resolve, load, sources };
}

describe("resolvePolicyIndex", () => {
  it("makes exactly one bounded policy query when nothing is mentioned", async () => {
    const { resolve, load, sources } = setup({ rows: [row("a")] });
    const index = await resolve({ companyId: COMPANY, projectId: null, issue: ISSUE });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ companyId: COMPANY, projectId: null, mentionedKeys: [], limit: 100 });
    expect(index.entries.map((entry) => entry.key)).toEqual(["a"]);
    expect(sources.instructions).not.toHaveBeenCalled();
    expect(sources.skills).not.toHaveBeenCalled();
  });

  it("merges mentions from the issue, the instructions and the skills, once each, in that order", async () => {
    const { resolve, load, sources } = setup({
      rows: [row("from-issue"), row("from-instructions"), row("from-skill")],
      sources: {
        issue: vi.fn(async () => ["from-issue", "shared"]),
        instructions: vi.fn(async () => ["from-instructions", "shared"]),
        skills: vi.fn(async () => ["from-skill"]),
      },
    });
    await resolve({ companyId: COMPANY, projectId: null, issue: ISSUE, instructionsFilePath: "/stored/AGENTS.md", skillKeys: ["a/b/skill"] });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0].mentionedKeys).toEqual(["from-issue", "shared", "from-instructions", "from-skill"]);
    expect(load.mock.calls[0]![0].limit).toBe(104);
    expect(sources.instructions).toHaveBeenCalledWith({ filePath: "/stored/AGENTS.md" });
    expect(sources.skills).toHaveBeenCalledWith({ companyId: COMPANY, skillKeys: ["a/b/skill"] });
  });

  it("reports an unknown mentioned key as not active", async () => {
    const { resolve } = setup({ sources: { issue: vi.fn(async () => ["ghost"]) } });
    const index = await resolve({ companyId: COMPANY, projectId: null, issue: ISSUE });
    expect(index.entries).toEqual([{ state: "not_active", key: "ghost" }]);
  });

  it("keeps going when a mention source fails, and reports it", async () => {
    const onSourceError = vi.fn();
    const failure = new Error("disk gone");
    const { resolve } = setup({
      rows: [row("a")],
      sources: { instructions: vi.fn(async () => { throw failure; }), issue: vi.fn(async () => ["a"]) },
      onSourceError,
    });
    const index = await resolve({ companyId: COMPANY, projectId: null, issue: ISSUE, instructionsFilePath: "/x" });
    expect(index.entries.map((entry) => entry.key)).toEqual(["a"]);
    expect(onSourceError).toHaveBeenCalledWith("instructions", failure);
  });

  it("gives the same digest for the same index and a different one when the index changes", async () => {
    const a = await setup({ rows: [row("a")] }).resolve({ companyId: COMPANY, projectId: null, issue: ISSUE });
    const again = await setup({ rows: [row("a")] }).resolve({ companyId: COMPANY, projectId: null, issue: ISSUE });
    const changed = await setup({ rows: [row("a", { summary: "now with a summary" })] }).resolve({ companyId: COMPANY, projectId: null, issue: ISSUE });
    expect(again.digest).toBe(a.digest);
    expect(changed.digest).not.toBe(a.digest);
  });
});
