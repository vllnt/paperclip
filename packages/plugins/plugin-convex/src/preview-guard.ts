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

/** GitHub lists fetched at most once per repository and pass. A delete re-reads open pull requests and branches instead of reusing a pass-wide list. */
export interface GuardCache {
  open: Map<string, Promise<PullRequestRef[]>>;
  branches: Map<string, Promise<string[]>>;
  closed: Map<string, Promise<PullRequestRef[]>>;
}
export const newGuardCache = (): GuardCache => ({ open: new Map(), branches: new Map(), closed: new Map() });
/** Fresh open-PR and branch reads for one decision; the closed list is positive evidence only and may be shared. */
export const recheckCache = (shared?: GuardCache): GuardCache => ({ open: new Map(), branches: new Map(), closed: shared?.closed ?? new Map() });

/** Convex derives a preview identifier from a branch name; separators may differ (`feat/login` and `feat-login`). */
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const sameRef = (ref: string, identifier: string) => ref === identifier || (normalize(identifier) !== "" && normalize(ref) === normalize(identifier));
const sameNumber = (number: number, identifier: string) => [`pr-${number}`, `pr${number}`, `pr_${number}`, String(number)].includes(identifier.toLowerCase());
const matchesPull = (pr: PullRequestRef, identifier: string) => sameRef(pr.headRef, identifier) || sameNumber(pr.number, identifier);

const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
  let pending = cache.get(key);
  if (!pending) { pending = load(); cache.set(key, pending); }
  return pending;
};

export interface GuardInput {
  github: GitHubReader;
  token: string | null;
  project: ProjectMapping;
  deployment: ConvexDeployment;
  activityHours: number;
  now: number;
  cache?: GuardCache;
}

/**
 * The preview guard. It blocks when the preview's branch has an open pull request or recent commits, and when GitHub
 * cannot be read. "Branch gone" is only concluded from the full branch list, never from one missing exact name.
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
  const cache = input.cache ?? newGuardCache();
  try {
    const open = (await once(cache.open, repo, () => github.openPullRequests(repo, token))).find(pr => matchesPull(pr, identifier));
    if (open) return keep(`Preview ${identifier} belongs to open pull request #${open.number}.`);
    const matched = (await once(cache.branches, repo, () => github.branchNames(repo, token))).filter(name => sameRef(name, identifier));
    let lastCommitAt: number | null = null;
    for (const name of matched.slice(0, 5)) {
      const branch = await github.branch(repo, token, name);
      if (!branch) continue;
      const since = branch.lastCommitAt === null ? null : now - branch.lastCommitAt;
      if (since === null || since < activityHours * HOUR_MS) {
        return keep(`Branch ${name} has recent activity (last commit ${since === null ? "at an unknown time" : `${Math.max(0, Math.floor(since / HOUR_MS))}h ago`}).`);
      }
      lastCommitAt = Math.max(lastCommitAt ?? 0, branch.lastCommitAt ?? 0);
    }
    let finished: PullRequestRef | null = null;
    try {
      const closed = (await once(cache.closed, repo, () => github.recentClosedPullRequests(repo, token))).filter(pr => matchesPull(pr, identifier));
      finished = closed.find(pr => pr.state === "merged") ?? closed[0] ?? null;
    } catch { /* positive evidence only: without it the "branch gone and idle" rule below still needs the full branch list */ }
    const idleMs = now - (deployment.lastDeployTime ?? deployment.createTime ?? now);
    const evidence: PreviewEvidence = {
      prState: finished ? finished.state as "closed" | "merged" : "none", prNumber: finished?.number ?? null,
      branchExists: matched.length > 0, lastCommitAt, idleMs,
    };
    const reapReason = finished ? `pull request #${finished.number} is ${finished.state}`
      : matched.length === 0 && idleMs >= activityHours * HOUR_MS ? `branch is gone and the preview has been idle for ${Math.floor(idleMs / HOUR_MS)}h` : null;
    return { blocked: null, checked: true, evidence, reapReason };
  } catch {
    return unchecked(GITHUB_UNREADABLE);
  }
}
