import { AsyncLocalStorage } from "node:async_hooks";
import { gitHubAgentsNeverDenial, isProtectedBranchFloor } from "@paperclipai/shared";

/**
 * What GitHub says about a repository's branches, for the classifier's
 * protected-branch check: the default branch, and whether a branch is
 * protected (classic branch protection, or an active ruleset rule that guards
 * its history).
 *
 * Facts belong to one operation. They are read with that run's read
 * credential, handed to the classifier through {@link withProtectedBranchFacts},
 * and kept nowhere else: no cache, so another company or a later request never
 * reuses an answer, and a change at GitHub shows at once. A branch without
 * facts counts as protected (fail closed).
 */

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RULE_PAGES = 10;
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

/** What GitHub reported for one repository during one operation. */
export interface ProtectedBranchFacts {
  /** Lowercase `owner/name`. */
  repository: string;
  defaultBranch: string;
  /** Branch name to whether it is protected (classic protection or a guarding ruleset rule). */
  protection: ReadonlyMap<string, boolean>;
}

const operationFacts = new AsyncLocalStorage<ProtectedBranchFacts>();
const field = (value: unknown, name: string): unknown => (value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined);

/** Runs `operation` with `facts` visible to {@link protectedBranchRefusal} in it, and only in it. */
export function withProtectedBranchFacts<T>(facts: ProtectedBranchFacts | null, operation: () => Promise<T>): Promise<T> {
  return facts ? operationFacts.run(facts, operation) : operation();
}

/**
 * The refusal for a write that forces, deletes, renames or hard-resets
 * `branches` of `repository` (lowercase `owner/name`), or null when GitHub
 * reported, for this operation, that none of them is the default or a
 * protected branch. The default branch is compared case-insensitively: the
 * stricter reading wins.
 */
export function protectedBranchRefusal(repository: string, branches: readonly string[]): string | null {
  const reported = operationFacts.getStore();
  const facts = reported?.repository === repository ? reported : undefined;
  for (const branch of branches) {
    // The name floor is not something a "not protected" answer from GitHub can clear.
    if (isProtectedBranchFloor(branch)) return gitHubAgentsNeverDenial("defaultBranch", `${branch} is a protected branch name (main, master, staging or production) of ${repository}`);
    const unknown = `Denied: Paperclip could not read from GitHub whether ${branch} is the default or a protected branch of ${repository}, and agents never delete or force-push one. Try again; if this persists, check the run's GitHub read access.`;
    if (!facts) return unknown;
    if (branch.toLowerCase() === facts.defaultBranch.toLowerCase()) return gitHubAgentsNeverDenial("defaultBranch", `${branch} is the default branch of ${repository}`);
    const isProtected = facts.protection.get(branch);
    if (isProtected === undefined) return unknown;
    if (isProtected) return gitHubAgentsNeverDenial("defaultBranch", `${branch} is a protected branch of ${repository}`);
  }
  return null;
}

/**
 * Reads from GitHub, with `token`, the default branch of `repository` and
 * whether each of `branches` is protected. A branch that does not exist (404)
 * has no classic protection; rulesets still apply to its name. Throws when
 * GitHub does not answer clearly.
 */
export async function readProtectedBranches(repository: string, branches: readonly string[], token: string, fetchImpl: typeof fetch = fetch): Promise<ProtectedBranchFacts> {
  const get = async (path: string) => {
    const response = await fetchImpl(`${GITHUB_API}/${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "paperclip" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data: unknown = response.ok ? await response.json() : null;
    return { status: response.status, data, next: /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "") };
  };
  const failed = (what: string, status: number) => new Error(`GitHub answered ${status} for the ${what} of ${repository}.`);
  const repositoryResponse = await get(`repos/${repository}`);
  const defaultBranch = repositoryResponse.status === 200 ? field(repositoryResponse.data, "default_branch") : undefined;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw failed("default branch", repositoryResponse.status);
  const protection = new Map<string, boolean>();
  for (const branch of new Set(branches)) {
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
    protection.set(branch, classic || ruled);
  }
  return { repository, defaultBranch, protection };
}
