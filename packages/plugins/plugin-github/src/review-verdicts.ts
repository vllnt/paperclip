/**
 * Reviewer verdicts for the protected-path merge guard. A reviewer agent records its verdict as the first line of a comment
 * on a Paperclip issue. The guard counts a verdict only when
 * - the comment's author is an agent the admin named for that lens (the comment text is never trusted for who wrote it),
 * - it names the pull request's exact head commit (a full SHA), so any push after the review makes it stale, and
 * - it is the author's latest verdict for that lens at that head.
 * One `BLOCK` at the head from an agent of a lens keeps that lens from being approved.
 *
 * Two first-line forms are read, both with the full head SHA:
 *   VERDICT <lens> APPROVE|BLOCK <sha>
 *   VERDICT: APPROVE|BLOCK <lens> <owner/repo>#<number> @ <sha>      (names the pull request, which must be this one)
 */
import { lensKey, type LensDefinition } from "./protected-paths.js";

const SHA = "[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?";
const SCOPE_FORM = new RegExp(`^VERDICT\\s+(.{1,60}?)\\s+(APPROVE|BLOCK)\\s+(${SHA})\\s*$`);
const PULL_FORM = new RegExp(`^VERDICT:\\s*(APPROVE|BLOCK)\\s+(\\S{1,60})\\s+([A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100})#(\\d{1,9})\\s+@\\s*(${SHA})\\s*$`);

export interface ParsedVerdict { lens: string; decision: "APPROVE" | "BLOCK"; sha: string; repository: string | null; pullRequest: number | null }

/** The verdict on the first line of a comment, or null when the first line is not one (a quoted verdict further down never counts). */
export function parseVerdict(body: string): ParsedVerdict | null {
  const line = (body.split(/\r?\n/, 1)[0] ?? "").trim();
  const pull = PULL_FORM.exec(line);
  if (pull) return { lens: pull[2]!, decision: pull[1] as "APPROVE" | "BLOCK", sha: pull[5]!.toLowerCase(), repository: pull[3]!.toLowerCase(), pullRequest: Number(pull[4]) };
  const scope = SCOPE_FORM.exec(line);
  if (scope) return { lens: scope[1]!, decision: scope[2] as "APPROVE" | "BLOCK", sha: scope[3]!.toLowerCase(), repository: null, pullRequest: null };
  return null;
}

/** The part of an issue comment the guard reads. */
export interface VerdictComment {
  id: string;
  issueId: string;
  authorAgentId: string | null;
  body: string;
  createdAt: Date | string;
  deletedAt?: Date | string | null;
}

/** One reviewer's current verdict for a lens at the head. */
export interface LensVerdict { lens: string; decision: "APPROVE" | "BLOCK"; agentId: string; issueId: string; commentId: string; at: string }

const time = (value: Date | string): number => { const at = new Date(value).getTime(); return Number.isFinite(at) ? at : 0; };

/**
 * The current verdict of every allowed reviewer for every lens, at this head of this pull request. A reviewer's later
 * comment replaces its earlier one. Verdicts of the agent that asks for the merge never count: nobody approves their own merge.
 */
export function currentVerdicts(comments: readonly VerdictComment[], input: {
  repository: string; pullRequest: number; headSha: string; lenses: readonly LensDefinition[]; mergingAgentId?: string | null;
}): LensVerdict[] {
  const head = input.headSha.toLowerCase(), repository = input.repository.toLowerCase(), merging = input.mergingAgentId?.toLowerCase() ?? null;
  const latest = new Map<string, LensVerdict & { when: number }>();
  for (const comment of comments) {
    if (comment.deletedAt || !comment.authorAgentId) continue;
    const agentId = comment.authorAgentId.toLowerCase();
    if (agentId === merging) continue;
    const verdict = parseVerdict(comment.body);
    if (!verdict || verdict.sha !== head) continue;
    if (verdict.repository !== null && (verdict.repository !== repository || verdict.pullRequest !== input.pullRequest)) continue;
    const lens = input.lenses.find(candidate => candidate.agents.includes(agentId) && [candidate.name, ...candidate.aliases].some(name => lensKey(name) === lensKey(verdict.lens)));
    if (!lens) continue;
    const key = `${lensKey(lens.name)}\u0000${agentId}`, when = time(comment.createdAt);
    const before = latest.get(key);
    // A later comment replaces an earlier one; at the same instant the one listed later does.
    if (!before || when >= before.when) latest.set(key, { lens: lens.name, decision: verdict.decision, agentId, issueId: comment.issueId, commentId: comment.id, at: new Date(when).toISOString(), when });
  }
  return [...latest.values()].map(({ when: _when, ...verdict }) => verdict);
}

/** A lens is approved when an allowed reviewer approves it at the head and none of its reviewers blocks it there. */
export function lensOutcome(verdicts: readonly LensVerdict[], lens: string): "approved" | "blocked" | "missing" {
  const mine = verdicts.filter(verdict => lensKey(verdict.lens) === lensKey(lens));
  if (mine.some(verdict => verdict.decision === "BLOCK")) return "blocked";
  return mine.some(verdict => verdict.decision === "APPROVE") ? "approved" : "missing";
}
