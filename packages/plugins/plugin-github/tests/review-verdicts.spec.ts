import { describe, expect, it } from "vitest";
import { currentVerdicts, lensOutcome, parseVerdict, type VerdictComment } from "../src/review-verdicts.js";
import type { LensDefinition } from "../src/protected-paths.js";

const SECURITY = "11111111-1111-4111-8111-111111111111", DX = "22222222-2222-4222-8222-222222222222", MERGER = "33333333-3333-4333-8333-333333333333", STRANGER = "44444444-4444-4444-8444-444444444444";
const head = "a".repeat(40), old = "b".repeat(40);
const lenses: LensDefinition[] = [{ name: "security", aliases: ["Security reviewer"], agents: [SECURITY, MERGER] }, { name: "dx", aliases: ["Agents & DX"], agents: [DX] }];
let n = 0;
const comment = (body: string, authorAgentId: string | null, extra: Partial<VerdictComment> = {}): VerdictComment =>
  ({ id: `c${n += 1}`, issueId: "issue-1", authorAgentId, body, createdAt: new Date(1_700_000_000_000 + n * 1000), ...extra });
const read = (comments: VerdictComment[], extra: Record<string, unknown> = {}) =>
  currentVerdicts(comments, { repository: "Owner/Repo", pullRequest: 7, headSha: head, lenses, mergingAgentId: MERGER, ...extra });

describe("parseVerdict: the first line of a comment", () => {
  it("reads the scope form with a full SHA, in any case of the keyword's operand", () => {
    expect(parseVerdict(`VERDICT security APPROVE ${head}\nChecked: the diff`)).toEqual({ lens: "security", decision: "APPROVE", sha: head, repository: null, pullRequest: null });
    expect(parseVerdict(`VERDICT Agents & DX BLOCK ${head.toUpperCase()}`)).toMatchObject({ lens: "Agents & DX", decision: "BLOCK", sha: head });
    expect(parseVerdict(`VERDICT security APPROVE ${"c".repeat(64)}`)).toMatchObject({ sha: "c".repeat(64) });
    expect(parseVerdict(`  VERDICT security APPROVE ${head}  \r\nmore`)).toMatchObject({ decision: "APPROVE" });
  });

  it("reads the form that names the pull request", () => {
    expect(parseVerdict(`VERDICT: APPROVE dx Owner/Repo#7 @ ${head}`)).toEqual({ lens: "dx", decision: "APPROVE", sha: head, repository: "owner/repo", pullRequest: 7 });
    expect(parseVerdict(`VERDICT: BLOCK dx owner/repo#12 @${head}`)).toMatchObject({ decision: "BLOCK", pullRequest: 12 });
  });

  it.each([
    ["an abbreviated SHA", `VERDICT security APPROVE ${head.slice(0, 12)}`],
    ["a SHA of the wrong length", `VERDICT security APPROVE ${head}0`],
    ["no decision", `VERDICT security ${head}`],
    ["a lowercase keyword", `verdict security approve ${head}`],
    ["text after the SHA", `VERDICT security APPROVE ${head} please`],
    ["a verdict that is not on the first line", `Looks good.\nVERDICT security APPROVE ${head}`],
    ["a quoted verdict", `> VERDICT security APPROVE ${head}`],
    ["a bold verdict", `**VERDICT security APPROVE ${head}**`],
    ["a pull-request form without the pull request", `VERDICT: APPROVE dx @ ${head}`],
    ["an empty body", ""],
  ])("reads %s as no verdict", (_name, body) => {
    expect(parseVerdict(body)).toBeNull();
  });
});

