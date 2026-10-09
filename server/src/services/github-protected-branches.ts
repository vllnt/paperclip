import { gitHubAgentsNeverDenial, isProtectedBranchFloor } from "@paperclipai/shared";

/**
 * What GitHub says about a repository's branches, for the classifier's
 * protected-branch check: the default branch, and whether a branch is
 * protected (classic branch protection, or an active ruleset rule that guards
 * its history). Facts are read with a run's read credential and kept for
 * {@link FACT_TTL_MS}; only successful reads are kept, so a branch Paperclip
 * has not read counts as protected (fail closed).
 */

const GITHUB_API = "https://api.github.com";
const FACT_TTL_MS = 5 * 60_000;
/** A fact this close to expiry is read again before an operation, so it is still fresh when the classifier uses it. */
const REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RULE_PAGES = 10;
const MAX_FACTS = 10_000;
/**
 * Ruleset rule types that check commit contents, names or merges but do not
 * guard a branch against deletion or a forced update. Any other type, a new one
 * included, makes the branch protected.
 */
const NON_PROTECTING_RULES = new Set([
  "creation", "required_signatures", "required_linear_history", "commit_message_pattern", "commit_author_email_pattern", "committer_email_pattern",
  "branch_name_pattern", "tag_name_pattern", "file_path_restriction", "max_file_path_length", "file_extension_restriction", "max_file_size",
  "workflows", "code_scanning", "copilot_code_review",
]);

const defaultBranches = new Map<string, { name: string; at: number }>();
const branchProtection = new Map<string, { protected: boolean; at: number }>();
const branchKey = (repository: string, branch: string) => `${repository}\u0000${branch}`;
const field = (value: unknown, name: string): unknown => (value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined);

function remember<T extends { at: number }>(facts: Map<string, T>, key: string, value: T) {
  if (facts.size >= MAX_FACTS) {
    for (const [stored, fact] of facts) if (value.at - fact.at >= FACT_TTL_MS) facts.delete(stored);
    if (facts.size >= MAX_FACTS) facts.clear();
  }
  facts.set(key, value);
}

/**
 * The refusal for a write that forces, deletes, renames or hard-resets
 * `branches` of `repository` (lowercase `owner/name`), or null when GitHub
 * reported recently that none of them is the default or a protected branch.
 * The default branch is compared case-insensitively: the stricter reading wins.
 */
export function protectedBranchRefusal(repository: string, branches: readonly string[], now = Date.now()): string | null {
  const defaultBranch = defaultBranches.get(repository);
  for (const branch of branches) {
    // The name floor is not something a "not protected" answer from GitHub can clear.
    if (isProtectedBranchFloor(branch)) return gitHubAgentsNeverDenial("defaultBranch", `${branch} is a protected branch name (main, master, staging or production) of ${repository}`);
    const unknown = `Denied: Paperclip could not read from GitHub whether ${branch} is the default or a protected branch of ${repository}, and agents never delete or force-push one. Try again; if this persists, check the run's GitHub read access.`;
    if (!defaultBranch || now - defaultBranch.at >= FACT_TTL_MS) return unknown;
    if (branch.toLowerCase() === defaultBranch.name.toLowerCase()) return gitHubAgentsNeverDenial("defaultBranch", `${branch} is the default branch of ${repository}`);
    const facts = branchProtection.get(branchKey(repository, branch));
    if (!facts || now - facts.at >= FACT_TTL_MS) return unknown;
    if (facts.protected) return gitHubAgentsNeverDenial("defaultBranch", `${branch} is a protected branch of ${repository}`);
  }
  return null;
}

/**
 * Reads from GitHub, with `token`, the default branch of `repository` and
 * whether each of `branches` is protected, unless fresh facts are kept already.
 * A branch that does not exist (404) has no classic protection; rulesets still
 * apply to its name. Throws when GitHub does not answer clearly; nothing is kept then.
 */
export async function readProtectedBranches(repository: string, branches: readonly string[], token: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const stale = (fact: { at: number } | undefined) => fact === undefined || now - fact.at >= FACT_TTL_MS - REFRESH_MARGIN_MS;
  const get = async (path: string) => {
    const response = await fetchImpl(`${GITHUB_API}/${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "paperclip" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data: unknown = response.ok ? await response.json() : null;
    return { status: response.status, data, next: /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "") };
  };
  const failed = (what: string, status: number) => new Error(`GitHub answered ${status} for the ${what} of ${repository}.`);
  if (stale(defaultBranches.get(repository))) {
    const response = await get(`repos/${repository}`);
    const name = response.status === 200 ? field(response.data, "default_branch") : undefined;
    if (typeof name !== "string" || !name) throw failed("default branch", response.status);
    remember(defaultBranches, repository, { name, at: now });
  }
  for (const branch of new Set(branches)) {
    if (!stale(branchProtection.get(branchKey(repository, branch)))) continue;
    const encoded = encodeURIComponent(branch);
    const response = await get(`repos/${repository}/branches/${encoded}`);
    const classic = response.status === 404 ? false : response.status === 200 ? field(response.data, "protected") : undefined;
    if (typeof classic !== "boolean") throw failed(`protection of ${branch}`, response.status);
    let ruled = false;
    for (let page = 1; ; page += 1) {
      if (page > MAX_RULE_PAGES) throw new Error(`GitHub listed more than ${MAX_RULE_PAGES} pages of rules for ${branch} of ${repository}.`);
      const rules = await get(`repos/${repository}/rules/branches/${encoded}?per_page=100&page=${page}`);
      if (rules.status !== 200 || !Array.isArray(rules.data)) throw failed(`rules of ${branch}`, rules.status);
      ruled ||= rules.data.some(rule => {
        const type = field(rule, "type");
        return typeof type !== "string" || !NON_PROTECTING_RULES.has(type);
      });
      if (!rules.next) break;
    }
    remember(branchProtection, branchKey(repository, branch), { protected: classic || ruled, at: now });
  }
}
