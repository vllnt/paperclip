import type { FetchLike } from "./convex-client.js";

export interface PullRequestRef { number: number; headRef: string; state: "open" | "closed" | "merged" }
export interface BranchInfo { name: string; lastCommitAt: number | null }

const MAX_OPEN_PAGES = 10;
const encSegments = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/**
 * Read-only GitHub lookups for the preview guard. It needs a token that can read pull requests and branches of the mapped
 * repository (a fine-grained token with Metadata, Pull requests and Contents read). Any failure throws, and callers treat a
 * throw as "do not delete".
 */
export class GitHubReader {
  constructor(private fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  private async get<T>(repo: string, path: string, token: string): Promise<T | null> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid GitHub repository.");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
          method: "GET", redirect: "error", signal: abort.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "paperclip-convex-plugin" },
        });
      } catch { throw new Error("GitHub could not be reached."); }
      if (res.status === 404) { await res.body?.cancel(); return null; }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`GitHub answered ${res.status}.`); }
      return await res.json() as T;
    } finally { clearTimeout(timer); }
  }

  /** Every open pull request head ref. More than the page budget fails closed, because a missing PR would unprotect a preview. */
  async openPullRequests(repo: string, token: string): Promise<PullRequestRef[]> {
    const found: PullRequestRef[] = [];
    for (let page = 1; page <= MAX_OPEN_PAGES; page++) {
      const items = await this.get<Array<{ number?: number; head?: { ref?: string } }>>(repo, `/pulls?state=open&per_page=100&page=${page}`, token);
      if (!Array.isArray(items)) throw new Error("GitHub repository is not readable.");
      for (const item of items) if (typeof item.number === "number" && typeof item.head?.ref === "string") found.push({ number: item.number, headRef: item.head.ref, state: "open" });
      if (items.length < 100) return found;
    }
    throw new Error("Too many open pull requests to check safely.");
  }

  /** Pull requests (any state) whose head branch has this name. */
  async pullRequestsForBranch(repo: string, token: string, branch: string): Promise<PullRequestRef[]> {
    const owner = repo.split("/")[0];
    const items = await this.get<Array<{ number?: number; state?: string; merged_at?: string | null; head?: { ref?: string } }>>(
      repo, `/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`, token);
    if (!Array.isArray(items)) throw new Error("GitHub repository is not readable.");
    return items.flatMap(item => typeof item.number === "number" && typeof item.head?.ref === "string"
      ? [{ number: item.number, headRef: item.head.ref, state: item.state === "open" ? "open" as const : item.merged_at ? "merged" as const : "closed" as const }] : []);
  }

  /** The branch, or null when it does not exist. */
  async branch(repo: string, token: string, name: string): Promise<BranchInfo | null> {
    const item = await this.get<{ name?: string; commit?: { commit?: { committer?: { date?: string }; author?: { date?: string } } } }>(repo, `/branches/${encSegments(name)}`, token);
    if (!item) return null;
    const date = item.commit?.commit?.committer?.date ?? item.commit?.commit?.author?.date;
    const at = date ? Date.parse(date) : NaN;
    return { name: item.name ?? name, lastCommitAt: Number.isFinite(at) ? at : null };
  }
}
