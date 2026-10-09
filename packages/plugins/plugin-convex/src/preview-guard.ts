import { HOUR_MS, type ConvexDeployment, type ProjectMapping } from "./contracts.js";
import type { GitHubReader, PullRequestRef } from "./github-reader.js";

/** A refusal is a guard decision. Its message is written for the agent and never contains a credential. */
export class Refusal extends Error {
  constructor(message: string) { super(message); this.name = "Refusal"; }
}

export interface PreviewEvidence {
  prState: "none" | "closed" | "merged";
  prNumber: number | null;
  branchExists: boolean;
  lastCommitAt: number | null;
  idleMs: number;
}
export const GITHUB_UNREADABLE = "GitHub could not be read, so the preview was kept.";

export interface PreviewAssessment {
  /** Why the preview must be kept; null when no guard objects. */
  blocked: string | null;
  /** False when the guard could not evaluate the preview at all; the reaper then changes nothing about it. */
  checked: boolean;
  evidence: PreviewEvidence | null;
  /** Why the reaper may delete it (positive evidence); null when it should only be kept or expired. */
  reapReason: string | null;
}

/** Caches the open pull request list per repository for the length of one run. */
export type OpenPullRequestCache = Map<string, Promise<PullRequestRef[]>>;

const identifierMatches = (pr: PullRequestRef, identifier: string): boolean => {
  const wanted = identifier.toLowerCase();
  return pr.headRef.toLowerCase() === wanted || [`pr-${pr.number}`, `pr${pr.number}`, `pr_${pr.number}`, String(pr.number)].includes(wanted);
};

export interface GuardInput {
  github: GitHubReader;
  token: string | null;
  project: ProjectMapping;
  deployment: ConvexDeployment;
  activityHours: number;
  now: number;
  openCache?: OpenPullRequestCache;
}

/**
 * The preview guard. It blocks when the preview's branch has an open pull request or recent commits, and when GitHub
 * cannot be read. Everything that is not positively known to be safe is blocked.
 */
export async function assessPreview(input: GuardInput): Promise<PreviewAssessment> {
  const { github, token, project, deployment, activityHours, now } = input;
  const unchecked = (blocked: string): PreviewAssessment => ({ blocked, checked: false, evidence: null, reapReason: null });
  const keep = (blocked: string): PreviewAssessment => ({ blocked, checked: true, evidence: null, reapReason: null });
  const identifier = deployment.previewIdentifier;
  if (!identifier) return unchecked("This preview has no preview identifier, so its branch and pull request cannot be checked.");
  if (!project.repository) return unchecked("No GitHub repository is mapped for this Convex project, so open pull requests cannot be checked.");
  if (!token) return unchecked("No GitHub token is configured for this company, so open pull requests cannot be checked.");
  const repo = project.repository;
  try {
    const cache = input.openCache;
    let pending = cache?.get(repo);
    if (!pending) { pending = github.openPullRequests(repo, token); cache?.set(repo, pending); }
    const open = (await pending).find(pr => identifierMatches(pr, identifier));
    if (open) return keep(`Preview ${identifier} belongs to open pull request #${open.number}.`);
    const branch = await github.branch(repo, token, identifier);
    const sinceCommit = branch?.lastCommitAt == null ? null : now - branch.lastCommitAt;
    if (branch && (sinceCommit === null || sinceCommit < activityHours * HOUR_MS)) {
      return keep(`Branch ${identifier} has recent activity (last commit ${sinceCommit === null ? "at an unknown time" : `${Math.max(0, Math.floor(sinceCommit / HOUR_MS))}h ago`}).`);
    }
    const history = (await github.pullRequestsForBranch(repo, token, identifier)).filter(pr => pr.headRef === identifier);
    const finished = history.find(pr => pr.state === "merged") ?? history.find(pr => pr.state === "closed") ?? null;
    const idleMs = now - (deployment.lastDeployTime ?? deployment.createTime ?? now);
    const evidence: PreviewEvidence = {
      prState: finished ? finished.state as "closed" | "merged" : "none", prNumber: finished?.number ?? null,
      branchExists: branch !== null, lastCommitAt: branch?.lastCommitAt ?? null, idleMs,
    };
    const reapReason = finished ? `pull request #${finished.number} is ${finished.state}`
      : !branch && idleMs >= activityHours * HOUR_MS ? `branch is gone and the preview has been idle for ${Math.floor(idleMs / HOUR_MS)}h` : null;
    return { blocked: null, checked: true, evidence, reapReason };
  } catch {
    return unchecked(GITHUB_UNREADABLE);
  }
}
