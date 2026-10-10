import { assertReadOnlyInstallationToken, mintGitHubInstallationToken } from "@paperclipai/shared/github-installation-token";
import { createPrivateKey, sign } from "node:crypto";
import type { AllowedOwner, AppIdentity, Catalog, Credentials, GitHubIssue, IssuePage, Repository } from "./contracts.js";

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Validate an operator-provided GitHub owner allowlist without silently broadening it. */
export function validateAllowedOwners(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Allowed owners must be an array of GitHub logins or organization names.");
  if (value.length > 100) throw new Error("Allow at most 100 GitHub owners.");
  const owners = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Each allowed owner must be a GitHub login or organization name.");
    const owner = item.trim();
    if (!ownerPattern.test(owner)) throw new Error(`Invalid GitHub owner: ${owner || "(empty)"}.`);
    owners.set(owner.toLowerCase(), owner);
  }
  return [...owners.values()];
}

export function ownerFromRepository(fullName: string): string {
  return fullName.split("/", 1)[0]?.toLowerCase() ?? "";
}

/** Normalize persisted owner identities. A zero ID is accepted only for direct
 * legacy client calls; company state written by allowed-owners.set always pins
 * a positive GitHub account ID. */
export function normalizeAllowedOwnerRecords(value: unknown): AllowedOwner[] {
  if (!Array.isArray(value)) return [];
  const owners = new Map<string, AllowedOwner>();
  for (const item of value) {
    if (typeof item === "string") {
      const login = item.trim();
      if (ownerPattern.test(login)) owners.set(login.toLowerCase(), { id: 0, login });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const login = typeof record.login === "string" ? record.login.trim() : "";
    const id = record.id;
    if (!ownerPattern.test(login) || !Number.isSafeInteger(id) || Number(id) < 0) continue;
    owners.set(login.toLowerCase(), { id: Number(id), login });
  }
  return [...owners.values()];
}

export class GitHubError extends Error {
  constructor(public status: number) {
    super(status === 401 ? "GitHub rejected the App credentials. Reconnect or generate a new private key."
      : status === 403 || status === 429 ? "GitHub denied access or rate limited this request. Check App permissions and try again later."
      : status === 409 ? "GitHub changed or has a conflict. Refresh before trying again."
      : status === 422 ? "GitHub rejected these values or this action. Check the fields and repository rules."
      : status === 405 ? "GitHub cannot merge this pull request. Check required reviews, checks and conflicts."
      : status === 404 ? "GitHub could not find this resource. Check the App installation and repository access."
      : "GitHub is unavailable. Please try again.");
  }
}
export function appJwt(appId: string, pem: string, now = Date.now()): string {
  if (!/^[1-9][0-9]*$/.test(appId)) throw new Error("Enter a valid GitHub App ID.");
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: appId, iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540 })).toString("base64url");
    const payload = `${header}.${body}`;
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`;
  } catch { throw new Error("The private key must be a valid RSA PEM file from your GitHub App."); }
}
export function repoName(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== "https://github.com" || u.username || u.password || u.search || u.hash) return null;
    const path = u.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path.slice(1) : null;
  } catch { return null; }
}
function identity(raw: any): AppIdentity {
  if (!Number.isSafeInteger(raw.id) || raw.id < 1 || !/^[a-z0-9-]+$/.test(raw.slug)) throw new Error("GitHub returned an invalid App identity.");
  return { id: String(raw.id), slug: raw.slug, name: String(raw.name ?? raw.slug),
    issuesWrite: raw.permissions?.issues === "write", permissions: raw.permissions ?? {},
    settingsUrl: typeof raw.owner?.login === "string" && /^[A-Za-z0-9-]+$/.test(raw.owner.login)
      ? `https://github.com/${raw.owner.type === "Organization" ? `organizations/${raw.owner.login}/settings` : "settings"}/apps/${raw.slug}/permissions` : undefined,
    ...(typeof raw.owner?.login === "string" && /^[A-Za-z0-9-]+$/.test(raw.owner.login) ? { owner: raw.owner.login } : {}) };
}
/** I-RO (an App-user company's App only reads) lives with the one mint function Paperclip has. */
export { assertReadOnlyInstallationToken, GITHUB_READ_ONLY_INSTALLATION_SCOPES as READ_ONLY_INSTALLATION_SCOPES } from "@paperclipai/shared/github-installation-token";

