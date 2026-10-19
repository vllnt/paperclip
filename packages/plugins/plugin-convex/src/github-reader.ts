import { isRepositoryName } from "./contracts.js";
import type { FetchLike } from "./convex-client.js";

/** `headRepo` is the lowercase `owner/name` of the repository the pull request's branch lives in (null when GitHub does not say, e.g. a deleted fork). */
export interface PullRequestRef { number: number; headRef: string; headRepo: string | null; closedAt: number | null; state: "open" | "closed" | "merged" }
export interface BranchInfo { name: string; lastCommitAt: number | null }

const MAX_OPEN_PAGES = 10;
const MAX_BRANCH_PAGES = 10;
const MAX_CLOSED_PAGES = 5;
interface RawPull { number?: number; merged_at?: string | null; closed_at?: string | null; head?: { ref?: string; repo?: { full_name?: string } | null } }
const headRepo = (item: RawPull): string | null => typeof item.head?.repo?.full_name === "string" ? item.head.repo.full_name.toLowerCase() : null;
const timestamp = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const encSegments = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/**
 * Read-only GitHub lookups for the preview guard. It needs a token that can read pull requests and branches of the mapped
 * repository (a fine-grained token with Metadata, Pull requests and Contents read). Any failure throws, and callers treat a
 * throw as "do not delete". Lists that exceed their page budget also throw, because a missing entry would unprotect a preview.
 */
export class GitHubReader {
  /** Called with the token GitHub answered 401 for, so the owner can drop a stale cached copy. */
  onUnauthorized: (token: string) => void = () => {};
  constructor(private fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  private async get<T>(repo: string, path: string, token: string): Promise<T | null> {
    if (!isRepositoryName(repo)) throw new Error("Invalid GitHub repository.");
    // The host's own fetch limit (30 s) applies behind the plugin SDK, which does not forward the signal; this bounds a direct fetch.
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
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 401) this.onUnauthorized(token);
        throw new Error(`GitHub answered ${res.status}.`);
      }
      return await res.json() as T;
    } finally { clearTimeout(timer); }
  }

  private async pages<T>(repo: string, token: string, path: (page: number) => string, maxPages: number, complete: boolean): Promise<T[]> {
    const found: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.get<T[]>(repo, path(page), token);
      // A 404 on a list means the token cannot see the repository: never read that as "empty".
      if (!Array.isArray(items)) throw new Error("GitHub repository is not readable.");
      found.push(...items);
      if (items.length < 100) return found;
    }
    if (complete) throw new Error("Too many entries to check safely.");
    return found;
  }

  /** Every open pull request. More than the page budget fails closed. */
  async openPullRequests(repo: string, token: string): Promise<PullRequestRef[]> {
    const items = await this.pages<RawPull>(repo, token, page => `/pulls?state=open&per_page=100&page=${page}`, MAX_OPEN_PAGES, true);
    return items.flatMap(item => typeof item.number === "number" && typeof item.head?.ref === "string"
      ? [{ number: item.number, headRef: item.head.ref, headRepo: headRepo(item), closedAt: null, state: "open" as const }] : []);
  }

  /** Recently updated closed or merged pull requests. Used only as positive evidence, so a partial list is acceptable. */
  async recentClosedPullRequests(repo: string, token: string): Promise<PullRequestRef[]> {
    const items = await this.pages<RawPull>(
      repo, token, page => `/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, MAX_CLOSED_PAGES, false);
    return items.flatMap(item => typeof item.number === "number" && typeof item.head?.ref === "string"
      ? [{ number: item.number, headRef: item.head.ref, headRepo: headRepo(item), closedAt: timestamp(item.closed_at), state: item.merged_at ? "merged" as const : "closed" as const }] : []);
  }

  /** Every branch name. More than the page budget fails closed, because "no such branch" must mean the branch is gone. */
  async branchNames(repo: string, token: string): Promise<string[]> {
    const items = await this.pages<{ name?: string }>(repo, token, page => `/branches?per_page=100&page=${page}`, MAX_BRANCH_PAGES, true);
    return items.flatMap(item => typeof item.name === "string" ? [item.name] : []);
  }

  /** The branch's last commit time, or null when the branch does not exist. */
  async branch(repo: string, token: string, name: string): Promise<BranchInfo | null> {
    const item = await this.get<{ name?: string; commit?: { commit?: { committer?: { date?: string }; author?: { date?: string } } } }>(repo, `/branches/${encSegments(name)}`, token);
    if (!item) return null;
    const date = item.commit?.commit?.committer?.date ?? item.commit?.commit?.author?.date;
    const at = date ? Date.parse(date) : NaN;
    return { name: item.name ?? name, lastCommitAt: Number.isFinite(at) ? at : null };
  }
}
