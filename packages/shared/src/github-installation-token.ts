/**
 * The only place Paperclip mints GitHub App installation tokens
 * (POST /app/installations/{id}/access_tokens): the server's native GitHub
 * code and the GitHub plugin both call {@link mintGitHubInstallationToken}
 * with their own HTTP client.
 *
 * Invariant I-RO: when a company writes on GitHub as its App's user
 * (`userSource: "app"`), that App only reads. Every installation token of such
 * an App requests an explicit read-only permission subset and names either
 * exactly one repository by ID or repositories of the company's fence by
 * `owner/name` (one owner); it is never installation-wide and never carries a
 * write scope. The caller resolves the fence (null when no company writes as
 * this App's user).
 */

/** The read scopes an installation token of a read-only App may request. */
export const GITHUB_READ_ONLY_INSTALLATION_SCOPES: ReadonlySet<string> = new Set([
  "metadata", "contents", "issues", "pull_requests", "checks", "statuses", "actions", "organization_projects",
]);

/** A token request Paperclip refused before asking GitHub. */
export class GitHubInstallationTokenRefused extends Error {
  constructor(reason: string) {
    super(`Refused to mint a GitHub App installation token: ${reason}`);
    this.name = "GitHubInstallationTokenRefused";
  }
}

/**
 * Throws unless an installation token request satisfies I-RO. `repositories`
 * are IDs or `owner/name` names; `fence` is the company's fenced repositories,
 * lowercase `owner/name`.
 */
export function assertReadOnlyInstallationToken(permissions: unknown, repositories: ReadonlyArray<number | string>, fence: readonly string[]): void {
  const refuse = (reason: string): never => { throw new GitHubInstallationTokenRefused(reason); };
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions) || !Object.keys(permissions).length) refuse("it must request an explicit read-only permission subset.");
  for (const [scope, level] of Object.entries(permissions as Record<string, unknown>)) {
    if (level !== "read") refuse(`${scope} ${String(level)} is not read-only; this App's installation tokens only read.`);
    if (!GITHUB_READ_ONLY_INSTALLATION_SCOPES.has(scope)) refuse(`${scope} is not a read scope Paperclip uses.`);
  }
  const ids = repositories.filter(value => typeof value === "number");
  const names = repositories.filter((value): value is string => typeof value === "string");
  if (ids.length && names.length) refuse("it mixes repository IDs and names.");
  if (ids.length) {
    if (ids.length !== 1 || !Number.isSafeInteger(ids[0]) || Number(ids[0]) < 1) refuse("a token that names repositories by ID names exactly one.");
    return;
  }
  if (!names.length) refuse("it must name its repository, or the company's fenced repositories; never the whole installation.");
  if (new Set(names.map(name => name.split("/")[0]!.toLowerCase())).size !== 1) refuse("its repositories must belong to one installation owner.");
  const outside = names.filter(name => !/^[^/]+\/[^/]+$/.test(name) || !fence.includes(name.toLowerCase()));
  if (outside.length) refuse(`${outside.join(", ")} is outside the company's GitHub fence.`);
}

export interface GitHubInstallationTokenRequest {
  installationId: number | string;
  /** The permissions asked for; omitted asks for all of the installation's (refused under I-RO). */
  permissions?: Record<string, string>;
  /** Repository IDs, or `owner/name` names of one owner; omitted means the whole installation (refused under I-RO). */
  repositories?: ReadonlyArray<number> | ReadonlyArray<string>;
}

/** The request to send to GitHub, authenticated with the App's JWT. */
export interface GitHubInstallationTokenCall {
  /** REST path: `/app/installations/<id>/access_tokens`. */
  path: string;
  /** The same request as an Octokit route, with `installation_id` as its parameter. */
  route: "POST /app/installations/{installation_id}/access_tokens";
  installationId: string;
  body: { permissions?: Record<string, string>; repository_ids?: number[]; repositories?: string[] };
}

/**
 * Mints one installation token through `send`, the caller's GitHub client,
 * which returns the token GitHub issued. `fence` is null when no company
 * writes as this App's user; otherwise the request is checked against I-RO
 * before GitHub is asked.
 */
export async function mintGitHubInstallationToken(
  request: GitHubInstallationTokenRequest,
  fence: readonly string[] | null,
  send: (call: GitHubInstallationTokenCall) => Promise<unknown>,
): Promise<string> {
  const installationId = String(request.installationId);
  if (!/^[1-9]\d{0,19}$/.test(installationId)) throw new GitHubInstallationTokenRefused("the installation ID is invalid.");
  const list: Array<number | string> = request.repositories ? [...request.repositories] : [];
  if (fence !== null) assertReadOnlyInstallationToken(request.permissions, list, fence);
  const ids = list.filter((value): value is number => typeof value === "number");
  const names = list.filter((value): value is string => typeof value === "string");
  if (ids.length && names.length) throw new GitHubInstallationTokenRefused("it mixes repository IDs and names.");
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new GitHubInstallationTokenRefused("a repository ID is invalid.");
  const body: GitHubInstallationTokenCall["body"] = {
    ...(ids.length ? { repository_ids: ids } : {}),
    // GitHub takes repository names without their owner (the installation's account).
    ...(names.length ? { repositories: names.map(name => name.split("/").pop()!) } : {}),
    ...(request.permissions ? { permissions: { ...request.permissions } } : {}),
  };
  const token = await send({ path: `/app/installations/${installationId}/access_tokens`, route: "POST /app/installations/{installation_id}/access_tokens", installationId, body });
  if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token.");
  return token;
}