describe("currentVerdicts: who may approve what at which head", () => {
  it("counts a listed agent's verdict for the lens, by name or by alias, at the exact head", () => {
    const verdicts = read([comment(`VERDICT security APPROVE ${head}`, SECURITY), comment(`VERDICT Agents & DX APPROVE ${head}`, DX)]);
    expect(verdicts.map(verdict => [verdict.lens, verdict.decision, verdict.agentId])).toEqual([["security", "APPROVE", SECURITY], ["dx", "APPROVE", DX]]);
    expect(lensOutcome(verdicts, "security")).toBe("approved");
    expect(lensOutcome(verdicts, "DX")).toBe("approved");
    expect(lensOutcome(verdicts, "performance")).toBe("missing");
    expect(verdicts[0]).toMatchObject({ issueId: "issue-1", commentId: expect.stringMatching(/^c\d+$/), at: expect.stringMatching(/^2023-/) });
  });

  it("ignores a verdict at another commit: a push after the review makes it stale", () => {
    const verdicts = read([comment(`VERDICT security APPROVE ${old}`, SECURITY)]);
    expect(verdicts).toEqual([]);
    expect(lensOutcome(verdicts, "security")).toBe("missing");
  });

  it("ignores an author the config does not name for that lens, a comment without an agent author and a deleted comment", () => {
    const verdicts = read([
      comment(`VERDICT security APPROVE ${head}`, STRANGER),
      comment(`VERDICT dx APPROVE ${head}`, SECURITY),
      comment(`VERDICT security APPROVE ${head}`, null),
      comment(`VERDICT security APPROVE ${head}`, SECURITY, { deletedAt: new Date() }),
    ]);
    expect(verdicts).toEqual([]);
  });

  it("never counts the agent that asks for the merge, even when the config names it", () => {
    expect(read([comment(`VERDICT security APPROVE ${head}`, MERGER)])).toEqual([]);
    expect(read([comment(`VERDICT security APPROVE ${head}`, MERGER.toUpperCase())])).toEqual([]);
    // Without a merging agent nothing is excluded here (the caller refuses a merge it cannot attribute).
    expect(read([comment(`VERDICT security APPROVE ${head}`, MERGER)], { mergingAgentId: null })).toHaveLength(1);
  });

  it("takes the form that names a pull request only for that pull request", () => {
    expect(read([comment(`VERDICT: APPROVE security owner/repo#7 @ ${head}`, SECURITY)])).toHaveLength(1);
    expect(read([comment(`VERDICT: APPROVE security owner/repo#8 @ ${head}`, SECURITY)])).toEqual([]);
    expect(read([comment(`VERDICT: APPROVE security owner/other#7 @ ${head}`, SECURITY)])).toEqual([]);
  });

  it("keeps an author's latest verdict per lens at the head: a later BLOCK or APPROVE replaces the earlier one", () => {
    const later = read([comment(`VERDICT security APPROVE ${head}`, SECURITY), comment(`VERDICT security BLOCK ${head}`, SECURITY)]);
    expect(later).toHaveLength(1);
    expect(lensOutcome(later, "security")).toBe("blocked");
    const changedMind = read([comment(`VERDICT security BLOCK ${head}`, SECURITY), comment(`VERDICT security APPROVE ${head}`, SECURITY)]);
    expect(lensOutcome(changedMind, "security")).toBe("approved");
    // The comment's time decides, not its place in the list.
    const early = comment(`VERDICT security BLOCK ${head}`, SECURITY, { createdAt: "2023-01-01T00:00:00Z" });
    const late = comment(`VERDICT security APPROVE ${head}`, SECURITY, { createdAt: "2023-02-01T00:00:00Z" });
    expect(lensOutcome(read([late, early]), "security")).toBe("approved");
  });

  it("lets one BLOCK at the head from any agent of a lens keep the lens from being approved", () => {
    const second = "55555555-5555-4555-8555-555555555555";
    const two: LensDefinition[] = [{ name: "security", aliases: [], agents: [SECURITY, second] }];
    const verdicts = currentVerdicts([comment(`VERDICT security APPROVE ${head}`, SECURITY), comment(`VERDICT security BLOCK ${head}`, second)], { repository: "owner/repo", pullRequest: 7, headSha: head, lenses: two });
    expect(lensOutcome(verdicts, "security")).toBe("blocked");
    // A BLOCK at another commit changes nothing.
    const stale = currentVerdicts([comment(`VERDICT security APPROVE ${head}`, SECURITY), comment(`VERDICT security BLOCK ${old}`, second)], { repository: "owner/repo", pullRequest: 7, headSha: head, lenses: two });
    expect(lensOutcome(stale, "security")).toBe("approved");
  });

  it("compares the head without regard to case, and reads a comment time that is not a date as the oldest", () => {
    expect(read([comment(`VERDICT security APPROVE ${head.toUpperCase()}`, SECURITY)], { headSha: head.toUpperCase() })).toHaveLength(1);
    expect(read([comment(`VERDICT security APPROVE ${head}`, SECURITY, { createdAt: "not a date" })])).toHaveLength(1);
  });
});