/**
 * The one request this plugin sends without credentials: GitHub's one-time App manifest conversion, whose code is its only
 * authentication. It is a POST to the conversion path whose body is exactly `{}`. GitHub allows 60 unauthenticated
 * requests an hour per IP address, and everything behind one egress IP shares them, so any other request without a token is
 * refused here, whatever the caller meant (a missing, empty or blank token, another method, or another body on that path).
 * The body is judged as the string that is sent: a Date, a `toJSON` that is not an own key, or a Proxy can look empty to a check
 * on the object and still serialize to content.
 */
const UNAUTHENTICATED_PATH = /^\/app-manifests\/[A-Za-z0-9_-]{10,200}\/conversions$/;
const isManifestConversion = (verb: string, path: string, payload: string | undefined) =>
  verb === "POST" && UNAUTHENTICATED_PATH.test(path) && payload === "{}";

export class GitHubClient {
  constructor(private fetchImpl: typeof fetch = fetch) {}
  /**
   * The fenced repositories (lowercase `owner/name`) of the company that owns an
   * App, when that company writes as the App's user; null otherwise. Set by the
   * worker and read on every mint, so a policy change applies to the next token.
   * An error counts as such a company with an empty fence (fail closed).
   */
  appUserFence: (appId: string) => Promise<string[] | null> = async () => null;
  private async fenceFor(appId: string): Promise<string[] | null> {
    try { return await this.appUserFence(appId); } catch { return []; }
  }
  /** App installation tokens with a write scope minted in the last hour (installation tokens live one hour), per App. */
  private writeTokens = new Map<string, Array<{ token: string; expires: number }>>();
  /** Revokes one installation token at GitHub (DELETE /installation/token, authenticated by the token itself). */
  async revokeInstallationToken(token: string): Promise<boolean> {
    try { await this.request("/installation/token", token, undefined, "DELETE"); return true; } catch { return false; }
  }
  /**
   * Revokes every App write token this worker minted for an App in the last
   * hour, when its company switches to the App user (I-RO). Tokens minted by an
   * earlier worker process are not known here; they expire within the hour.
   */
  async revokeWriteTokens(appId: string): Promise<number> {
    const tokens = (this.writeTokens.get(appId) ?? []).filter(entry => entry.expires > Date.now());
    this.writeTokens.delete(appId);
    const results = await Promise.all(tokens.map(entry => this.revokeInstallationToken(entry.token)));
    return results.filter(Boolean).length;
  }
  async request<T>(path: string, token?: string, body?: unknown, method?: "POST" | "PATCH" | "PUT" | "DELETE"): Promise<{ data: T; next: boolean }> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub path.");
    const verb = method ?? (body === undefined ? "GET" : "POST");
    // Serialize once: the credential decision and the request use this one string, never the object again.
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (!token?.trim() && !isManifestConversion(verb, path, payload)) throw new Error("Paperclip does not call GitHub without credentials.");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await this.fetchImpl(`https://api.github.com${path}`, {
        method: verb, redirect: "error", signal: abort.signal,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "paperclip-github-plugin",
          ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(payload === undefined ? {} : { body: payload })
      });
      if (!res.ok) { await res.body?.cancel(); throw new GitHubError(res.status); }
      if (res.status === 204) return { data: undefined as T, next: false };
      const reader = res.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4_000_000) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T, next: /rel="next"/.test(res.headers.get("link") ?? "") };
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      // Provider bodies and network errors can contain credentials or request URLs.
      throw new Error("GitHub did not return a valid response. Please try again.");
    } finally { clearTimeout(timer); }
  }
  async convert(code: string): Promise<Credentials> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(code)) throw new Error("Invalid GitHub setup code. Start setup again.");
    const { data } = await this.request<any>(`/app-manifests/${encodeURIComponent(code)}/conversions`, undefined, {});
    if (typeof data.pem !== "string") throw new Error("GitHub did not return an App private key.");
    const app = identity(data);
    await this.verify(app.id, data.pem);
    return { ...app, privateKey: data.pem };
  }
  async verify(id: string, pem: string): Promise<AppIdentity> {
    const { data } = await this.request<any>("/app", appJwt(id, pem));
    const app = identity(data);
    if (app.id !== id) throw new Error("The GitHub App ID does not match this private key.");
    return app;
  }
  /** An issues token for one repository (the mirror and sync). */
  async token(id: string, pem: string, installationId: number, repositoryId: number, write = false): Promise<string> {
    return this.scopedToken(id, pem, installationId, { metadata: "read", issues: write ? "write" : "read" }, repositoryId);
  }
  /**
   * The only way this plugin mints installation tokens. `repositories` are IDs,
   * or `owner/name` names of one installation owner. For an App-user company's
   * App every token is checked against I-RO here.
   */
  async scopedToken(id: string, pem: string, installationId: number, permissions: Record<string, string>, repositories?: number | ReadonlyArray<number> | ReadonlyArray<string>) {
    const list: Array<number | string> = repositories === undefined ? [] : typeof repositories === "number" ? [repositories] : [...repositories];
    const fence = await this.fenceFor(id);
    const token = await mintGitHubInstallationToken({ installationId, permissions, repositories: list as number[] | string[] }, fence,
      async call => (await this.request<{ token?: unknown }>(call.path, appJwt(id, pem), call.body)).data?.token);
    // The company may have switched to its App user while GitHub minted the token: check again, and
    // revoke a token that I-RO no longer allows instead of handing it out.
    const after = fence ?? await this.fenceFor(id);
    if (after && !fence) {
      try { assertReadOnlyInstallationToken(permissions, list, after); } catch (error) {
        await this.revokeInstallationToken(token);
        throw error;
      }
    }
    if (!after && Object.values(permissions).some(level => level !== "read")) {
      const recent = (this.writeTokens.get(id) ?? []).filter(entry => entry.expires > Date.now());
      recent.push({ token: token, expires: Date.now() + 60 * 60_000 });
      this.writeTokens.set(id, recent);
    }
    return token;
  }
  async graphql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { data } = await this.request<{ data?: T; errors?: { type?: string }[] }>("/graphql", token, { query, variables });
    if (data.errors?.length || !data.data) {
      if (!data.data && data.errors?.some(e => e.type === "FORBIDDEN" || e.type === "NOT_FOUND")) throw new GitHubError(403);
      throw new Error("GitHub could not complete this action. Refresh and check permissions and field values before retrying.");
    }
    return data.data;
  }
  async resolveOwners(id: string, pem: string, requested: readonly string[]): Promise<AllowedOwner[]> {
    const wanted = validateAllowedOwners(requested);
    if (!wanted.length) return [];
    const byLogin = new Map<string, AllowedOwner>();
    const jwt = appJwt(id, pem);
    for (let page = 1; page <= 10; page++) {
      const response = await this.request<any[]>(`/app/installations?per_page=100&page=${page}`, jwt);
      for (const row of response.data) {
        const login = typeof row.account?.login === "string" ? row.account.login : "";
        const accountId = row.account?.id;
        if (login && Number.isSafeInteger(accountId) && Number(accountId) > 0) {
          byLogin.set(login.toLowerCase(), { id: Number(accountId), login });
        }
      }
      if (!response.next) break;
    }
    return wanted.map(login => {
      const owner = byLogin.get(login.toLowerCase());
      if (!owner) throw new Error(`GitHub owner ${login} is not installed on this App. Install the App first, then retry.`);
      return owner;
    });
  }

  /** Identify a webhook installation without applying the repository owner allowlist. */
  async hasInstallation(id: string, pem: string, installationId: number): Promise<boolean> {
    if (!Number.isSafeInteger(installationId) || installationId < 1) return false;
    const jwt = appJwt(id, pem);
    for (let page = 1; page <= 10; page++) {
      const response = await this.request<any[]>(`/app/installations?per_page=100&page=${page}`, jwt);
      if (response.data.some(row => Number.isSafeInteger(row?.id) && row.id === installationId)) return true;
      if (!response.next) return false;
    }
    return false;
  }

  async catalog(id: string, pem: string, allowedOwners: readonly (string | AllowedOwner)[] = []): Promise<Catalog> {
    const owners = normalizeAllowedOwnerRecords(allowedOwners);
    const ownerIds = new Set(owners.filter(owner => owner.id > 0).map(owner => owner.id));
    const ownerLogins = new Set(owners.map(owner => owner.login.toLowerCase()));
    const jwt = appJwt(id, pem);
    const { data } = await this.request<any>("/app", jwt);
    const app = identity(data);
    if (app.id !== id) throw new Error("The GitHub App identity changed. Reconnect the App.");
    // An App-user company's App lists only its fenced repositories (I-RO).
    const fence = await this.fenceFor(id);
    const result: Catalog = { app, installations: [], repositories: [], warnings: [], truncated: false };
    if (!owners.length) {
      result.warnings.push("No GitHub owners are allowlisted for this company. Add at least one owner in GitHub connection settings.");
      return result;
    }
    for (let page = 1; page <= 10; page++) {
      const response = await this.request<any[]>(`/app/installations?per_page=100&page=${page}`, jwt);
      for (const row of response.data) {
        if (!Number.isSafeInteger(row.id) || !row.account?.login) continue;
        const login = String(row.account.login);
        const accountId = Number.isSafeInteger(row.account.id) && row.account.id > 0 ? Number(row.account.id) : undefined;
        if (ownerIds.size ? !accountId || !ownerIds.has(accountId) : !ownerLogins.has(login.toLowerCase())) continue;
        const installation = { accountId, id: row.id, login, suspended: !!row.suspended_at, issuesWrite: row.permissions?.issues === "write", permissions: row.permissions ?? {}, accountType: row.account.type === "Organization" ? "Organization" as const : "User" as const,
          settingsUrl: `https://github.com/${row.account.type === "Organization" ? `organizations/${encodeURIComponent(row.account.login)}/settings` : "settings"}/installations/${row.id}` };
        result.installations.push(installation);
      }
      if (!response.next) break;
      if (page === 10) result.truncated = true;
    }
    for (const installation of result.installations) {
      if (installation.suspended) { result.warnings.push(`${installation.login}: installation is suspended.`); continue; }
      try {
        // Listing the installation's repositories needs metadata alone.
        const fenced = fence?.filter(name => name.split("/")[0] === installation.login.toLowerCase());
        if (fenced && !fenced.length) continue;
        const token = await this.scopedToken(id, pem, installation.id, { metadata: "read" }, fenced);
        for (let page = 1; page <= 10; page++) {
          const response = await this.request<{ repositories: any[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
          for (const row of response.data.repositories) {
            const fullName = repoName(row.html_url);
            const ownerMatches = ownerIds.size ? ownerIds.has(installation.accountId ?? -1) : ownerLogins.has(ownerFromRepository(fullName ?? ""));
            if (fullName && ownerMatches && Number.isSafeInteger(row.id)) result.repositories.push({
              id: row.id, name: String(row.name), fullName, url: `https://github.com/${fullName}`,
              installationId: installation.id, owner: installation.login, ownerId: installation.accountId, private: !!row.private, issuesWrite: installation.issuesWrite, permissions: installation.permissions
            });
          }
          if (!response.next) break;
          if (page === 10) result.truncated = true;
        }
      } catch (error) { result.warnings.push(`${installation.login}: ${error instanceof Error ? error.message : "Unable to list repositories."}`); }
    }
    result.repositories = [...new Map(result.repositories.map(r => [r.id, r])).values()].sort((a,b) => a.fullName.localeCompare(b.fullName));
    return result;
  }
  async issues(id: string, pem: string, repository: Repository, page: number, state: "open" | "closed" | "all"): Promise<IssuePage> {
    const token = await this.token(id, pem, repository.installationId, repository.id);
    const { data, next } = await this.request<any[]>(`/repos/${repository.fullName}/issues?state=${state}&sort=updated&direction=desc&per_page=50&page=${page}`, token);
    const issues = data.filter(row => !row.pull_request).map(row => this.issue(row, repository));
    return { issues, repository: repository.fullName, nextPage: next ? page + 1 : null };
  }
  issue(row: any, repository: Repository): GitHubIssue {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.number) || row.number < 1 || row.pull_request) throw new Error("GitHub returned an invalid issue.");
    return { id: row.id, number: row.number, title: String(row.title), state: row.state === "closed" ? "closed" : "open",
      body: typeof row.body === "string" ? row.body : "", stateReason: row.state_reason ?? null,
      labels: (row.labels ?? []).map((label: any) => typeof label === "string" ? label : String(label.name)),
      url: `https://github.com/${repository.fullName}/issues/${row.number}`, repository: repository.fullName,
      updatedAt: String(row.updated_at), assignees: (row.assignees ?? []).map((a: any) => String(a.login)) };
  }
  async getIssue(id: string, pem: string, repository: Repository, number: number): Promise<GitHubIssue> {
    const token = await this.token(id, pem, repository.installationId, repository.id);
    const { data } = await this.request<any>(`/repos/${repository.fullName}/issues/${number}`, token);
    return this.issue(data, repository);
  }
  /** `token` writes as that identity (the company's App user) instead of the App. */
  async createIssue(id: string, pem: string, repository: Repository, input: { title: string; body: string }, token?: string): Promise<GitHubIssue> {
    token ??= await this.token(id, pem, repository.installationId, repository.id, true);
    const { data } = await this.request<any>(`/repos/${repository.fullName}/issues`, token, input);
    return this.issue(data, repository);
  }
  async updateIssue(id: string, pem: string, repository: Repository, number: number,
    input: { title?: string; body?: string; state?: "open" | "closed"; state_reason?: "completed" | "not_planned" | "reopened" }, token?: string): Promise<GitHubIssue> {
    token ??= await this.token(id, pem, repository.installationId, repository.id, true);
    const { data } = await this.request<any>(`/repos/${repository.fullName}/issues/${number}`, token, input, "PATCH");
    return this.issue(data, repository);
  }

  /**
   * POST to GitHub's OAuth endpoints (device flow and user token refresh).
   * GitHub reports OAuth errors in a 200 body (`{ error }`), which is returned
   * as data. Bodies and errors are never logged; they carry tokens.
   */
  async oauth(path: "/login/device/code" | "/login/oauth/access_token", body: Record<string, string>): Promise<Record<string, unknown>> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await this.fetchImpl(`https://github.com${path}`, {
        method: "POST", redirect: "error", signal: abort.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "paperclip-github-plugin" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { await res.body?.cancel(); throw new GitHubError(res.status); }
      const data = await res.json() as unknown;
      if (!data || typeof data !== "object") throw new Error();
      return data as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new Error("GitHub did not return a valid response. Please try again.");
    } finally { clearTimeout(timer); }
  }

}
